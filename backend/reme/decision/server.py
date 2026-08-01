"""Local HTTP API exposing decision sessions to the C demo frontend.

Endpoints (JSON in/out, permissive CORS for the local browser demo):
- POST /api/scenes/{scene_id}/posture      body=PostureObservation → decision|null
- POST /api/scenes/{scene_id}/transition   body=TransitionEvent   → decision|null
- POST /api/scenes/{scene_id}/response     body=InteractionResponse → decision
- GET  /api/scenes/{scene_id}/decision     → latest decision|null
- POST /api/scenes/{scene_id}/reset        → fresh session
- GET  /api/health                         → {"status": "ok", ...}

Run: `python -m reme.decision.server --mode mock --port 8788`
"""

from __future__ import annotations

import argparse
import json
import re
from collections.abc import Sequence
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from reme.decision.audit import AuditLogger
from reme.decision.contracts import ContractError, InteractionResponse
from reme.decision.engine import DecisionSession
from reme.decision.guardrails import GuardrailConfig
from reme.decision.mimo_client import MiMoClient, MiMoClientError
from reme.decision.mock_scenes import scene_ids, scripted_payloads

_SCENE_ROUTE = re.compile(r"^/api/scenes/(?P<scene_id>[\w.-]+)/(?P<verb>\w+)$")


class SessionRegistry:
    """Create and cache one DecisionSession per scene."""

    def __init__(
        self,
        *,
        mode: str,
        audit_dir: Path | None = None,
        config: GuardrailConfig | None = None,
    ) -> None:
        self._mode = mode
        self._audit_dir = audit_dir
        self._config = config or GuardrailConfig()
        self._sessions: dict[str, DecisionSession] = {}

    def get(self, scene_id: str) -> DecisionSession:
        if scene_id not in self._sessions:
            self._sessions[scene_id] = self._build(scene_id)
        return self._sessions[scene_id]

    def reset(self, scene_id: str) -> DecisionSession:
        self._sessions[scene_id] = self._build(scene_id)
        return self._sessions[scene_id]

    def _build(self, scene_id: str) -> DecisionSession:
        if self._mode == "mock":
            client = MiMoClient("mock", mock_payloads=scripted_payloads(scene_id))
        elif self._mode == "live":
            client = MiMoClient("live")
        else:
            raise MiMoClientError(
                "record mode needs a per-scene record_path; start it via code, not CLI"
            )
        audit = None
        if self._audit_dir is not None:
            audit = AuditLogger(self._audit_dir / f"{scene_id}.audit.jsonl")
        return DecisionSession(scene_id, client=client, config=self._config, audit=audit)


def build_handler(registry: SessionRegistry) -> type[BaseHTTPRequestHandler]:
    class DecisionHandler(BaseHTTPRequestHandler):
        server_version = "RemeDecision/0.1"

        def do_OPTIONS(self) -> None:  # noqa: N802 (http.server naming)
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path == "/api/health":
                self._json(HTTPStatus.OK, {"status": "ok", "scenes": list(scene_ids())})
                return
            match = _SCENE_ROUTE.match(self.path)
            if match and match["verb"] == "decision":
                session = registry.get(match["scene_id"])
                latest = session.last_decision
                self._json(HTTPStatus.OK, latest.to_dict() if latest else None)
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": f"unknown path {self.path}"})

        def do_POST(self) -> None:  # noqa: N802
            match = _SCENE_ROUTE.match(self.path)
            if not match:
                self._json(HTTPStatus.NOT_FOUND, {"error": f"unknown path {self.path}"})
                return
            scene_id, verb = match["scene_id"], match["verb"]
            try:
                if verb == "reset":
                    registry.reset(scene_id)
                    self._json(HTTPStatus.OK, {"status": "reset", "scene_id": scene_id})
                    return
                body = self._read_json()
                session = registry.get(scene_id)
                if verb == "posture":
                    decision = session.on_posture_observation(body)
                elif verb == "transition":
                    decision = session.on_transition_event(body)
                elif verb == "response":
                    decision = session.on_interaction_response(InteractionResponse.from_dict(body))
                else:
                    self._json(HTTPStatus.NOT_FOUND, {"error": f"unknown verb {verb!r}"})
                    return
            except (ContractError, MiMoClientError, ValueError) as exc:
                self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(exc)})
                return
            self._json(HTTPStatus.OK, decision.to_dict() if decision else None)

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            parsed = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(parsed, dict):
                raise ContractError("request body must be a JSON object")
            return parsed

        def _json(self, status: HTTPStatus, payload: Any) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return  # Quiet by default; the audit log is the source of truth.

    return DecisionHandler


def serve(registry: SessionRegistry, *, host: str = "127.0.0.1", port: int = 8788) -> None:
    httpd = ThreadingHTTPServer((host, port), build_handler(registry))
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Reme B-side decision API")
    parser.add_argument("--mode", choices=("mock", "live"), default="mock")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8788)
    parser.add_argument("--audit-dir", type=Path, default=Path(".reme-audit"))
    args = parser.parse_args(argv)
    registry = SessionRegistry(mode=args.mode, audit_dir=args.audit_dir)
    print(f"Reme decision API ({args.mode}) on http://{args.host}:{args.port}")
    serve(registry, host=args.host, port=args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
