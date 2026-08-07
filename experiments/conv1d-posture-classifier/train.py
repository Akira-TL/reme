#!/usr/bin/env python3
"""Train the paper-inspired MoveNet17 + Conv1D posture classifier."""

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path
from typing import Any

try:
    import numpy as np
    import torch
    from torch import Tensor
    from torch.utils.data import DataLoader
except ImportError as exc:  # pragma: no cover - dependency guard
    raise SystemExit(
        "NumPy and PyTorch are required. Install requirements.txt first."
    ) from exc

from dataset import (
    PoseSequenceDataset,
    build_windows,
    label_names,
    read_annotations,
    read_keypoint_jsonl,
)
from model import ClassificationObjective, ModelConfig, MoveNetConv1DClassifier


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Train a MoveNet17 sequence classifier using Conv1D and "
            "Triplet-Center Loss."
        )
    )
    parser.add_argument("--keypoints", type=Path, help="MoveNet keypoints.jsonl")
    parser.add_argument("--annotations", type=Path, help="Segment annotation CSV")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/conv1d-posture"))
    parser.add_argument("--window-frames", type=int, default=60)
    parser.add_argument("--stride-frames", type=int, default=15)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--hidden-channels", type=int, default=128)
    parser.add_argument("--embedding-dim", type=int, default=64)
    parser.add_argument("--dropout", type=float, default=0.2)
    parser.add_argument("--center-weight", type=float, default=0.1)
    parser.add_argument("--center-margin", type=float, default=0.3)
    parser.add_argument("--epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=1e-4)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--device", default="auto", choices=("auto", "cpu", "cuda"))
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Run one synthetic forward/backward step without reading project data",
    )
    args = parser.parse_args()

    if not args.dry_run and (args.keypoints is None or args.annotations is None):
        parser.error("--keypoints and --annotations are required unless --dry-run is used")
    if args.window_frames < 2 or args.stride_frames < 1:
        parser.error("window and stride frame counts must be positive")
    if not 0.0 <= args.score_threshold <= 1.0:
        parser.error("--score-threshold must be between 0 and 1")
    if args.epochs < 1 or args.batch_size < 1:
        parser.error("--epochs and --batch-size must be positive")
    return args


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def resolve_device(requested: str) -> torch.device:
    if requested == "cpu":
        return torch.device("cpu")
    if requested == "cuda":
        if not torch.cuda.is_available():
            raise SystemExit("CUDA was requested but torch.cuda.is_available() is false")
        return torch.device("cuda")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def batch_metrics(logits: Tensor, labels: Tensor, num_classes: int) -> dict[str, Any]:
    predictions = logits.argmax(dim=1)
    confusion = torch.zeros(
        (num_classes, num_classes), dtype=torch.long, device=logits.device
    )
    flat = labels * num_classes + predictions
    confusion += torch.bincount(flat, minlength=num_classes**2).reshape(
        num_classes, num_classes
    )
    return {
        "correct": int((predictions == labels).sum().item()),
        "count": int(labels.numel()),
        "confusion": confusion.cpu(),
    }


def summarize_confusion(confusion: Tensor) -> dict[str, float]:
    true_positive = confusion.diag().to(torch.float32)
    predicted = confusion.sum(dim=0).to(torch.float32)
    actual = confusion.sum(dim=1).to(torch.float32)
    precision = true_positive / predicted.clamp_min(1.0)
    recall = true_positive / actual.clamp_min(1.0)
    f1 = 2 * precision * recall / (precision + recall).clamp_min(1e-12)
    supported = actual > 0
    macro_f1 = float(f1[supported].mean().item()) if supported.any() else 0.0
    return {"macro_f1": macro_f1}


def run_epoch(
    model: MoveNetConv1DClassifier,
    objective: ClassificationObjective,
    loader: DataLoader[Any],
    device: torch.device,
    optimizer: torch.optim.Optimizer | None,
    num_classes: int,
) -> dict[str, Any]:
    training = optimizer is not None
    model.train(training)
    objective.train(training)

    total_loss = 0.0
    total_correct = 0
    total_count = 0
    confusion = torch.zeros((num_classes, num_classes), dtype=torch.long)

    for sequences, labels in loader:
        sequences = sequences.to(device=device, dtype=torch.float32)
        labels = labels.to(device=device)

        if optimizer is not None:
            optimizer.zero_grad(set_to_none=True)

        with torch.set_grad_enabled(training):
            logits, embeddings = model(sequences)
            loss, _ = objective(logits, embeddings, labels)
            if optimizer is not None:
                loss.backward()
                optimizer.step()

        metrics = batch_metrics(logits.detach(), labels, num_classes)
        batch_size = metrics["count"]
        total_loss += float(loss.detach().item()) * batch_size
        total_correct += metrics["correct"]
        total_count += batch_size
        confusion += metrics["confusion"]

    if total_count == 0:
        raise RuntimeError("Data loader produced no samples")
    summary = {
        "loss": total_loss / total_count,
        "accuracy": total_correct / total_count,
        "confusion_matrix": confusion.tolist(),
    }
    summary.update(summarize_confusion(confusion))
    return summary


