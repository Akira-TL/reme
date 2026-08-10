"""Load the versioned P0 fixture, generate/cache summaries, and publish to Relay."""

from __future__ import annotations

import argparse
import os
from collections.abc import Sequence
from pathlib import Path

from reme.runtime.history.projection import DEFAULT_FIXTURE_PATH, load_projected_demo_fixture
from reme.runtime.history.relay import HistoryRelayError, HistoryRelayPublisher
from reme.runtime.history.summary import DEFAULT_CACHE_PATH, DiarySummaryService


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--relay-url",
        default=os.environ.get("REME_HISTORY_RELAY_ENDPOINT", ""),
        help="Relay base URL, e.g. https://relay.example.com/",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("REME_HISTORY_RELAY_TOKEN", ""),
        help="server-to-server Runtime ingest token",
    )
    parser.add_argument("--fixture", type=Path, default=DEFAULT_FIXTURE_PATH)
    parser.add_argument("--summary-cache", type=Path, default=DEFAULT_CACHE_PATH)
    parser.add_argument(
        "--skip-summaries",
        action="store_true",
        help="publish timeline snapshots only; summary endpoint stays unchanged",
    )
    parser.add_argument(
        "--retry-summaries",
        action="store_true",
        help="explicitly retry the same timeline input with a new summary revision",
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if not args.relay_url or not args.token:
        print("error: --relay-url and --token are required")
        return 2

    fixture = load_projected_demo_fixture(args.fixture)
    publisher = HistoryRelayPublisher(relay_url=args.relay_url, token=args.token)
    summary_service = DiarySummaryService.from_environment(cache_path=args.summary_cache)

    try:
        for date_key in sorted(fixture.day_states):
            day = fixture.day_states[date_key]
            publisher.publish_day(day)
            print(f"history day published: {date_key} revision={day['revision']}")
            if args.skip_summaries:
                continue
            summary = summary_service.generate(day, force_retry=args.retry_summaries)
            publisher.publish_summary(summary)
            print(
                "history summary published: "
                f"{date_key} revision={summary['revision']} status={summary['status']}"
            )
    except HistoryRelayError as exc:
        print(f"error: {exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
