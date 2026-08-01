#!/usr/bin/env python3
"""Throwaway LiteRT + MoveNet feasibility runner.

Raw video frames are decoded locally and kept in memory. The runner only writes
skeleton video, keypoints, and measurement summaries.
"""

from __future__ import annotations

import argparse
import json
import resource
import sys
import time
from pathlib import Path
from typing import Any

KEYPOINT_NAMES = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)

SKELETON_EDGES = (
    (0, 1),
    (0, 2),
    (1, 3),
    (2, 4),
    (0, 5),
    (0, 6),
    (5, 6),
    (5, 7),
    (7, 9),
    (6, 8),
    (8, 10),
    (5, 11),
    (6, 12),
    (11, 12),
    (11, 13),
    (13, 15),
    (12, 14),
    (14, 16),
)

TORSO_SHOULDERS = (5, 6)
TORSO_HIPS = (11, 12)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run MoveNet with LiteRT and export a skeleton-only privacy view."
    )
    parser.add_argument("--model", type=Path, required=True, help="MoveNet .tflite file")
    parser.add_argument("--video", type=Path, required=True, help="Input video file")
    parser.add_argument(
        "--output-dir",
        type=Path,
        required=True,
        help="Directory for skeleton.mp4, keypoints.jsonl, and summary.json",
    )
    parser.add_argument(
        "--score-threshold",
        type=float,
        default=0.2,
        help="Minimum keypoint confidence used for drawing and torso coverage",
    )
    parser.add_argument(
        "--sample-every",
        type=int,
        default=1,
        help="Run inference on every Nth decoded frame",
    )
    parser.add_argument(
        "--max-frames",
        type=int,
        default=None,
        help="Stop after this many processed frames",
    )
    parser.add_argument(
        "--num-threads",
        type=int,
        default=4,
        help="LiteRT Interpreter CPU thread count",
    )
    parser.add_argument(
        "--warmup-runs",
        type=int,
        default=3,
        help="Model warm-up invocations excluded from latency metrics",
    )
    parser.add_argument(
        "--no-video",
        action="store_true",
        help="Write keypoints and summary only",
    )
    parser.add_argument(
        "--tracking-crop",
        action="store_true",
        help=(
            "Use the previous frame's pose to crop the next frame, following the "
            "MoveNet video inference strategy"
        ),
    )
    args = parser.parse_args()

    if not 0.0 <= args.score_threshold <= 1.0:
        parser.error("--score-threshold must be between 0 and 1")
    if args.sample_every < 1:
        parser.error("--sample-every must be at least 1")
    if args.max_frames is not None and args.max_frames < 1:
        parser.error("--max-frames must be at least 1")
    if args.num_threads < 1:
        parser.error("--num-threads must be at least 1")
    if args.warmup_runs < 0:
        parser.error("--warmup-runs cannot be negative")
    return args


def load_runtime() -> tuple[Any, Any, Any]:
    try:
        import cv2
        import numpy as np
        from ai_edge_litert.interpreter import Interpreter
    except ImportError as exc:
        raise SystemExit(
            "Missing feasibility dependencies. Install ai-edge-litert, numpy, and "
            "opencv-python-headless in the project virtual environment."
        ) from exc
    return cv2, np, Interpreter


