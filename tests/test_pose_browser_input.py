"""Browser input lane tests: geometric posture, ingest pipeline, WS reader."""

from __future__ import annotations

import io
import struct
from typing import Any

from reme.runtime.perception.browser_input import (
    KEYPOINT_NAMES,
    BrowserGatewayPerceptionWorker,
    GeometricPostureModel,
    LandmarkFrameEngine,
    parse_input_text,
    read_ws_messages,
)
from reme.runtime.perception.runtime import (
    ModeProfile,
    RuntimeEvent,
    RuntimeEventType,
    RuntimeSessionRequest,
)

SESSION = "live-camera-test"
SCENE = "living_room"


def _skeleton(
    coords: dict[str, tuple[float, float]], *, score: float = 0.9
) -> list[dict[str, Any]]:
    return [
        {
            "name": name,
            "x_norm": coords.get(name, (0.5, 0.5))[0],
            "y_norm": coords.get(name, (0.5, 0.5))[1],
            "score": score if name in coords else 0.0,
        }
        for name in KEYPOINT_NAMES
    ]


def _standing(center_x: float = 0.5, drop: float = 0.0) -> dict[str, tuple[float, float]]:
    def at(dx: float, y: float) -> tuple[float, float]:
        return (center_x + dx, min(y + drop, 1.0))

    return {
        "nose": at(0.0, 0.18),
        "left_eye": at(-0.015, 0.17),
        "right_eye": at(0.015, 0.17),
        "left_ear": at(-0.03, 0.18),
        "right_ear": at(0.03, 0.18),
        "left_shoulder": at(-0.06, 0.30),
        "right_shoulder": at(0.06, 0.30),
        "left_elbow": at(-0.08, 0.42),
        "right_elbow": at(0.08, 0.42),
        "left_wrist": at(-0.09, 0.53),
        "right_wrist": at(0.09, 0.53),
        "left_hip": at(-0.04, 0.55),
        "right_hip": at(0.04, 0.55),
        "left_knee": at(-0.04, 0.75),
        "right_knee": at(0.04, 0.75),
        "left_ankle": at(-0.04, 0.95),
        "right_ankle": at(0.04, 0.95),
    }


def _lying() -> dict[str, tuple[float, float]]:
    return {
        "nose": (0.24, 0.84),
        "left_eye": (0.25, 0.83),
        "right_eye": (0.25, 0.85),
        "left_ear": (0.26, 0.82),
        "right_ear": (0.26, 0.86),
        "left_shoulder": (0.36, 0.83),
        "right_shoulder": (0.40, 0.87),
        "left_elbow": (0.44, 0.80),
        "right_elbow": (0.46, 0.90),
        "left_wrist": (0.50, 0.79),
        "right_wrist": (0.52, 0.91),
        "left_hip": (0.58, 0.84),
        "right_hip": (0.62, 0.88),
        "left_knee": (0.70, 0.83),
        "right_knee": (0.72, 0.89),
        "left_ankle": (0.80, 0.84),
        "right_ankle": (0.82, 0.88),
    }


def _sitting() -> dict[str, tuple[float, float]]:
    return {
        "nose": (0.50, 0.25),
        "left_shoulder": (0.44, 0.35),
        "right_shoulder": (0.56, 0.35),
        "left_elbow": (0.42, 0.46),
        "right_elbow": (0.58, 0.46),
        "left_wrist": (0.41, 0.55),
        "right_wrist": (0.59, 0.55),
        "left_hip": (0.46, 0.62),
        "right_hip": (0.54, 0.62),
        "left_knee": (0.40, 0.66),
        "right_knee": (0.60, 0.66),
        "left_ankle": (0.40, 0.82),
        "right_ankle": (0.60, 0.82),
    }


def _record(coords: dict[str, tuple[float, float]], **overrides: Any) -> dict[str, Any]:
    record: dict[str, Any] = {
        "person_detected": True,
        "keypoints": _skeleton(coords),
    }
    record.update(overrides)
    return record


