"""Live camera capture and MoveNet RuntimeEvent streaming."""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from collections.abc import Callable, Generator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from reme.pose.movenet import MoveNetEstimator, MoveNetResult
from reme.pose.runtime import RuntimeEvent, RuntimeEventType
from reme.pose.scene_bundle import FRAME_LANDMARKS_SCHEMA_VERSION


class CameraStreamError(RuntimeError):
    """Raised when a live camera stream cannot start or continue."""


@dataclass(frozen=True, slots=True)
class CameraConfig:
    """Requested OpenCV camera settings for the current workstation."""

    device_index: int = 0
    width: int = 1280
    height: int = 720
    fps: float = 30.0
    fourcc: str = "MJPG"

    def __post_init__(self) -> None:
        if (
            isinstance(self.device_index, bool)
            or not isinstance(self.device_index, int)
            or self.device_index < 0
        ):
            raise CameraStreamError("device_index must be a non-negative integer")
        for field_name, value in (("width", self.width), ("height", self.height)):
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise CameraStreamError(f"{field_name} must be a positive integer")
        if isinstance(self.fps, bool) or not isinstance(self.fps, int | float):
            raise CameraStreamError("fps must be positive")
        if self.fps <= 0:
            raise CameraStreamError("fps must be positive")
        if len(self.fourcc) != 4:
            raise CameraStreamError("fourcc must contain exactly four characters")


class FrameSource(Protocol):
    """Minimal seam for a live image source."""

    def open(self) -> None: ...

    def read(self) -> object | None: ...

    def close(self) -> None: ...


class PoseEstimator(Protocol):
    """Minimal seam for a stateful pose estimator."""

    def reset(self) -> None: ...

    def infer(self, frame: object) -> MoveNetResult: ...


class OpenCVCameraSource:
    """Open one V4L2/OpenCV camera without persisting raw frames."""

    def __init__(self, config: CameraConfig) -> None:
        self.config = config
        self._capture: Any | None = None
        self._cv2: Any | None = None

    def open(self) -> None:
        """Open and configure the selected camera."""

        if self._capture is not None:
            raise CameraStreamError("camera is already open")
        try:
            import cv2
        except ImportError as exc:
            raise CameraStreamError("camera runtime requires opencv-python") from exc

        cv2_module: Any = cv2
        capture = cv2_module.VideoCapture(
            self.config.device_index, cv2_module.CAP_V4L2
        )
        if not capture.isOpened():
            capture.release()
            raise CameraStreamError(
                f"OpenCV could not open camera index {self.config.device_index}"
            )
        capture.set(
            cv2_module.CAP_PROP_FOURCC,
            cv2_module.VideoWriter_fourcc(*self.config.fourcc),
        )
        capture.set(cv2_module.CAP_PROP_FRAME_WIDTH, self.config.width)
        capture.set(cv2_module.CAP_PROP_FRAME_HEIGHT, self.config.height)
        capture.set(cv2_module.CAP_PROP_FPS, float(self.config.fps))
        capture.set(cv2_module.CAP_PROP_BUFFERSIZE, 1)
        self._capture = capture
        self._cv2 = cv2_module

    def read(self) -> object:
        """Read one BGR frame or raise a visible degraded-state error."""

        if self._capture is None:
            raise CameraStreamError("camera is not open")
        ok, frame = self._capture.read()
        if not ok or frame is None:
            raise CameraStreamError("camera read failed")
        return frame

    def close(self) -> None:
        """Release the camera immediately."""

        if self._capture is not None:
            self._capture.release()
        self._capture = None
        self._cv2 = None

    def properties(self) -> dict[str, float | int | str]:
        """Return the actual camera settings reported by OpenCV."""

        if self._capture is None or self._cv2 is None:
            raise CameraStreamError("camera is not open")
        return {
            "device_index": self.config.device_index,
            "width": int(self._capture.get(self._cv2.CAP_PROP_FRAME_WIDTH)),
            "height": int(self._capture.get(self._cv2.CAP_PROP_FRAME_HEIGHT)),
            "fps": round(float(self._capture.get(self._cv2.CAP_PROP_FPS)), 3),
            "fourcc": self.config.fourcc,
        }


@dataclass(frozen=True, slots=True)
class LiveStreamSummary:
    """Measured output of one live-camera run."""

    processed_frames: int
    person_detected_frames: int
    elapsed_seconds: float
    output_fps: float
    inference_ms_average: float | None
    inference_ms_p95: float | None
    processing_ms_average: float | None
    processing_ms_p95: float | None

    def to_payload(self) -> dict[str, object]:
        """Return a JSON-serializable measurement summary."""

        coverage = (
            self.person_detected_frames / self.processed_frames
            if self.processed_frames
            else 0.0
        )
        return {
            "processed_frames": self.processed_frames,
            "person_detected_frames": self.person_detected_frames,
            "person_detected_coverage": round(coverage, 6),
            "elapsed_seconds": round(self.elapsed_seconds, 3),
            "output_fps": round(self.output_fps, 3),
            "inference_ms_average": self.inference_ms_average,
            "inference_ms_p95": self.inference_ms_p95,
            "processing_ms_average": self.processing_ms_average,
            "processing_ms_p95": self.processing_ms_p95,
            "raw_frames_written": False,
            "raw_video_recorded": False,
        }


