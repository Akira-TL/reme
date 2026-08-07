"""MoveNet SinglePose adapter used by live and recorded perception."""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from reme.runtime.perception.scene_bundle import (
    CORE_KEYPOINT_NAMES,
    MOVENET_KEYPOINT_NAMES,
)

LandmarkQuality = Literal["usable", "degraded", "unavailable"]
TORSO_SHOULDERS = (5, 6)
TORSO_HIPS = (11, 12)


class MoveNetError(RuntimeError):
    """Raised when MoveNet cannot be loaded or invoked."""


@dataclass(frozen=True, slots=True)
class MoveNetKeypoint:
    """One normalized MoveNet keypoint."""

    name: str
    x_norm: float
    y_norm: float
    score: float

    def __post_init__(self) -> None:
        if self.name not in MOVENET_KEYPOINT_NAMES:
            raise ValueError(f"unknown MoveNet keypoint name: {self.name!r}")
        for field_name, value in (
            ("x_norm", self.x_norm),
            ("y_norm", self.y_norm),
            ("score", self.score),
        ):
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise ValueError(f"{field_name} must be numeric")
            if not 0.0 <= float(value) <= 1.0:
                raise ValueError(f"{field_name} must be between 0 and 1")

    def to_payload(self) -> dict[str, object]:
        """Return the shared FrameLandmarks keypoint shape."""

        return {
            "name": self.name,
            "x_norm": round(float(self.x_norm), 6),
            "y_norm": round(float(self.y_norm), 6),
            "score": round(float(self.score), 6),
        }


@dataclass(frozen=True, slots=True)
class MoveNetResult:
    """One MoveNet inference result and its quality state."""

    keypoints: tuple[MoveNetKeypoint, ...]
    person_detected: bool
    landmark_quality: LandmarkQuality
    inference_ms: float

    def __post_init__(self) -> None:
        names = tuple(keypoint.name for keypoint in self.keypoints)
        if names != MOVENET_KEYPOINT_NAMES:
            raise ValueError("MoveNetResult must contain the ordered 17 MoveNet keypoints")
        if self.inference_ms < 0:
            raise ValueError("inference_ms must be non-negative")
        if not self.person_detected and self.landmark_quality != "unavailable":
            raise ValueError("undetected person must have unavailable landmark quality")


class MoveNetEstimator:
    """Stateful MoveNet Lightning estimator with video-style tracking crop."""

    def __init__(
        self,
        model_path: str | Path,
        *,
        score_threshold: float = 0.2,
        num_threads: int = 4,
        warmup_runs: int = 3,
    ) -> None:
        if not 0.0 <= score_threshold <= 1.0:
            raise MoveNetError("score_threshold must be between 0 and 1")
        if num_threads < 1:
            raise MoveNetError("num_threads must be positive")
        if warmup_runs < 0:
            raise MoveNetError("warmup_runs must be non-negative")

        resolved_model = Path(model_path).expanduser().resolve()
        if not resolved_model.is_file():
            raise MoveNetError(f"MoveNet model not found: {resolved_model}")

        cv2, np, interpreter_class = _load_runtime()
        interpreter = interpreter_class(
            model_path=str(resolved_model), num_threads=num_threads
        )
        interpreter.allocate_tensors()
        input_details = interpreter.get_input_details()
        output_details = interpreter.get_output_details()
        if len(input_details) != 1 or not output_details:
            raise MoveNetError("MoveNet model must have one input and at least one output")

        input_detail = input_details[0]
        output_detail = output_details[0]
        input_shape = tuple(int(value) for value in input_detail["shape"])
        if len(input_shape) != 4 or input_shape[0] != 1 or input_shape[3] != 3:
            raise MoveNetError(f"unexpected MoveNet input shape: {input_shape}")

        warmup_tensor = np.zeros(input_shape, dtype=input_detail["dtype"])
        for _ in range(warmup_runs):
            interpreter.set_tensor(input_detail["index"], warmup_tensor)
            interpreter.invoke()

        self.model_path = resolved_model
        self.score_threshold = score_threshold
        self.num_threads = num_threads
        self._cv2 = cv2
        self._np = np
        self._interpreter = interpreter
        self._input_detail = input_detail
        self._output_detail = output_detail
        self._target_height = input_shape[1]
        self._target_width = input_shape[2]
        self._crop_region: dict[str, float] | None = None

    def reset(self) -> None:
        """Reset tracking state for a new runtime session."""

        self._crop_region = None

    def infer(self, frame: object) -> MoveNetResult:
        """Estimate normalized 17-point landmarks for one BGR camera frame."""

        if not hasattr(frame, "shape"):
            raise MoveNetError("camera frame must provide an image shape")
        frame_height, frame_width = frame.shape[:2]
        if frame_height <= 0 or frame_width <= 0:
            raise MoveNetError("camera frame reports an invalid size")
        if self._crop_region is None:
            self._crop_region = initial_crop_region(frame_height, frame_width)

        input_tensor = _prepare_cropped_input(
            frame,
            self._crop_region,
            self._target_height,
            self._target_width,
            self._input_detail,
            self._cv2,
            self._np,
        )
        self._interpreter.set_tensor(self._input_detail["index"], input_tensor)
        started = time.perf_counter()
        self._interpreter.invoke()
        inference_ms = (time.perf_counter() - started) * 1000.0
        raw_output = self._interpreter.get_tensor(self._output_detail["index"])
        keypoint_array = _decode_cropped_keypoints(
            raw_output,
            self._output_detail,
            self._crop_region,
            self._np,
        )
        self._crop_region = determine_next_crop_region(
            keypoint_array,
            frame_height,
            frame_width,
            self.score_threshold,
        )

        person_detected = _torso_detected(keypoint_array, self.score_threshold)
        quality = _derive_quality(
            keypoint_array,
            person_detected=person_detected,
            score_threshold=self.score_threshold,
        )
        keypoints = tuple(
            MoveNetKeypoint(
                name=name,
                y_norm=float(keypoint_array[index, 0]),
                x_norm=float(keypoint_array[index, 1]),
                score=float(keypoint_array[index, 2]),
            )
            for index, name in enumerate(MOVENET_KEYPOINT_NAMES)
        )
        return MoveNetResult(
            keypoints=keypoints,
            person_detected=person_detected,
            landmark_quality=quality,
            inference_ms=inference_ms,
        )


