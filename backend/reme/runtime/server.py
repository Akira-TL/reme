"""Unified Reme backend server.

One process owns perception, decision, in-process event transport, and the
browser-facing HTTP/WebSocket surface. Perception-to-decision events never
leave the process; only browser/device traffic crosses the HTTP boundary.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse

from reme.runtime.decision.config import ServerConfigError, server_config_from_namespace
from reme.runtime.decision.config import build_parser as build_decision_parser
from reme.runtime.decision.context import SceneStreamError
from reme.runtime.decision.server import (
    build_decision_handler,
    build_decision_runtime,
    build_server,
)
from reme.runtime.perception.runtime_server import (
    RuntimeServerError,
    add_perception_arguments,
    build_perception_runtime,
    build_runtime_handler,
)
from reme.runtime.transport import InProcessPerceptionBridge

DEFAULT_BACKEND_PORT = 8770

_PERCEPTION_GET_PATHS = frozenset(
    {
        "/api/runtime/capabilities",
        "/api/runtime/status",
        "/ws/camera-input",
        "/ws/events",
    }
)
_PERCEPTION_POST_PATHS = frozenset({"/api/runtime/start", "/api/runtime/stop"})


def build_parser() -> argparse.ArgumentParser:
    """Build one parser covering decision and perception configuration."""

    parser = build_decision_parser()
    parser.description = "Reme unified local backend"
    parser.set_defaults(host="127.0.0.1", port=DEFAULT_BACKEND_PORT)
    add_perception_arguments(parser, include_network=False)
    return parser


def build_unified_handler(
    perception_handler: type[BaseHTTPRequestHandler],
    decision_handler: type[BaseHTTPRequestHandler],
) -> type[BaseHTTPRequestHandler]:
    """Route both component handlers through one HTTP listener."""

    class UnifiedHandler(perception_handler, decision_handler):  # type: ignore[misc, valid-type]
        server_version = "RemeRuntime/0.2"

        def setup(self) -> None:
            decision_handler.setup(self)

        def handle(self) -> None:
            perception_handler.handle(self)

        def do_OPTIONS(self) -> None:  # noqa: N802
            perception_handler.do_OPTIONS(self)

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path in _PERCEPTION_GET_PATHS:
                perception_handler.do_GET(self)
                return
            decision_handler.do_GET(self)

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path in _PERCEPTION_POST_PATHS:
                perception_handler.do_POST(self)
                return
            if path == "/api/events":
                self._send_error_json(
                    HTTPStatus.CONFLICT,
                    "in_process_only",
                    "perception events are delivered in-process; HTTP ingest is disabled",
                )
                return
            decision_handler.do_POST(self)

        def do_HEAD(self) -> None:  # noqa: N802
            decision_handler.do_HEAD(self)

        def log_message(self, format_string: str, *args: object) -> None:
            decision_handler.log_message(self, format_string, *args)

    return UnifiedHandler


def main(argv: Sequence[str] | None = None) -> int:
    """Run the single Reme backend process."""

    args = build_parser().parse_args(argv)
    try:
        decision_config = server_config_from_namespace(args)
        perception = build_perception_runtime(args)
        decision = build_decision_runtime(decision_config)
        bridge = InProcessPerceptionBridge(
            broker=perception.controller.broker,
            ingest=decision.ingest,
            registry=decision.registry,
            service=decision.service,
            danger=decision.danger,
        )
        perception_handler = build_runtime_handler(
            perception.controller,
            input_gateway=perception.input_gateway,
        )
        decision_handler = build_decision_handler(
            service=decision.service,
            static_dir=decision_config.static_dir,
            registry=decision.registry,
            hub=decision.hub,
            ingest=decision.ingest,
            bridge=bridge,
            danger=decision.danger,
            voice_dialogue=decision.voice_dialogue,
            voice_dir=(
                decision_config.voice_dir if decision_config.voice_dir.is_dir() else None
            ),
        )
        server = build_server(
            decision_config,
            build_unified_handler(perception_handler, decision_handler),
        )
    except (ServerConfigError, SceneStreamError, RuntimeServerError, OSError) as exc:
        print(f"error: {exc}")
        return 2

    scheme = "https" if decision_config.certfile is not None else "http"
    base_url = f"{scheme}://{decision_config.host}:{decision_config.port}"
    print(f"Reme unified backend: {base_url}")
    print(f"Perception input: {perception.input_adapter}")
    print("Perception → decision transport: in-process")
    print(f"Camera input: {base_url.replace('http', 'ws', 1)}/ws/camera-input")
    print(f"Decision stream: {base_url.replace('http', 'ws', 1)}/ws")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        perception.controller.shutdown()
        decision.shutdown(bridge)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
