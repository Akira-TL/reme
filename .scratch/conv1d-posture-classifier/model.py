#!/usr/bin/env python3
"""Paper-inspired MoveNet17 + Conv1D classifier.

This is an independent reproduction of the public method description from
Hsu et al. (2026), not the authors' official implementation.
"""

from __future__ import annotations

from dataclasses import dataclass

try:
    import torch
    import torch.nn.functional as F
    from torch import Tensor, nn
except ImportError as exc:  # pragma: no cover - dependency guard
    raise SystemExit(
        "PyTorch is required. Install the dependencies from requirements.txt."
    ) from exc


@dataclass(frozen=True)
class ModelConfig:
    num_keypoints: int = 17
    keypoint_channels: int = 3
    hidden_channels: int = 128
    embedding_dim: int = 64
    dropout: float = 0.2


class ResidualConv1DBlock(nn.Module):
    def __init__(self, channels: int, dropout: float) -> None:
        super().__init__()
        self.net = nn.Sequential(
            nn.Conv1d(channels, channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm1d(channels),
            nn.ReLU(inplace=True),
            nn.Dropout(dropout),
            nn.Conv1d(channels, channels, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm1d(channels),
        )

    def forward(self, inputs: Tensor) -> Tensor:
        return F.relu(inputs + self.net(inputs), inplace=True)


class MoveNetConv1DClassifier(nn.Module):
    """Classify fixed-length MoveNet sequences and expose metric embeddings.

    Expected input shape: ``[batch, time, 17, 3]`` where the final dimension is
    normalized ``x``, normalized ``y``, and confidence score.
    """

    def __init__(self, num_classes: int, config: ModelConfig | None = None) -> None:
        super().__init__()
        if num_classes < 2:
            raise ValueError("num_classes must be at least 2")

        self.config = config or ModelConfig()
        input_channels = self.config.num_keypoints * self.config.keypoint_channels
        hidden = self.config.hidden_channels

        self.encoder = nn.Sequential(
            nn.Conv1d(input_channels, 64, kernel_size=5, padding=2, bias=False),
            nn.BatchNorm1d(64),
            nn.ReLU(inplace=True),
            nn.Conv1d(64, hidden, kernel_size=3, padding=1, bias=False),
            nn.BatchNorm1d(hidden),
            nn.ReLU(inplace=True),
            nn.MaxPool1d(kernel_size=2),
            ResidualConv1DBlock(hidden, self.config.dropout),
            nn.AdaptiveAvgPool1d(1),
        )
        self.embedding_head = nn.Sequential(
            nn.Flatten(),
            nn.Linear(hidden, self.config.embedding_dim),
        )
        self.classifier = nn.Linear(self.config.embedding_dim, num_classes)

    def forward(self, inputs: Tensor) -> tuple[Tensor, Tensor]:
        expected_tail = (
            self.config.num_keypoints,
            self.config.keypoint_channels,
        )
        if inputs.ndim != 4 or tuple(inputs.shape[-2:]) != expected_tail:
            raise ValueError(
                "Expected input [batch, time, "
                f"{expected_tail[0]}, {expected_tail[1]}], got {tuple(inputs.shape)}"
            )

        batch, time, keypoints, channels = inputs.shape
        sequence = inputs.reshape(batch, time, keypoints * channels).transpose(1, 2)
        encoded = self.encoder(sequence)
        embedding = F.normalize(self.embedding_head(encoded), p=2, dim=1)
        logits = self.classifier(embedding)
        return logits, embedding


class TripletCenterLoss(nn.Module):
    """Triplet-Center Loss with one learnable center per class."""

    def __init__(self, num_classes: int, embedding_dim: int, margin: float = 0.3) -> None:
        super().__init__()
        if num_classes < 2:
            raise ValueError("num_classes must be at least 2")
        if embedding_dim < 1:
            raise ValueError("embedding_dim must be positive")
        if margin <= 0:
            raise ValueError("margin must be positive")

        self.num_classes = num_classes
        self.embedding_dim = embedding_dim
        self.margin = margin
        self.centers = nn.Parameter(torch.empty(num_classes, embedding_dim))
        nn.init.xavier_uniform_(self.centers)

    def forward(self, embeddings: Tensor, labels: Tensor) -> Tensor:
        if embeddings.ndim != 2 or embeddings.shape[1] != self.embedding_dim:
            raise ValueError(
                f"Expected embeddings [batch, {self.embedding_dim}], "
                f"got {tuple(embeddings.shape)}"
            )
        if labels.ndim != 1 or labels.shape[0] != embeddings.shape[0]:
            raise ValueError("labels must be a one-dimensional tensor matching batch size")
        if labels.numel() == 0:
            return embeddings.sum() * 0.0
        if int(labels.min()) < 0 or int(labels.max()) >= self.num_classes:
            raise ValueError("labels contain an out-of-range class index")

        normalized_centers = F.normalize(self.centers, p=2, dim=1)
        distances = torch.cdist(embeddings, normalized_centers, p=2).pow(2)
        positive = distances.gather(1, labels[:, None]).squeeze(1)

        negative_mask = F.one_hot(labels, num_classes=self.num_classes).bool()
        negative = distances.masked_fill(negative_mask, torch.inf).min(dim=1).values
        return F.relu(positive + self.margin - negative).mean()


class ClassificationObjective(nn.Module):
    def __init__(
        self,
        num_classes: int,
        embedding_dim: int,
        center_weight: float = 0.1,
        margin: float = 0.3,
    ) -> None:
        super().__init__()
        if center_weight < 0:
            raise ValueError("center_weight cannot be negative")
        self.center_weight = center_weight
        self.center_loss = TripletCenterLoss(num_classes, embedding_dim, margin)

    def forward(
        self,
        logits: Tensor,
        embeddings: Tensor,
        labels: Tensor,
    ) -> tuple[Tensor, dict[str, Tensor]]:
        classification = F.cross_entropy(logits, labels)
        metric = self.center_loss(embeddings, labels)
        total = classification + self.center_weight * metric
        return total, {
            "loss": total.detach(),
            "cross_entropy": classification.detach(),
            "triplet_center": metric.detach(),
        }
