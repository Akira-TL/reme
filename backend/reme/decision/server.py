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
from reme.decision.records import DecisionRecordError, parse_interaction_response

_REJECT_STATUS: dict[str, HTTPStatus] = {
    "stale_decision": HTTPStatus.CONFLICT,
    "timeline_rewind": HTTPStatus.CONFLICT,
    "episode_resolved": HTTPStatus.CONFLICT,
    "risk_floor_violation": HTTPStatus.CONFLICT,
    "no_recorded_decisions": HTTPStatus.CONFLICT,
    "invalid_response": HTTPStatus.UNPROCESSABLE_ENTITY,
    "no_pending_decision": HTTPStatus.UNPROCESSABLE_ENTITY,
}


def build_decision_handler(
    *,
    service: DecisionService,
    static_dir: Path | None,
) -> type[BaseHTTPRequestHandler]:
    """Create the request handler bound to one DecisionService."""

    static_root = None if static_dir is None else static_dir.resolve()

    class DecisionHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        # -- plumbing -------------------------------------------------------

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
            self._send_json(HTTPStatus.OK, {"reset": scene_id})

        def do_GET(self) -> None:  # noqa: N802
            path = urlparse(self.path).path
            if path == "/api/health":
                self._handle_health()
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
        server.socket = context.wrap_socket(server.socket, server_side=True)
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
    service = DecisionService(
        scenes=scenes,
        config=build_policy_config(config),
        mimo=build_mimo_client(config),
        audit=audit,
    )
    handler = build_decision_handler(service=service, static_dir=config.static_dir)
    server = build_server(config, handler)
    scheme = "https" if config.certfile is not None else "http"
    print(f"Reme B decision service: {scheme}://{config.host}:{config.port}")
    print(f"mode={config.demo_mode.value} scenes={', '.join(service.scene_ids())}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
