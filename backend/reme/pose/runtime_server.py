"""C-controlled live perception server with HTTP control and WebSocket events."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import queue
import threading
from collections.abc import Callable, Sequence
from contextlib import suppress
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import parse_qs, urlparse

from reme.pose.camera import CameraConfig, LiveMoveNetStream, OpenCVCameraSource
from reme.pose.movenet import MoveNetEstimator
from reme.pose.posture import StaticPostureModel
from reme.pose.posture_runtime import PostureRuntimeConfig, RealtimePostureTracker
from reme.pose.runtime import (
    Component,
    ModeProfile,
    RuntimeEvent,
    RuntimeSessionError,
    RuntimeSessionRequest,
    RuntimeSessionState,
    RuntimeSessionStatus,
    ensure_new_session,
)
from reme.pose.transitions import TransitionDetector

DEFAULT_MOVENET_MODEL = Path("models/movenet/movenet_lightning_f16_v4.tflite")
DEFAULT_POSTURE_MODEL = Path(
    "artifacts/pose-classification/models/posture-sweep-20260801/"
    "seed-42-lr-0.04/model.json"
)
_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


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
    ) -> None:
        self.camera_config = camera_config
        self.movenet_model = movenet_model
        self.posture_model = posture_model
        self.posture_hz = posture_hz
        self.score_threshold = score_threshold
        self.num_threads = num_threads

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
        predictor = StaticPostureModel.load(self.posture_model)
        tracker = RealtimePostureTracker(
            session_id=request.session_id,
            predictor=predictor,
            config=PostureRuntimeConfig(
                output_hz=self.posture_hz,
                score_threshold=self.score_threshold,
            ),
        )
        transition_detector = TransitionDetector(session_id=request.session_id)
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


def build_runtime_handler(
    controller: RuntimePerceptionController,
) -> type[BaseHTTPRequestHandler]:
    """Build HTTP control and send-only WebSocket event routes."""

    class RuntimeHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "RemePerception/0.1"

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
            if parsed.path == "/api/runtime/status":
                status = controller.status()
                self._json(HTTPStatus.OK, status.to_payload() if status else None)
                return
            if parsed.path == "/ws/events":
                session_id = parse_qs(parsed.query).get("session_id", [""])[0]
                self._websocket_events(session_id)
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": f"unknown path {parsed.path}"})

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
                self._json(HTTPStatus.UNPROCESSABLE_ENTITY, {"error": str(exc)})
                return
            self._json(HTTPStatus.NOT_FOUND, {"error": f"unknown path {parsed.path}"})

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

        def _cors(self) -> None:
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")

        def _websocket_events(self, session_id: str) -> None:
            if not session_id.strip():
                self._json(HTTPStatus.BAD_REQUEST, {"error": "session_id is required"})
                return
            if self.headers.get("Upgrade", "").lower() != "websocket":
                self._json(HTTPStatus.UPGRADE_REQUIRED, {"error": "websocket upgrade required"})
                return
            key = self.headers.get("Sec-WebSocket-Key")
            if not key:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "Sec-WebSocket-Key is required"})
                return
            accept = base64.b64encode(
                hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
            ).decode("ascii")
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


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8770)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--movenet-model", type=Path, default=DEFAULT_MOVENET_MODEL)
    parser.add_argument("--posture-model", type=Path, default=DEFAULT_POSTURE_MODEL)
    parser.add_argument("--posture-hz", type=float, default=7.5)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--num-threads", type=int, default=4)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the local A-side live perception control server."""

    args = _build_parser().parse_args(argv)
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
    )
    controller = RuntimePerceptionController(worker=worker)
    server = RuntimeHTTPServer((args.host, args.port), build_runtime_handler(controller))
    print(f"Reme perception control: http://{args.host}:{args.port}")
    print(f"WebSocket events: ws://{args.host}:{args.port}/ws/events?session_id=<id>")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        controller.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