def initial_crop_region(frame_height: int, frame_width: int) -> dict[str, float]:
    """Return a square crop that includes the full frame with optional padding."""

    if frame_height <= 0 or frame_width <= 0:
        raise MoveNetError("frame dimensions must be positive")
    if frame_width > frame_height:
        crop_height = frame_width / frame_height
        crop_width = 1.0
        y_min = (frame_height / 2.0 - frame_width / 2.0) / frame_height
        x_min = 0.0
    else:
        crop_height = 1.0
        crop_width = frame_height / frame_width
        y_min = 0.0
        x_min = (frame_width / 2.0 - frame_height / 2.0) / frame_width
    return {
        "y_min": float(y_min),
        "x_min": float(x_min),
        "y_max": float(y_min + crop_height),
        "x_max": float(x_min + crop_width),
    }


def determine_next_crop_region(
    keypoints: Any,
    frame_height: int,
    frame_width: int,
    threshold: float,
) -> dict[str, float]:
    """Compute the next tracking crop from visible torso and body keypoints."""

    shoulders_visible = all(
        float(keypoints[index, 2]) >= threshold for index in TORSO_SHOULDERS
    )
    hips_visible = all(float(keypoints[index, 2]) >= threshold for index in TORSO_HIPS)
    if not (shoulders_visible or hips_visible):
        return initial_crop_region(frame_height, frame_width)

    center_y = float((keypoints[11, 0] + keypoints[12, 0]) * 0.5 * frame_height)
    center_x = float((keypoints[11, 1] + keypoints[12, 1]) * 0.5 * frame_width)

    torso_x_range = 0.0
    torso_y_range = 0.0
    for index in (*TORSO_SHOULDERS, *TORSO_HIPS):
        torso_x_range = max(
            torso_x_range,
            abs(float(keypoints[index, 1]) * frame_width - center_x),
        )
        torso_y_range = max(
            torso_y_range,
            abs(float(keypoints[index, 0]) * frame_height - center_y),
        )

    body_x_range = 0.0
    body_y_range = 0.0
    for index in range(len(MOVENET_KEYPOINT_NAMES)):
        if float(keypoints[index, 2]) < threshold:
            continue
        body_x_range = max(
            body_x_range,
            abs(float(keypoints[index, 1]) * frame_width - center_x),
        )
        body_y_range = max(
            body_y_range,
            abs(float(keypoints[index, 0]) * frame_height - center_y),
        )

    crop_half = max(
        torso_x_range * 1.9,
        torso_y_range * 1.9,
        body_x_range * 1.2,
        body_y_range * 1.2,
    )
    crop_half = min(
        crop_half,
        max(
            center_x,
            frame_width - center_x,
            center_y,
            frame_height - center_y,
        ),
    )
    crop_length = crop_half * 2.0
    if crop_length <= 1.0 or crop_length > max(frame_width, frame_height):
        return initial_crop_region(frame_height, frame_width)

    return {
        "y_min": (center_y - crop_half) / frame_height,
        "x_min": (center_x - crop_half) / frame_width,
        "y_max": (center_y + crop_half) / frame_height,
        "x_max": (center_x + crop_half) / frame_width,
    }


