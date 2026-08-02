"""Assemble the decision server's configuration from argv and environment."""

from __future__ import annotations

import argparse
import os
import time
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from reme.decision.guardrails import TriggerConfig
from reme.decision.home import (
    NIGHT_HOURS,
    HomeContext,
    HomeContextProvider,
    HomeScriptError,
    RoomLabel,
    ScriptedHomeProvider,
    StaticHomeProvider,
)
from reme.decision.memory import BehaviorMemoryStore
from reme.decision.mimo.adapter import MimoClient, config_from_environment
from reme.decision.mimo.prompts import PersonaConfig
from reme.decision.policy import (
    LiveMimoDecisionClient,
    MimoDecisionClient,
    MockMimoClient,
    PolicyConfig,
)
from reme.decision.records import DemoMode
from reme.decision.ws_client import WebSocketClientError, _split_ws_url

DEFAULT_PORT = 8100
DEFAULT_MOCK_SCRIPT_DIR = Path("examples/decision/mimo_mock")
DEFAULT_AUDIT_PATH = Path("artifacts/decision-audit.jsonl")


class ServerConfigError(ValueError):
    """Raised when the CLI arguments cannot form a runnable server."""


@dataclass(frozen=True, slots=True)
class ServerConfig:
    """Everything main() needs to bind, serve, and shut down."""

    # None = pure live_camera run: no prerecorded bundles at all.  Only the
    # record mode genuinely needs them (it replays captured decisions).
    scenes_dir: Path | None = None
    host: str = "127.0.0.1"
    port: int = DEFAULT_PORT
    static_dir: Path | None = None
    certfile: Path | None = None
    keyfile: Path | None = None
    demo_mode: DemoMode = DemoMode.LIVE
    mock_script_dir: Path = DEFAULT_MOCK_SCRIPT_DIR
    record_capture: bool = False
    audit_path: Path | None = DEFAULT_AUDIT_PATH
    elder_name: str = "王奶奶"
    family_relation: str = "家人"
    visual_enabled: bool = False
    cognition_enabled: bool = True
    home_script: Path | None = None
    home_room: str | None = None
    local_hour: int | None = None
    memory_file: Path | None = None
    # Set = pull mode: B subscribes to A's event stream itself.  Unset = push
    # mode: something else POSTs to /api/events (replays, fixtures).
    a_events_url: str | None = None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Reme B decision service (contract reme-care-decision/v0-experiment)"
    )
    parser.add_argument(
        "scenes_dir",
        type=Path,
        nargs="?",
        default=None,
        help="directory containing scene bundles; omit for a pure live_camera run",
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--static", type=Path, default=None, help="C's built static page dir")
    parser.add_argument("--cert", type=Path, default=None, help="TLS certificate (mkcert)")
    parser.add_argument("--key", type=Path, default=None, help="TLS private key (mkcert)")
    parser.add_argument(
        "--mode", choices=[mode.value for mode in DemoMode], default=DemoMode.LIVE.value
    )
    parser.add_argument("--mock-scripts", type=Path, default=DEFAULT_MOCK_SCRIPT_DIR)
    parser.add_argument(
        "--record-output",
        action="store_true",
        help="capture every emitted decision into each bundle's recorded_decisions.jsonl",
    )
    parser.add_argument("--audit", type=Path, default=DEFAULT_AUDIT_PATH)
    parser.add_argument("--no-audit", action="store_true")
    parser.add_argument("--elder-name", default="王奶奶")
    parser.add_argument("--family-relation", default="家人")
    parser.add_argument(
        "--visual",
        action="store_true",
        help="attach the bundle's pre-cut visual context to MiMo calls (ADR-0003 V path)",
    )
    parser.add_argument(
        "--no-cognition",
        action="store_true",
        help="disable the ADR-0006 cognition layers (behavior/memory/home context)",
    )
    parser.add_argument(
        "--home-script",
        type=Path,
        default=None,
        help="home-context timeline JSONL driving the whole-home semantics (ADR-0006)",
    )
    parser.add_argument(
        "--home-room",
        choices=[room.value for room in RoomLabel],
        default=None,
        help="static room label for the whole demo (alternative to --home-script)",
    )
    parser.add_argument(
        "--local-hour",
        type=int,
        default=None,
        help="static local hour 0..23 for the demo (night rules derive from it)",
    )
    parser.add_argument(
        "--memory-file",
        type=Path,
        default=None,
        help="behavior-memory JSON path; omit to run without longitudinal memory",
    )
    parser.add_argument(
        "--a-events-url",
        default=None,
        help=(
            "A's perception stream, e.g. ws://127.0.0.1:8200/ws/events. "
            "Given it, B subscribes itself and POST /api/events is refused; "
            "omit it to keep the push entry open for replays and fixtures."
        ),
    )
    return parser


def server_config_from_args(argv: Sequence[str] | None = None) -> ServerConfig:
    args = build_parser().parse_args(argv)
    if (args.cert is None) != (args.key is None):
        raise ServerConfigError("--cert and --key must be provided together")
    if args.home_script is not None and (args.home_room is not None or args.local_hour is not None):
        raise ServerConfigError("--home-script excludes --home-room/--local-hour")
    if args.local_hour is not None and not 0 <= args.local_hour <= 23:
        raise ServerConfigError("--local-hour must be within 0..23")
    if args.scenes_dir is None and DemoMode(args.mode) is DemoMode.RECORD:
        raise ServerConfigError("record mode needs a scenes_dir to replay from")
    if args.a_events_url is not None:
        # Validate at boot, not at the first session start (Codex R4): a bad
        # URL discovered mid-start leaves the registry running with no bridge
        # and every retry then 409s on the already-active session.
        try:
            _split_ws_url(args.a_events_url, "probe")
        except WebSocketClientError as exc:
            raise ServerConfigError(f"--a-events-url is unusable: {exc}") from exc
    if (
        args.home_script is not None
        and args.memory_file is not None
        and args.home_script.resolve() == args.memory_file.resolve()
    ):
        # Memory persistence would silently overwrite the read-only script.
        raise ServerConfigError("--home-script and --memory-file must be different files")
    return ServerConfig(
        scenes_dir=args.scenes_dir,
        host=args.host,
        port=args.port,
        static_dir=args.static,
        certfile=args.cert,
        keyfile=args.key,
        demo_mode=DemoMode(args.mode),
        mock_script_dir=args.mock_scripts,
        record_capture=args.record_output,
        audit_path=None if args.no_audit else args.audit,
        elder_name=args.elder_name,
        family_relation=args.family_relation,
        visual_enabled=args.visual,
        cognition_enabled=not args.no_cognition,
        home_script=args.home_script,
        home_room=args.home_room,
        local_hour=args.local_hour,
        memory_file=args.memory_file,
        a_events_url=args.a_events_url,
    )


def build_home_provider(config: ServerConfig) -> HomeContextProvider | None:
    """Timeline script wins; otherwise static flags; otherwise no provider."""

    if config.home_script is not None:
        try:
            return ScriptedHomeProvider.load(config.home_script)
        except HomeScriptError as exc:
            raise ServerConfigError(f"home script invalid: {exc}") from exc
    if config.home_room is None and config.local_hour is None:
        return None
    room = RoomLabel.UNKNOWN if config.home_room is None else RoomLabel(config.home_room)
    hour = config.local_hour
    return StaticHomeProvider(
        HomeContext(
            local_hour=hour,
            room=room,
            is_night=hour is not None and hour in NIGHT_HOURS,
            ambient={},
        )
    )


def build_policy_config(config: ServerConfig) -> PolicyConfig:
    persona = PersonaConfig(elder_name=config.elder_name, family_relation=config.family_relation)
    if not config.cognition_enabled:
        # The one-switch v1 fallback must boot even when a cognition file is
        # corrupt or unavailable, so those files are not touched at all.
        return PolicyConfig(
            persona=persona,
            trigger=TriggerConfig(),
            demo_mode=config.demo_mode,
            record_capture=config.record_capture,
            visual_enabled=config.visual_enabled,
            cognition_enabled=False,
        )
    memory_store = None
    if config.memory_file is not None:
        # persist_async: mutations on the decision path never wait on disk.
        memory_store = BehaviorMemoryStore(config.memory_file, clock=time.time, persist_async=True)
    return PolicyConfig(
        persona=persona,
        trigger=TriggerConfig(),
        demo_mode=config.demo_mode,
        record_capture=config.record_capture,
        visual_enabled=config.visual_enabled,
        cognition_enabled=True,
        home_provider=build_home_provider(config),
        memory_store=memory_store,
    )


def build_mimo_client(config: ServerConfig) -> MimoDecisionClient | None:
    if config.demo_mode is DemoMode.RECORD:
        return None
    if config.demo_mode is DemoMode.MOCK:
        return MockMimoClient(script_dir=config.mock_script_dir)
    client_config = config_from_environment()
    if not client_config.api_key and os.environ.get("MIMO_API_KEY") is None:
        # Live mode without a key still boots: MiMo-backed transitions will
        # degrade visibly instead of crashing the demo host.
        pass
    return LiveMimoDecisionClient(MimoClient(client_config))
