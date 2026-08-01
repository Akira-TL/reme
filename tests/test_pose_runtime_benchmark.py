from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import cast

from reme.pose.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
)
from reme.pose.runtime_benchmark import (
    AcceptanceThresholds,
    MetricSeries,
    SessionRecorder,
    WebSocketProbe,
    evaluate_acceptance,
    render_markdown,
)
from reme.pose.runtime_server import (
    EventBroker,
    RuntimeHTTPServer,
    RuntimePerceptionController,
    build_runtime_handler,
)


def _event(
    *,
    session_id: str,
    event_type: RuntimeEventType,
    timestamp_ms: float,
    sequence: int = 0,
) -> RuntimeEvent:
    return RuntimeEvent(
        session_id=session_id,
        sequence=sequence,
        event_type=event_type,
        payload={
            "scene_id": "live-camera-001",
            "frame_index": sequence,
            "timestamp_ms": timestamp_ms,
        },
    )


def test_metric_series_reports_interpolated_p95() -> None:
    series = MetricSeries()
    for value in (1.0, 2.0, 3.0, 4.0, 100.0):
        series.add(value)

    assert series.to_payload() == {
        "count": 5,
        "average": 22.0,
        "p95": 80.8,
        "minimum": 1.0,
        "maximum": 100.0,
    }


def test_session_recorder_measures_generation_and_websocket_latency() -> None:
    recorder = SessionRecorder(
        session_id="session-a",
        scene_id="live-camera-001",
        requested_at=10.0,
    )
    recorder.mark_stream_started(10.2)
    recorder.mark_camera_opened(10.25, {"width": 1280, "height": 720, "fps": 30.0})

    frame = _event(
        session_id="session-a",
        event_type=RuntimeEventType.FRAME_LANDMARKS,
        timestamp_ms=100.0,
    )
    posture = _event(
        session_id="session-a",
        event_type=RuntimeEventType.POSTURE_OBSERVATION,
        timestamp_ms=100.0,
    )
    recorder.record_generated(frame, 10.32)
    recorder.record_generated(posture, 10.35)
    recorder.record_websocket_received(frame, 10.36)
    recorder.record_websocket_received(posture, 10.40)
    recorder.mark_stop_requested(20.0)
    recorder.mark_camera_closed(20.08)
    recorder.set_stream_summary(
        {
            "processed_frames": 300,
            "elapsed_seconds": 10.0,
            "output_fps": 30.0,
            "inference_ms_average": 4.0,
            "inference_ms_p95": 5.0,
            "processing_ms_average": 6.0,
            "processing_ms_p95": 8.0,
        }
    )

    payload = recorder.to_payload()

    assert payload["frame_landmarks_count"] == 1
    assert payload["posture_observation_count"] == 1
    assert payload["first_frame_startup_ms"] == 320.0
    posture_latency = cast(
        dict[str, object], payload["posture_generation_latency_ms"]
    )
    websocket_latency = cast(
        dict[str, object], payload["websocket_posture_latency_ms"]
    )
    assert posture_latency["average"] == 50.0
    assert websocket_latency["average"] == 100.0
    assert payload["camera_release_ms"] == 80.0
    assert payload["frame_landmarks_fps"] == 30.0
    assert payload["posture_observation_hz"] == 0.1


def test_bounded_broker_drops_old_events_without_blocking_publisher() -> None:
    broker = EventBroker(queue_size=1)
    slow = broker.subscribe("session-a")
    started = time.perf_counter()

    for sequence in range(5000):
        broker.publish(
            _event(
                session_id="session-a",
                event_type=RuntimeEventType.FRAME_LANDMARKS,
                timestamp_ms=float(sequence),
                sequence=sequence,
            )
        )

    elapsed = time.perf_counter() - started
    latest = slow.get_nowait()
    assert latest is not None
    assert latest.sequence == 4999
    assert elapsed < 0.5


