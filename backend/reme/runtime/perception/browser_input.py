"""Server-hosted camera input: C's browser dials A at ``/ws/camera-input``.

A's formal input adapter (``CCameraWebSocketSource``) dials *out* to a C-owned
WebSocket, but the real C is a phone browser page — browsers can only be
WebSocket *clients*, so somebody must host the socket. This module is that
host: A serves ``/ws/camera-input``, C connects and pushes either

- ``frame_meta`` + binary JPEG (or inline ``frame``): decoded with A's own
  :class:`CStreamDecoder` and fed through the unchanged
  :class:`CCameraWebSocketPerceptionWorker` MoveNet pipeline via an in-process
  queue source — available when cv2/model artifacts are installed;
- ``landmarks_frame``: C's in-browser extractor already produced MoveNet-17
  points, so a pure-Python lane (geometric posture heuristic + A's posture
  tracker and transition detector) runs on any machine, model files or not.

Exactly one lane is active per server (capabilities tell C which), so the
per-session event sequence stays single-writer.
"""

from __future__ import annotations

import base64
import contextlib
import hashlib
import json
import math
import queue
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any, Protocol

from reme.pose.c_stream import (
    CStreamDecoder,
    CStreamError,
    CStreamMessage,
    CVideoFrame,
)
from reme.pose.demo_scenarios import DemoScenarioCommand, build_demo_runtime_events
from reme.pose.posture import PosturePrediction
from reme.pose.posture_runtime import PostureRuntimeConfig, RealtimePostureTracker
from reme.pose.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
)
from reme.pose.transitions import (
    FRAME_LANDMARKS_SCHEMA_VERSION,
    TransitionDetector,
    TransitionDetectorConfig,
)

_WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_INPUT_MESSAGE_BYTES = 5_000_000

# MoveNet-17 keypoint order; C's mapper emits exactly this sequence.
KEYPOINT_NAMES = (
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
)

POSTURE_LABELS = ("standing", "sitting", "lying", "bending_or_crouching", "unknown")


class BrowserInputError(ValueError):
    """Raised when a pushed input message violates the wire contract."""


def _finite_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


