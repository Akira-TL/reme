from __future__ import annotations

from http import HTTPStatus
from http.server import BaseHTTPRequestHandler
from typing import Any

from reme.runtime.server import DEFAULT_BACKEND_PORT, build_parser, build_unified_handler


def test_unified_parser_uses_one_backend_port_and_in_process_transport() -> None:
    args = build_parser().parse_args([])

    assert args.host == "127.0.0.1"
    assert args.port == DEFAULT_BACKEND_PORT
    assert not hasattr(args, "a_events_url")
    assert args.input_adapter == "c_ws_server"


def test_unified_handler_routes_perception_and_decision_paths() -> None:
    calls: list[tuple[str, Any]] = []

    class PerceptionHandler(BaseHTTPRequestHandler):
        def setup(self) -> None:
            calls.append(("perception.setup", None))

        def handle(self) -> None:
            calls.append(("perception.handle", None))

        def do_OPTIONS(self) -> None:  # noqa: N802
            calls.append(("perception.options", self.path))

        def do_GET(self) -> None:  # noqa: N802
            calls.append(("perception.get", self.path))

        def do_POST(self) -> None:  # noqa: N802
            calls.append(("perception.post", self.path))

    class DecisionHandler(BaseHTTPRequestHandler):
        def setup(self) -> None:
            calls.append(("decision.setup", None))

        def do_GET(self) -> None:  # noqa: N802
            calls.append(("decision.get", self.path))

        def do_POST(self) -> None:  # noqa: N802
            calls.append(("decision.post", self.path))

        def do_HEAD(self) -> None:  # noqa: N802
            calls.append(("decision.head", self.path))

        def _send_error_json(self, status: HTTPStatus, code: str, message: str) -> None:
            calls.append(("decision.error", (status, code, message)))

        def log_message(self, format_string: str, *args: object) -> None:
            calls.append(("decision.log", (format_string, args)))

    handler_type = build_unified_handler(PerceptionHandler, DecisionHandler)
    handler = object.__new__(handler_type)

    handler.path = "/api/runtime/status"
    handler.do_GET()
    handler.path = "/api/session/status"
    handler.do_GET()
    handler.path = "/api/runtime/start"
    handler.do_POST()
    handler.path = "/api/session"
    handler.do_POST()
    handler.path = "/api/events"
    handler.do_POST()

    assert calls[0] == ("perception.get", "/api/runtime/status")
    assert calls[1] == ("decision.get", "/api/session/status")
    assert calls[2] == ("perception.post", "/api/runtime/start")
    assert calls[3] == ("decision.post", "/api/session")
    assert calls[4][0] == "decision.error"
    assert calls[4][1][0] is HTTPStatus.CONFLICT
    assert calls[4][1][1] == "in_process_only"