def test_websocket_probe_reads_events_and_observes_server_close() -> None:
    class FakeWorker:
        def run(
            self,
            request: RuntimeSessionRequest,
            *,
            publish: Callable[[RuntimeEvent], None],
            mark_running: Callable[[], None],
            is_active: Callable[[], bool],
        ) -> None:
            mark_running()
            sequence = 0
            while is_active():
                publish(
                    _event(
                        session_id=request.session_id,
                        event_type=RuntimeEventType.FRAME_LANDMARKS,
                        timestamp_ms=float(sequence),
                        sequence=sequence,
                    )
                )
                sequence += 1
                time.sleep(0.002)

    controller = RuntimePerceptionController(worker=FakeWorker())
    server = RuntimeHTTPServer(
        ("127.0.0.1", 0), build_runtime_handler(controller)
    )
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    received: list[RuntimeEvent] = []
    probe = WebSocketProbe(
        host="127.0.0.1",
        port=server.server_port,
        session_id="session-probe",
        callback=lambda event, _received_at: received.append(event),
    )
    try:
        probe.connect()
        controller.start(
            RuntimeSessionRequest(
                session_id="session-probe",
                profile=ModeProfile.LIVE_CAMERA,
                scene_id="live-camera-001",
                camera_id="default",
            )
        )
        assert probe.wait_for_count(3, timeout=2.0)
        controller.stop("session-probe")
        assert probe.wait_for_server_close(timeout=2.0)
        assert received
        assert {event.session_id for event in received} == {"session-probe"}
    finally:
        probe.close()
        controller.shutdown()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2.0)


def test_acceptance_requires_session_isolation_and_client_resilience() -> None:
    evidence: dict[str, object] = {
        "restart_performed": True,
        "old_websocket_closed": True,
        "old_websocket_received_new_session": False,
        "new_websocket_received_old_session": False,
        "slow_client_did_not_block": True,
        "abnormal_disconnect_survived": True,
        "raw_frames_written": False,
        "raw_video_recorded": False,
        "runtime_errors": [],
    }
    report: dict[str, object] = {
        "requested_camera_seconds": 600.0,
        "metrics": {
            "camera_active_seconds": 600.2,
            "frame_landmarks_fps": 24.0,
            "posture_observation_hz": 7.2,
            "first_frame_startup_ms": 950.0,
            "posture_generation_latency_ms": {"p95": 80.0},
            "websocket_frame_latency_ms": {"p95": 90.0},
            "websocket_posture_latency_ms": {"p95": 130.0},
            "memory": {"growth_mb": 8.0},
            "camera_release_ms": {"maximum": 120.0},
        },
        "evidence": evidence,
    }

    acceptance = evaluate_acceptance(report, AcceptanceThresholds())

    assert acceptance["all_passed"] is True
    evidence["new_websocket_received_old_session"] = True
    acceptance = evaluate_acceptance(report, AcceptanceThresholds())
    assert acceptance["all_passed"] is False
    checks = cast(dict[str, object], acceptance["checks"])
    assert checks["new_session_rejects_old_events"] is False


def test_markdown_summary_exposes_measured_values_and_failures() -> None:
    report = {
        "schema_version": "reme-runtime-reliability/v0-experiment",
        "started_at": "2026-08-01T15:00:00Z",
        "finished_at": "2026-08-01T15:10:05Z",
        "command": "python -m reme.pose.runtime_benchmark",
        "requested_camera_seconds": 600.0,
        "metrics": {
            "camera_active_seconds": 600.1,
            "frame_landmarks_count": 14400,
            "frame_landmarks_fps": 24.0,
            "posture_observation_count": 4320,
            "posture_observation_hz": 7.2,
            "movenet_inference_ms": {"average": 4.1, "p95": 5.2},
            "single_frame_processing_ms": {"average": 7.1, "p95": 9.2},
            "first_frame_startup_ms": 980.0,
            "posture_generation_latency_ms": {"average": 8.0, "p95": 12.0},
            "websocket_frame_latency_ms": {"average": 12.0, "p95": 35.0},
            "websocket_posture_latency_ms": {"average": 15.0, "p95": 42.0},
            "memory": {"start_mb": 500.0, "peak_mb": 620.0, "end_mb": 510.0, "growth_mb": 10.0},
            "camera_release_ms": {"average": 45.0, "maximum": 60.0},
        },
        "evidence": {
            "restart_performed": True,
            "old_websocket_closed": True,
            "old_websocket_received_new_session": False,
            "new_websocket_received_old_session": False,
            "slow_client_did_not_block": True,
            "abnormal_disconnect_survived": True,
            "raw_frames_written": False,
            "raw_video_recorded": False,
            "runtime_errors": [],
        },
        "acceptance": {
            "all_passed": False,
            "checks": {"ten_minute_camera_run": True, "memory_growth": False},
        },
        "sessions": [],
    }

    markdown = render_markdown(report)

    assert "# Reme 实时链路稳定性验收" in markdown
    assert "24.000 FPS" in markdown
    assert "内存增长" in markdown
    assert "不能仅据此判定内存泄漏" in markdown
    assert "❌" in markdown
