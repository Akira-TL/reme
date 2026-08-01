"""B's HTTP surface: a thin stdlib handler over DecisionService.

The handler only routes, parses and serializes; every business rule lives in
:mod:`reme.decision.policy`. TLS uses ``ssl.SSLContext`` (``ssl.wrap_socket``
was removed in Python 3.12); certificates come from mkcert so phone browsers
on the demo hotspot can open the same origin that serves C's static page.
"""

from __future__ import annotations

import json
import mimetypes
import os
import re
import ssl
from collections.abc import Sequence
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from reme.decision.audit import AuditLog
from reme.decision.config import (
    ServerConfig,
    ServerConfigError,
    build_mimo_client,
    build_policy_config,
    server_config_from_args,
)
from reme.decision.context import SceneStreamError, discover_scenes
from reme.decision.policy import (
    DecisionRejectedError,
    DecisionService,
    UnknownSceneError,
)
from reme.decision.records import DecisionRecordError, DemoMode, parse_interaction_response
from reme.decision.runtime_glue import (
    RuntimeDecisionPublisher,
    live_streams_resolver,
    spawn_post_ingest_evaluation,
)
from reme.decision.session import (
    RuntimeSessionRegistry,
    SessionRegistryError,
    parse_session_request,
)
from reme.decision.stream import EventIngest, IngestError
from reme.decision.websocket import DecisionEventHub, WebSocketError
from reme.pose.runtime import ModeProfile, RuntimeSessionStatus

_REJECT_STATUS: dict[str, HTTPStatus] = {
    "stale_decision": HTTPStatus.CONFLICT,
    "timeline_rewind": HTTPStatus.CONFLICT,
    "episode_resolved": HTTPStatus.CONFLICT,
    "risk_floor_violation": HTTPStatus.CONFLICT,
    "no_recorded_decisions": HTTPStatus.CONFLICT,
    "invalid_response": HTTPStatus.UNPROCESSABLE_ENTITY,
    "no_pending_decision": HTTPStatus.UNPROCESSABLE_ENTITY,
}

_SESSION_STATUS: dict[str, HTTPStatus] = {
    "bad_request": HTTPStatus.BAD_REQUEST,
    "session_conflict": HTTPStatus.CONFLICT,
    "unknown_session": HTTPStatus.NOT_FOUND,
}

_INGEST_STATUS: dict[str, HTTPStatus] = {
    "stale_session": HTTPStatus.CONFLICT,
    "no_active_session": HTTPStatus.CONFLICT,
    "bad_event": HTTPStatus.UNPROCESSABLE_ENTITY,
}