def _load_runtime() -> tuple[Any, Any, Any]:
    try:
        import cv2
        import numpy as np
        from ai_edge_litert.interpreter import Interpreter
    except ImportError as exc:
        raise MoveNetError(
            "MoveNet runtime requires ai-edge-litert, numpy, and opencv-python"
        ) from exc
    return cv2, np, Interpreter


def _prepare_cropped_input(
    frame: Any,
    crop_region: dict[str, float],
    target_height: int,
    target_width: int,
    input_detail: dict[str, Any],
    cv2: Any,
    np: Any,
) -> Any:
    frame_height, frame_width = frame.shape[:2]
    y_min_px = int(round(crop_region["y_min"] * frame_height))
    x_min_px = int(round(crop_region["x_min"] * frame_width))
    y_max_px = int(round(crop_region["y_max"] * frame_height))
    x_max_px = int(round(crop_region["x_max"] * frame_width))
    crop_height = max(1, y_max_px - y_min_px)
    crop_width = max(1, x_max_px - x_min_px)

    canvas = np.zeros((crop_height, crop_width, 3), dtype=np.uint8)
    src_y0 = max(0, y_min_px)
    src_x0 = max(0, x_min_px)
    src_y1 = min(frame_height, y_max_px)
    src_x1 = min(frame_width, x_max_px)
    if src_y1 > src_y0 and src_x1 > src_x0:
        dst_y0 = src_y0 - y_min_px
        dst_x0 = src_x0 - x_min_px
        canvas[
            dst_y0 : dst_y0 + (src_y1 - src_y0),
            dst_x0 : dst_x0 + (src_x1 - src_x0),
        ] = frame[src_y0:src_y1, src_x0:src_x1]

    rgb = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (target_width, target_height), interpolation=cv2.INTER_LINEAR)
    input_dtype = np.dtype(input_detail["dtype"])
    if np.issubdtype(input_dtype, np.floating):
        tensor = resized.astype(input_dtype)
    elif input_dtype == np.uint8:
        tensor = resized
    elif input_dtype == np.int8:
        quant_scale, zero_point = input_detail.get("quantization", (0.0, 0))
        if quant_scale:
            quantized = np.rint(resized.astype(np.float32) / quant_scale + zero_point)
            tensor = np.clip(quantized, -128, 127).astype(np.int8)
        else:
            tensor = resized.astype(np.int8)
    else:
        raise MoveNetError(f"unsupported MoveNet input dtype: {input_dtype}")
    return np.expand_dims(tensor, axis=0)


def _decode_cropped_keypoints(
    raw_output: Any,
    output_detail: dict[str, Any],
    crop_region: dict[str, float],
    np: Any,
) -> Any:
    output = np.asarray(raw_output)
    output_dtype = np.dtype(output_detail["dtype"])
    if np.issubdtype(output_dtype, np.integer):
        quant_scale, zero_point = output_detail.get("quantization", (0.0, 0))
        if quant_scale:
            output = (output.astype(np.float32) - zero_point) * quant_scale

    flattened = output.reshape(-1, 3)
    if flattened.shape[0] < len(MOVENET_KEYPOINT_NAMES):
        raise MoveNetError(
            f"unexpected MoveNet output shape: {tuple(output.shape)}"
        )
    keypoints = flattened[: len(MOVENET_KEYPOINT_NAMES)].astype(
        np.float32, copy=True
    )
    crop_height = crop_region["y_max"] - crop_region["y_min"]
    crop_width = crop_region["x_max"] - crop_region["x_min"]
    keypoints[:, 0] = np.clip(
        crop_region["y_min"] + keypoints[:, 0] * crop_height,
        0.0,
        1.0,
    )
    keypoints[:, 1] = np.clip(
        crop_region["x_min"] + keypoints[:, 1] * crop_width,
        0.0,
        1.0,
    )
    return keypoints


def _torso_detected(keypoints: Any, threshold: float) -> bool:
    shoulder_visible = any(
        float(keypoints[index, 2]) >= threshold for index in TORSO_SHOULDERS
    )
    hip_visible = any(float(keypoints[index, 2]) >= threshold for index in TORSO_HIPS)
    return shoulder_visible and hip_visible


def _derive_quality(
    keypoints: Any,
    *,
    person_detected: bool,
    score_threshold: float,
) -> LandmarkQuality:
    if not person_detected:
        return "unavailable"
    scores = {
        name: float(keypoints[index, 2])
        for index, name in enumerate(MOVENET_KEYPOINT_NAMES)
    }
    if all(scores[name] >= score_threshold for name in CORE_KEYPOINT_NAMES):
        return "usable"
    return "degraded"