def prepare_input(
    frame: Any,
    target_height: int,
    target_width: int,
    input_detail: dict[str, Any],
    cv2: Any,
    np: Any,
) -> tuple[Any, dict[str, float]]:
    frame_height, frame_width = frame.shape[:2]
    scale = min(target_width / frame_width, target_height / frame_height)
    resized_width = max(1, round(frame_width * scale))
    resized_height = max(1, round(frame_height * scale))
    pad_left = (target_width - resized_width) // 2
    pad_top = (target_height - resized_height) // 2

    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    resized = cv2.resize(rgb, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    padded = np.zeros((target_height, target_width, 3), dtype=np.uint8)
    padded[
        pad_top : pad_top + resized_height,
        pad_left : pad_left + resized_width,
    ] = resized

    input_dtype = np.dtype(input_detail["dtype"])
    if np.issubdtype(input_dtype, np.floating):
        tensor = padded.astype(input_dtype)
    elif input_dtype == np.uint8:
        tensor = padded
    elif input_dtype == np.int8:
        quant_scale, zero_point = input_detail.get("quantization", (0.0, 0))
        if quant_scale:
            quantized = np.rint(padded.astype(np.float32) / quant_scale + zero_point)
            tensor = np.clip(quantized, -128, 127).astype(np.int8)
        else:
            tensor = padded.astype(np.int8)
    else:
        raise ValueError(f"Unsupported model input dtype: {input_dtype}")

    transform = {
        "scale": float(scale),
        "pad_left": float(pad_left),
        "pad_top": float(pad_top),
        "frame_width": float(frame_width),
        "frame_height": float(frame_height),
        "target_width": float(target_width),
        "target_height": float(target_height),
    }
    return np.expand_dims(tensor, axis=0), transform


def decode_keypoints(
    raw_output: Any,
    output_detail: dict[str, Any],
    transform: dict[str, float],
    np: Any,
) -> Any:
    output = np.asarray(raw_output)
    output_dtype = np.dtype(output_detail["dtype"])
    if np.issubdtype(output_dtype, np.integer):
        quant_scale, zero_point = output_detail.get("quantization", (0.0, 0))
        if quant_scale:
            output = (output.astype(np.float32) - zero_point) * quant_scale

    flattened = output.reshape(-1, 3)
    if flattened.shape[0] < len(KEYPOINT_NAMES):
        raise ValueError(
            "Unexpected MoveNet output shape: "
            f"{tuple(output.shape)}; expected at least 17 keypoints"
        )
    keypoints = flattened[: len(KEYPOINT_NAMES)].astype(np.float32, copy=True)

    model_y = keypoints[:, 0] * transform["target_height"]
    model_x = keypoints[:, 1] * transform["target_width"]
    original_y = (model_y - transform["pad_top"]) / transform["scale"]
    original_x = (model_x - transform["pad_left"]) / transform["scale"]

    keypoints[:, 0] = np.clip(original_y / transform["frame_height"], 0.0, 1.0)
    keypoints[:, 1] = np.clip(original_x / transform["frame_width"], 0.0, 1.0)
    return keypoints


def initial_crop_region(frame_height: int, frame_width: int) -> dict[str, float]:
    """Return a square crop that contains the full frame, with zero padding if needed."""
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


def prepare_cropped_input(
    frame: Any,
    crop_region: dict[str, float],
    target_height: int,
    target_width: int,
    input_detail: dict[str, Any],
    cv2: Any,
    np: Any,
) -> tuple[Any, dict[str, float]]:
    """Crop a square region, padding outside-frame areas with black, then resize."""
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
        raise ValueError(f"Unsupported model input dtype: {input_dtype}")

    return np.expand_dims(tensor, axis=0), {
        "y_min": float(crop_region["y_min"]),
        "x_min": float(crop_region["x_min"]),
        "y_max": float(crop_region["y_max"]),
        "x_max": float(crop_region["x_max"]),
    }


def decode_cropped_keypoints(
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
    if flattened.shape[0] < len(KEYPOINT_NAMES):
        raise ValueError(
            "Unexpected MoveNet output shape: "
            f"{tuple(output.shape)}; expected at least 17 keypoints"
        )
    keypoints = flattened[: len(KEYPOINT_NAMES)].astype(np.float32, copy=True)
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


def determine_next_crop_region(
    keypoints: Any,
    frame_height: int,
    frame_width: int,
    threshold: float,
) -> dict[str, float]:
    """Compute the next square crop from visible torso and body keypoints."""
    shoulders_visible = all(float(keypoints[index, 2]) >= threshold for index in TORSO_SHOULDERS)
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
    for index in range(len(KEYPOINT_NAMES)):
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


def torso_detected(keypoints: Any, threshold: float) -> bool:
    shoulder_visible = any(float(keypoints[index, 2]) >= threshold for index in TORSO_SHOULDERS)
    hip_visible = any(float(keypoints[index, 2]) >= threshold for index in TORSO_HIPS)
    return shoulder_visible and hip_visible


def render_skeleton(
    keypoints: Any,
    frame_height: int,
    frame_width: int,
    threshold: float,
    cv2: Any,
    np: Any,
) -> Any:
    canvas = np.zeros((frame_height, frame_width, 3), dtype=np.uint8)
    points: list[tuple[int, int]] = []
    for keypoint in keypoints:
        x = int(round(float(keypoint[1]) * (frame_width - 1)))
        y = int(round(float(keypoint[0]) * (frame_height - 1)))
        points.append((x, y))

    for start, end in SKELETON_EDGES:
        if keypoints[start, 2] >= threshold and keypoints[end, 2] >= threshold:
            cv2.line(canvas, points[start], points[end], (255, 255, 255), 3, cv2.LINE_AA)

    for index, point in enumerate(points):
        if keypoints[index, 2] >= threshold:
            cv2.circle(canvas, point, 5, (255, 255, 255), -1, cv2.LINE_AA)
    return canvas


def keypoint_record(
    frame_index: int,
    timestamp_ms: float,
    keypoints: Any,
    threshold: float,
) -> dict[str, Any]:
    detected = torso_detected(keypoints, threshold)
    return {
        "schema": "movenet-17/v0-experiment",
        "frame_index": frame_index,
        "timestamp_ms": round(timestamp_ms, 3),
        "torso_detected": detected,
        "keypoints": [
            {
                "name": name,
                "y_norm": round(float(keypoints[index, 0]), 6),
                "x_norm": round(float(keypoints[index, 1]), 6),
                "score": round(float(keypoints[index, 2]), 6),
            }
            for index, name in enumerate(KEYPOINT_NAMES)
        ],
    }


def percentile(values: list[float], quantile: float, np: Any) -> float | None:
    if not values:
        return None
    return round(float(np.percentile(np.asarray(values), quantile)), 3)


def peak_rss_mb() -> float:
    # Linux reports ru_maxrss in KiB. This experiment currently targets Linux/Pi.
    return round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0, 3)


def run(args: argparse.Namespace) -> dict[str, Any]:
    cv2, np, Interpreter = load_runtime()

    model_path = args.model.expanduser().resolve()
    video_path = args.video.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    if not model_path.is_file():
        raise SystemExit(f"Model not found: {model_path}")
    if not video_path.is_file():
        raise SystemExit(f"Video not found: {video_path}")
    output_dir.mkdir(parents=True, exist_ok=True)

    interpreter = Interpreter(model_path=str(model_path), num_threads=args.num_threads)
    interpreter.allocate_tensors()
    input_details = interpreter.get_input_details()
    output_details = interpreter.get_output_details()
    if len(input_details) != 1 or len(output_details) < 1:
        raise SystemExit(
            "This spike expects a single-input MoveNet model with at least one output tensor."
        )

    input_detail = input_details[0]
    output_detail = output_details[0]
    input_shape = tuple(int(value) for value in input_detail["shape"])
    if len(input_shape) != 4 or input_shape[0] != 1 or input_shape[3] != 3:
        raise SystemExit(f"Unexpected model input shape: {input_shape}")
    target_height, target_width = input_shape[1], input_shape[2]

    warmup_tensor = np.zeros(input_shape, dtype=input_detail["dtype"])
    for _ in range(args.warmup_runs):
        interpreter.set_tensor(input_detail["index"], warmup_tensor)
        interpreter.invoke()

    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise SystemExit(f"OpenCV could not open video: {video_path}")

    source_width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    source_height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    source_fps = float(capture.get(cv2.CAP_PROP_FPS))
    source_frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if source_width <= 0 or source_height <= 0:
        capture.release()
        raise SystemExit("Video reports an invalid frame size")
    if source_fps <= 0:
        source_fps = 30.0

    writer = None
    skeleton_path = output_dir / "skeleton.mp4"
    if not args.no_video:
        output_fps = source_fps / args.sample_every
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(
            str(skeleton_path),
            fourcc,
            output_fps,
            (source_width, source_height),
        )
        if not writer.isOpened():
            capture.release()
            raise SystemExit(f"OpenCV could not create skeleton video: {skeleton_path}")

    keypoints_path = output_dir / "keypoints.jsonl"
    inference_times_ms: list[float] = []
    processed_frames = 0
    torso_detected_frames = 0
    decoded_frames = 0
    started = time.perf_counter()
    crop_region = initial_crop_region(source_height, source_width)

    try:
        with keypoints_path.open("w", encoding="utf-8") as keypoint_file:
            while True:
                ok, frame = capture.read()
                if not ok:
                    break
                frame_index = decoded_frames
                decoded_frames += 1
                if frame_index % args.sample_every != 0:
                    continue

                if args.tracking_crop:
                    input_tensor, transform = prepare_cropped_input(
                        frame,
                        crop_region,
                        target_height,
                        target_width,
                        input_detail,
                        cv2,
                        np,
                    )
                else:
                    input_tensor, transform = prepare_input(
                        frame,
                        target_height,
                        target_width,
                        input_detail,
                        cv2,
                        np,
                    )
                interpreter.set_tensor(input_detail["index"], input_tensor)
                inference_started = time.perf_counter()
                interpreter.invoke()
                inference_times_ms.append((time.perf_counter() - inference_started) * 1000.0)

                raw_output = interpreter.get_tensor(output_detail["index"])
                if args.tracking_crop:
                    keypoints = decode_cropped_keypoints(
                        raw_output,
                        output_detail,
                        transform,
                        np,
                    )
                    crop_region = determine_next_crop_region(
                        keypoints,
                        source_height,
                        source_width,
                        args.score_threshold,
                    )
                else:
                    keypoints = decode_keypoints(raw_output, output_detail, transform, np)
                timestamp_ms = frame_index / source_fps * 1000.0
                record = keypoint_record(
                    frame_index,
                    timestamp_ms,
                    keypoints,
                    args.score_threshold,
                )
                keypoint_file.write(json.dumps(record, ensure_ascii=False) + "\n")

                if record["torso_detected"]:
                    torso_detected_frames += 1
                if writer is not None:
                    skeleton = render_skeleton(
                        keypoints,
                        source_height,
                        source_width,
                        args.score_threshold,
                        cv2,
                        np,
                    )
                    writer.write(skeleton)

                processed_frames += 1
                if args.max_frames is not None and processed_frames >= args.max_frames:
                    break
    finally:
        capture.release()
        if writer is not None:
            writer.release()

    elapsed_seconds = time.perf_counter() - started
    coverage = torso_detected_frames / processed_frames if processed_frames else 0.0
    summary = {
        "experiment": "litert-movenet-feasibility",
        "status": "measured" if processed_frames else "no_frames_processed",
        "privacy_boundary": {
            "raw_frames_written": False,
            "raw_frames_uploaded": False,
            "derived_outputs": [
                "keypoints.jsonl",
                *([] if args.no_video else ["skeleton.mp4"]),
            ],
        },
        "model": {
            "path": str(model_path),
            "input_shape": list(input_shape),
            "input_dtype": str(np.dtype(input_detail["dtype"])),
            "output_shape": [int(value) for value in output_detail["shape"]],
            "output_dtype": str(np.dtype(output_detail["dtype"])),
            "num_threads": args.num_threads,
            "warmup_runs": args.warmup_runs,
        },
        "video": {
            "path": str(video_path),
            "width": source_width,
            "height": source_height,
            "fps": round(source_fps, 3),
            "reported_frame_count": source_frame_count,
            "reported_duration_seconds": round(source_frame_count / source_fps, 3)
            if source_frame_count > 0
            else None,
        },
        "sampling": {
            "sample_every": args.sample_every,
            "max_frames": args.max_frames,
            "score_threshold": args.score_threshold,
            "preprocessing": "tracking_crop" if args.tracking_crop else "full_frame_letterbox",
        },
        "measurements": {
            "decoded_frames": decoded_frames,
            "processed_frames": processed_frames,
            "torso_detected_frames": torso_detected_frames,
            "detection_coverage": round(coverage, 6),
            "coverage_definition": (
                "At least one shoulder and at least one hip score meet the threshold"
            ),
            "inference_ms_mean": round(float(np.mean(inference_times_ms)), 3)
            if inference_times_ms
            else None,
            "inference_ms_p50": percentile(inference_times_ms, 50, np),
            "inference_ms_p95": percentile(inference_times_ms, 95, np),
            "inference_ms_max": round(max(inference_times_ms), 3)
            if inference_times_ms
            else None,
            "elapsed_seconds": round(elapsed_seconds, 3),
            "end_to_end_fps": round(processed_frames / elapsed_seconds, 3)
            if elapsed_seconds > 0
            else None,
            "peak_rss_mb": peak_rss_mb(),
        },
        "outputs": {
            "keypoints_jsonl": str(keypoints_path),
            "skeleton_video": None if args.no_video else str(skeleton_path),
        },
        "interpretation_warning": (
            "These measurements evaluate pose extraction only; they are not posture or "
            "fall-detection accuracy."
        ),
    }

    summary_path = output_dir / "summary.json"
    summary_path.write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return summary


def main() -> int:
    try:
        summary = run(parse_args())
    except (OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
