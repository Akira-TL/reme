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
from contextlib import suppress
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from reme.decision.audit import AuditLog
from reme.decision.config import (
    ServerConfig,
    ServerConfigError,
    build_danger_controller,
    build_mimo_client,
    build_policy_config,
    build_speech_client,
)
from reme.decision.context import discover_scenes
from reme.decision.danger import DangerConfirmController, DangerRejectedError
from reme.decision.policy import (
    DecisionRejectedError,
    DecisionService,
    UnknownSceneError,
)
from reme.decision.records import DecisionRecordError, DemoMode, parse_interaction_response
from reme.decision.runtime_glue import (
    PerceptionBridgeLike,
    RuntimeDecisionPublisher,
    live_streams_resolver,
    spawn_post_ingest_evaluation,
)
from reme.decision.session import (
    RuntimeSessionRegistry,
    SessionRegistryError,
    parse_session_request,
)
from reme.decision.state_machine import DemoConversationKind
from reme.decision.stream import EventIngest, IngestError
from reme.decision.voice_dialogue import VoiceDialogueController, VoiceDialogueError
from reme.decision.websocket import DecisionEventHub, WebSocketError
from reme.pose.runtime import ModeProfile, RuntimeSessionStatus

_REJECT_STATUS: dict[str, HTTPStatus] = {
    "stale_decision": HTTPStatus.CONFLICT,
    "timeline_rewind": HTTPStatus.CONFLICT,
    "episode_resolved": HTTPStatus.CONFLICT,
    "risk_floor_violation": HTTPStatus.CONFLICT,
    "response_too_early": HTTPStatus.CONFLICT,
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
    "push_ingest_disabled": HTTPStatus.CONFLICT,
}

_VOICE_STATUS: dict[str, HTTPStatus] = {
    "speech_unavailable": HTTPStatus.SERVICE_UNAVAILABLE,
    "asr_failed": HTTPStatus.BAD_GATEWAY,
    "tts_failed": HTTPStatus.BAD_GATEWAY,
    "bad_audio": HTTPStatus.UNPROCESSABLE_ENTITY,
    "no_pending_decision": HTTPStatus.CONFLICT,
    "stale_decision": HTTPStatus.CONFLICT,
    "no_elder_message": HTTPStatus.UNPROCESSABLE_ENTITY,
}

_DANGER_STATUS: dict[str, HTTPStatus] = {
    "no_confirm_pending": HTTPStatus.CONFLICT,
    "channel_not_offered": HTTPStatus.UNPROCESSABLE_ENTITY,
    "bad_media": HTTPStatus.UNPROCESSABLE_ENTITY,
    "confirm_budget_exhausted": HTTPStatus.TOO_MANY_REQUESTS,
    "confirm_unavailable": HTTPStatus.SERVICE_UNAVAILABLE,
}