def build_decision_handler(
    *,
    service: DecisionService,
    static_dir: Path | None,
    registry: RuntimeSessionRegistry | None = None,
    hub: DecisionEventHub | None = None,
    ingest: EventIngest | None = None,
) -> type[BaseHTTPRequestHandler]:
    """Create the request handler bound to one DecisionService.

    The three realtime collaborators are optional: a server built without
    them still serves the recorded-bundle routes, and every runtime route
    answers 503 ``runtime_disabled`` instead of pretending to work.
    """

    static_root = None if static_dir is None else static_dir.resolve()

    class DecisionHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # -- plumbing -------------------------------------------------------

        def setup(self) -> None:
            # TLS handshakes are deferred out of the accept loop (Codex
            # review P1: a stalled ClientHello must not block new
            # connections); build_server wraps the listener with
            # do_handshake_on_connect=False, so the handshake runs here on
            # this connection's own worker thread, with a bounded timeout.
            if isinstance(self.request, ssl.SSLSocket):
                self.request.settimeout(10)
                self.request.do_handshake()
                self.request.settimeout(None)
            super().setup()

        def _send_json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self._send_cors_headers()
            self.end_headers()
            self.wfile.write(body)

        def _send_error_json(self, status: HTTPStatus, code: str, message: str) -> None:
            self._send_json(status, {"error": {"code": code, "message": message}})

        def _send_cors_headers(self) -> None:
            # Same-origin is the demo deployment; these headers only ease C's
            # dev-server integration before the static page moves in.
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _read_json_body(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length > 0 else b""
            try:
                payload = json.loads(raw.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise ValueError(f"request body is not valid JSON: {exc}") from exc
            if not isinstance(payload, dict):
                raise ValueError("request body must be a JSON object")
            return payload

        # -- routes ---------------------------------------------------------

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(HTTPStatus.NO_CONTENT)
            self._send_cors_headers()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            try:
                payload = self._read_json_body()
            except ValueError as exc:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "bad_json", str(exc))
                return
            try:
                if path == "/api/decision":
                    self._handle_decision(payload)
                elif path == "/api/response":
                    self._handle_response(payload)
                elif path == "/api/scene/reset":
                    self._handle_reset(payload)
                elif path == "/api/session":
                    self._handle_session_start(payload)
                elif path == "/api/session/stop":
                    self._handle_session_stop(payload)
                elif path == "/api/events":
                    self._handle_events(payload)
                else:
                    self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path)
            except UnknownSceneError as exc:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND, "unknown_scene", f"unknown scene {exc.args[0]!r}"
                )
            except DecisionRejectedError as exc:
                status = _REJECT_STATUS.get(exc.code, HTTPStatus.UNPROCESSABLE_ENTITY)
                self._send_error_json(status, exc.code, exc.code)
            except DecisionRecordError as exc:
                self._send_error_json(
                    HTTPStatus.UNPROCESSABLE_ENTITY, "contract_violation", str(exc)
                )
            except SessionRegistryError as exc:
                status = _SESSION_STATUS.get(exc.code, HTTPStatus.BAD_REQUEST)
                self._send_error_json(status, exc.code, str(exc))
            except IngestError as exc:
                status = _INGEST_STATUS.get(exc.code, HTTPStatus.UNPROCESSABLE_ENTITY)
                self._send_error_json(status, exc.code, str(exc))

        def _handle_decision(self, payload: dict[str, Any]) -> None:
            scene_id = payload.get("scene_id")
            timestamp_ms = payload.get("timestamp_ms")
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return
            if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, int | float):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "timestamp_ms must be a number"
                )
                return
            decision = service.get_decision(scene_id=scene_id, timestamp_ms=float(timestamp_ms))
            self._send_json(HTTPStatus.OK, decision.to_payload())

        def _handle_response(self, payload: dict[str, Any]) -> None:
            response = parse_interaction_response(payload)
            decision = service.submit_response(response)
            self._send_json(HTTPStatus.OK, decision.to_payload())

        def _handle_reset(self, payload: dict[str, Any]) -> None:
            scene_id = payload.get("scene_id")
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return
            service.reset_scene(scene_id)
            if ingest is not None:
                # Live buffers reset with the episode, or replays from an
                # earlier timestamp would trip the ingest watermark.
                ingest.reset_scene(scene_id)
            self._send_json(HTTPStatus.OK, {"reset": scene_id})

        # -- runtime routes -------------------------------------------------

        def _send_runtime_disabled(self, what: str) -> None:
            self._send_error_json(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "runtime_disabled",
                f"{what} is unavailable: the server was built without the realtime runtime",
            )

        def _announce_session(self, status: RuntimeSessionStatus) -> None:
            # Buffers, episodes and in-flight MiMo work are all dropped before
            # the status goes out, so nothing computed for the previous
            # session can surface under the new one (Codex review P1).
            if ingest is not None:
                ingest.reset_all()
            service.reset_all_scenes()
            if hub is not None:
                hub.broadcast_json(status.to_payload())

        def _handle_session_start(self, payload: dict[str, Any]) -> None:
            if registry is None:
                self._send_runtime_disabled("session control")
                return
            request = parse_session_request(payload)
            # The requested profile must match how this server actually runs,
            # or a RUNNING status would claim a mode nobody is executing
            # (Codex review P1): record replay serves recorded_video only,
            # live/mock serve live_camera only.
            expected = (
                ModeProfile.RECORDED_VIDEO
                if service.demo_mode is DemoMode.RECORD
                else ModeProfile.LIVE_CAMERA
            )
            if request.profile is not expected:
                self._send_error_json(
                    HTTPStatus.CONFLICT,
                    "profile_mismatch",
                    f"server demo_mode={service.demo_mode.value} only serves "
                    f"profile={expected.value}",
                )
                return
            status = registry.start(request)
            self._announce_session(status)
            self._send_json(HTTPStatus.OK, status.to_payload())

        def _handle_session_stop(self, payload: dict[str, Any]) -> None:
            if registry is None:
                self._send_runtime_disabled("session control")
                return
            session_id = payload.get("session_id")
            if not isinstance(session_id, str) or not session_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "session_id must be a non-empty string"
                )
                return
            status = registry.stop(session_id)
            self._announce_session(status)
            self._send_json(HTTPStatus.OK, status.to_payload())

        def _handle_session_status(self) -> None:
            if registry is None:
                self._send_runtime_disabled("session control")
                return
            status = registry.current_status()
            if status is None:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND, "no_session", "no runtime session has been started"
                )
                return
            self._send_json(HTTPStatus.OK, status.to_payload())

        def _handle_events(self, payload: dict[str, Any]) -> None:
            # Ingest needs the registry too: without the active session id
            # there is nothing to check inbound envelopes against.
            if registry is None or ingest is None:
                self._send_runtime_disabled("event ingest")
                return
            event = ingest.submit(payload, active_session_id=registry.active_session_id())
            # Evaluate off-thread so A's event POST never waits on a MiMo
            # round trip; the resulting decision reaches C over /ws.
            spawn_post_ingest_evaluation(service, event)
            self._send_json(HTTPStatus.OK, {"accepted": event.event_type.value})

        def _handle_websocket(self) -> None:
            # Wire format on this socket: every broadcast is one JSON object
            # in one text frame (the hub never fragments). C tells the two
            # kinds apart by ``schema_version``:
            # ``reme-runtime-event/v0-experiment`` is a RuntimeEvent envelope
            # (session_id / sequence / event_type / payload), while
            # ``reme-runtime-session-status/v0-experiment`` is a
            # RuntimeSessionStatus (component / requested_profile /
            # effective_profile / state / reason).
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_upgrade", "/ws requires a WebSocket upgrade"
                )
                return
            if hub is None:
                self._send_runtime_disabled("the decision stream")
                return
            # Hand the socket over only after keep-alive is off: once accept()
            # owns the connection, BaseHTTPRequestHandler must not try to read
            # another request off it.
            self.close_connection = True
            try:
                hub.accept(self)
            except WebSocketError as exc:
                # accept() raises before writing a single byte on handshake
                # failure, so a plain HTTP error is still a valid response.
                self._send_error_json(HTTPStatus.BAD_REQUEST, "bad_upgrade", str(exc))

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/api/health":
                self._handle_health()
                return
            if path == "/ws":
                self._handle_websocket()
                return
            if path == "/api/session/status":
                try:
                    self._handle_session_status()
                except SessionRegistryError as exc:
                    status = _SESSION_STATUS.get(exc.code, HTTPStatus.BAD_REQUEST)
                    self._send_error_json(status, exc.code, str(exc))
                return
            if path.startswith("/scenes/"):
                self._handle_scene_asset(path)
                return
            self._handle_static(path)

        def do_HEAD(self) -> None:  # noqa: N802
            # HEAD mirrors GET without bodies; only static assets need it.
            path = urlparse(self.path).path
            if path.startswith("/scenes/"):
                self._handle_scene_asset(path, send_body=False)
                return
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Length", "0")
            self.end_headers()

        def _handle_health(self) -> None:
            scenes: dict[str, Any] = {}
            for scene_id in service.scene_ids():
                streams = service.scene_streams(scene_id)
                scenes[scene_id] = {
                    "postures": len(streams.postures),
                    "transitions": len(streams.transitions),
                }
            self._send_json(HTTPStatus.OK, {"status": "ok", "scenes": scenes})

        def _handle_scene_asset(self, path: str, *, send_body: bool = True) -> None:
            parts = path.split("/", 3)
            if len(parts) < 4 or not parts[2]:
                self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path)
                return
            scene_id, relative = parts[2], parts[3]
            try:
                streams = service.scene_streams(scene_id)
            except UnknownSceneError:
                self._send_error_json(HTTPStatus.NOT_FOUND, "unknown_scene", scene_id)
                return
            bundle_root = streams.manifest.path.parent.resolve()
            target = (bundle_root / relative).resolve()
            try:
                target.relative_to(bundle_root)
            except ValueError:
                self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path)
                return
            self._send_file(target, allow_range=True, send_body=send_body)

        def _handle_static(self, path: str) -> None:
            if static_root is None:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND, "no_static_dir", "server started without --static"
                )
                return
            relative = path.lstrip("/") or "index.html"
            target = (static_root / relative).resolve()
            try:
                target.relative_to(static_root)
            except ValueError:
                self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path)
                return
            if target.is_dir():
                target = target / "index.html"
            self._send_file(target, allow_range=False)

        def _send_file(
            self, path: Path, *, allow_range: bool, send_body: bool = True
        ) -> None:
            # Byte-range support mirrors reme.pose.review_server so phone
            # browsers can seek inside bundle mp4 files.
            if not path.is_file():
                self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path.name)
                return
            size = path.stat().st_size
            start = 0
            end = size - 1
            status = HTTPStatus.OK
            range_header = self.headers.get("Range") if allow_range else None
            if range_header:
                match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
                if match is None:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    return
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = int(last) if last else size - 1
                elif last:
                    count = int(last)
                    if count <= 0:
                        self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                        return
                    start = max(0, size - count)
                else:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    return
                if start >= size or start > end:
                    self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    return
                end = min(end, size - 1)
                status = HTTPStatus.PARTIAL_CONTENT
            length = end - start + 1
            content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            self._send_cors_headers()
            if allow_range:
                self.send_header("Accept-Ranges", "bytes")
            if status == HTTPStatus.PARTIAL_CONTENT:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if not send_body:
                return
            try:
                with path.open("rb") as handle:
                    handle.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = handle.read(min(1024 * 1024, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return

        def log_message(self, format_string: str, *args: object) -> None:
            if os.environ.get("REME_DEMO_QUIET") == "1":
                return
            super().log_message(format_string, *args)

    return DecisionHandler


def build_ssl_context(certfile: Path, keyfile: Path) -> ssl.SSLContext:
    """TLS context for mkcert certificates (Python 3.12+ safe)."""

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certfile=str(certfile), keyfile=str(keyfile))
    return context


def build_server(
    config: ServerConfig, handler: type[BaseHTTPRequestHandler]
) -> ThreadingHTTPServer:
    """Bind the threading server and wrap its socket when TLS is configured."""

    server = ThreadingHTTPServer((config.host, config.port), handler)
    if config.certfile is not None and config.keyfile is not None:
        context = build_ssl_context(config.certfile, config.keyfile)
        server.socket = context.wrap_socket(
            server.socket, server_side=True, do_handshake_on_connect=False
        )
    return server


def main(argv: Sequence[str] | None = None) -> int:
    """Boot the decision service over the given scenes directory."""

    try:
        config = server_config_from_args(argv)
        scenes = discover_scenes(config.scenes_dir)
    except (ServerConfigError, SceneStreamError) as exc:
        print(f"error: {exc}")
        return 2
    if not scenes:
        print(f"error: no scene bundles found under {config.scenes_dir}")
        return 2
    audit = None if config.audit_path is None else AuditLog(config.audit_path)
    registry = RuntimeSessionRegistry()
    hub = DecisionEventHub()
    ingest = EventIngest()
    service = DecisionService(
        scenes=scenes,
        config=build_policy_config(config),
        mimo=build_mimo_client(config),
        audit=audit,
        publisher=RuntimeDecisionPublisher(registry=registry, hub=hub),
        live_streams=live_streams_resolver(registry, ingest),
    )
    handler = build_decision_handler(
        service=service,
        static_dir=config.static_dir,
        registry=registry,
        hub=hub,
        ingest=ingest,
    )
    server = build_server(config, handler)
    scheme = "https" if config.certfile is not None else "http"
    print(f"Reme B decision service: {scheme}://{config.host}:{config.port}")
    print(f"mode={config.demo_mode.value} scenes={', '.join(service.scene_ids())}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        # Close the streaming sockets first: server_close() only drops the
        # listening socket, and blocked WS threads would keep the process up.
        hub.close_all()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