class GeometricPostureModel:
    """Deterministic torso-geometry posture heuristic (PosturePredictor).

    A model-free fallback so the browser lane classifies on any machine.  It
    is intentionally conservative: thin torso projections (the along-axis
    lying failure mode), missing hips/shoulders, or sparse keypoints abstain
    to ``unknown`` instead of guessing.  Angle thresholds are demo-tuned
    engineering values, not literature claims (the projection distortion of
    normalized single-camera coordinates is documented in
    .scratch/posture-classifier-theory/notes/clinical-posture.md).
    """

    def __init__(
        self,
        *,
        score_threshold: float = 0.2,
        lying_angle_deg: float = 65.0,
        upright_angle_deg: float = 35.0,
        min_torso_length: float = 0.04,
        min_visible_ratio: float = 0.5,
    ) -> None:
        self.score_threshold = score_threshold
        self.lying_angle_deg = lying_angle_deg
        self.upright_angle_deg = upright_angle_deg
        self.min_torso_length = min_torso_length
        self.min_visible_ratio = min_visible_ratio

    def predict_record(self, record: dict[str, Any]) -> PosturePrediction:
        points = self._visible_points(record)
        ratio = len(points) / len(KEYPOINT_NAMES)
        if not bool(record.get("person_detected")) or ratio < self.min_visible_ratio:
            return self._prediction("unknown", 0.3, ratio)
        shoulder = self._pair_mid(points, "left_shoulder", "right_shoulder")
        hip = self._pair_mid(points, "left_hip", "right_hip")
        if shoulder is None or hip is None:
            return self._prediction("unknown", 0.3, ratio)
        dx = abs(hip[0] - shoulder[0])
        dy = hip[1] - shoulder[1]
        torso_length = math.hypot(dx, dy)
        if torso_length < self.min_torso_length:
            # Along-camera-axis collapse: the angle is pure noise, abstain.
            return self._prediction("unknown", 0.3, ratio)
        if dy > 0:
            angle = math.degrees(math.atan2(dx, dy))
        else:
            angle = 180.0 - math.degrees(math.atan2(dx, -dy))
        if angle >= self.lying_angle_deg:
            span = (angle - self.lying_angle_deg) / (180.0 - self.lying_angle_deg)
            return self._prediction("lying", 0.6 + 0.3 * min(span * 2.0, 1.0), ratio)
        if angle <= self.upright_angle_deg:
            return self._upright(points, hip, torso_length, ratio)
        margin = min(angle - self.upright_angle_deg, self.lying_angle_deg - angle)
        confidence = 0.55 + 0.2 * min(margin / 15.0, 1.0)
        return self._prediction("bending_or_crouching", confidence, ratio)

    def _upright(
        self,
        points: dict[str, tuple[float, float]],
        hip: tuple[float, float],
        torso_length: float,
        ratio: float,
    ) -> PosturePrediction:
        lower = self._pair_mid(points, "left_ankle", "right_ankle")
        expected = 1.4
        if lower is None:
            lower = self._pair_mid(points, "left_knee", "right_knee")
            expected = 0.75
        if lower is None:
            return self._prediction("standing", 0.5, ratio)
        leg_drop = lower[1] - hip[1]
        if leg_drop >= expected * torso_length:
            stretch = leg_drop / (expected * torso_length)
            return self._prediction("standing", min(0.55 + 0.25 * (stretch - 1.0), 0.9), ratio)
        fold = leg_drop / (expected * torso_length)
        if fold <= 0.72:
            return self._prediction("sitting", min(0.55 + 0.3 * (0.72 - fold), 0.85), ratio)
        return self._prediction("standing", 0.5, ratio)

    def _visible_points(self, record: dict[str, Any]) -> dict[str, tuple[float, float]]:
        raw = record.get("keypoints")
        if not isinstance(raw, list):
            raise BrowserInputError("keypoints must be an array")
        points: dict[str, tuple[float, float]] = {}
        for item in raw:
            if not isinstance(item, dict):
                continue
            name = item.get("name")
            score = item.get("score")
            x_norm = item.get("x_norm")
            y_norm = item.get("y_norm")
            if (
                not isinstance(name, str)
                or isinstance(score, bool)
                or not isinstance(score, int | float)
                or isinstance(x_norm, bool)
                or not isinstance(x_norm, int | float)
                or isinstance(y_norm, bool)
                or not isinstance(y_norm, int | float)
            ):
                continue
            if float(score) >= self.score_threshold:
                points[name] = (float(x_norm), float(y_norm))
        return points

    def _pair_mid(
        self, points: dict[str, tuple[float, float]], left: str, right: str
    ) -> tuple[float, float] | None:
        pair = [points[name] for name in (left, right) if name in points]
        if not pair:
            return None
        return (
            sum(point[0] for point in pair) / len(pair),
            sum(point[1] for point in pair) / len(pair),
        )

    def _prediction(self, posture: str, confidence: float, ratio: float) -> PosturePrediction:
        confidence = min(max(confidence, 0.0), 1.0)
        remainder = (1.0 - confidence) / (len(POSTURE_LABELS) - 1)
        probabilities = {
            label: confidence if label == posture else remainder for label in POSTURE_LABELS
        }
        return PosturePrediction(
            posture=posture,
            confidence=confidence,
            probabilities=probabilities,
            visible_keypoint_ratio=round(ratio, 6),
            classification_source="geometry",
        )


@dataclass(slots=True)
class IngestStats:
    """Counters the input route can report truthfully."""

    landmark_frames: int = 0
    jpeg_frames: int = 0
    dropped_messages: int = 0


