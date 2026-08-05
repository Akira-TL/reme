"""Repeatable real-camera reliability and latency acceptance for A's runtime."""

from __future__ import annotations

import argparse
import base64
import json
import math
import platform
import socket
import statistics
import sys
import threading
import time
import urllib.request
import uuid
from collections.abc import Callable, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Protocol, cast

from reme.pose.camera import (
    CameraConfig,
    FrameSource,
    LiveMoveNetStream,
    OpenCVCameraSource,
    PoseEstimator,
)
from reme.pose.movenet import MoveNetEstimator, MoveNetResult
from reme.pose.posture import StaticPostureModel
from reme.pose.posture_runtime import PostureRuntimeConfig, RealtimePostureTracker
from reme.pose.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
    RuntimeSessionState,
)
from reme.pose.runtime_server import (
    DEFAULT_MOVENET_MODEL,
    DEFAULT_POSTURE_MODEL,
    EventBroker,
    PerceptionWorker,
    RuntimeHTTPServer,
    RuntimePerceptionController,
    build_runtime_handler,
)

REPORT_SCHEMA_VERSION = "reme-runtime-reliability/v0-experiment"


class RuntimeBenchmarkError(RuntimeError):
    """Raised when the reliability acceptance cannot be completed safely."""


class MetricSeries:
    """Thread-safe timing samples with deterministic summary statistics."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: list[float] = []

    def add(self, value: float) -> None:
        number = float(value)
        if not math.isfinite(number):
            raise RuntimeBenchmarkError("metric values must be finite")
        with self._lock:
            self._values.append(number)

    def values(self) -> tuple[float, ...]:
        with self._lock:
            return tuple(self._values)

    def extend(self, values: Sequence[float]) -> None:
        for value in values:
            self.add(value)

    def to_payload(self) -> dict[str, float | int | None]:
        values = self.values()
        if not values:
            return {
                "count": 0,
                "average": None,
                "p95": None,
                "minimum": None,
                "maximum": None,
            }
        return {
            "count": len(values),
            "average": _round(statistics.fmean(values)),
            "p95": _round(_percentile(values, 0.95)),
            "minimum": _round(min(values)),
            "maximum": _round(max(values)),
        }


class SessionRecorder:
    """Collect one session's generation, delivery, memory-neutral, and release evidence."""

    def __init__(
        self,
        *,
        session_id: str,
        scene_id: str,
        requested_at: float,
    ) -> None:
        self.session_id = session_id
        self.scene_id = scene_id
        self.requested_at = requested_at
        self._lock = threading.RLock()
        self._stream_started_at: float | None = None
        self._camera_opened_at: float | None = None
        self._camera_closed_at: float | None = None
        self._stop_requested_at: float | None = None
        self._first_frame_at: float | None = None
        self._camera_properties: dict[str, object] | None = None
        self._stream_summary: dict[str, object] | None = None
        self._frame_count = 0
        self._posture_count = 0
        self._errors: list[str] = []
        self.inference_ms = MetricSeries()
        self.processing_ms = MetricSeries()
        self.frame_generation_latency_ms = MetricSeries()
        self.posture_generation_latency_ms = MetricSeries()
        self.websocket_frame_latency_ms = MetricSeries()
        self.websocket_posture_latency_ms = MetricSeries()

    def mark_stream_started(self, timestamp: float) -> None:
        with self._lock:
            if self._stream_started_at is None:
                self._stream_started_at = timestamp

    def mark_camera_opened(
        self, timestamp: float, properties: Mapping[str, object]
    ) -> None:
        with self._lock:
            self._camera_opened_at = timestamp
            self._camera_properties = dict(properties)

    def mark_camera_closed(self, timestamp: float) -> None:
        with self._lock:
            self._camera_closed_at = timestamp

    def mark_stop_requested(self, timestamp: float) -> None:
        with self._lock:
            self._stop_requested_at = timestamp

    def record_inference(self, inference_ms: float, processing_ms: float) -> None:
        self.inference_ms.add(inference_ms)
        self.processing_ms.add(processing_ms)

    def record_generated(self, event: RuntimeEvent, received_at: float) -> None:
        if event.session_id != self.session_id:
            raise RuntimeBenchmarkError(
                f"recorder {self.session_id!r} cannot accept {event.session_id!r}"
            )
        latency = self._event_latency_ms(event, received_at)
        with self._lock:
            if event.event_type is RuntimeEventType.FRAME_LANDMARKS:
                self._frame_count += 1
                if self._first_frame_at is None:
                    self._first_frame_at = received_at
                self.frame_generation_latency_ms.add(latency)
            elif event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
                self._posture_count += 1
                self.posture_generation_latency_ms.add(latency)

    def record_websocket_received(self, event: RuntimeEvent, received_at: float) -> None:
        latency = self._event_latency_ms(event, received_at)
        if event.event_type is RuntimeEventType.FRAME_LANDMARKS:
            self.websocket_frame_latency_ms.add(latency)
        elif event.event_type is RuntimeEventType.POSTURE_OBSERVATION:
            self.websocket_posture_latency_ms.add(latency)

    def set_stream_summary(self, summary: Mapping[str, object]) -> None:
        with self._lock:
            self._stream_summary = dict(summary)

    def add_error(self, message: str) -> None:
        with self._lock:
            self._errors.append(message)

    def frame_count(self) -> int:
        with self._lock:
            return self._frame_count

    def posture_count(self) -> int:
        with self._lock:
            return self._posture_count

    def camera_opened_at(self) -> float | None:
        with self._lock:
            return self._camera_opened_at

    def camera_closed_at(self) -> float | None:
        with self._lock:
            return self._camera_closed_at

    def camera_active_seconds(self, *, now: float | None = None) -> float:
        with self._lock:
            opened = self._camera_opened_at
            closed = self._camera_closed_at
        if opened is None:
            return 0.0
        end = closed if closed is not None else now
        if end is None:
            return 0.0
        return max(end - opened, 0.0)

    def to_payload(self) -> dict[str, object]:
        with self._lock:
            stream_started_at = self._stream_started_at
            camera_opened_at = self._camera_opened_at
            camera_closed_at = self._camera_closed_at
            stop_requested_at = self._stop_requested_at
            first_frame_at = self._first_frame_at
            frame_count = self._frame_count
            posture_count = self._posture_count
            camera_properties = (
                dict(self._camera_properties) if self._camera_properties is not None else None
            )
            summary = dict(self._stream_summary) if self._stream_summary is not None else {}
            errors = list(self._errors)
        elapsed_seconds = _optional_number(summary.get("elapsed_seconds"))
        if elapsed_seconds is None or elapsed_seconds <= 0:
            elapsed_seconds = self.camera_active_seconds()
        output_fps = _optional_number(summary.get("output_fps"))
        if output_fps is None:
            output_fps = frame_count / elapsed_seconds if elapsed_seconds > 0 else 0.0
        posture_hz = posture_count / elapsed_seconds if elapsed_seconds > 0 else 0.0
        first_frame_startup_ms = None
        if first_frame_at is not None:
            first_frame_startup_ms = _round((first_frame_at - self.requested_at) * 1000.0)
        camera_release_ms = None
        if camera_closed_at is not None and stop_requested_at is not None:
            camera_release_ms = _round(
                max(camera_closed_at - stop_requested_at, 0.0) * 1000.0
            )
        return {
            "session_id": self.session_id,
            "scene_id": self.scene_id,
            "stream_started": stream_started_at is not None,
            "camera_opened": camera_opened_at is not None,
            "camera_closed": camera_closed_at is not None,
            "camera_properties": camera_properties,
            "camera_active_seconds": _round(self.camera_active_seconds()),
            "frame_landmarks_count": frame_count,
            "posture_observation_count": posture_count,
            "frame_landmarks_fps": _round(output_fps),
            "posture_observation_hz": _round(posture_hz),
            "movenet_inference_ms": self.inference_ms.to_payload(),
            "single_frame_processing_ms": self.processing_ms.to_payload(),
            "first_frame_startup_ms": first_frame_startup_ms,
            "frame_generation_latency_ms": self.frame_generation_latency_ms.to_payload(),
            "posture_generation_latency_ms": self.posture_generation_latency_ms.to_payload(),
            "websocket_frame_latency_ms": self.websocket_frame_latency_ms.to_payload(),
            "websocket_posture_latency_ms": self.websocket_posture_latency_ms.to_payload(),
            "camera_release_ms": camera_release_ms,
            "errors": errors,
        }

    def _event_latency_ms(self, event: RuntimeEvent, received_at: float) -> float:
        with self._lock:
            stream_started_at = self._stream_started_at
        if stream_started_at is None:
            raise RuntimeBenchmarkError("stream clock is not initialized")
        timestamp_ms = _required_number(event.payload.get("timestamp_ms"), "timestamp_ms")
        return max((received_at - stream_started_at) * 1000.0 - timestamp_ms, 0.0)


