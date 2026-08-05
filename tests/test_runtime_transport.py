from __future__ import annotations

import threading
from typing import Any

from reme.runtime.perception.runtime import RuntimeEvent, RuntimeEventType
from reme.runtime.perception.runtime_server import EventBroker
from reme.runtime.transport import InProcessPerceptionBridge


class _FakeIngest:
    def __init__(self) -> None:
        self.owner: str | None = None
        self.submitted: list[tuple[object, str | None, str]] = []

    def claim_pull(self, session_id: str) -> None:
        self.owner = session_id

    def release_pull(self) -> None:
        self.owner = None

    def submit(
        self,
        payload: object,
        *,
        active_session_id: str | None,
        source: str = "push",
    ) -> RuntimeEvent:
        self.submitted.append((payload, active_session_id, source))
        assert isinstance(payload, dict)
        return RuntimeEvent(
            session_id=str(payload["session_id"]),
            sequence=int(payload["sequence"]),
            event_type=RuntimeEventType(str(payload["event_type"])),
            payload=dict(payload["payload"]),
        )


class _FakeRegistry:
    def __init__(self, session_id: str) -> None:
        self.session_id = session_id

    def active_session_id(self) -> str | None:
        return self.session_id


class _FakeService:
    pass


def test_in_process_bridge_delivers_without_socket_transport() -> None:
    broker = EventBroker()
    ingest = _FakeIngest()
    registry = _FakeRegistry("session-1")
    evaluated = threading.Event()
    evaluation: list[tuple[Any, RuntimeEvent, object]] = []

    def evaluator(service: object, event: RuntimeEvent, *, danger: object = None) -> None:
        evaluation.append((service, event, danger))
        evaluated.set()

    service = _FakeService()
    bridge = InProcessPerceptionBridge(
        broker=broker,
        ingest=ingest,  # type: ignore[arg-type]
        registry=registry,  # type: ignore[arg-type]
        service=service,  # type: ignore[arg-type]
        evaluator=evaluator,
    )
    bridge.start_for("session-1")
    try:
        broker.publish(
            RuntimeEvent(
                session_id="session-1",
                sequence=1,
                event_type=RuntimeEventType.FRAME_LANDMARKS,
                payload={"scene_id": "living-room"},
            )
        )
        assert evaluated.wait(1.0)
        assert bridge.attached()
        assert bridge.connected()
        assert bridge.safe_url == "in-process://perception/events"
        assert ingest.owner == "session-1"
        assert ingest.submitted[0][1:] == ("session-1", "pull")
        assert evaluation[0][0] is service
        assert evaluation[0][1].sequence == 1
    finally:
        bridge.stop()

    assert not bridge.attached()
    assert not bridge.connected()
    assert ingest.owner is None


def test_in_process_bridge_disconnects_when_perception_session_closes() -> None:
    broker = EventBroker()
    ingest = _FakeIngest()
    bridge = InProcessPerceptionBridge(
        broker=broker,
        ingest=ingest,  # type: ignore[arg-type]
        registry=_FakeRegistry("session-2"),  # type: ignore[arg-type]
        service=_FakeService(),  # type: ignore[arg-type]
        evaluator=lambda *_args, **_kwargs: None,
    )
    bridge.start_for("session-2")
    broker.close_session("session-2")

    for _ in range(100):
        if not bridge.connected():
            break
        threading.Event().wait(0.01)

    assert bridge.attached()
    assert not bridge.connected()
    bridge.stop()
