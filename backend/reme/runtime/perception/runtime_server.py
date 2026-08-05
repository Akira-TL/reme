"""C-controlled live perception server with HTTP control and WebSocket events."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import queue
import threading
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, replace
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlparse

from reme.pose.browser_input import (
    BrowserGatewayPerceptionWorker,
    GeometricPostureModel,
    parse_input_text,
    read_ws_messages,
    websocket_accept_value,
)
from reme.pose.c_stream import (
    CCameraMessageSource,
    CCameraWebSocketSource,
    CDebugScenario,
    CSceneSignal,
)
from reme.pose.camera import CameraConfig, LiveMoveNetStream, OpenCVCameraSource
from reme.pose.demo_scenarios import build_demo_runtime_events
from reme.pose.fall_runtime import DEFAULT_FALL_MIL_MODEL, FallMILTransitionEnhancer
from reme.pose.movenet import MoveNetEstimator
from reme.pose.posture import PosturePrediction, StaticPostureModel
from reme.pose.posture_runtime import PostureRuntimeConfig, RealtimePostureTracker
from reme.pose.runtime import (
    Component,
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionError,
    RuntimeSessionRequest,
    RuntimeSessionState,
    RuntimeSessionStatus,
    ensure_new_session,
)
from reme.pose.scene_bundle import FRAME_LANDMARKS_SCHEMA_VERSION
from reme.pose.transitions import TransitionDetector

DEFAULT_MOVENET_MODEL = Path("models/movenet/movenet_lightning_f16_v4.tflite")
DEFAULT_POSTURE_MODEL = Path(
    "artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json"
)
_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
FRONTEND_API_SCHEMA_VERSION = "reme-perception-frontend/v0-experiment"
API_ERROR_SCHEMA_VERSION = "reme-api-error/v0-experiment"


class RuntimeServerError(RuntimeError):
    """Raised when the live runtime server cannot satisfy a request."""


class EventSubscription(queue.Queue[RuntimeEvent | None]):
    """One bounded per-client event stream."""


class EventBroker:
    """Fan out session-scoped RuntimeEvents without blocking perception."""

    def __init__(self, *, queue_size: int = 128) -> None:
        if queue_size < 1:
            raise RuntimeServerError("queue_size must be positive")
        self.queue_size = queue_size
        self._lock = threading.Lock()
        self._subscribers: dict[str, list[EventSubscription]] = {}

    def subscribe(self, session_id: str) -> EventSubscription:
        if not isinstance(session_id, str) or not session_id.strip():
            raise RuntimeServerError("session_id must be non-empty")
        subscription = EventSubscription(maxsize=self.queue_size)
        with self._lock:
            self._subscribers.setdefault(session_id, []).append(subscription)
        return subscription

    def unsubscribe(self, session_id: str, subscription: EventSubscription) -> None:
        with self._lock:
            subscribers = self._subscribers.get(session_id)
            if subscribers is None:
                return
            try:
                subscribers.remove(subscription)
            except ValueError:
                return
            if not subscribers:
                self._subscribers.pop(session_id, None)

    def publish(self, event: RuntimeEvent) -> None:
        with self._lock:
            subscribers = tuple(self._subscribers.get(event.session_id, ()))
        for subscription in subscribers:
            _put_latest(subscription, event)

    def close_session(self, session_id: str) -> None:
        with self._lock:
            subscribers = tuple(self._subscribers.pop(session_id, ()))
        for subscription in subscribers:
            _put_latest(subscription, None)


class PostureEventTracker(Protocol):
    """Produce optional low-frequency posture events from frame events."""

    def process_frame_event(self, event: RuntimeEvent) -> RuntimeEvent | None: ...


class TransitionEventDetector(Protocol):
    """Consume ordered posture/frame events and emit optional transitions."""

    def process_runtime_event(self, event: RuntimeEvent) -> RuntimeEvent | None: ...

    def reset(self, *, session_id: str) -> None: ...


class PerceptionWorker(Protocol):
    """Adapter seam for one live perception implementation."""

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Callable[[RuntimeEvent], None],
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None: ...


class HybridPostureModel:
    """Use the learned classifier first, then a conservative geometry fallback.

    The learned model keeps its calibrated rejection gate.  Only records it
    rejects as ``unknown`` are offered to the geometry model; low-visibility
    or collapsed poses may still remain unknown.  This avoids solving a
    real-video domain shift by globally lowering confidence thresholds.
    """

    def __init__(
        self,
        *,
        primary: StaticPostureModel,
        fallback: GeometricPostureModel,
    ) -> None:
        self.primary = primary
        self.fallback = fallback

    def predict_record(self, record: dict[str, Any]) -> PosturePrediction:
        primary = self.primary.predict_record(record)
        if primary.posture != "unknown":
            return primary
        fallback = self.fallback.predict_record(record)
        if fallback.posture == "unknown":
            return primary
        return replace(fallback, classification_source="geometry_fallback")


def build_runtime_posture_model(
    posture_model: Path,
    *,
    score_threshold: float,
) -> HybridPostureModel:
    """Load the runtime static model with a safe real-domain fallback."""

    return HybridPostureModel(
        primary=StaticPostureModel.load(posture_model),
        fallback=GeometricPostureModel(score_threshold=score_threshold),
    )


def build_runtime_transition_detector(
    session_id: str,
    *,
    fall_mil_model: Path | None,
    score_threshold: float,
) -> TransitionEventDetector:
    """Load MIL v3 as a candidate enhancer when its artifact is available."""

    if fall_mil_model is None or not fall_mil_model.is_file():
        return TransitionDetector(session_id=session_id)
    return FallMILTransitionEnhancer.load(
        session_id=session_id,
        model_path=fall_mil_model,
        score_threshold=score_threshold,
    )


def derive_live_perception_events(
    frame_event: RuntimeEvent,
    *,
    posture_tracker: PostureEventTracker,
    transition_detector: TransitionEventDetector,
) -> tuple[RuntimeEvent, ...]:
    """Derive ordered posture and transition events for one landmark frame."""

    posture_event = posture_tracker.process_frame_event(frame_event)
    if posture_event is not None:
        transition_detector.process_runtime_event(posture_event)
    transition_event = transition_detector.process_runtime_event(frame_event)

    events = [frame_event]
    if posture_event is not None:
        events.append(posture_event)
    if transition_event is not None:
        events.append(transition_event)
    return tuple(events)


class CCameraWebSocketPerceptionWorker:
    """Run perception on C-owned camera frames and reusable scene signals."""

    def __init__(
        self,
        *,
        source: CCameraMessageSource,
        movenet_model: Path,
        posture_model: Path,
        posture_hz: float = 7.5,
        score_threshold: float = 0.2,
        num_threads: int = 4,
        fall_mil_model: Path | None = DEFAULT_FALL_MIL_MODEL,
    ) -> None:
        self.source = source
        self.movenet_model = movenet_model
        self.posture_model = posture_model
        self.posture_hz = posture_hz
        self.score_threshold = score_threshold
        self.num_threads = num_threads
        self.fall_mil_model = fall_mil_model

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Callable[[RuntimeEvent], None],
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None:
        if request.profile is not ModeProfile.LIVE_CAMERA:
            raise RuntimeServerError("C camera WebSocket worker supports live_camera only")
        try:
            import cv2
            import numpy as np
        except ImportError as exc:
            raise RuntimeServerError(
                "C camera WebSocket input requires opencv-python and numpy"
            ) from exc

        cv2_module: Any = cv2
        estimator = MoveNetEstimator(
            self.movenet_model,
            score_threshold=self.score_threshold,
            num_threads=self.num_threads,
        )
        estimator.reset()
        predictor = build_runtime_posture_model(
            self.posture_model,
            score_threshold=self.score_threshold,
        )
        tracker = RealtimePostureTracker(
            session_id=request.session_id,
            predictor=predictor,
            config=PostureRuntimeConfig(
                output_hz=self.posture_hz,
                score_threshold=self.score_threshold,
            ),
        )
        transition_detector = build_runtime_transition_detector(
            request.session_id,
            fall_mil_model=self.fall_mil_model,
            score_threshold=self.score_threshold,
        )
        current_scene_id = request.scene_id
        announced = False
        sequence = 0

        for message in self.source.iter_messages(request, is_active=is_active):
            if not is_active():
                return
            if message.session_id != request.session_id:
                continue
            if isinstance(message, CSceneSignal):
                if message.signal not in {"activate", "reuse", "switch"}:
                    continue
                current_scene_id = message.scene_id
                tracker.reset()
                transition_detector.reset(session_id=request.session_id)
                continue
            if isinstance(message, CDebugScenario):
                current_scene_id = message.scene_id
                tracker.reset()
                transition_detector.reset(session_id=request.session_id)
                events = build_demo_runtime_events(
                    message.to_command(),
                    start_sequence=sequence,
                )
                sequence += len(events)
                if not announced:
                    mark_running()
                    announced = True
                for event in events:
                    publish(event)
                continue
            if message.scene_id != current_scene_id:
                continue

            encoded = np.frombuffer(message.jpeg, dtype=np.uint8)
            frame = cv2_module.imdecode(encoded, cv2_module.IMREAD_COLOR)
            if frame is None:
                continue
            result = estimator.infer(frame)
            frame_event = RuntimeEvent(
                session_id=request.session_id,
                sequence=sequence,
                event_type=RuntimeEventType.FRAME_LANDMARKS,
                payload={
                    "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
                    "scene_id": current_scene_id,
                    "frame_index": message.frame_index,
                    "timestamp_ms": round(message.timestamp_ms, 3),
                    "person_detected": result.person_detected,
                    "landmark_quality": result.landmark_quality,
                    "coordinate_space": "normalized_image_top_left",
                    "smoothed": False,
                    "keypoints": [keypoint.to_payload() for keypoint in result.keypoints],
                },
            )
            sequence += 1
            if not announced:
                mark_running()
                announced = True
            for event in derive_live_perception_events(
                frame_event,
                posture_tracker=tracker,
                transition_detector=transition_detector,
            ):
                publish(event)


class LiveCameraPerceptionWorker:
    """Run camera, MoveNet, posture, and transition inference behind one interface."""

    def __init__(
        self,
        *,
        camera_config: CameraConfig,
        movenet_model: Path,
        posture_model: Path,
        posture_hz: float = 7.5,
        score_threshold: float = 0.2,
        num_threads: int = 4,
        fall_mil_model: Path | None = DEFAULT_FALL_MIL_MODEL,
    ) -> None:
        self.camera_config = camera_config
        self.movenet_model = movenet_model
        self.posture_model = posture_model
        self.posture_hz = posture_hz
        self.score_threshold = score_threshold
        self.num_threads = num_threads
        self.fall_mil_model = fall_mil_model

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Callable[[RuntimeEvent], None],
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None:
        if request.profile is not ModeProfile.LIVE_CAMERA:
            raise RuntimeServerError("live perception worker supports live_camera only")
        source = OpenCVCameraSource(self.camera_config)
        estimator = MoveNetEstimator(
            self.movenet_model,
            score_threshold=self.score_threshold,
            num_threads=self.num_threads,
        )
        predictor = build_runtime_posture_model(
            self.posture_model,
            score_threshold=self.score_threshold,
        )
        tracker = RealtimePostureTracker(
            session_id=request.session_id,
            predictor=predictor,
            config=PostureRuntimeConfig(
                output_hz=self.posture_hz,
                score_threshold=self.score_threshold,
            ),
        )
        transition_detector = build_runtime_transition_detector(
            request.session_id,
            fall_mil_model=self.fall_mil_model,
            score_threshold=self.score_threshold,
        )
        stream = LiveMoveNetStream(
            session_id=request.session_id,
            scene_id=request.scene_id,
            frame_source=source,
            estimator=estimator,
            is_session_active=lambda _session_id: is_active(),
        )
        announced = False
        for frame_event in stream.iter_events():
            if not announced:
                mark_running()
                announced = True
            for event in derive_live_perception_events(
                frame_event,
                posture_tracker=tracker,
                transition_detector=transition_detector,
            ):
                publish(event)


class RuntimePerceptionController:
    """Own one active C-controlled perception session and its event lifecycle."""

    def __init__(
        self,
        *,
        worker: PerceptionWorker,
        broker: EventBroker | None = None,
    ) -> None:
        self.worker = worker
        self.broker = broker or EventBroker()
        self._lock = threading.RLock()
        self._active_request: RuntimeSessionRequest | None = None
        self._status: RuntimeSessionStatus | None = None
        self._stop_event: threading.Event | None = None
        self._thread: threading.Thread | None = None

    def start(self, request: RuntimeSessionRequest) -> RuntimeSessionStatus:
        if request.profile is not ModeProfile.LIVE_CAMERA:
            raise RuntimeServerError("this server currently supports live_camera only")
        with self._lock:
            previous = self._active_request
        if previous is not None:
            ensure_new_session(previous, request)
            self.stop(previous.session_id)

        stop_event = threading.Event()
        starting = RuntimeSessionStatus(
            session_id=request.session_id,
            component=Component.PERCEPTION,
            requested_profile=request.profile,
            effective_profile=None,
            state=RuntimeSessionState.STARTING,
        )
        worker = self.worker
        thread = threading.Thread(
            target=self._run_worker,
            args=(request, worker, stop_event),
            name=f"reme-perception-{request.session_id}",
            daemon=True,
        )
        with self._lock:
            self._active_request = request
            self._stop_event = stop_event
            self._thread = thread
            self._status = starting
        thread.start()
        return starting

    def stop(self, session_id: str) -> RuntimeSessionStatus:
        with self._lock:
            request = self._active_request
            stop_event = self._stop_event
            thread = self._thread
            if request is None or request.session_id != session_id:
                raise RuntimeServerError(f"session {session_id!r} is not active")
            if stop_event is not None:
                stop_event.set()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=5.0)
        stopped = RuntimeSessionStatus(
            session_id=request.session_id,
            component=Component.PERCEPTION,
            requested_profile=request.profile,
            effective_profile=request.profile,
            state=RuntimeSessionState.STOPPED,
        )
        with self._lock:
            if self._active_request is request:
                self._status = stopped
                self._active_request = None
                self._stop_event = None
                self._thread = None
        self.broker.close_session(session_id)
        return stopped

    def status(self) -> RuntimeSessionStatus | None:
        with self._lock:
            return self._status

    def active_session_id(self) -> str | None:
        with self._lock:
            return self._active_request.session_id if self._active_request else None

    def shutdown(self) -> None:
        active = self.active_session_id()
        if active is not None:
            self.stop(active)

    def _run_worker(
        self,
        request: RuntimeSessionRequest,
        worker: PerceptionWorker,
        stop_event: threading.Event,
    ) -> None:
        def is_active() -> bool:
            with self._lock:
                return (
                    not stop_event.is_set()
                    and self._active_request is request
                    and self._stop_event is stop_event
                )

        def mark_running() -> None:
            running = RuntimeSessionStatus(
                session_id=request.session_id,
                component=Component.PERCEPTION,
                requested_profile=request.profile,
                effective_profile=request.profile,
                state=RuntimeSessionState.RUNNING,
            )
            with self._lock:
                if self._active_request is request and not stop_event.is_set():
                    self._status = running

        try:
            worker.run(
                request,
                publish=self.broker.publish,
                mark_running=mark_running,
                is_active=is_active,
            )
            if is_active():
                raise RuntimeServerError("perception worker exited unexpectedly")
        except Exception as exc:  # pragma: no cover - hardware adapter boundary
            degraded = RuntimeSessionStatus(
                session_id=request.session_id,
                component=Component.PERCEPTION,
                requested_profile=request.profile,
                effective_profile=None,
                state=RuntimeSessionState.DEGRADED,
                reason=f"{type(exc).__name__}: {exc}",
            )
            with self._lock:
                if self._active_request is request and not stop_event.is_set():
                    self._status = degraded
            self.broker.close_session(request.session_id)


class RuntimeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def frontend_capabilities() -> dict[str, object]:
    """Describe the stable A-side interface consumed by B and C."""

    return {
        "schema_version": FRONTEND_API_SCHEMA_VERSION,
        "service": "reme-perception",
        "profiles": [ModeProfile.LIVE_CAMERA.value],
        "events": [
            "frame_landmarks",
            "posture_observation",
            "transition_event",
        ],
        "states": [state.value for state in RuntimeSessionState],
        "endpoints": {
            "health": "/api/health",
            "capabilities": "/api/runtime/capabilities",
            "start": "/api/runtime/start",
            "stop": "/api/runtime/stop",
            "status": "/api/runtime/status",
            "events": "/ws/events?session_id=<session_id>",
        },
        "schemas": {
            "session_request": "reme-runtime-session-request/v0-experiment",
            "session_status": "reme-runtime-session-status/v0-experiment",
            "runtime_event": "reme-runtime-event/v0-experiment",
            "frame_landmarks": "movenet-17/v0-experiment",
            "posture_observation": "reme-posture/v0-experiment",
            "transition_event": "reme-transition/v0-experiment",
            "error": API_ERROR_SCHEMA_VERSION,
        },
        "session_controller": "C",
        "formal_input_adapter": "c_ws",
        "local_test_input_adapter": "local_camera",
        "frame_source_owner": "C",
        "scene_signal_supported": True,
        "camera_websocket_reused_across_scenes": True,
        "audio_processed_by_a": False,
        "raw_video_persisted": False,
        "cors": "any_origin_local_network_demo",
    }


def build_runtime_handler(
    controller: RuntimePerceptionController,
    *,
    input_gateway: BrowserGatewayPerceptionWorker | None = None,
) -> type[BaseHTTPRequestHandler]:
    """Build HTTP control and WebSocket routes (events out, camera input in).

    With ``input_gateway`` set the server *hosts* ``/ws/camera-input`` for C's
    browser (which can only be a WebSocket client) and advertises the lane in
    the capabilities payload; the out-dialling ``c_ws`` adapter stays for
    setups where something C-side really does host a socket.
    """

    class RuntimeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "RemePerception/0.1"

        def handle(self) -> None:
            try:
                super().handle()
            except (BrokenPipeError, ConnectionResetError):
                return

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(HTTPStatus.NO_CONTENT)
            self._cors()
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/api/health":
                status = controller.status()
                self._json(
                    HTTPStatus.OK,
                    {
                        "status": "ok",
                        "active_session_id": controller.active_session_id(),
                        "perception": status.to_payload() if status else None,
                    },
                )
                return
            if parsed.path == "/api/runtime/capabilities":
                payload = frontend_capabilities()
                if input_gateway is not None:
                    payload["input"] = input_gateway.capabilities()
                    endpoints = payload.get("endpoints")
                    if isinstance(endpoints, dict):
                        endpoints["camera_input"] = "/ws/camera-input"
                self._json(HTTPStatus.OK, payload)
                return
            if parsed.path == "/ws/camera-input":
                self._websocket_camera_input(parsed.path)
                return
            if parsed.path == "/api/runtime/status":
                status = controller.status()
                self._json(HTTPStatus.OK, status.to_payload() if status else None)
                return
            if parsed.path == "/ws/events":
                session_id = parse_qs(parsed.query).get("session_id", [""])[0]
                self._websocket_events(session_id)
                return
            self._error(
                HTTPStatus.NOT_FOUND,
                code="not_found",
                message=f"unknown path {parsed.path}",
                path=parsed.path,
            )

        def do_POST(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            try:
                body = self._read_json()
                if parsed.path == "/api/runtime/start":
                    request = RuntimeSessionRequest.from_payload(body)
                    status = controller.start(request)
                    self._json(HTTPStatus.ACCEPTED, status.to_payload())
                    return
                if parsed.path == "/api/runtime/stop":
                    session_id = body.get("session_id")
                    if not isinstance(session_id, str) or not session_id.strip():
                        raise RuntimeServerError("session_id must be non-empty")
                    status = controller.stop(session_id.strip())
                    self._json(HTTPStatus.OK, status.to_payload())
                    return
            except (
                RuntimeServerError,
                RuntimeSessionError,
                ValueError,
                json.JSONDecodeError,
            ) as exc:
                self._error(
                    HTTPStatus.UNPROCESSABLE_ENTITY,
                    code="invalid_request",
                    message=str(exc),
                    path=parsed.path,
                )
                return
            self._error(
                HTTPStatus.NOT_FOUND,
                code="not_found",
                message=f"unknown path {parsed.path}",
                path=parsed.path,
            )

        def _read_json(self) -> dict[str, Any]:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            payload = json.loads(raw.decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise RuntimeServerError("request body must be an object")
            return payload

        def _json(self, status: HTTPStatus, payload: object) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                return

        def _error(
            self,
            status: HTTPStatus,
            *,
            code: str,
            message: str,
            path: str,
        ) -> None:
            self._json(
                status,
                {
                    "schema_version": API_ERROR_SCHEMA_VERSION,
                    "code": code,
                    "message": message,
                    "path": path,
                },
            )

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-Reme-Session-Id",
            )
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def _websocket_events(self, session_id: str) -> None:
            if not session_id.strip():
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    code="missing_session_id",
                    message="session_id is required",
                    path="/ws/events",
                )
                return
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self._error(
                    HTTPStatus.UPGRADE_REQUIRED,
                    code="websocket_required",
                    message="websocket upgrade required",
                    path="/ws/events",
                )
                return
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    code="missing_websocket_key",
                    message="Sec-WebSocket-Key is required",
                    path="/ws/events",
                )
                return
            accept = base64.b64encode(
                hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
            ).decode("ascii")
            self.close_connection = True
            subscription = controller.broker.subscribe(session_id)
            self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", accept)
            self.end_headers()
            try:
                while True:
                    try:
                        event = subscription.get(timeout=12.0)
                    except queue.Empty:
                        self.wfile.write(encode_websocket_frame(b"", opcode=0x9))
                        self.wfile.flush()
                        continue
                    if event is None:
                        self.wfile.write(encode_websocket_frame(b"", opcode=0x8))
                        self.wfile.flush()
                        return
                    payload = json.dumps(
                        event.to_payload(), ensure_ascii=False, separators=(",", ":")
                    ).encode("utf-8")
                    self.wfile.write(encode_websocket_frame(payload))
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            finally:
                controller.broker.unsubscribe(session_id, subscription)

        def _websocket_camera_input(self, path: str) -> None:
            # Hosted receiving lane for C's browser camera: JSON text messages
            # are routed by their embedded session_id to the active session's
            # intake; binary JPEG pairs with the preceding frame_meta.
            if input_gateway is None:
                self._error(
                    HTTPStatus.CONFLICT,
                    code="camera_input_disabled",
                    message="this adapter dials out to C; the hosted input lane is off",
                    path=path,
                )
                return
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self._error(
                    HTTPStatus.UPGRADE_REQUIRED,
                    code="websocket_required",
                    message="websocket upgrade required",
                    path=path,
                )
                return
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    code="missing_websocket_key",
                    message="Sec-WebSocket-Key is required",
                    path=path,
                )
                return
            self.close_connection = True
            self.send_response(HTTPStatus.SWITCHING_PROTOCOLS)
            self.send_header("Upgrade", "websocket")
            self.send_header("Connection", "Upgrade")
            self.send_header("Sec-WebSocket-Accept", websocket_accept_value(key))
            self.end_headers()
            write_lock = threading.Lock()

            def send_control(opcode: int, payload: bytes) -> None:
                frame = encode_websocket_frame(payload, opcode=opcode)
                with write_lock, suppress(BrokenPipeError, ConnectionResetError, OSError):
                    self.wfile.write(frame)
                    self.wfile.flush()

            last_intake = None
            try:
                for opcode, payload in read_ws_messages(self.rfile, send_control):
                    if opcode == 0x1:
                        parsed_text = parse_input_text(payload)
                        if parsed_text is None:
                            continue
                        raw_text, message = parsed_text
                        session_id = message.get("session_id")
                        if not isinstance(session_id, str):
                            continue
                        intake = input_gateway.get_intake(session_id)
                        if intake is None:
                            continue
                        last_intake = intake
                        intake.submit_text(raw_text, message)
                    elif opcode == 0x2 and last_intake is not None:
                        last_intake.submit_binary(payload)
            except (BrokenPipeError, ConnectionResetError, OSError):
                return

        def log_message(self, format_string: str, *args: object) -> None:
            return

    return RuntimeHandler


def encode_websocket_frame(payload: bytes, *, opcode: int = 0x1) -> bytes:
    """Encode one unmasked final server-to-client WebSocket frame."""

    if not 0 <= opcode <= 0xF:
        raise RuntimeServerError("invalid WebSocket opcode")
    length = len(payload)
    first = bytes((0x80 | opcode,))
    if length < 126:
        header = first + bytes((length,))
    elif length <= 0xFFFF:
        header = first + bytes((126,)) + length.to_bytes(2, "big")
    else:
        header = first + bytes((127,)) + length.to_bytes(8, "big")
    return header + payload


def _put_latest(subscription: EventSubscription, event: RuntimeEvent | None) -> None:
    try:
        subscription.put_nowait(event)
        return
    except queue.Full:
        pass
    with suppress(queue.Empty):
        subscription.get_nowait()
    subscription.put_nowait(event)


@dataclass(frozen=True, slots=True)
class PerceptionRuntime:
    """Perception controller plus the optional browser input gateway."""

    controller: RuntimePerceptionController
    input_gateway: BrowserGatewayPerceptionWorker | None
    input_adapter: str


def add_perception_arguments(
    parser: argparse.ArgumentParser,
    *,
    include_network: bool = True,
) -> argparse.ArgumentParser:
    """Add perception options to a standalone or unified runtime parser."""

    if include_network:
        parser.add_argument(
            "--host",
            default="0.0.0.0",
            help="listen address for the unified local backend",
        )
        parser.add_argument("--port", type=int, default=8770)
    parser.add_argument(
        "--input-adapter",
        choices=("c_ws_server", "c_ws", "local_camera"),
        default="c_ws_server",
        help=(
            "c_ws_server hosts /ws/camera-input for the browser, c_ws dials a "
            "C-owned socket, and local_camera is a local hardware adapter"
        ),
    )
    parser.add_argument(
        "--browser-input-mode",
        choices=("auto", "jpeg", "landmarks"),
        default="auto",
        help=(
            "auto prefers local JPEG inference when dependencies and models exist; "
            "landmarks uses browser keypoints; jpeg requires the full local stack"
        ),
    )
    parser.add_argument("--c-camera-ws-url")
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--movenet-model", type=Path, default=DEFAULT_MOVENET_MODEL)
    parser.add_argument("--posture-model", type=Path, default=DEFAULT_POSTURE_MODEL)
    parser.add_argument(
        "--fall-mil-model",
        type=Path,
        default=DEFAULT_FALL_MIL_MODEL,
        help="weakly supervised MIL model used to enhance transition candidates",
    )
    parser.add_argument("--posture-hz", type=float, default=7.5)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--num-threads", type=int, default=4)
    return parser


def build_parser() -> argparse.ArgumentParser:
    return add_perception_arguments(argparse.ArgumentParser(description=__doc__))


def _build_parser() -> argparse.ArgumentParser:
    """Compatibility alias for existing parser tests."""

    return build_parser()


def build_browser_gateway(args: argparse.Namespace) -> BrowserGatewayPerceptionWorker:
    """Build the hosted browser input gateway in auto or explicitly selected mode."""

    from importlib.util import find_spec

    jpeg_ready = (
        args.movenet_model.is_file()
        and args.posture_model.is_file()
        and find_spec("cv2") is not None
        and find_spec("numpy") is not None
    )
    posture_config = PostureRuntimeConfig(
        output_hz=args.posture_hz, score_threshold=args.score_threshold
    )
    requested_mode = args.browser_input_mode

    def transition_factory(session_id: str) -> TransitionEventDetector:
        return build_runtime_transition_detector(
            session_id,
            fall_mil_model=args.fall_mil_model,
            score_threshold=args.score_threshold,
        )

    if requested_mode == "landmarks" or (requested_mode == "auto" and not jpeg_ready):
        return BrowserGatewayPerceptionWorker(
            posture_config=posture_config,
            transition_detector_factory=transition_factory,
        )
    if not jpeg_ready:
        raise RuntimeServerError(
            "--browser-input-mode jpeg requires cv2, numpy, and readable MoveNet/posture models"
        )

    def jpeg_pipeline(source: object) -> CCameraWebSocketPerceptionWorker:
        return CCameraWebSocketPerceptionWorker(
            source=source,  # type: ignore[arg-type]
            movenet_model=args.movenet_model,
            posture_model=args.posture_model,
            posture_hz=args.posture_hz,
            score_threshold=args.score_threshold,
            num_threads=args.num_threads,
            fall_mil_model=args.fall_mil_model,
        )

    return BrowserGatewayPerceptionWorker(
        jpeg_pipeline_factory=jpeg_pipeline,
        transition_detector_factory=transition_factory,
    )


def build_perception_runtime(args: argparse.Namespace) -> PerceptionRuntime:
    """Build perception components without binding a standalone server."""

    input_gateway: BrowserGatewayPerceptionWorker | None = None
    if args.input_adapter == "c_ws_server":
        input_gateway = build_browser_gateway(args)
        worker: PerceptionWorker = input_gateway
    elif args.input_adapter == "c_ws":
        if not isinstance(args.c_camera_ws_url, str) or not args.c_camera_ws_url.strip():
            raise RuntimeServerError("--c-camera-ws-url is required for c_ws input")
        worker = CCameraWebSocketPerceptionWorker(
            source=CCameraWebSocketSource(args.c_camera_ws_url.strip()),
            movenet_model=args.movenet_model,
            posture_model=args.posture_model,
            posture_hz=args.posture_hz,
            score_threshold=args.score_threshold,
            num_threads=args.num_threads,
            fall_mil_model=args.fall_mil_model,
        )
    else:
        worker = LiveCameraPerceptionWorker(
            camera_config=CameraConfig(
                device_index=args.camera,
                width=args.width,
                height=args.height,
                fps=args.fps,
            ),
            movenet_model=args.movenet_model,
            posture_model=args.posture_model,
            posture_hz=args.posture_hz,
            score_threshold=args.score_threshold,
            num_threads=args.num_threads,
            fall_mil_model=args.fall_mil_model,
        )
    return PerceptionRuntime(
        controller=RuntimePerceptionController(worker=worker),
        input_gateway=input_gateway,
        input_adapter=args.input_adapter,
    )