class _RecordingFrameSource(FrameSource):
    def __init__(
        self,
        source: OpenCVCameraSource,
        recorder: SessionRecorder,
        clock: Callable[[], float],
    ) -> None:
        self._source = source
        self._recorder = recorder
        self._clock = clock

    def open(self) -> None:
        self._source.open()
        properties = cast(dict[str, object], self._source.properties())
        self._recorder.mark_camera_opened(self._clock(), properties)

    def read(self) -> object | None:
        return self._source.read()

    def close(self) -> None:
        try:
            self._source.close()
        finally:
            self._recorder.mark_camera_closed(self._clock())


class _RecordingEstimator(PoseEstimator):
    def __init__(
        self,
        estimator: MoveNetEstimator,
        recorder: SessionRecorder,
        clock: Callable[[], float],
    ) -> None:
        self._estimator = estimator
        self._recorder = recorder
        self._clock = clock

    def reset(self) -> None:
        self._estimator.reset()

    def infer(self, frame: object) -> MoveNetResult:
        started = self._clock()
        result = self._estimator.infer(frame)
        finished = self._clock()
        self._recorder.record_inference(
            result.inference_ms, max(finished - started, 0.0) * 1000.0
        )
        return result


class _CapturingClock:
    def __init__(self, clock: Callable[[], float], recorder: SessionRecorder) -> None:
        self._clock = clock
        self._recorder = recorder
        self._captured = False
        self._lock = threading.Lock()

    def __call__(self) -> float:
        timestamp = self._clock()
        with self._lock:
            if not self._captured:
                self._captured = True
                self._recorder.mark_stream_started(timestamp)
        return timestamp


