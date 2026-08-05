"""Command-line demonstration for the motion-data care pipeline."""

from __future__ import annotations

import argparse
import json
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from reme.care import CheckInResponse, run_care_sequence
from reme.motion import MotionObservation
from reme.motion_io import load_motion_jsonl

STARTED_AT = datetime(2026, 8, 1, 0, 30, tzinfo=UTC)
SCENARIOS = (
    "normal",
    "fall-awaiting",
    "fall-safe",
    "fall-no-response",
    "low-visibility",
)


def _normal_sequence() -> list[MotionObservation]:
    return [
        MotionObservation(0, 8.0, 0.42, 0.96),
        MotionObservation(500, 12.0, 0.43, 0.95),
        MotionObservation(1000, 10.0, 0.42, 0.97),
    ]


def _fall_sequence(*, visibility: float = 0.95) -> list[MotionObservation]:
    return [
        MotionObservation(0, 9.0, 0.36, visibility),
        MotionObservation(600, 31.0, 0.48, visibility),
        MotionObservation(1200, 78.0, 0.72, visibility),
    ]


def _scenario_data(
    scenario: str,
) -> tuple[list[MotionObservation], CheckInResponse]:
    if scenario == "normal":
        return _normal_sequence(), CheckInResponse.UNKNOWN
    if scenario == "fall-awaiting":
        return _fall_sequence(), CheckInResponse.UNKNOWN
    if scenario == "fall-safe":
        return _fall_sequence(), CheckInResponse.SAFE
    if scenario == "fall-no-response":
        return _fall_sequence(), CheckInResponse.NO_RESPONSE
    if scenario == "low-visibility":
        return _fall_sequence(visibility=0.30), CheckInResponse.UNKNOWN
    raise ValueError(f"unknown scenario: {scenario}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run Reme over derived JSONL motion data or a deterministic scenario."
    )
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--input", type=Path, help="JSONL motion-data file")
    source.add_argument("--scenario", choices=SCENARIOS, default="fall-no-response")
    parser.add_argument(
        "--response",
        choices=tuple(response.value for response in CheckInResponse),
        help="Override the check-in response for an input file or scenario.",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.input is not None:
        observations = load_motion_jsonl(args.input)
        inferred_response = CheckInResponse.UNKNOWN
        adapter_name = f"jsonl:{args.input.name}"
    else:
        observations, inferred_response = _scenario_data(args.scenario)
        adapter_name = f"synthetic:{args.scenario}"

    response = (
        CheckInResponse(args.response) if args.response is not None else inferred_response
    )
    result = run_care_sequence(
        observations,
        started_at=STARTED_AT,
        check_in_response=response,
        adapter_name=adapter_name,
    )
    print(json.dumps(result.to_payload(), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def entrypoint() -> int:
    """Compatibility callable retained for direct Python imports."""

    return main()


if __name__ == "__main__":
    raise SystemExit(main())