class LandmarkFrameEngine:
    """Landmark lane: ``landmarks_frame`` messages in, runtime events out."""

    def __init__(
        self,
        *,
        session_id: str,
        scene_id: str,
        publish: Callable[[RuntimeEvent], None],
        predictor: GeometricPostureModel | None = None,
        posture_config: PostureRuntimeConfig | None = None,
        transition_config: TransitionDetectorConfig | None = None,
        transition_detector: Any | None = None,
    ) -> None:
        self.session_id = session_id
        self.scene_id = scene_id
        self._publish = publish
        self._predictor = predictor or GeometricPostureModel()
        self._tracker = RealtimePostureTracker(
            session_id=session_id,
            predictor=self._predictor,
            config=posture_config or PostureRuntimeConfig(),
        )
        self._detector = transition_detector or TransitionDetector(
            session_id=session_id, config=transition_config or TransitionDetectorConfig()
        )
        self._lock = threading.Lock()
        self._sequence = 0
        self.stats = IngestStats()

    def handle_text(self, message: dict[str, Any]) -> None:
        kind = message.get("type")
        if message.get("session_id") != self.session_id:
            self.stats.dropped_messages += 1
            return
        if kind == "landmarks_frame":
            self._ingest_landmarks(message)
        elif kind == "debug_scenario":
            self._ingest_debug_scenario(message)
        elif kind == "scene_signal":
            self._handle_scene_signal(message)
        elif kind in ("ping", "heartbeat", "frame_meta"):
            # frame_meta may leak from a JPEG-mode client; count it so the
            # capabilities mismatch is visible instead of silent.
            if kind == "frame_meta":
                self.stats.dropped_messages += 1
        else:
            self.stats.dropped_messages += 1

    def handle_binary(self, data: bytes) -> None:
        self.stats.dropped_messages += 1

    def _handle_scene_signal(self, message: dict[str, Any]) -> None:
        signal = message.get("signal", "activate")
        scene_id = message.get("scene_id")
        if signal not in ("activate", "switch", "reuse") or not isinstance(scene_id, str):
            self.stats.dropped_messages += 1
            return
        if signal == "switch" and scene_id != self.scene_id:
            self.scene_id = scene_id
            self._tracker.reset()
            self._detector.reset(session_id=self.session_id)

    def _ingest_debug_scenario(self, message: dict[str, Any]) -> None:
        session_id = message.get("session_id")
        scene_id = message.get("scene_id")
        timestamp_ms = _finite_number(message.get("timestamp_ms"))
        scenario = message.get("scenario")
        if (
            session_id != self.session_id
            or not isinstance(scene_id, str)
            or not scene_id
            or timestamp_ms is None
            or timestamp_ms < 0
            or not isinstance(scenario, str)
        ):
            self.stats.dropped_messages += 1
            return
        try:
            command = DemoScenarioCommand(
                session_id=self.session_id,
                scene_id=scene_id,
                timestamp_ms=timestamp_ms,
                scenario=scenario,
            )
            with self._lock:
                start_sequence = self._sequence
                events = build_demo_runtime_events(
                    command,
                    start_sequence=start_sequence,
                )
                self._sequence += len(events)
        except ValueError:
            self.stats.dropped_messages += 1
            return
        for event in events:
            self._publish(event)

    def _ingest_landmarks(self, message: dict[str, Any]) -> None:
        record = self._frame_record(message)
        if record is None:
            self.stats.dropped_messages += 1
            return
        with self._lock:
            sequence = self._sequence
            self._sequence += 1
        frame_event = RuntimeEvent(
            session_id=self.session_id,
            sequence=sequence,
            event_type=RuntimeEventType.FRAME_LANDMARKS,
            payload=record,
        )
        self.stats.landmark_frames += 1
        # Same ordering as runtime_server.derive_live_perception_events.
        posture_event = self._tracker.process_frame_event(frame_event)
        if posture_event is not None:
            self._detector.process_runtime_event(posture_event)
        transition_event = self._detector.process_runtime_event(frame_event)
        self._publish(frame_event)
        if posture_event is not None:
            self._publish(posture_event)
        if transition_event is not None:
            self._publish(transition_event)

    def _frame_record(self, message: dict[str, Any]) -> dict[str, Any] | None:
        timestamp_ms = message.get("timestamp_ms")
        frame_index = message.get("frame_index")
        keypoints = message.get("keypoints")
        scene_id = message.get("scene_id")
        if (
            isinstance(timestamp_ms, bool)
            or not isinstance(timestamp_ms, int | float)
            or not math.isfinite(float(timestamp_ms))
            or float(timestamp_ms) < 0
        ):
            return None
        if isinstance(frame_index, bool) or not isinstance(frame_index, int) or frame_index < 0:
            return None
        if not isinstance(keypoints, list):
            return None
        cleaned: list[dict[str, Any]] = []
        for item in keypoints:
            if not isinstance(item, dict):
                return None
            name = item.get("name")
            if not isinstance(name, str) or name not in KEYPOINT_NAMES:
                return None
            score = _finite_number(item.get("score"))
            x_norm = _finite_number(item.get("x_norm"))
            y_norm = _finite_number(item.get("y_norm"))
            if score is None or x_norm is None or y_norm is None:
                return None
            cleaned.append(
                {
                    "name": name,
                    "x_norm": min(max(x_norm, 0.0), 1.0),
                    "y_norm": min(max(y_norm, 0.0), 1.0),
                    "score": min(max(score, 0.0), 1.0),
                }
            )
        person_detected = bool(message.get("person_detected")) and bool(cleaned)
        quality = message.get("landmark_quality")
        if quality not in ("usable", "degraded", "unavailable"):
            visible = sum(1 for item in cleaned if item["score"] >= self._predictor.score_threshold)
            usable = person_detected and visible / len(KEYPOINT_NAMES) >= 0.5
            quality = "usable" if usable else "degraded"
        return {
            "schema_version": FRAME_LANDMARKS_SCHEMA_VERSION,
            "scene_id": scene_id if isinstance(scene_id, str) and scene_id else self.scene_id,
            "timestamp_ms": float(timestamp_ms),
            "frame_index": frame_index,
            "person_detected": person_detected,
            "coordinate_space": "normalized_image_top_left",
            "smoothed": False,
            "keypoints": cleaned,
            "landmark_quality": quality,
        }