def dry_run(args: argparse.Namespace, device: torch.device) -> None:
    labels = ("standing", "sitting", "lying", "bending_or_crouching", "unknown")
    config = ModelConfig(
        hidden_channels=args.hidden_channels,
        embedding_dim=args.embedding_dim,
        dropout=args.dropout,
    )
    model = MoveNetConv1DClassifier(len(labels), config).to(device)
    objective = ClassificationObjective(
        len(labels),
        config.embedding_dim,
        center_weight=args.center_weight,
        margin=args.center_margin,
    ).to(device)
    optimizer = torch.optim.AdamW(
        [*model.parameters(), *objective.parameters()],
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )
    sequences = torch.randn(8, args.window_frames, 17, 3, device=device)
    sequences[..., 2].sigmoid_()
    targets = torch.arange(8, device=device) % len(labels)

    logits, embeddings = model(sequences)
    loss, parts = objective(logits, embeddings, targets)
    optimizer.zero_grad(set_to_none=True)
    loss.backward()
    optimizer.step()
    print(
        json.dumps(
            {
                "device": str(device),
                "logits_shape": list(logits.shape),
                "embedding_shape": list(embeddings.shape),
                "losses": {name: float(value.item()) for name, value in parts.items()},
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def main() -> None:
    args = parse_args()
    seed_everything(args.seed)
    device = resolve_device(args.device)
    if args.dry_run:
        dry_run(args, device)
        return

    assert args.keypoints is not None
    assert args.annotations is not None
    records = read_keypoint_jsonl(args.keypoints)
    annotations = read_annotations(args.annotations)
    labels = label_names(annotations)
    windows = build_windows(
        records,
        annotations,
        window_frames=args.window_frames,
        stride_frames=args.stride_frames,
    )
    split_counts = Counter(window.split for window in windows)
    if split_counts["train"] == 0:
        raise SystemExit("No training windows were generated from the annotations")

    train_dataset = PoseSequenceDataset(
        records,
        windows,
        labels,
        split="train",
        score_threshold=args.score_threshold,
    )
    val_dataset = (
        PoseSequenceDataset(
            records,
            windows,
            labels,
            split="val",
            score_threshold=args.score_threshold,
        )
        if split_counts["val"]
        else None
    )
    train_loader = DataLoader(
        train_dataset,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=0,
    )
    val_loader = (
        DataLoader(val_dataset, batch_size=args.batch_size, shuffle=False, num_workers=0)
        if val_dataset is not None
        else None
    )

    config = ModelConfig(
        hidden_channels=args.hidden_channels,
        embedding_dim=args.embedding_dim,
        dropout=args.dropout,
    )
    model = MoveNetConv1DClassifier(len(labels), config).to(device)
    objective = ClassificationObjective(
        len(labels),
        config.embedding_dim,
        center_weight=args.center_weight,
        margin=args.center_margin,
    ).to(device)
    optimizer = torch.optim.AdamW(
        [*model.parameters(), *objective.parameters()],
        lr=args.learning_rate,
        weight_decay=args.weight_decay,
    )

    args.output_dir.mkdir(parents=True, exist_ok=True)
    history: list[dict[str, Any]] = []
    best_metric = float("-inf")
    for epoch in range(1, args.epochs + 1):
        train_metrics = run_epoch(
            model, objective, train_loader, device, optimizer, len(labels)
        )
        val_metrics = (
            run_epoch(model, objective, val_loader, device, None, len(labels))
            if val_loader is not None
            else None
        )
        record = {"epoch": epoch, "train": train_metrics, "val": val_metrics}
        history.append(record)
        print(json.dumps(record, ensure_ascii=False))

        selection_metric = (
            val_metrics["macro_f1"] if val_metrics is not None else train_metrics["macro_f1"]
        )
        if selection_metric > best_metric:
            best_metric = selection_metric
            torch.save(
                {
                    "model_state": model.state_dict(),
                    "objective_state": objective.state_dict(),
                    "labels": labels,
                    "model_config": config.__dict__,
                    "window_frames": args.window_frames,
                    "score_threshold": args.score_threshold,
                    "method_boundary": (
                        "Independent reproduction of MoveNet17 + Conv1D + "
                        "Triplet-Center Loss; not official author code."
                    ),
                },
                args.output_dir / "best.pt",
            )

    (args.output_dir / "history.json").write_text(
        json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (args.output_dir / "labels.json").write_text(
        json.dumps(labels, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "device": str(device),
                "labels": labels,
                "window_counts": dict(split_counts),
                "best_selection_macro_f1": best_metric,
                "checkpoint": str(args.output_dir / "best.pt"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
