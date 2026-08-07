#!/usr/bin/env python3
"""Offline MoveNet 2D -> MotionBERT 3D inference for the Reme demo.

This prototype imports the official MotionBERT DSTFormer implementation from a
local clone and strictly maps an OpenMMLab MotionBERT checkpoint to it. It does
not process raw frames; it consumes the previously derived MoveNet JSONL.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from functools import partial
from pathlib import Path
from typing import Any

import numpy as np

H36M_NAMES = (
    "pelvis",
    "right_hip",
    "right_knee",
    "right_ankle",
    "left_hip",
    "left_knee",
    "left_ankle",
    "spine",
    "thorax",
    "nose",
    "head",
    "left_shoulder",
    "left_elbow",
    "left_wrist",
    "right_shoulder",
    "right_elbow",
    "right_wrist",
)

H36M_EDGES = (
    (0, 1),
    (1, 2),
    (2, 3),
    (0, 4),
    (4, 5),
    (5, 6),
    (0, 7),
    (7, 8),
    (8, 9),
    (9, 10),
    (8, 11),
    (11, 12),
    (12, 13),
    (8, 14),
    (14, 15),
    (15, 16),
)

LEFT_JOINTS = (4, 5, 6, 11, 12, 13)
RIGHT_JOINTS = (1, 2, 3, 14, 15, 16)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lift Reme MoveNet JSONL into an offline MotionBERT 3D sequence."
    )
    parser.add_argument("--keypoints", type=Path, required=True)
    parser.add_argument("--motionbert-repo", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--video-name", default="148703662.mp4")
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--window", type=int, default=243)
    parser.add_argument("--stride", type=int, default=81)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--score-threshold", type=float, default=0.05)
    parser.add_argument("--smooth-radius", type=int, default=2)
    parser.add_argument("--no-flip", action="store_true")
    parser.add_argument("--no-amp", action="store_true")
    args = parser.parse_args()

    if args.width < 1 or args.height < 1:
        parser.error("video dimensions must be positive")
    if args.fps <= 0:
        parser.error("--fps must be positive")
    if args.window < 1 or args.stride < 1 or args.batch_size < 1:
        parser.error("window, stride, and batch size must be positive")
    if args.stride > args.window:
        parser.error("--stride cannot be larger than --window")
    if args.smooth_radius < 0:
        parser.error("--smooth-radius cannot be negative")
    return args


def weighted_midpoint(
    first: np.ndarray,
    second: np.ndarray,
) -> np.ndarray:
    result = (first + second) * 0.5
    result[2] = min(float(first[2]), float(second[2]))
    return result


def read_movenet_jsonl(path: Path, width: int, height: int) -> tuple[np.ndarray, list[int]]:
    frames: list[np.ndarray] = []
    frame_indices: list[int] = []

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            record = json.loads(line)
            points_by_name = {point["name"]: point for point in record["keypoints"]}
            required = {
                "nose",
                "left_eye",
                "right_eye",
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
            }
            missing = sorted(required - points_by_name.keys())
            if missing:
                raise ValueError(f"line {line_number} is missing joints: {missing}")

            def point(
                name: str,
                points: dict[str, Any] = points_by_name,
            ) -> np.ndarray:
                item = points[name]
                return np.array(
                    [
                        float(item["x_norm"]) * width,
                        float(item["y_norm"]) * height,
                        float(item["score"]),
                    ],
                    dtype=np.float32,
                )

            nose = point("nose")
            left_eye = point("left_eye")
            right_eye = point("right_eye")
            left_shoulder = point("left_shoulder")
            right_shoulder = point("right_shoulder")
            left_hip = point("left_hip")
            right_hip = point("right_hip")
            pelvis = weighted_midpoint(left_hip, right_hip)
            thorax = weighted_midpoint(left_shoulder, right_shoulder)
            spine = weighted_midpoint(pelvis, thorax)
            head = weighted_midpoint(left_eye, right_eye)

            # This is the same COCO -> H36M ordering used by MMPose.
            h36m = np.stack(
                [
                    pelvis,
                    right_hip,
                    point("right_knee"),
                    point("right_ankle"),
                    left_hip,
                    point("left_knee"),
                    point("left_ankle"),
                    spine,
                    thorax,
                    nose,
                    head,
                    left_shoulder,
                    point("left_elbow"),
                    point("left_wrist"),
                    right_shoulder,
                    point("right_elbow"),
                    point("right_wrist"),
                ]
            )
            frames.append(h36m)
            frame_indices.append(int(record.get("frame_index", len(frame_indices))))

    if not frames:
        raise ValueError(f"no keypoint records found in {path}")
    return np.stack(frames).astype(np.float32), frame_indices


def normalize_motion(motion: np.ndarray, score_threshold: float) -> np.ndarray:
    """Match the official MotionBERT wild-video crop_scale normalization."""
    result = motion.copy()
    visible = motion[..., 2] >= score_threshold
    coords = motion[..., :2][visible]
    if len(coords) < 4:
        raise ValueError("not enough visible 2D coordinates to normalize the sequence")

    xmin, ymin = coords.min(axis=0)
    xmax, ymax = coords.max(axis=0)
    scale = float(max(xmax - xmin, ymax - ymin))
    if scale <= 0:
        raise ValueError("2D keypoint extent is zero")

    xs = (float(xmin) + float(xmax) - scale) / 2.0
    ys = (float(ymin) + float(ymax) - scale) / 2.0
    result[..., :2] = (motion[..., :2] - np.array([xs, ys], dtype=np.float32)) / scale
    result[..., :2] = (result[..., :2] - 0.5) * 2.0
    result[..., :2] = np.clip(result[..., :2], -1.0, 1.0)
    result[..., 2] = np.clip(result[..., 2], 0.0, 1.0)
    return result.astype(np.float32)


def map_openmmlab_checkpoint(state_dict: dict[str, Any]) -> dict[str, Any]:
    mapped: dict[str, Any] = {}
    for key, value in state_dict.items():
        if key.startswith("backbone."):
            new_key = key[len("backbone.") :]
            new_key = new_key.replace("spat_embed", "pos_embed")
            new_key = new_key.replace("attn_regress", "ts_attn")
            new_key = new_key.replace(".mlp_s.0.", ".mlp_s.fc1.")
            new_key = new_key.replace(".mlp_s.2.", ".mlp_s.fc2.")
            new_key = new_key.replace(".mlp_t.0.", ".mlp_t.fc1.")
            new_key = new_key.replace(".mlp_t.2.", ".mlp_t.fc2.")
        elif key.startswith("head.pre_logits."):
            new_key = key[len("head.") :]
        elif key.startswith("head.fc."):
            new_key = "head." + key[len("head.fc.") :]
        else:
            raise ValueError(f"unhandled checkpoint tensor: {key}")
        mapped[new_key] = value
    return mapped


def load_model(repo: Path, checkpoint: Path, device_name: str) -> tuple[Any, Any, str]:
    repo = repo.expanduser().resolve()
    checkpoint = checkpoint.expanduser().resolve()
    if not (repo / "lib/model/DSTformer.py").is_file():
        raise SystemExit(f"MotionBERT repository not found or incomplete: {repo}")
    if not checkpoint.is_file():
        raise SystemExit(f"checkpoint not found: {checkpoint}")

    sys.path.insert(0, str(repo))
    import torch
    import torch.nn as nn
    from lib.model.DSTformer import DSTformer

    if device_name.startswith("cuda") and not torch.cuda.is_available():
        raise SystemExit("CUDA was requested but torch.cuda.is_available() is false")
    device = torch.device(device_name)

    model = DSTformer(
        dim_in=3,
        dim_out=3,
        dim_feat=512,
        dim_rep=512,
        depth=5,
        num_heads=8,
        mlp_ratio=2,
        num_joints=17,
        maxlen=243,
        norm_layer=partial(nn.LayerNorm, eps=1e-6),
        att_fuse=True,
    )
    checkpoint_object = torch.load(checkpoint, map_location="cpu", weights_only=False)
    if "state_dict" not in checkpoint_object:
        raise ValueError("expected an OpenMMLab checkpoint containing state_dict")
    mapped = map_openmmlab_checkpoint(checkpoint_object["state_dict"])

    model_state = model.state_dict()
    missing = sorted(set(model_state) - set(mapped))
    unexpected = sorted(set(mapped) - set(model_state))
    shape_mismatch = [
        key
        for key in set(model_state) & set(mapped)
        if model_state[key].shape != mapped[key].shape
    ]
    if missing or unexpected or shape_mismatch:
        raise ValueError(
            "checkpoint mapping is not strict: "
            f"missing={missing}, unexpected={unexpected}, shape_mismatch={shape_mismatch}"
        )
    model.load_state_dict(mapped, strict=True)
    model.eval().to(device)
    return torch, model, str(device)


def flip_tensor(tensor: Any) -> Any:
    flipped = tensor.clone()
    flipped[..., 0] *= -1
    order = list(LEFT_JOINTS + RIGHT_JOINTS)
    source = list(RIGHT_JOINTS + LEFT_JOINTS)
    flipped[..., order, :] = flipped[..., source, :]
    return flipped


def window_starts(frame_count: int, window: int, stride: int) -> list[int]:
    if frame_count <= window:
        return [0]
    starts = list(range(0, frame_count - window + 1, stride))
    last = frame_count - window
    if starts[-1] != last:
        starts.append(last)
    return starts


def make_window(motion: np.ndarray, start: int, window: int) -> tuple[np.ndarray, int]:
    segment = motion[start : start + window]
    valid_length = len(segment)
    if valid_length < window:
        padding = np.repeat(segment[-1:], window - valid_length, axis=0)
        segment = np.concatenate([segment, padding], axis=0)
    return segment, valid_length


def infer_sequence(
    torch: Any,
    model: Any,
    motion: np.ndarray,
    *,
    device: str,
    window: int,
    stride: int,
    batch_size: int,
    flip_test: bool,
    use_amp: bool,
) -> tuple[np.ndarray, dict[str, Any]]:
    starts = window_starts(len(motion), window, stride)
    blend = 0.1 + 0.9 * np.sin(np.linspace(0.0, np.pi, window, dtype=np.float32)) ** 2
    accumulated = np.zeros((len(motion), 17, 3), dtype=np.float64)
    weights = np.zeros((len(motion), 1, 1), dtype=np.float64)

    if device.startswith("cuda"):
        torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()

    for batch_start in range(0, len(starts), batch_size):
        batch_starts = starts[batch_start : batch_start + batch_size]
        windows: list[np.ndarray] = []
        valid_lengths: list[int] = []
        for start in batch_starts:
            segment, valid_length = make_window(motion, start, window)
            windows.append(segment)
            valid_lengths.append(valid_length)

        tensor = torch.from_numpy(np.stack(windows)).to(device)
        amp_enabled = use_amp and device.startswith("cuda")
        with (
            torch.inference_mode(),
            torch.autocast(
                device_type="cuda",
                dtype=torch.float16,
                enabled=amp_enabled,
            ),
        ):
            prediction = model(tensor)
            if flip_test:
                flipped_prediction = model(flip_tensor(tensor))
                prediction = (prediction + flip_tensor(flipped_prediction)) * 0.5
            prediction[:, :, 0, :] = 0
        prediction_np = prediction.float().cpu().numpy()

        for local_index, start in enumerate(batch_starts):
            valid_length = valid_lengths[local_index]
            end = start + valid_length
            local_weight = blend[:valid_length, None, None]
            accumulated[start:end] += prediction_np[local_index, :valid_length] * local_weight
            weights[start:end] += local_weight

    elapsed = time.perf_counter() - started
    if np.any(weights == 0):
        raise RuntimeError("sliding-window blending left uncovered frames")
    output = (accumulated / weights).astype(np.float32)
    metrics: dict[str, Any] = {
        "window_count": len(starts),
        "window": window,
        "stride": stride,
        "batch_size": batch_size,
        "flip_test": flip_test,
        "amp": use_amp and device.startswith("cuda"),
        "elapsed_seconds": round(elapsed, 3),
        "effective_output_fps": round(len(output) / elapsed, 3) if elapsed else None,
    }
    if device.startswith("cuda"):
        metrics["peak_cuda_memory_mb"] = round(
            torch.cuda.max_memory_allocated() / 1024 / 1024, 3
        )
    return output, metrics


def smooth_sequence(sequence: np.ndarray, radius: int) -> np.ndarray:
    if radius <= 0:
        return sequence
    ascending = np.arange(1, radius + 2, dtype=np.float32)
    kernel = np.concatenate([ascending, ascending[-2::-1]])
    kernel /= kernel.sum()
    padded = np.pad(sequence, ((radius, radius), (0, 0), (0, 0)), mode="edge")
    smoothed = np.zeros_like(sequence)
    for offset, weight in enumerate(kernel):
        smoothed += padded[offset : offset + len(sequence)] * weight
    return smoothed


def to_web_coordinates(prediction: np.ndarray) -> tuple[np.ndarray, float]:
    # MotionBERT uses image-style Y. Three.js uses Y-up.
    scene = np.stack(
        [-prediction[..., 0], -prediction[..., 1], prediction[..., 2]], axis=-1
    )
    scene[..., 1] -= scene[..., 1].min(axis=1, keepdims=True)

    heights = np.ptp(scene[..., 1], axis=1)
    valid_heights = heights[heights > 1e-6]
    median_height = float(np.median(valid_heights)) if len(valid_heights) else 1.0
    display_scale = 1.7 / median_height
    scene *= display_scale
    return scene.astype(np.float32), display_scale


def write_outputs(
    output_path: Path,
    *,
    scene: np.ndarray,
    raw_prediction: np.ndarray,
    input_motion: np.ndarray,
    frame_indices: list[int],
    args: argparse.Namespace,
    metrics: dict[str, Any],
    display_scale: float,
    torch_version: str,
    device: str,
) -> None:
    output_path = output_path.expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    rounded_scene = np.round(scene, 5)
    rounded_scores = np.round(input_motion[..., 2], 4)
    payload = {
        "schema": "motionbert-h36m-17/offline-demo-v1",
        "model": {
            "name": "MotionBERT DSTFormer",
            "checkpoint": args.checkpoint.name,
            "representation": "monocular root-relative 3D pose estimate",
            "joint_count": 17,
            "window": args.window,
            "stride": args.stride,
            "flip_test": not args.no_flip,
        },
        "video": {
            "name": args.video_name,
            "width": args.width,
            "height": args.height,
            "fps": args.fps,
            "frame_count": int(len(scene)),
            "duration_seconds": round(len(scene) / args.fps, 3),
            "source_frame_indices": frame_indices,
        },
        "coordinate_system": {
            "x": "viewer right",
            "y": "viewer up",
            "z": "estimated depth",
            "root_relative": True,
            "absolute_room_position": False,
            "display_height_normalized": True,
            "display_scale": round(display_scale, 6),
        },
        "joint_names": list(H36M_NAMES),
        "edges": [list(edge) for edge in H36M_EDGES],
        "frames": rounded_scene.tolist(),
        "scores": rounded_scores.tolist(),
        "runtime": {
            "device": device,
            "torch": torch_version,
            **metrics,
        },
        "warning": (
            "Single-camera root-relative 3D pose estimate for demonstration; "
            "not an absolute room coordinate or medical measurement."
        ),
    }
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    np.save(output_path.with_suffix(".raw.npy"), raw_prediction)
    summary = {
        "status": "measured",
        "output_json": str(output_path),
        "raw_npy": str(output_path.with_suffix(".raw.npy")),
        "frame_count": len(scene),
        "finite_output": bool(np.isfinite(scene).all()),
        "scene_bounds": {
            "min": np.round(scene.reshape(-1, 3).min(axis=0), 5).tolist(),
            "max": np.round(scene.reshape(-1, 3).max(axis=0), 5).tolist(),
        },
        "runtime": payload["runtime"],
        "capability_boundary": payload["warning"],
    }
    output_path.with_suffix(".summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    keypoints_path = args.keypoints.expanduser().resolve()
    if not keypoints_path.is_file():
        raise SystemExit(f"keypoint JSONL not found: {keypoints_path}")

    raw_motion, frame_indices = read_movenet_jsonl(
        keypoints_path, args.width, args.height
    )
    input_motion = normalize_motion(raw_motion, args.score_threshold)
    torch, model, device = load_model(
        args.motionbert_repo, args.checkpoint, args.device
    )
    prediction, metrics = infer_sequence(
        torch,
        model,
        input_motion,
        device=device,
        window=args.window,
        stride=args.stride,
        batch_size=args.batch_size,
        flip_test=not args.no_flip,
        use_amp=not args.no_amp,
    )
    prediction = smooth_sequence(prediction, args.smooth_radius)
    prediction[:, 0, :] = 0
    scene, display_scale = to_web_coordinates(prediction)
    write_outputs(
        args.output,
        scene=scene,
        raw_prediction=prediction,
        input_motion=input_motion,
        frame_indices=frame_indices,
        args=args,
        metrics=metrics,
        display_scale=display_scale,
        torch_version=torch.__version__,
        device=device,
    )
    summary_payload = json.loads(
        args.output.with_suffix(".summary.json").read_text(encoding="utf-8")
    )
    print(json.dumps(summary_payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