class QueuedCameraMessageSource:
    """In-process CCameraMessageSource fed by the hosted input WebSocket."""

    def __init__(self, *, max_pending: int = 64) -> None:
        self._queue: queue.Queue[CStreamMessage | None] = queue.Queue(maxsize=max_pending)

    def push(self, message: CStreamMessage) -> None:
        try:
            self._queue.put_nowait(message)
        except queue.Full:
            # Perception lag sheds the oldest frame, never blocks the socket.
            with contextlib.suppress(queue.Empty):
                self._queue.get_nowait()
            with contextlib.suppress(queue.Full):
                self._queue.put_nowait(message)

    def close(self) -> None:
        self.push_sentinel()

    def push_sentinel(self) -> None:
        with contextlib.suppress(queue.Full):
            self._queue.put_nowait(None)

    def iter_messages(
        self,
        request: RuntimeSessionRequest,
        *,
        is_active: Callable[[], bool],
    ) -> Iterator[CStreamMessage]:
        while is_active():
            try:
                message = self._queue.get(timeout=0.2)
            except queue.Empty:
                continue
            if message is None:
                return
            yield message


@dataclass(slots=True)
class SessionIntake:
    """Connection-facing intake for one active session (single lane)."""

    session_id: str
    mode: str  # "jpeg" | "landmarks"
    engine: LandmarkFrameEngine | None = None
    source: QueuedCameraMessageSource | None = None
    decoder: CStreamDecoder = field(default_factory=CStreamDecoder)
    stats: IngestStats = field(default_factory=IngestStats)

    def submit_text(self, raw_text: str, message: dict[str, Any]) -> None:
        if self.mode == "landmarks":
            assert self.engine is not None
            self.engine.handle_text(message)
            return
        assert self.source is not None
        try:
            for decoded in self.decoder.feed(raw_text):
                self._push_decoded(decoded)
        except CStreamError:
            self.stats.dropped_messages += 1

    def submit_binary(self, data: bytes) -> None:
        if self.mode == "landmarks":
            assert self.engine is not None
            self.engine.handle_binary(data)
            return
        assert self.source is not None
        try:
            for decoded in self.decoder.feed(data):
                self._push_decoded(decoded)
        except CStreamError:
            self.stats.dropped_messages += 1

    def _push_decoded(self, decoded: CStreamMessage) -> None:
        assert self.source is not None
        if decoded.session_id != self.session_id:
            self.stats.dropped_messages += 1
            return
        if isinstance(decoded, CVideoFrame):
            self.stats.jpeg_frames += 1
        self.source.push(decoded)


class BrowserGatewayPerceptionWorker:
    """PerceptionWorker for browser-pushed input, one lane per server.

    ``jpeg_pipeline_factory`` builds the deps-heavy MoveNet worker (usually
    :class:`CCameraWebSocketPerceptionWorker` bound to this session's queue
    source); when absent the landmark lane runs instead.
    """

    def __init__(
        self,
        *,
        jpeg_pipeline_factory: Callable[[QueuedCameraMessageSource], Any] | None = None,
        predictor: GeometricPostureModel | None = None,
        posture_config: PostureRuntimeConfig | None = None,
        transition_config: TransitionDetectorConfig | None = None,
        transition_detector_factory: Callable[[str], Any] | None = None,
        poll_interval_s: float = 0.1,
    ) -> None:
        self._jpeg_pipeline_factory = jpeg_pipeline_factory
        self._predictor = predictor
        self._posture_config = posture_config
        self._transition_config = transition_config
        self._transition_detector_factory = transition_detector_factory
        self._poll_interval_s = poll_interval_s
        self._lock = threading.Lock()
        self._intakes: dict[str, SessionIntake] = {}

    @property
    def mode(self) -> str:
        return "jpeg" if self._jpeg_pipeline_factory is not None else "landmarks"

    def capabilities(self) -> dict[str, Any]:
        jpeg = self._jpeg_pipeline_factory is not None
        accepts = (
            ["frame_meta", "frame", "debug_scenario", "scene_signal"]
            if jpeg
            else ["landmarks_frame", "debug_scenario", "scene_signal"]
        )
        return {
            "camera_input_ws": "/ws/camera-input",
            "accepts": accepts,
            "jpeg_inference": jpeg,
            "landmarks_inference": not jpeg,
        }

    def get_intake(self, session_id: str) -> SessionIntake | None:
        with self._lock:
            return self._intakes.get(session_id)

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Callable[[RuntimeEvent], None],
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None:
        if request.profile is not ModeProfile.LIVE_CAMERA:
            raise BrowserInputError("browser gateway supports live_camera only")
        if self._jpeg_pipeline_factory is not None:
            source = QueuedCameraMessageSource()
            intake = SessionIntake(session_id=request.session_id, mode="jpeg", source=source)
            pipeline = self._jpeg_pipeline_factory(source)
            with self._lock:
                self._intakes[request.session_id] = intake
            try:
                pipeline.run(
                    request,
                    publish=publish,
                    mark_running=mark_running,
                    is_active=is_active,
                )
            finally:
                with self._lock:
                    self._intakes.pop(request.session_id, None)
            return
        transition_detector = (
            None
            if self._transition_detector_factory is None
            else self._transition_detector_factory(request.session_id)
        )
        engine = LandmarkFrameEngine(
            session_id=request.session_id,
            scene_id=request.scene_id,
            publish=publish,
            predictor=self._predictor,
            posture_config=self._posture_config,
            transition_config=self._transition_config,
            transition_detector=transition_detector,
        )
        intake = SessionIntake(session_id=request.session_id, mode="landmarks", engine=engine)
        with self._lock:
            self._intakes[request.session_id] = intake
        mark_running()
        try:
            while is_active():
                time.sleep(self._poll_interval_s)
        finally:
            with self._lock:
                self._intakes.pop(request.session_id, None)