class LiveMoveNetStream:
    """Turn camera frames into session-scoped FrameLandmarks events."""

    def __init__(
        self,
        *,
        session_id: str,
        scene_id: str,
        frame_source: FrameSource,
        estimator: PoseEstimator,
        clock: Callable[[], float] = time.perf_counter,
        is_session_active: Callable[[str], bool] | None = None,
    ) -> None:
        if not session_id.strip():
            raise CameraStreamError("session_id must be non-empty")
        if not scene_id.strip():
            raise CameraStreamError("scene_id must be non-empty")
        self.session_id = session_id
        self.scene_id = scene_id
        self.frame_source = frame_source
        self.estimator = estimator
        self.clock = clock
        self.is_session_active = is_session_active or (lambda _session_id: True)
        self.summary: LiveStreamSummary | None = None

    def iter_events(self, *, max_frames: int | None = None) -> Generator[RuntimeEvent, None, None]:
        """Yield ordered FrameLandmarks events and release the source on exit."""

        if max_frames is not None and (
            isinstance(max_frames, bool)
            or not isinstance(max_frames, int)
            or max_frames <= 0
        ):
            raise CameraStreamError("max_frames must be a positive integer")

        processed_frames = 0
        detected_frames = 0
        inference_times_ms: list[float] = []
        processing_times_ms: list[float] = []
        started = self.clock()
        self.summary = None
        self.frame_source.open()
        self.estimator.reset()
        try:
            while max_frames is None or processed_frames < max_frames:
                if not self.is_session_active(self.session_id):
                    break
                frame = self.frame_source.read()
                if frame is None:
                    break
                captured_at = self.clock()
                result = self.estimator.infer(frame)
                ready_at = self.clock()
                inference_times_ms.append(result.inference_ms)
                processing_times_ms.append((ready_at - captured_at) * 1000.0)
                if result.person_detected:
                    detected_frames += 1
                timestamp_ms = round((captured_at - started) * 1000.0, 3)
                payload = {
                    "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
                    "scene_id": self.scene_id,
                    "frame_index": processed_frames,
                    "timestamp_ms": timestamp_ms,
                    "person_detected": result.person_detected,
                    "landmark_quality": result.landmark_quality,
                    "coordinate_space": "normalized_image_top_left",
                    "smoothed": False,
                    "keypoints": [keypoint.to_payload() for keypoint in result.keypoints],
                }
                event = RuntimeEvent(
                    session_id=self.session_id,
                    sequence=processed_frames,
                    event_type=RuntimeEventType.FRAME_LANDMARKS,
                    payload=payload,
                )
                processed_frames += 1
                yield event
        finally:
            finished = self.clock()
            self.frame_source.close()
            elapsed_seconds = max(finished - started, 0.0)
            output_fps = (
                processed_frames / elapsed_seconds if elapsed_seconds > 0 else 0.0
            )
            self.summary = LiveStreamSummary(
                processed_frames=processed_frames,
                person_detected_frames=detected_frames,
                elapsed_seconds=elapsed_seconds,
                output_fps=output_fps,
                inference_ms_average=_average(inference_times_ms),
                inference_ms_p95=_percentile(inference_times_ms, 0.95),
                processing_ms_average=_average(processing_times_ms),
                processing_ms_p95=_percentile(processing_times_ms, 0.95),
            )


def _average(values: list[float]) -> float | None:
    if not values:
        return None
    return round(float(statistics.fmean(values)), 3)


def _percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    value = ordered[lower] * (1.0 - weight) + ordered[upper] * weight
    return round(value, 3)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--scene-id", required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--num-threads", type=int, default=4)
    parser.add_argument("--warmup-runs", type=int, default=3)
    parser.add_argument(
        "--posture-model",
        type=Path,
        default=None,
        help="Optional trained posture model; emits PostureObservation events when set",
    )
    parser.add_argument("--posture-hz", type=float, default=7.5)
    parser.add_argument(
        "--max-frames",
        type=int,
        default=None,
        help="Stop after N frames; omit to run until interrupted",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run a bounded live-camera benchmark and print RuntimeEvents as JSONL."""

    args = _build_parser().parse_args(argv)
    try:
        source = OpenCVCameraSource(
            CameraConfig(
                device_index=args.camera,
                width=args.width,
                height=args.height,
                fps=args.fps,
            )
        )
        estimator = MoveNetEstimator(
            args.model,
            score_threshold=args.score_threshold,
            num_threads=args.num_threads,
            warmup_runs=args.warmup_runs,
        )
        stream = LiveMoveNetStream(
            session_id=args.session_id,
            scene_id=args.scene_id,
            frame_source=source,
            estimator=estimator,
        )
        posture_tracker = None
        if args.posture_model is not None:
            from reme.pose.posture import StaticPostureModel
            from reme.pose.posture_runtime import (
                PostureRuntimeConfig,
                RealtimePostureTracker,
            )

            posture_tracker = RealtimePostureTracker(
                session_id=args.session_id,
                predictor=StaticPostureModel.load(args.posture_model),
                config=PostureRuntimeConfig(output_hz=args.posture_hz),
            )
        posture_observations = 0
        events = stream.iter_events(max_frames=args.max_frames)
        try:
            for event in events:
                print(json.dumps(event.to_payload(), ensure_ascii=False), flush=True)
                if posture_tracker is not None:
                    posture_event = posture_tracker.process_frame_event(event)
                    if posture_event is not None:
                        posture_observations += 1
                        print(
                            json.dumps(posture_event.to_payload(), ensure_ascii=False),
                            flush=True,
                        )
        except KeyboardInterrupt:
            events.close()
        if stream.summary is None:
            raise CameraStreamError("live stream completed without a summary")
        summary_payload = stream.summary.to_payload()
        summary_payload["posture_observations"] = posture_observations
        print(
            json.dumps(summary_payload, ensure_ascii=False),
            file=sys.stderr,
            flush=True,
        )
        return 0
    except (CameraStreamError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