class BenchmarkPerceptionWorker(PerceptionWorker):
    """Existing live pipeline plus passive instrumentation at adapter boundaries."""

    def __init__(
        self,
        *,
        camera_config: CameraConfig,
        movenet_model: Path,
        posture_model: Path,
        posture_hz: float,
        score_threshold: float,
        num_threads: int,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.camera_config = camera_config
        self.movenet_model = movenet_model
        self.posture_model = posture_model
        self.posture_hz = posture_hz
        self.score_threshold = score_threshold
        self.num_threads = num_threads
        self.clock = clock
        self._lock = threading.RLock()
        self._recorders: dict[str, SessionRecorder] = {}

    def prepare_session(
        self, request: RuntimeSessionRequest, requested_at: float
    ) -> SessionRecorder:
        recorder = SessionRecorder(
            session_id=request.session_id,
            scene_id=request.scene_id,
            requested_at=requested_at,
        )
        with self._lock:
            self._recorders[request.session_id] = recorder
        return recorder

    def recorder(self, session_id: str) -> SessionRecorder:
        with self._lock:
            recorder = self._recorders.get(session_id)
        if recorder is None:
            raise RuntimeBenchmarkError(f"unknown benchmark session {session_id!r}")
        return recorder

    def recorders(self) -> tuple[SessionRecorder, ...]:
        with self._lock:
            return tuple(self._recorders.values())

    def run(
        self,
        request: RuntimeSessionRequest,
        *,
        publish: Callable[[RuntimeEvent], None],
        mark_running: Callable[[], None],
        is_active: Callable[[], bool],
    ) -> None:
        recorder = self.recorder(request.session_id)
        source = _RecordingFrameSource(
            OpenCVCameraSource(self.camera_config), recorder, self.clock
        )
        estimator = _RecordingEstimator(
            MoveNetEstimator(
                self.movenet_model,
                score_threshold=self.score_threshold,
                num_threads=self.num_threads,
            ),
            recorder,
            self.clock,
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
        stream = LiveMoveNetStream(
            session_id=request.session_id,
            scene_id=request.scene_id,
            frame_source=source,
            estimator=estimator,
            clock=_CapturingClock(self.clock, recorder),
            is_session_active=lambda _session_id: is_active(),
        )
        events = stream.iter_events()
        announced = False
        try:
            for frame_event in events:
                if not announced:
                    mark_running()
                    announced = True
                recorder.record_generated(frame_event, self.clock())
                publish(frame_event)
                posture_event = tracker.process_frame_event(frame_event)
                if posture_event is not None:
                    recorder.record_generated(posture_event, self.clock())
                    publish(posture_event)
        except Exception as exc:
            recorder.add_error(f"{type(exc).__name__}: {exc}")
            raise
        finally:
            events.close()
            summary = stream.summary
            if summary is not None:
                recorder.set_stream_summary(summary.to_payload())


class MemorySampler:
    """Sample current-process RSS without persisting frames or process dumps."""

    def __init__(
        self,
        *,
        interval_seconds: float = 0.5,
        reader: Callable[[], float] | None = None,
    ) -> None:
        if interval_seconds <= 0:
            raise RuntimeBenchmarkError("memory sample interval must be positive")
        self.interval_seconds = interval_seconds
        self.reader = reader or _read_rss_mb
        self._lock = threading.Lock()
        self._samples: list[float] = []
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            raise RuntimeBenchmarkError("memory sampler is already running")
        self._sample()
        self._thread = threading.Thread(target=self._run, name="reme-memory-sampler", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None:
            thread.join(timeout=max(self.interval_seconds * 2.0, 1.0))
        self._sample()

    def to_payload(self) -> dict[str, float | int | None]:
        with self._lock:
            samples = tuple(self._samples)
        if not samples:
            return {
                "samples": 0,
                "start_mb": None,
                "peak_mb": None,
                "end_mb": None,
                "growth_mb": None,
            }
        return {
            "samples": len(samples),
            "start_mb": _round(samples[0]),
            "peak_mb": _round(max(samples)),
            "end_mb": _round(samples[-1]),
            "growth_mb": _round(samples[-1] - samples[0]),
        }

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            self._sample()

    def _sample(self) -> None:
        value = self.reader()
        with self._lock:
            self._samples.append(value)


class _EventCallback(Protocol):
    def __call__(self, event: RuntimeEvent, received_at: float) -> None: ...


class WebSocketProbe:
    """Minimal local WebSocket client used only for runtime acceptance evidence."""

    def __init__(
        self,
        *,
        host: str,
        port: int,
        session_id: str,
        callback: _EventCallback,
        read_delay_seconds: float = 0.0,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.host = host
        self.port = port
        self.session_id = session_id
        self.callback = callback
        self.read_delay_seconds = read_delay_seconds
        self.clock = clock
        self._socket: socket.socket | None = None
        self._buffer = bytearray()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._condition = threading.Condition()
        self._received: list[RuntimeEvent] = []
        self._error: str | None = None
        self._server_closed = False
        self._expected_abort = False

    def connect(self) -> None:
        sock = socket.create_connection((self.host, self.port), timeout=5.0)
        sock.settimeout(1.0)
        key = base64.b64encode(uuid.uuid4().bytes).decode("ascii")
        request = (
            f"GET /ws/events?session_id={self.session_id} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        sock.sendall(request)
        response = self._read_handshake(sock)
        if b"101 Switching Protocols" not in response:
            sock.close()
            raise RuntimeBenchmarkError(
                f"WebSocket handshake failed for {self.session_id}: {response[:200]!r}"
            )
        self._socket = sock
        self._thread = threading.Thread(
            target=self._run,
            name=f"reme-ws-probe-{self.session_id}",
            daemon=True,
        )
        self._thread.start()

    def received_count(self) -> int:
        with self._condition:
            return len(self._received)

    def session_ids(self) -> set[str]:
        with self._condition:
            return {event.session_id for event in self._received}

    def wait_for_count(self, minimum: int, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            while len(self._received) < minimum:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(timeout=remaining)
            return True

    def wait_for_server_close(self, timeout: float = 10.0) -> bool:
        deadline = time.monotonic() + timeout
        with self._condition:
            while not self._server_closed:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                self._condition.wait(timeout=remaining)
            return True

    def error(self) -> str | None:
        with self._condition:
            return self._error

    def abort(self) -> None:
        self._expected_abort = True
        self.close()

    def close(self) -> None:
        self._stop.set()
        sock = self._socket
        if sock is not None:
            with suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
            sock.close()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _run(self) -> None:
        try:
            while not self._stop.is_set():
                if self.read_delay_seconds > 0 and self._stop.wait(
                    self.read_delay_seconds
                ):
                    return
                opcode, payload = self._read_frame()
                if opcode == 0x8:
                    with self._condition:
                        self._server_closed = True
                        self._condition.notify_all()
                    return
                if opcode == 0x9:
                    continue
                if opcode != 0x1:
                    continue
                event = _runtime_event_from_payload(json.loads(payload.decode("utf-8")))
                received_at = self.clock()
                with self._condition:
                    self._received.append(event)
                    self._condition.notify_all()
                self.callback(event, received_at)
        except (ConnectionError, OSError, ValueError, json.JSONDecodeError) as exc:
            if not self._stop.is_set() and not self._expected_abort:
                with self._condition:
                    self._error = f"{type(exc).__name__}: {exc}"
                    self._condition.notify_all()

    def _read_frame(self) -> tuple[int, bytes]:
        header = self._read_exact(2)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = int.from_bytes(self._read_exact(2), "big")
        elif length == 127:
            length = int.from_bytes(self._read_exact(8), "big")
        mask = self._read_exact(4) if masked else None
        payload = self._read_exact(length)
        if mask is not None:
            payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
        return opcode, payload

    def _read_exact(self, size: int) -> bytes:
        sock = self._socket
        if sock is None:
            raise ConnectionError("WebSocket is not connected")
        while len(self._buffer) < size:
            try:
                chunk = sock.recv(max(size - len(self._buffer), 4096))
            except TimeoutError as exc:
                if self._stop.is_set():
                    raise ConnectionError("WebSocket probe stopped") from exc
                continue
            if not chunk:
                raise ConnectionError("WebSocket connection closed")
            self._buffer.extend(chunk)
        data = bytes(self._buffer[:size])
        del self._buffer[:size]
        return data

    def _read_handshake(self, sock: socket.socket) -> bytes:
        response = bytearray()
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeBenchmarkError("WebSocket handshake closed early")
            response.extend(chunk)
            if len(response) > 65536:
                raise RuntimeBenchmarkError("WebSocket handshake exceeded 64 KiB")
        header_end = response.index(b"\r\n\r\n") + 4
        self._buffer.extend(response[header_end:])
        return bytes(response[:header_end])


@dataclass(frozen=True, slots=True)
class AcceptanceThresholds:
    """Explicit engineering thresholds used by the acceptance command."""

    min_frame_fps: float = 15.0
    min_posture_hz: float = 5.0
    max_posture_hz: float = 10.0
    max_websocket_frame_p95_ms: float = 300.0
    max_websocket_posture_p95_ms: float = 500.0
    max_posture_generation_p95_ms: float = 500.0
    max_first_frame_startup_ms: float = 30000.0
    max_camera_release_ms: float = 5000.0
    max_memory_growth_mb: float = 128.0
    duration_tolerance_seconds: float = 1.0

    def to_payload(self) -> dict[str, float]:
        return {
            "min_frame_fps": self.min_frame_fps,
            "min_posture_hz": self.min_posture_hz,
            "max_posture_hz": self.max_posture_hz,
            "max_websocket_frame_p95_ms": self.max_websocket_frame_p95_ms,
            "max_websocket_posture_p95_ms": self.max_websocket_posture_p95_ms,
            "max_posture_generation_p95_ms": self.max_posture_generation_p95_ms,
            "max_first_frame_startup_ms": self.max_first_frame_startup_ms,
            "max_camera_release_ms": self.max_camera_release_ms,
            "max_memory_growth_mb": self.max_memory_growth_mb,
            "duration_tolerance_seconds": self.duration_tolerance_seconds,
        }


@dataclass(frozen=True, slots=True)
class BenchmarkConfig:
    """CLI configuration for one formal device acceptance."""

    duration_seconds: float
    restart_after_seconds: float
    host: str
    port: int
    camera: CameraConfig
    movenet_model: Path
    posture_model: Path
    posture_hz: float
    score_threshold: float
    num_threads: int
    websocket_queue_size: int
    slow_client_delay_seconds: float
    progress_seconds: float
    memory_sample_seconds: float
    report_json: Path
    report_markdown: Path
    session_prefix: str
    thresholds: AcceptanceThresholds
    command: str

    def __post_init__(self) -> None:
        if self.duration_seconds <= 0:
            raise RuntimeBenchmarkError("duration_seconds must be positive")
        if not 0 < self.restart_after_seconds < self.duration_seconds:
            raise RuntimeBenchmarkError(
                "restart_after_seconds must be positive and less than duration_seconds"
            )
        if self.port < 0 or self.port > 65535:
            raise RuntimeBenchmarkError("port must be between 0 and 65535")
        if self.websocket_queue_size < 1:
            raise RuntimeBenchmarkError("websocket_queue_size must be positive")
        if self.slow_client_delay_seconds <= 0:
            raise RuntimeBenchmarkError("slow_client_delay_seconds must be positive")
        if self.progress_seconds <= 0:
            raise RuntimeBenchmarkError("progress_seconds must be positive")
        if not self.movenet_model.is_file():
            raise RuntimeBenchmarkError(f"MoveNet model not found: {self.movenet_model}")
        if not self.posture_model.is_file():
            raise RuntimeBenchmarkError(f"posture model not found: {self.posture_model}")


def evaluate_acceptance(
    report: Mapping[str, object], thresholds: AcceptanceThresholds
) -> dict[str, object]:
    """Evaluate only explicit runtime targets and isolation evidence."""

    requested = _mapping_number(report, "requested_camera_seconds")
    metrics = _mapping(report, "metrics")
    evidence = _mapping(report, "evidence")
    memory = _mapping(metrics, "memory")
    release = _mapping(metrics, "camera_release_ms")
    frame_ws = _mapping(metrics, "websocket_frame_latency_ms")
    posture_ws = _mapping(metrics, "websocket_posture_latency_ms")
    posture_generation = _mapping(metrics, "posture_generation_latency_ms")
    runtime_errors = evidence.get("runtime_errors")
    checks = {
        "ten_minute_camera_run": _mapping_number(metrics, "camera_active_seconds")
        >= requested - thresholds.duration_tolerance_seconds,
        "frame_landmarks_fps": _mapping_number(metrics, "frame_landmarks_fps")
        >= thresholds.min_frame_fps,
        "posture_observation_hz": thresholds.min_posture_hz
        <= _mapping_number(metrics, "posture_observation_hz")
        <= thresholds.max_posture_hz,
        "first_frame_startup": _mapping_number(metrics, "first_frame_startup_ms")
        <= thresholds.max_first_frame_startup_ms,
        "posture_generation_latency": _mapping_number(
            posture_generation, "p95"
        )
        <= thresholds.max_posture_generation_p95_ms,
        "websocket_frame_latency": _mapping_number(frame_ws, "p95")
        <= thresholds.max_websocket_frame_p95_ms,
        "websocket_posture_latency": _mapping_number(posture_ws, "p95")
        <= thresholds.max_websocket_posture_p95_ms,
        "memory_growth": _mapping_number(memory, "growth_mb")
        <= thresholds.max_memory_growth_mb,
        "camera_release": _mapping_number(release, "maximum")
        <= thresholds.max_camera_release_ms,
        "restart_performed": _mapping_bool(evidence, "restart_performed"),
        "old_websocket_closed": _mapping_bool(evidence, "old_websocket_closed"),
        "old_websocket_rejects_new_events": not _mapping_bool(
            evidence, "old_websocket_received_new_session"
        ),
        "new_session_rejects_old_events": not _mapping_bool(
            evidence, "new_websocket_received_old_session"
        ),
        "slow_client_non_blocking": _mapping_bool(
            evidence, "slow_client_did_not_block"
        ),
        "abnormal_disconnect_resilience": _mapping_bool(
            evidence, "abnormal_disconnect_survived"
        ),
        "no_raw_frame_persistence": not _mapping_bool(
            evidence, "raw_frames_written"
        )
        and not _mapping_bool(evidence, "raw_video_recorded"),
        "no_runtime_errors": isinstance(runtime_errors, list) and not runtime_errors,
    }
    return {"all_passed": all(checks.values()), "checks": checks}


def render_markdown(report: Mapping[str, object]) -> str:
    """Render the machine report as a concise reviewable acceptance record."""

    metrics = _mapping(report, "metrics")
    evidence = _mapping(report, "evidence")
    acceptance = _mapping(report, "acceptance")
    checks = _mapping(acceptance, "checks")
    inference = _mapping(metrics, "movenet_inference_ms")
    processing = _mapping(metrics, "single_frame_processing_ms")
    posture_generation = _mapping(metrics, "posture_generation_latency_ms")
    frame_ws = _mapping(metrics, "websocket_frame_latency_ms")
    posture_ws = _mapping(metrics, "websocket_posture_latency_ms")
    memory = _mapping(metrics, "memory")
    release = _mapping(metrics, "camera_release_ms")
    status = "通过" if bool(acceptance.get("all_passed")) else "未通过"
    frame_count = int(_number_or_zero(metrics.get("frame_landmarks_count")))
    posture_count = int(_number_or_zero(metrics.get("posture_observation_count")))
    old_rejects_new = not bool(evidence.get("old_websocket_received_new_session"))
    new_rejects_old = not bool(evidence.get("new_websocket_received_old_session"))

    def latency_text(values: Mapping[str, object]) -> str:
        average = _fmt(values.get("average"))
        p95 = _fmt(values.get("p95"))
        return f"avg {average} ms / P95 {p95} ms"

    lines = [
        "# Reme 实时链路稳定性验收",
        "",
        f"- 报告版本：`{report.get('schema_version', REPORT_SCHEMA_VERSION)}`",
        f"- 开始：`{report.get('started_at', 'unknown')}`",
        f"- 结束：`{report.get('finished_at', 'unknown')}`",
        f"- 结论：**{status}**",
        f"- 命令：`{report.get('command', '')}`",
        "",
        "## 核心指标",
        "",
        "| 指标 | 实测 |",
        "|---|---:|",
        (
            "| 摄像头有效运行 | "
            f"{_fmt(metrics.get('camera_active_seconds'))} s |"
        ),
        (
            f"| FrameLandmarks | {frame_count} 帧 / "
            f"{_fmt(metrics.get('frame_landmarks_fps'))} FPS |"
        ),
        (
            f"| PostureObservation | {posture_count} 条 / "
            f"{_fmt(metrics.get('posture_observation_hz'))} Hz |"
        ),
        f"| MoveNet 推理 | {latency_text(inference)} |",
        f"| 单帧处理 | {latency_text(processing)} |",
        f"| 首帧启动 | {_fmt(metrics.get('first_frame_startup_ms'))} ms |",
        f"| 姿态事件生成延迟 | {latency_text(posture_generation)} |",
        f"| WebSocket 关键点延迟 | {latency_text(frame_ws)} |",
        f"| WebSocket 姿态延迟 | {latency_text(posture_ws)} |",
        (
            f"| 内存 | start {_fmt(memory.get('start_mb'))} MB / "
            f"peak {_fmt(memory.get('peak_mb'))} MB / "
            f"end {_fmt(memory.get('end_mb'))} MB |"
        ),
        f"| 内存增长 | {_fmt(memory.get('growth_mb'))} MB |",
        (
            f"| 摄像头释放 | avg {_fmt(release.get('average'))} ms / "
            f"max {_fmt(release.get('maximum'))} ms |"
        ),
        "",
        "## Session 与客户端证据",
        "",
        f"- 重启旧 session：{_yes_no(evidence.get('restart_performed'))}",
        f"- 旧 WebSocket 正常关闭：{_yes_no(evidence.get('old_websocket_closed'))}",
        f"- 旧 WebSocket 未收到新 session：{_yes_no(old_rejects_new)}",
        f"- 新 session 未收到旧事件：{_yes_no(new_rejects_old)}",
        (
            "- 慢客户端未阻塞推理："
            f"{_yes_no(evidence.get('slow_client_did_not_block'))}"
        ),
        (
            "- 异常断开后服务继续运行："
            f"{_yes_no(evidence.get('abnormal_disconnect_survived'))}"
        ),
        f"- 原始帧落盘：{_yes_no(evidence.get('raw_frames_written'))}",
        f"- 原始视频录制：{_yes_no(evidence.get('raw_video_recorded'))}",
        "",
        "## 验收检查",
        "",
    ]
    for name, passed in checks.items():
        lines.append(f"- {'✅' if bool(passed) else '❌'} `{name}`")
    if not bool(checks.get("memory_growth")):
        lines.extend(
            [
                "",
                "## 内存判定说明",
                "",
                (
                    "本次 RSS 起点位于 LiteRT、OpenCV 和模型首次初始化之前。"
                    "起止增长包含原生运行时初始化与分配器缓存，不能仅据此判定内存泄漏。"
                    "因此保留失败项，并要求后续增加预热后基线和多次 session 重启斜率验证。"
                ),
            ]
        )
    runtime_errors = evidence.get("runtime_errors")
    if isinstance(runtime_errors, list) and runtime_errors:
        lines.extend(["", "## 运行错误", ""])
        lines.extend(f"- {error}" for error in runtime_errors)
    sessions = report.get("sessions")
    if isinstance(sessions, list) and sessions:
        lines.extend(["", "## 分 Session 指标", ""])
        for item in sessions:
            if not isinstance(item, dict):
                continue
            lines.extend(
                [
                    f"### `{item.get('session_id', 'unknown')}`",
                    "",
                    (
                        "- 摄像头有效运行："
                        f"{_fmt(item.get('camera_active_seconds'))} s"
                    ),
                    (
                        f"- FrameLandmarks：{item.get('frame_landmarks_count', 0)} / "
                        f"{_fmt(item.get('frame_landmarks_fps'))} FPS"
                    ),
                    (
                        "- PostureObservation："
                        f"{item.get('posture_observation_count', 0)} / "
                        f"{_fmt(item.get('posture_observation_hz'))} Hz"
                    ),
                    f"- 首帧：{_fmt(item.get('first_frame_startup_ms'))} ms",
                    f"- 摄像头释放：{_fmt(item.get('camera_release_ms'))} ms",
                    "",
                ]
            )
    lines.extend(
        [
            "## 隐私与解释边界",
            "",
            (
                "本验收默认仅在内存中处理摄像头帧，不保存原始帧或视频。"
                "延迟和置信度是工程测量，不代表医疗准确率或跌倒识别准确率。"
            ),
            "",
        ]
    )
    return "\n".join(lines)


def run_benchmark(config: BenchmarkConfig) -> dict[str, object]:
    """Run the formal device acceptance and return a complete report."""

    started_wall = datetime.now(UTC)
    clock = time.perf_counter
    runtime_errors: list[str] = []
    evidence: dict[str, object] = {
        "restart_performed": False,
        "old_websocket_closed": False,
        "old_websocket_received_new_session": False,
        "new_websocket_received_old_session": False,
        "slow_client_did_not_block": False,
        "abnormal_disconnect_survived": False,
        "raw_frames_written": False,
        "raw_video_recorded": False,
        "runtime_errors": runtime_errors,
    }
    worker = BenchmarkPerceptionWorker(
        camera_config=config.camera,
        movenet_model=config.movenet_model,
        posture_model=config.posture_model,
        posture_hz=config.posture_hz,
        score_threshold=config.score_threshold,
        num_threads=config.num_threads,
        clock=clock,
    )
    controller = RuntimePerceptionController(
        worker=worker,
        broker=EventBroker(queue_size=config.websocket_queue_size),
    )
    server = RuntimeHTTPServer((config.host, config.port), build_runtime_handler(controller))
    server_thread = threading.Thread(
        target=server.serve_forever, name="reme-runtime-benchmark-server", daemon=True
    )
    memory = MemorySampler(interval_seconds=config.memory_sample_seconds)
    probes: list[WebSocketProbe] = []
    server_thread.start()
    memory.start()
    actual_port = int(server.server_port)
    base_url = f"http://{config.host}:{actual_port}"
    old_id = f"{config.session_prefix}-old"
    new_id = f"{config.session_prefix}-new"
    old_request = _live_request(old_id, f"{config.session_prefix}-scene-old")
    new_request = _live_request(new_id, f"{config.session_prefix}-scene-new")

    def callback(event: RuntimeEvent, received_at: float) -> None:
        try:
            worker.recorder(event.session_id).record_websocket_received(event, received_at)
        except RuntimeBenchmarkError as exc:
            runtime_errors.append(str(exc))

    def stress_callback(event: RuntimeEvent, received_at: float) -> None:
        del event, received_at

    old_probe = WebSocketProbe(
        host=config.host,
        port=actual_port,
        session_id=old_id,
        callback=callback,
    )
    slow_probe = WebSocketProbe(
        host=config.host,
        port=actual_port,
        session_id=old_id,
        callback=stress_callback,
        read_delay_seconds=config.slow_client_delay_seconds,
    )
    probes.extend((old_probe, slow_probe))

    try:
        old_probe.connect()
        slow_probe.connect()
        old_recorder = worker.prepare_session(old_request, clock())
        _post_json(base_url, "/api/runtime/start", old_request.to_payload())
        _wait_running(base_url, old_id)
        if not old_probe.wait_for_count(5, timeout=20.0):
            raise RuntimeBenchmarkError("old session WebSocket did not receive five events")

        abnormal_probe = WebSocketProbe(
            host=config.host,
            port=actual_port,
            session_id=old_id,
            callback=stress_callback,
        )
        probes.append(abnormal_probe)
        abnormal_probe.connect()
        if not abnormal_probe.wait_for_count(1, timeout=10.0):
            raise RuntimeBenchmarkError("abnormal-disconnect probe did not receive an event")
        normal_before_abort = old_probe.received_count()
        abnormal_probe.abort()
        if not old_probe.wait_for_count(normal_before_abort + 10, timeout=10.0):
            raise RuntimeBenchmarkError(
                "normal WebSocket stopped receiving after abnormal client disconnect"
            )
        _require_running(base_url, old_id)
        evidence["abnormal_disconnect_survived"] = True

        frames_before_slow_check = old_recorder.frame_count()
        normal_before_slow_check = old_probe.received_count()
        _sleep_with_health_checks(
            base_url,
            old_id,
            duration_seconds=min(3.0, config.restart_after_seconds / 2.0),
        )
        evidence["slow_client_did_not_block"] = (
            old_recorder.frame_count() >= frames_before_slow_check + 10
            and old_probe.received_count() >= normal_before_slow_check + 10
        )

        _run_active_phase(
            base_url=base_url,
            session_id=old_id,
            recorder=old_recorder,
            target_active_seconds=config.restart_after_seconds,
            progress_seconds=config.progress_seconds,
            total_target_seconds=config.duration_seconds,
            completed_before=0.0,
        )
        old_recorder.mark_stop_requested(clock())
        _post_json(base_url, "/api/runtime/stop", {"session_id": old_id})
        evidence["restart_performed"] = True
        evidence["old_websocket_closed"] = old_probe.wait_for_server_close(timeout=10.0)
        slow_probe.abort()

        new_probe = WebSocketProbe(
            host=config.host,
            port=actual_port,
            session_id=new_id,
            callback=callback,
        )
        probes.append(new_probe)
        new_probe.connect()
        new_recorder = worker.prepare_session(new_request, clock())
        _post_json(base_url, "/api/runtime/start", new_request.to_payload())
        _wait_running(base_url, new_id)
        if not new_probe.wait_for_count(5, timeout=20.0):
            raise RuntimeBenchmarkError("new session WebSocket did not receive five events")

        stale_event = RuntimeEvent(
            session_id=old_id,
            sequence=2_000_000_000,
            event_type=RuntimeEventType.FRAME_LANDMARKS,
            payload={
                "scene_id": old_request.scene_id,
                "frame_index": 2_000_000_000,
                "timestamp_ms": 0.0,
            },
        )
        controller.broker.publish(stale_event)
        time.sleep(0.25)
        evidence["new_websocket_received_old_session"] = old_id in new_probe.session_ids()
        evidence["old_websocket_received_new_session"] = new_id in old_probe.session_ids()

        old_active = old_recorder.camera_active_seconds()
        remaining = max(config.duration_seconds - old_active, 0.1)
        _run_active_phase(
            base_url=base_url,
            session_id=new_id,
            recorder=new_recorder,
            target_active_seconds=remaining,
            progress_seconds=config.progress_seconds,
            total_target_seconds=config.duration_seconds,
            completed_before=old_active,
        )
        new_recorder.mark_stop_requested(clock())
        _post_json(base_url, "/api/runtime/stop", {"session_id": new_id})
        new_probe.wait_for_server_close(timeout=10.0)
    except Exception as exc:
        runtime_errors.append(f"{type(exc).__name__}: {exc}")
    finally:
        active_session = controller.active_session_id()
        if active_session is not None:
            try:
                worker.recorder(active_session).mark_stop_requested(clock())
                controller.stop(active_session)
            except Exception as exc:
                runtime_errors.append(f"cleanup {type(exc).__name__}: {exc}")
        for probe in probes:
            probe.close()
            if probe.error() is not None:
                runtime_errors.append(f"WebSocket {probe.session_id}: {probe.error()}")
        memory.stop()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=5.0)

    session_recorders = worker.recorders()
    session_payloads = [recorder.to_payload() for recorder in session_recorders]
    metrics = _aggregate_metrics(session_recorders, memory.to_payload())
    finished_wall = datetime.now(UTC)
    report: dict[str, object] = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "started_at": started_wall.isoformat().replace("+00:00", "Z"),
        "finished_at": finished_wall.isoformat().replace("+00:00", "Z"),
        "command": config.command,
        "requested_camera_seconds": config.duration_seconds,
        "configuration": {
            "host": config.host,
            "port": actual_port,
            "camera": {
                "device_index": config.camera.device_index,
                "width": config.camera.width,
                "height": config.camera.height,
                "fps": config.camera.fps,
                "fourcc": config.camera.fourcc,
            },
            "movenet_model": str(config.movenet_model),
            "posture_model": str(config.posture_model),
            "posture_hz": config.posture_hz,
            "score_threshold": config.score_threshold,
            "num_threads": config.num_threads,
            "websocket_queue_size": config.websocket_queue_size,
            "slow_client_delay_seconds": config.slow_client_delay_seconds,
            "restart_after_seconds": config.restart_after_seconds,
            "raw_frames_written": False,
            "raw_video_recorded": False,
        },
        "environment": {
            "python": platform.python_version(),
            "platform": platform.platform(),
        },
        "thresholds": config.thresholds.to_payload(),
        "metrics": metrics,
        "evidence": evidence,
        "sessions": session_payloads,
    }
    report["acceptance"] = evaluate_acceptance(report, config.thresholds)
    return report


def _aggregate_metrics(
    recorders: Sequence[SessionRecorder], memory: Mapping[str, object]
) -> dict[str, object]:
    active_seconds = sum(recorder.camera_active_seconds() for recorder in recorders)
    frame_count = sum(recorder.frame_count() for recorder in recorders)
    posture_count = sum(recorder.posture_count() for recorder in recorders)
    inference = MetricSeries()
    processing = MetricSeries()
    frame_generation = MetricSeries()
    posture_generation = MetricSeries()
    frame_ws = MetricSeries()
    posture_ws = MetricSeries()
    startup = MetricSeries()
    release = MetricSeries()
    for recorder in recorders:
        inference.extend(recorder.inference_ms.values())
        processing.extend(recorder.processing_ms.values())
        frame_generation.extend(recorder.frame_generation_latency_ms.values())
        posture_generation.extend(recorder.posture_generation_latency_ms.values())
        frame_ws.extend(recorder.websocket_frame_latency_ms.values())
        posture_ws.extend(recorder.websocket_posture_latency_ms.values())
        payload = recorder.to_payload()
        first_frame = _optional_number(payload.get("first_frame_startup_ms"))
        if first_frame is not None:
            startup.add(first_frame)
        camera_release = _optional_number(payload.get("camera_release_ms"))
        if camera_release is not None:
            release.add(camera_release)
    startup_payload = startup.to_payload()
    return {
        "camera_active_seconds": _round(active_seconds),
        "camera_frame_count": frame_count,
        "frame_landmarks_count": frame_count,
        "frame_landmarks_fps": _round(
            frame_count / active_seconds if active_seconds > 0 else 0.0
        ),
        "posture_observation_count": posture_count,
        "posture_observation_hz": _round(
            posture_count / active_seconds if active_seconds > 0 else 0.0
        ),
        "movenet_inference_ms": inference.to_payload(),
        "single_frame_processing_ms": processing.to_payload(),
        "first_frame_startup_ms": startup_payload["maximum"],
        "first_frame_startup_samples_ms": startup_payload,
        "frame_generation_latency_ms": frame_generation.to_payload(),
        "posture_generation_latency_ms": posture_generation.to_payload(),
        "websocket_frame_latency_ms": frame_ws.to_payload(),
        "websocket_posture_latency_ms": posture_ws.to_payload(),
        "memory": dict(memory),
        "camera_release_ms": release.to_payload(),
    }


def _run_active_phase(
    *,
    base_url: str,
    session_id: str,
    recorder: SessionRecorder,
    target_active_seconds: float,
    progress_seconds: float,
    total_target_seconds: float,
    completed_before: float,
) -> None:
    deadline = time.monotonic() + 30.0
    opened_at = recorder.camera_opened_at()
    while opened_at is None and time.monotonic() < deadline:
        _require_running(base_url, session_id)
        time.sleep(0.05)
        opened_at = recorder.camera_opened_at()
    if opened_at is None:
        raise RuntimeBenchmarkError(f"camera did not open for session {session_id}")
    next_progress = progress_seconds
    while True:
        active = recorder.camera_active_seconds(now=time.perf_counter())
        if active >= target_active_seconds:
            return
        _require_running(base_url, session_id)
        if active >= next_progress:
            total = completed_before + active
            print(
                json.dumps(
                    {
                        "progress": "runtime-reliability",
                        "session_id": session_id,
                        "camera_active_seconds": _round(total),
                        "target_seconds": total_target_seconds,
                        "frames": recorder.frame_count(),
                        "posture_observations": recorder.posture_count(),
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
                flush=True,
            )
            next_progress += progress_seconds
        time.sleep(min(1.0, max(target_active_seconds - active, 0.05)))


def _sleep_with_health_checks(
    base_url: str, session_id: str, *, duration_seconds: float
) -> None:
    deadline = time.monotonic() + duration_seconds
    while time.monotonic() < deadline:
        _require_running(base_url, session_id)
        time.sleep(min(0.25, max(deadline - time.monotonic(), 0.01)))


def _wait_running(base_url: str, session_id: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    last_status: object = None
    while time.monotonic() < deadline:
        last_status = _get_json(base_url, "/api/runtime/status")
        if isinstance(last_status, dict):
            if (
                last_status.get("session_id") == session_id
                and last_status.get("state") == RuntimeSessionState.RUNNING.value
            ):
                return
            if last_status.get("state") == RuntimeSessionState.DEGRADED.value:
                raise RuntimeBenchmarkError(
                    f"session {session_id} degraded: {last_status.get('reason')}"
                )
        time.sleep(0.05)
    raise RuntimeBenchmarkError(
        f"session {session_id} did not reach running; last status={last_status!r}"
    )


def _require_running(base_url: str, session_id: str) -> None:
    status = _get_json(base_url, "/api/runtime/status")
    if not isinstance(status, dict):
        raise RuntimeBenchmarkError("runtime status is not an object")
    if status.get("session_id") != session_id or status.get("state") != "running":
        raise RuntimeBenchmarkError(
            f"session {session_id} is not running: {status!r}"
        )


def _live_request(session_id: str, scene_id: str) -> RuntimeSessionRequest:
    return RuntimeSessionRequest(
        session_id=session_id,
        profile=ModeProfile.LIVE_CAMERA,
        scene_id=scene_id,
        camera_id="default",
    )


def _post_json(base: str, path: str, payload: Mapping[str, object]) -> object:
    request = urllib.request.Request(
        f"{base}{path}",
        data=json.dumps(dict(payload)).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10.0) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(base: str, path: str) -> object:
    with urllib.request.urlopen(f"{base}{path}", timeout=10.0) as response:
        return json.loads(response.read().decode("utf-8"))


def _runtime_event_from_payload(payload: object) -> RuntimeEvent:
    if not isinstance(payload, dict):
        raise ValueError("runtime event must be an object")
    session_id = payload.get("session_id")
    sequence = payload.get("sequence")
    event_type = payload.get("event_type")
    event_payload = payload.get("payload")
    if not isinstance(session_id, str):
        raise ValueError("runtime event session_id must be a string")
    if isinstance(sequence, bool) or not isinstance(sequence, int):
        raise ValueError("runtime event sequence must be an integer")
    if not isinstance(event_type, str):
        raise ValueError("runtime event event_type must be a string")
    if not isinstance(event_payload, dict):
        raise ValueError("runtime event payload must be an object")
    return RuntimeEvent(
        session_id=session_id,
        sequence=sequence,
        event_type=RuntimeEventType(event_type),
        payload=cast(dict[str, Any], event_payload),
    )


def _read_rss_mb() -> float:
    status_path = Path("/proc/self/status")
    if status_path.is_file():
        for line in status_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("VmRSS:"):
                fields = line.split()
                if len(fields) >= 2:
                    return float(fields[1]) / 1024.0
    try:
        import resource
    except ImportError as exc:  # pragma: no cover - Linux is the target runtime
        raise RuntimeBenchmarkError("cannot read process RSS") from exc
    rss = float(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)
    return rss / 1024.0 if sys.platform != "darwin" else rss / (1024.0 * 1024.0)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration-seconds", type=float, default=600.0)
    parser.add_argument("--restart-after-seconds", type=float, default=60.0)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--camera", type=int, default=0)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--fourcc", default="MJPG")
    parser.add_argument("--movenet-model", type=Path, default=DEFAULT_MOVENET_MODEL)
    parser.add_argument("--posture-model", type=Path, default=DEFAULT_POSTURE_MODEL)
    parser.add_argument("--posture-hz", type=float, default=7.5)
    parser.add_argument("--score-threshold", type=float, default=0.2)
    parser.add_argument("--num-threads", type=int, default=4)
    parser.add_argument("--websocket-queue-size", type=int, default=8)
    parser.add_argument("--slow-client-delay-seconds", type=float, default=0.5)
    parser.add_argument("--progress-seconds", type=float, default=60.0)
    parser.add_argument("--memory-sample-seconds", type=float, default=0.5)
    parser.add_argument("--session-prefix", default="runtime-reliability")
    parser.add_argument("--report-json", type=Path, default=None)
    parser.add_argument("--report-markdown", type=Path, default=None)
    parser.add_argument("--max-memory-growth-mb", type=float, default=128.0)
    parser.add_argument("--max-camera-release-ms", type=float, default=5000.0)
    parser.add_argument("--max-first-frame-startup-ms", type=float, default=30000.0)
    return parser


def _config_from_args(args: argparse.Namespace, argv: Sequence[str] | None) -> BenchmarkConfig:
    date = datetime.now().date().isoformat()
    default_prefix = Path(
        f".scratch/perception-runtime/results/{date}-runtime-reliability"
    )
    report_json = args.report_json or default_prefix.with_suffix(".json")
    report_markdown = args.report_markdown or default_prefix.with_suffix(".md")
    raw_argv = list(argv) if argv is not None else sys.argv[1:]
    command = "python -m reme.pose.runtime_benchmark"
    if raw_argv:
        command = f"{command} {' '.join(raw_argv)}"
    return BenchmarkConfig(
        duration_seconds=args.duration_seconds,
        restart_after_seconds=args.restart_after_seconds,
        host=args.host,
        port=args.port,
        camera=CameraConfig(
            device_index=args.camera,
            width=args.width,
            height=args.height,
            fps=args.fps,
            fourcc=args.fourcc,
        ),
        movenet_model=args.movenet_model,
        posture_model=args.posture_model,
        posture_hz=args.posture_hz,
        score_threshold=args.score_threshold,
        num_threads=args.num_threads,
        websocket_queue_size=args.websocket_queue_size,
        slow_client_delay_seconds=args.slow_client_delay_seconds,
        progress_seconds=args.progress_seconds,
        memory_sample_seconds=args.memory_sample_seconds,
        report_json=report_json,
        report_markdown=report_markdown,
        session_prefix=args.session_prefix,
        thresholds=AcceptanceThresholds(
            max_memory_growth_mb=args.max_memory_growth_mb,
            max_camera_release_ms=args.max_camera_release_ms,
            max_first_frame_startup_ms=args.max_first_frame_startup_ms,
        ),
        command=command,
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run one formal acceptance and write JSON plus Markdown reports."""

    args = _build_parser().parse_args(argv)
    try:
        config = _config_from_args(args, argv)
        report = run_benchmark(config)
        config.report_json.parent.mkdir(parents=True, exist_ok=True)
        config.report_markdown.parent.mkdir(parents=True, exist_ok=True)
        config.report_json.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        config.report_markdown.write_text(render_markdown(report), encoding="utf-8")
        print(
            json.dumps(
                {
                    "report_json": str(config.report_json),
                    "report_markdown": str(config.report_markdown),
                    "all_passed": _mapping(report, "acceptance").get("all_passed"),
                },
                ensure_ascii=False,
            )
        )
        return 0 if bool(_mapping(report, "acceptance").get("all_passed")) else 1
    except (OSError, RuntimeBenchmarkError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


def _percentile(values: Sequence[float], quantile: float) -> float:
    ordered = sorted(float(value) for value in values)
    if not ordered:
        raise RuntimeBenchmarkError("cannot compute percentile of no values")
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def _round(value: float) -> float:
    return round(float(value), 3)


def _required_number(value: object, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise RuntimeBenchmarkError(f"{field_name} must be numeric")
    number = float(value)
    if not math.isfinite(number):
        raise RuntimeBenchmarkError(f"{field_name} must be finite")
    return number


def _optional_number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _number_or_zero(value: object) -> float:
    number = _optional_number(value)
    return number if number is not None else 0.0


def _mapping(value: Mapping[str, object], key: str) -> Mapping[str, object]:
    nested = value.get(key)
    if not isinstance(nested, dict):
        raise RuntimeBenchmarkError(f"{key} must be an object")
    return cast(Mapping[str, object], nested)


def _mapping_number(value: Mapping[str, object], key: str) -> float:
    return _required_number(value.get(key), key)


def _mapping_bool(value: Mapping[str, object], key: str) -> bool:
    item = value.get(key)
    if not isinstance(item, bool):
        raise RuntimeBenchmarkError(f"{key} must be a boolean")
    return item


def _fmt(value: object) -> str:
    number = _optional_number(value)
    return "n/a" if number is None else f"{number:.3f}"


def _yes_no(value: object) -> str:
    return "是" if bool(value) else "否"


if __name__ == "__main__":
    raise SystemExit(main())