class TestGeometricPostureModel:
    def test_standing(self) -> None:
        prediction = GeometricPostureModel().predict_record(_record(_standing()))
        assert prediction.posture == "standing"
        assert prediction.confidence >= 0.5

    def test_sitting(self) -> None:
        prediction = GeometricPostureModel().predict_record(_record(_sitting()))
        assert prediction.posture == "sitting"

    def test_lying(self) -> None:
        prediction = GeometricPostureModel().predict_record(_record(_lying()))
        assert prediction.posture == "lying"
        assert prediction.confidence >= 0.6

    def test_sparse_keypoints_abstain(self) -> None:
        coords = {"nose": (0.5, 0.2), "left_shoulder": (0.45, 0.3)}
        prediction = GeometricPostureModel().predict_record(_record(coords))
        assert prediction.posture == "unknown"

    def test_collapsed_torso_abstains(self) -> None:
        coords = _standing()
        squeezed = {
            name: (0.5, 0.5 + (xy[1] - 0.5) * 0.02) if "should" in name or "hip" in name else xy
            for name, xy in coords.items()
        }
        prediction = GeometricPostureModel().predict_record(_record(squeezed))
        assert prediction.posture == "unknown"

    def test_person_not_detected(self) -> None:
        prediction = GeometricPostureModel().predict_record(
            _record(_standing(), person_detected=False)
        )
        assert prediction.posture == "unknown"


def _landmark_message(
    coords: dict[str, tuple[float, float]],
    *,
    frame_index: int,
    timestamp_ms: float,
    scene_id: str = SCENE,
) -> dict[str, Any]:
    return {
        "type": "landmarks_frame",
        "session_id": SESSION,
        "scene_id": scene_id,
        "frame_index": frame_index,
        "timestamp_ms": timestamp_ms,
        "person_detected": True,
        "keypoints": _skeleton(coords),
    }


def _fall_stream() -> list[dict[str, Any]]:
    """Synthetic 10fps stream: brief stand, fast 0.4s drop, lie still 6s.

    The standing prefix is deliberately short: the transition detector's
    evidence window spans the whole sample buffer, and fall_max_duration_ms
    caps that window — a live camera reaches the same shape because the
    detector clears its buffer after every emitted transition.
    """

    frames: list[dict[str, Any]] = []
    index = 0
    timestamp = 0.0
    for _ in range(6):
        frames.append(_landmark_message(_standing(), frame_index=index, timestamp_ms=timestamp))
        index += 1
        timestamp += 100.0
    standing, lying = _standing(), _lying()
    steps = 4
    for step in range(1, steps + 1):
        blend = step / steps
        coords = {
            name: (
                standing[name][0]
                + (lying.get(name, standing[name])[0] - standing[name][0]) * blend,
                standing[name][1]
                + (lying.get(name, standing[name])[1] - standing[name][1]) * blend,
            )
            for name in standing
        }
        frames.append(_landmark_message(coords, frame_index=index, timestamp_ms=timestamp))
        index += 1
        timestamp += 100.0
    for _ in range(60):
        frames.append(_landmark_message(_lying(), frame_index=index, timestamp_ms=timestamp))
        index += 1
        timestamp += 100.0
    return frames


class TestLandmarkFrameEngine:
    def _session(self) -> tuple[LandmarkFrameEngine, list[RuntimeEvent]]:
        published: list[RuntimeEvent] = []
        engine = LandmarkFrameEngine(session_id=SESSION, scene_id=SCENE, publish=published.append)
        return engine, published

    def test_fall_stream_emits_posture_and_fall_transition(self) -> None:
        engine, published = self._session()
        for message in _fall_stream():
            engine.handle_text(message)
        types = {event.event_type for event in published}
        assert RuntimeEventType.FRAME_LANDMARKS in types
        assert RuntimeEventType.POSTURE_OBSERVATION in types
        postures = [
            event.payload["posture"]
            for event in published
            if event.event_type is RuntimeEventType.POSTURE_OBSERVATION
        ]
        assert "standing" in postures and "lying" in postures
        transitions = [
            event.payload
            for event in published
            if event.event_type is RuntimeEventType.TRANSITION_EVENT
        ]
        falls = [t for t in transitions if t["transition"] == "fall_like_transition"]
        assert falls, f"no fall transition, got {[t['transition'] for t in transitions]}"
        assert falls[0]["transition_confidence"] >= 0.55
        # Wire contract: derived events share their source frame's sequence,
        # so ordering is non-decreasing overall and unique per event type
        # (B's ingest watermark and C's dedupe both key on (sequence, type)).
        sequences = [event.sequence for event in published]
        assert sequences == sorted(sequences)
        for event_type in types:
            typed = [e.sequence for e in published if e.event_type is event_type]
            assert len(set(typed)) == len(typed)
        assert engine.stats.landmark_frames == len(_fall_stream())

    def test_manual_fall_scenario_uses_current_event_sequence(self) -> None:
        engine, published = self._session()
        engine.handle_text(
            {
                "type": "debug_scenario",
                "session_id": SESSION,
                "scene_id": SCENE,
                "timestamp_ms": 5000.0,
                "scenario": "fall",
            }
        )
        engine.handle_text(
            _landmark_message(_standing(), frame_index=1, timestamp_ms=5100.0)
        )

        assert [event.sequence for event in published[:3]] == [0, 1, 2]
        assert published[1].event_type is RuntimeEventType.TRANSITION_EVENT
        assert published[1].payload["transition"] == "fall_like_transition"
        assert published[2].payload["posture"] == "lying"
        assert published[2].payload["classification_source"] == "manual_debug"
        assert published[3].sequence == 3

    def test_wrong_session_and_bad_payloads_counted(self) -> None:
        engine, published = self._session()
        engine.handle_text({"type": "landmarks_frame", "session_id": "other"})
        engine.handle_text({"type": "landmarks_frame", "session_id": SESSION, "timestamp_ms": -5})
        engine.handle_text({"type": "mystery", "session_id": SESSION})
        assert not published
        assert engine.stats.dropped_messages == 3

    def test_jpeg_without_estimator_counts_drop(self) -> None:
        engine, published = self._session()
        engine.handle_text(
            {
                "type": "frame_meta",
                "session_id": SESSION,
                "scene_id": SCENE,
                "frame_index": 0,
                "timestamp_ms": 0.0,
            }
        )
        engine.handle_binary(b"\xff\xd8\xffjpeg")
        assert not published
        assert engine.stats.dropped_messages == 2

    def test_scene_switch_resets_pipeline(self) -> None:
        engine, published = self._session()
        engine.handle_text(_landmark_message(_standing(), frame_index=0, timestamp_ms=0.0))
        engine.handle_text(
            {
                "type": "scene_signal",
                "session_id": SESSION,
                "scene_id": "bedroom",
                "timestamp_ms": 100.0,
                "signal": "switch",
            }
        )
        engine.handle_text(
            _landmark_message(_standing(), frame_index=1, timestamp_ms=200.0, scene_id="bedroom")
        )
        scenes = {
            event.payload["scene_id"]
            for event in published
            if event.event_type is RuntimeEventType.FRAME_LANDMARKS
        }
        assert scenes == {SCENE, "bedroom"}