def build_decision_handler(
    *,
    service: DecisionService,
    static_dir: Path | None,
    registry: RuntimeSessionRegistry | None = None,
    hub: DecisionEventHub | None = None,
    ingest: EventIngest | None = None,
    bridge: PerceptionBridgeLike | None = None,
    danger: DangerConfirmController | None = None,
    voice_dialogue: VoiceDialogueController | None = None,
    voice_dir: Path | None = None,
) -> type[BaseHTTPRequestHandler]:
    """Create the request handler bound to one DecisionService.

    The three realtime collaborators are optional: a server built without
    them still serves the recorded-bundle routes, and every runtime route
    answers 503 ``runtime_disabled`` instead of pretending to work. The same
    holds for the danger link: without a controller its upload routes answer
    503 ``danger_disabled``, and without a voice dir ``/voice/`` is 404.
    """

    static_root = None if static_dir is None else static_dir.resolve()
    voice_root = None if voice_dir is None else voice_dir.resolve()

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
                elif path == "/api/demo/conversation":
                    self._handle_demo_conversation(payload)
                elif path == "/api/session":
                    self._handle_session_start(payload)
                elif path == "/api/session/scene":
                    self._handle_session_scene(payload)
                elif path == "/api/session/stop":
                    self._handle_session_stop(payload)
                elif path == "/api/events":
                    self._handle_events(payload)
                elif path == "/api/voice/tts":
                    self._handle_voice_tts(payload)
                elif path == "/api/voice/dialogue":
                    self._handle_voice_dialogue(payload)
                elif path == "/api/danger/frame":
                    self._handle_danger_frame(payload)
                elif path == "/api/danger/voice":
                    self._handle_danger_voice(payload)
                else:
                    self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path)
            except UnknownSceneError as exc:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND, "unknown_scene", f"unknown scene {exc.args[0]!r}"
                )
            except DecisionRejectedError as exc:
                status = _REJECT_STATUS.get(exc.code, HTTPStatus.UNPROCESSABLE_ENTITY)
                self._send_error_json(status, exc.code, exc.code)
            except DangerRejectedError as exc:
                status = _DANGER_STATUS.get(exc.code, HTTPStatus.UNPROCESSABLE_ENTITY)
                self._send_error_json(status, exc.code, exc.code)
            except VoiceDialogueError as exc:
                status = _VOICE_STATUS.get(exc.code, HTTPStatus.UNPROCESSABLE_ENTITY)
                self._send_error_json(status, exc.code, str(exc))
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

        def _handle_demo_conversation(self, payload: dict[str, Any]) -> None:
            scene_id = payload.get("scene_id")
            scenario = payload.get("scenario")
            timestamp_ms = payload.get("timestamp_ms")
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return
            if not isinstance(scenario, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "bad_request",
                    f"scenario must be one of {[item.value for item in DemoConversationKind]}",
                )
                return
            try:
                kind = DemoConversationKind(scenario)
            except ValueError:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "bad_request",
                    f"scenario must be one of {[item.value for item in DemoConversationKind]}",
                )
                return
            if (
                isinstance(timestamp_ms, bool)
                or not isinstance(timestamp_ms, int | float)
                or timestamp_ms < 0
            ):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "timestamp_ms must be a number >= 0"
                )
                return
            decision = service.start_demo_conversation(
                scene_id=scene_id,
                kind=kind,
                timestamp_ms=float(timestamp_ms),
            )
            self._send_json(HTTPStatus.OK, decision.to_payload())

        # -- MiMo voice dialogue (ASR -> decision -> TTS) ------------------

        def _handle_voice_tts(self, payload: dict[str, Any]) -> None:
            if voice_dialogue is None:
                raise VoiceDialogueError("speech_unavailable")
            scene_id = payload.get("scene_id")
            decision_id = payload.get("decision_id")
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return
            if not isinstance(decision_id, str) or not decision_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "bad_request",
                    "decision_id must be a non-empty string",
                )
                return
            decision, audio = voice_dialogue.synthesize_decision(
                scene_id=scene_id,
                decision_id=decision_id,
            )
            response: dict[str, Any] = {
                "scene_id": scene_id,
                "decision_id": decision.decision_id,
                "text": decision.elder_message,
            }
            response.update(audio.to_payload())
            self._send_json(HTTPStatus.OK, response)

        def _handle_voice_dialogue(self, payload: dict[str, Any]) -> None:
            if voice_dialogue is None:
                raise VoiceDialogueError("speech_unavailable")
            scene_id = payload.get("scene_id")
            decision_id = payload.get("decision_id")
            timestamp_ms = payload.get("timestamp_ms")
            audio_b64 = payload.get("audio_b64")
            audio_format = payload.get("audio_format", "wav")
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return
            if not isinstance(decision_id, str) or not decision_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "bad_request",
                    "decision_id must be a non-empty string",
                )
                return
            if (
                isinstance(timestamp_ms, bool)
                or not isinstance(timestamp_ms, int | float)
                or timestamp_ms < 0
            ):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "timestamp_ms must be a number >= 0"
                )
                return
            if not isinstance(audio_b64, str) or not audio_b64:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "audio_b64 must be a non-empty string"
                )
                return
            if not isinstance(audio_format, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "audio_format must be a string"
                )
                return
            result = voice_dialogue.submit_audio_reply(
                scene_id=scene_id,
                decision_id=decision_id,
                timestamp_ms=float(timestamp_ms),
                audio_b64=audio_b64,
                audio_format=audio_format,
            )
            self._send_json(HTTPStatus.OK, result.to_payload())

        # -- danger link (fall fast-confirm) --------------------------------

        def _danger_common(self, payload: dict[str, Any]) -> tuple[str, str, float] | None:
            """Shared field checks; None means an error was already sent."""

            scene_id = payload.get("scene_id")
            decision_id = payload.get("decision_id")
            timestamp_ms = payload.get("timestamp_ms")
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return None
            if not isinstance(decision_id, str) or not decision_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "bad_request",
                    "decision_id must be a non-empty string",
                )
                return None
            if (
                isinstance(timestamp_ms, bool)
                or not isinstance(timestamp_ms, int | float)
                or timestamp_ms < 0
            ):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "timestamp_ms must be a number >= 0"
                )
                return None
            return scene_id, decision_id, float(timestamp_ms)

        def _handle_danger_frame(self, payload: dict[str, Any]) -> None:
            if danger is None:
                self._send_error_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "danger_disabled",
                    "this server runs without the danger confirmation link",
                )
                return
            common = self._danger_common(payload)
            if common is None:
                return
            scene_id, decision_id, timestamp_ms = common
            image_b64 = payload.get("image_b64")
            if not isinstance(image_b64, str) or not image_b64:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "image_b64 must be a non-empty string"
                )
                return
            mime_type = payload.get("mime_type", "image/jpeg")
            if not isinstance(mime_type, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "mime_type must be a string"
                )
                return
            danger.submit_frame(
                scene_id=scene_id,
                decision_id=decision_id,
                image_b64=image_b64,
                timestamp_ms=timestamp_ms,
                mime_type=mime_type,
            )
            # The verdict arrives over /ws as a new decision; this response
            # only acknowledges that the confirmation is running.
            self._send_json(HTTPStatus.OK, {"accepted": "visual_confirm"})

        def _handle_danger_voice(self, payload: dict[str, Any]) -> None:
            if danger is None:
                self._send_error_json(
                    HTTPStatus.SERVICE_UNAVAILABLE,
                    "danger_disabled",
                    "this server runs without the danger confirmation link",
                )
                return
            common = self._danger_common(payload)
            if common is None:
                return
            scene_id, decision_id, timestamp_ms = common
            text = payload.get("text")
            audio_b64 = payload.get("audio_b64")
            audio_format = payload.get("audio_format")
            if text is not None and not isinstance(text, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "text must be a string"
                )
                return
            if audio_b64 is not None and not isinstance(audio_b64, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "audio_b64 must be a string"
                )
                return
            if audio_format is not None and not isinstance(audio_format, str):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "audio_format must be a string"
                )
                return
            danger.submit_voice(
                scene_id=scene_id,
                decision_id=decision_id,
                timestamp_ms=timestamp_ms,
                text=text,
                audio_b64=audio_b64,
                audio_format=audio_format,
            )
            self._send_json(HTTPStatus.OK, {"accepted": "voice_intent"})

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
            replace_active = payload.get("replace_active", False)
            if not isinstance(replace_active, bool):
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST,
                    "bad_request",
                    "replace_active must be a boolean",
                )
                return
            request_payload = dict(payload)
            request_payload.pop("replace_active", None)
            request = parse_session_request(request_payload)
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
            if replace_active:
                _, status = registry.replace_active(request)
            else:
                status = registry.start(request)
            self._announce_session(status)
            if bridge is not None:
                # Subscribe to A only after the buffers are clean, so no event
                # from the previous session can slip into this one.
                try:
                    bridge.start_for(request.session_id)
                except Exception as exc:  # noqa: BLE001 - roll back, never wedge
                    # Without this the registry would stay RUNNING with no feed
                    # and every retry would 409 on the active session (Codex R4).
                    bridge.stop()
                    registry.stop(request.session_id)
                    self._send_error_json(
                        HTTPStatus.SERVICE_UNAVAILABLE,
                        "perception_unavailable",
                        f"could not subscribe to {bridge.events_url}: {exc}",
                    )
                    return
            self._send_json(HTTPStatus.OK, status.to_payload())

        def _handle_session_scene(self, payload: dict[str, Any]) -> None:
            if registry is None:
                self._send_runtime_disabled("session scene control")
                return
            session_id = payload.get("session_id")
            scene_id = payload.get("scene_id")
            if not isinstance(session_id, str) or not session_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "session_id must be a non-empty string"
                )
                return
            if not isinstance(scene_id, str) or not scene_id:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "bad_request", "scene_id must be a non-empty string"
                )
                return
            status = registry.switch_scene(session_id, scene_id)
            if ingest is not None:
                ingest.reset_scene(scene_id)
            service.reset_scene(scene_id)
            self._send_json(
                HTTPStatus.OK,
                {
                    "session_id": session_id,
                    "scene_id": scene_id,
                    "state": status.state.value,
                },
            )

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
            # Validate the target BEFORE touching the bridge (Codex R4): the
            # old order let a wrong or stale session_id cut the live session's
            # data feed while the registry still reported it running.
            if not registry.is_active(session_id):
                # Not the running session: let the registry produce the
                # authoritative error (unknown_session / already stopped)
                # without disturbing anything that is actually live.
                status = registry.stop(session_id)
                self._announce_session(status)
                self._send_json(HTTPStatus.OK, status.to_payload())
                return
            # Genuine stop of the active session: drop the subscription first,
            # or in-flight events from A land while the buffers are resetting.
            if bridge is not None:
                bridge.stop()
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
            # Mutual exclusion lives inside the ingest lock, not here: an
            # attached() probe followed by submit() was a TOCTOU check across
            # two unrelated locks, so a push arriving mid-attach could still
            # double-write the watermark (Codex R4). submit() now refuses the
            # push itself with push_ingest_disabled.
            event = ingest.submit(payload, active_session_id=registry.active_session_id())
            # Evaluate off-thread so A's event POST never waits on a MiMo
            # round trip; the resulting decision reaches C over /ws.
            spawn_post_ingest_evaluation(service, event, danger=danger)
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
            if path.startswith("/voice/"):
                self._handle_voice_asset(path)
                return
            self._handle_static(path)

        def _handle_voice_asset(self, path: str) -> None:
            # Preset check-in clips (danger link): tiny immutable m4a files.
            if voice_root is None:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND, "no_voice_dir", "server started without voice presets"
                )
                return
            relative = path.removeprefix("/voice/")
            target = (voice_root / relative).resolve()
            try:
                target.relative_to(voice_root)
            except ValueError:
                self._send_error_json(HTTPStatus.NOT_FOUND, "not_found", path)
                return
            self._send_file(target, allow_range=False)

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
            body: dict[str, Any] = {"status": "ok", "scenes": scenes}
            if bridge is not None:
                # A subscription that is attached but not connected means B is
                # running on nothing: reporting "ok" there let a dead A look
                # healthy while stale postures kept producing normal decisions
                # (Codex R4).
                body["perception"] = {
                    "source": "pull",
                    "url": bridge.safe_url,
                    "attached": bridge.attached(),
                    "connected": bridge.connected(),
                }
                if bridge.attached() and not bridge.connected():
                    body["status"] = "degraded"
                    body["degraded_reason"] = "perception stream from A is down"
                    if registry is not None:
                        # Make C's status view agree with health, not just this
                        # endpoint: a degraded component must stop reading LIVE.
                        with suppress(SessionRegistryError):
                            status = registry.mark_degraded("perception stream from A is down")
                            if hub is not None:
                                hub.broadcast_json(status.to_payload())
            self._send_json(HTTPStatus.OK, body)

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

        def _send_file(self, path: Path, *, allow_range: bool, send_body: bool = True) -> None:
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


@dataclass(frozen=True, slots=True)
class DecisionRuntime:
    """Decision components owned by the unified backend process."""

    config: ServerConfig
    service: DecisionService
    registry: RuntimeSessionRegistry
    hub: DecisionEventHub
    ingest: EventIngest
    danger: DangerConfirmController | None
    voice_dialogue: VoiceDialogueController

    def shutdown(self, bridge: PerceptionBridgeLike | None = None) -> None:
        if bridge is not None:
            bridge.stop()
        self.hub.close_all()


def build_decision_runtime(config: ServerConfig) -> DecisionRuntime:
    """Build decision components without binding a standalone server."""

    scenes = {} if config.scenes_dir is None else discover_scenes(config.scenes_dir)
    if not scenes and config.demo_mode is DemoMode.RECORD:
        raise ServerConfigError(f"no scene bundles found under {config.scenes_dir}")
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
    danger = build_danger_controller(config, service, audit)
    voice_dialogue = VoiceDialogueController(
        service=service,
        speech=build_speech_client(config),
    )
    return DecisionRuntime(
        config=config,
        service=service,
        registry=registry,
        hub=hub,
        ingest=ingest,
        danger=danger,
        voice_dialogue=voice_dialogue,
    )


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
