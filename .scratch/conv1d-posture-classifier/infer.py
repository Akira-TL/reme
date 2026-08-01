#!/usr/bin/env python3
"""Run a trained MoveNet17 + Conv1D checkpoint over keypoint JSONL."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

try:
    import numpy as np
    import torch
except ImportError as exc:  # pragma: no cover - dependency guard
    raise SystemExit(
        "NumPy and PyTorch are required. Install requirements.txt first."
    ) from exc

from dataset import normalize_frame, read_keypoint_jsonl
from model import ModelConfig, MoveNetConv1DClassifier


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Classify MoveNet17 pose windows")
    parser.add_argument("--keypoints", type=Path, required=True)
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--stride-frames", type=int, default=15)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--min-confidence", type=float, default=0.0)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    args = parser.parse_args()
    if args.stride_frames < 1 or args.batch_size < 1:
        parser.error("stride and batch size must be positive")
    if not 0.0 <= args.min_confidence <= 1.0:
        parser.error("--min-confidence must be between 0 and 1")
    return args


def resolve_device(requested: str) -> torch.device:
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("CUDA was requested but is unavailable")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def main() -> None:
    args = parse_args()
    device = resolve_device(args.device)
    checkpoint = torch.load(args.checkpoint, map_location="cpu", weights_only=False)
    labels = tuple(checkpoint["labels"])
    config = ModelConfig(**checkpoint["model_config"])
    window_frames = int(checkpoint["window_frames"])
    score_threshold = float(checkpoint["score_threshold"])

    model = MoveNetConv1DClassifier(len(labels), config)
    model.load_state_dict(checkpoint["model_state"])
    model.to(device).eval()

    records = read_keypoint_jsonl(args.keypoints)
    starts = list(range(0, len(records) - window_frames + 1, args.stride_frames))
    if not starts:
        raise SystemExit(
            f"Input has {len(records)} frames, fewer than checkpoint window {window_frames}"
        )

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as output:
        for batch_start in range(0, len(starts), args.batch_size):
            batch_indices = starts[batch_start : batch_start + args.batch_size]
            sequences = np.stack(
                [
                    np.stack(
                        [
                            normalize_frame(record, score_threshold)
                            for record in records[start : start + window_frames]
                        ],
                        axis=0,
                    )
                    for start in batch_indices
                ],
                axis=0,
            )
            with torch.inference_mode():
                logits, _ = model(
                    torch.from_numpy(sequences).to(device=device, dtype=torch.float32)
                )
                probabilities = logits.softmax(dim=1).cpu().numpy()

            for start, class_probabilities in zip(batch_indices, probabilities, strict=True):
                class_index = int(class_probabilities.argmax())
                confidence = float(class_probabilities[class_index])
                predicted_label = labels[class_index]
                abstained = confidence < args.min_confidence
                if abstained:
                    predicted_label = "unknown"
                end = start + window_frames
                center = start + window_frames // 2
                record = {
                    "schema": "reme-pose-conv1d/v0-experiment",
                    "start_frame": int(records[start]["frame_index"]),
                    "end_frame": int(records[end - 1]["frame_index"]),
                    "start_timestamp_ms": float(records[start]["timestamp_ms"]),
                    "end_timestamp_ms": float(records[end - 1]["timestamp_ms"]),
                    "center_timestamp_ms": float(records[center]["timestamp_ms"]),
                    "label": predicted_label,
                    "confidence": round(confidence, 6),
                    "abstained": abstained,
                    "probabilities": {
                        label: round(float(probability), 6)
                        for label, probability in zip(labels, class_probabilities, strict=True)
                    },
                }
                output.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(
        json.dumps(
            {
                "device": str(device),
                "windows": len(starts),
                "output": str(args.output),
                "method_boundary": checkpoint.get("method_boundary"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
