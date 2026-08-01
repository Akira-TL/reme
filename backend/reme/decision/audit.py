"""Append-only JSONL audit trail for decision output (SAFE-09 / MIMO-12 core).

Every emitted CareDecision gets one line recording mode, latency, degradation
and what (if anything) was sent to MiMo — the measured facts D cites on stage.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path

from reme.decision.contracts import CareDecision
from reme.decision.mimo_client import MiMoCallResult


class AuditLogger:
    """Append-only JSONL writer; one line per emitted decision."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def log_decision(self, decision: CareDecision, call: MiMoCallResult | None) -> None:
        entry = {
            "ts": datetime.now(tz=UTC).isoformat(timespec="milliseconds"),
            "scene_id": decision.scene_id,
            "decision_id": decision.decision_id,
            "timestamp_ms": decision.timestamp_ms,
            "state": decision.state,
            "action": decision.action,
            "risk_level": decision.risk_level,
            "source": decision.source,
            "demo_mode": decision.demo_mode,
            "fallback_used": decision.fallback_used,
            "mimo_latency_ms": round(call.latency_ms, 1) if call else None,
            "mimo_attempts": call.attempts if call else None,
            "visual_sent": bool(
                decision.visual_context and decision.visual_context.sent_to_mimo
            ),
            "reason_summary": decision.reason_summary,
        }
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def read_entries(self) -> list[dict[str, object]]:
        if not self._path.exists():
            return []
        entries: list[dict[str, object]] = []
        for line in self._path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                loaded = json.loads(line)
                if isinstance(loaded, dict):
                    entries.append(loaded)
        return entries