# -- minimal server-side WebSocket receive support ---------------------------


def websocket_accept_value(key: str) -> str:
    """Compute the Sec-WebSocket-Accept header for one client key."""

    digest = hashlib.sha1((key + _WEBSOCKET_GUID).encode("ascii")).digest()
    return base64.b64encode(digest).decode("ascii")


class ByteReader(Protocol):
    """The one stream capability the frame reader needs (rfile-compatible)."""

    def read(self, size: int = ..., /) -> bytes: ...


def read_ws_messages(
    rfile: ByteReader,
    send_control: Callable[[int, bytes], None],
) -> Iterator[tuple[int, bytes]]:
    """Yield (opcode, payload) data messages from one client connection.

    Handles masking, fragmentation, ping (replied via ``send_control``), and
    close (echoed, then iteration ends). Oversized messages abort the
    connection — the input lane never buffers unbounded data.
    """

    fragments: list[bytes] = []
    fragment_opcode = 0
    while True:
        header = _read_exact(rfile, 2)
        if header is None:
            return
        fin = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            extended = _read_exact(rfile, 2)
            if extended is None:
                return
            length = int.from_bytes(extended, "big")
        elif length == 127:
            extended = _read_exact(rfile, 8)
            if extended is None:
                return
            length = int.from_bytes(extended, "big")
        if length > MAX_INPUT_MESSAGE_BYTES:
            send_control(0x8, (1009).to_bytes(2, "big"))
            return
        mask = b""
        if masked:
            mask_bytes = _read_exact(rfile, 4)
            if mask_bytes is None:
                return
            mask = mask_bytes
        payload = _read_exact(rfile, length) if length else b""
        if payload is None:
            return
        if masked and payload:
            payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        if opcode == 0x8:
            send_control(0x8, payload[:125])
            return
        if opcode == 0x9:
            send_control(0xA, payload[:125])
            continue
        if opcode == 0xA:
            continue
        if opcode in (0x1, 0x2):
            if fin:
                fragments = []
                yield opcode, payload
            else:
                fragments = [payload]
                fragment_opcode = opcode
            continue
        if opcode == 0x0:
            if not fragments:
                return
            fragments.append(payload)
            if sum(len(part) for part in fragments) > MAX_INPUT_MESSAGE_BYTES:
                send_control(0x8, (1009).to_bytes(2, "big"))
                return
            if fin:
                yield fragment_opcode, b"".join(fragments)
                fragments = []
            continue
        return


def _read_exact(rfile: ByteReader, count: int) -> bytes | None:
    data = b""
    while len(data) < count:
        chunk = rfile.read(count - len(data))
        if not chunk:
            return None
        data += chunk
    return data


def parse_input_text(payload: bytes) -> tuple[str, dict[str, Any]] | None:
    """Decode one text message; (raw_text, object) or None when not an object."""

    try:
        raw_text = payload.decode("utf-8")
        message = json.loads(raw_text)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(message, dict):
        return None
    return raw_text, message
