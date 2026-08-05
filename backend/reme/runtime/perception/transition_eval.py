"""Generate deterministic transition candidates from recorded pose streams."""

from __future__ import annotations

import argparse
import json
from collections import Counter
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.transitions import TransitionDetector, TransitionError


class TransitionEvalError(ValueError):
    """Raised when an offline transition input or output is invalid."""


def generate_transition_candidates(
    *,
    keypoints_path: str | Path,
    output_path: str | Path,
    session_id: str,
    postures_path: str | Path | None = None,
    report_path: str | Path | None = None,
) -> dict[str, object]:
    """Run the deterministic detector and persist candidates without accuracy claims."""

    keypoints = _read_jsonl(Path(keypoints_path), stream_name="keypoints")
    postures = (
        _read_jsonl(Path(postures_path), stream_name="postures")
        if postures_path is not None
        else []
    )
    detector = TransitionDetector(session_id=session_id)
    events: list[dict[str, object]] = []
    posture_index = 0

    for frame_index, frame in enumerate(keypoints):
        frame_timestamp = _timestamp(frame, f"keypoints[{frame_index}]")
        while posture_index < len(postures):
            posture = postures[posture_index]
            posture_timestamp = _timestamp(posture, f"postures[{posture_index}]")
            if posture_timestamp > frame_timestamp:
                break
            detector.process_runtime_event(
                RuntimeEvent(
                    session_id=session_id,
                    sequence=posture_index,
                    event_type=RuntimeEventType.POSTURE_OBSERVATION,
                    payload=posture,
                )
            )
            posture_index += 1
        runtime_event = detector.process_runtime_event(
            RuntimeEvent(
                session_id=session_id,
                sequence=frame_index,
                event_type=RuntimeEventType.FRAME_LANDMARKS,
                payload=frame,
            )
        )
        if runtime_event is not None:
            events.append(dict(runtime_event.payload))

    destination = Path(output_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        "".join(
            json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n" for event in events
        ),
        encoding="utf-8",
    )
    counts = Counter(str(event["transition"]) for event in events)
    report: dict[str, object] = {
        "evaluation_status": "candidates_only_unlabelled",
        "keypoint_record_count": len(keypoints),
        "posture_record_count": len(postures),
        "candidate_event_count": len(events),
        "candidate_event_counts": dict(sorted(counts.items())),
        "error_intervals": [issue.to_payload() for issue in detector.issues],
        "accuracy_claims": "not_available_until_transition_annotations_are_complete",
    }
    if report_path is not None:
        report_destination = Path(report_path)
        report_destination.parent.mkdir(parents=True, exist_ok=True)
        report_destination.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return report


def _read_jsonl(path: Path, *, stream_name: str) -> list[dict[str, Any]]:
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError as exc:
        raise TransitionEvalError(f"cannot read {stream_name}: {exc}") from exc
    records: list[dict[str, Any]] = []
    for line_number, raw_line in enumerate(lines, start=1):
        if not raw_line.strip():
            continue
        try:
            value = json.loads(raw_line)
        except json.JSONDecodeError as exc:
            raise TransitionEvalError(
                f"invalid {stream_name} JSON on line {line_number}: {exc}"
            ) from exc
        if not isinstance(value, dict):
            raise TransitionEvalError(f"{stream_name} line {line_number} must be a JSON object")
        records.append(value)
    if not records:
        raise TransitionEvalError(f"{stream_name} JSONL must contain at least one record")
    return records


def _timestamp(payload: dict[str, Any], prefix: str) -> float:
    value = payload.get("timestamp_ms")
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise TransitionEvalError(f"{prefix}.timestamp_ms must be numeric")
    timestamp = float(value)
    if timestamp < 0:
        raise TransitionEvalError(f"{prefix}.timestamp_ms must be non-negative")
    return timestamp


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keypoints", type=Path, required=True)
    parser.add_argument("--postures", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--session-id", default="offline-transition-eval")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run offline candidate generation without reporting precision or recall."""

    args = _build_parser().parse_args(argv)
    try:
        report = generate_transition_candidates(
            keypoints_path=args.keypoints,
            postures_path=args.postures,
            output_path=args.output,
            report_path=args.report,
            session_id=args.session_id,
        )
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0
    except (TransitionEvalError, TransitionError) as exc:
        print(f"error: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
