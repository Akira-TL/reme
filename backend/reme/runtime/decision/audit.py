"""Append-only observability log for every decision-layer event.

This is B spec acceptance item 8: the log must show, per request, whether
visual content was sent, its sampling window, the latency, and which demo mode
produced the result. Wall-clock timestamps are fine here — this file is
operator observability, not scene data, and it lives under the git-ignored
``artifacts/`` directory by default.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path


class AuditLog:
    """Thread-safe JSONL writer for decision-layer observability events."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        *,
        kind: str,
        scene_id: str,
        mode: str,
        decision_id: str | None = None,
        latency_ms: float | None = None,
        mimo_attempts: int | None = None,
        visual_sent: bool = False,
        note: str | None = None,
    ) -> None:
        entry = {
            "wall_time": round(time.time(), 3),
            "kind": kind,
            "scene_id": scene_id,
            "mode": mode,
            "decision_id": decision_id,
            "latency_ms": None if latency_ms is None else round(latency_ms, 1),
            "mimo_attempts": mimo_attempts,
            "visual_sent": visual_sent,
            "note": note,
        }
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        try:
            with self._lock, self._path.open("a", encoding="utf-8") as stream:
                stream.write(line + "\n")
        except OSError as exc:
            # Observability must never block or fail a care decision.
            print(f"warning: audit write failed: {exc}")