class TestBrowserGatewayWorker:
    def test_run_registers_and_unregisters(self) -> None:
        worker = BrowserGatewayPerceptionWorker(poll_interval_s=0.01)
        request = RuntimeSessionRequest(
            session_id=SESSION,
            profile=ModeProfile.LIVE_CAMERA,
            scene_id=SCENE,
            camera_id="c-primary-camera",
        )
        running: list[bool] = []
        active = {"value": True}
        import threading

        thread = threading.Thread(
            target=worker.run,
            kwargs={
                "request": request,
                "publish": lambda event: None,
                "mark_running": lambda: running.append(True),
                "is_active": lambda: active["value"],
            },
        )
        thread.start()
        for _ in range(100):
            if worker.get_intake(SESSION) is not None:
                break
            import time

            time.sleep(0.01)
        assert running == [True]
        assert worker.get_intake(SESSION) is not None
        assert worker.capabilities()["landmarks_inference"] is True
        active["value"] = False
        thread.join(timeout=2)
        assert worker.get_intake(SESSION) is None


def _client_frame(opcode: int, payload: bytes, *, mask: bytes = b"\x01\x02\x03\x04") -> bytes:
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", 0x80 | opcode, 0x80 | length)
    elif length <= 0xFFFF:
        header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, length)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, length)
    return header + mask + masked


class TestWsReader:
    def test_reads_masked_text_and_binary(self) -> None:
        stream = io.BytesIO(
            _client_frame(0x1, b'{"type":"scene_signal"}') + _client_frame(0x2, b"\xff\xd8jpg")
        )
        controls: list[tuple[int, bytes]] = []
        messages = list(read_ws_messages(stream, lambda op, data: controls.append((op, data))))
        assert messages == [(0x1, b'{"type":"scene_signal"}'), (0x2, b"\xff\xd8jpg")]
        assert controls == []

    def test_ping_replied_and_close_echoed(self) -> None:
        stream = io.BytesIO(
            _client_frame(0x9, b"hb") + _client_frame(0x1, b"x") + _client_frame(0x8, b"")
        )
        controls: list[tuple[int, bytes]] = []
        messages = list(read_ws_messages(stream, lambda op, data: controls.append((op, data))))
        assert messages == [(0x1, b"x")]
        assert controls == [(0xA, b"hb"), (0x8, b"")]

    def test_parse_input_text(self) -> None:
        assert parse_input_text(b'{"a":1}') == ('{"a":1}', {"a": 1})
        assert parse_input_text(b"[1]") is None
        assert parse_input_text(b"\xff\xfe") is None
