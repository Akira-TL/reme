"""In-process perception-to-decision event transport.

The browser still uses HTTP/WebSocket to reach the unified backend. Inside the
backend process, perception events are delivered directly from ``EventBroker``
to ``EventIngest``; no loopback socket, JSON reparse, reconnect loop, or second
server process is involved.
"""

from __future__ import annotations

import queue
import sys
import threading
from collections.abc import Callable

from reme.decision.danger import DangerConfirmController
from reme.decision.policy import DecisionService
from reme.decision.runtime_glue import spawn_post_ingest_evaluation
from reme.decision.session import RuntimeSessionRegistry
from reme.decision.stream import EventIngest, IngestError
from reme.pose.runtime import RuntimeEvent
from reme.pose.runtime_server import EventBroker, EventSubscription

EventEvaluator = Callable[..., None]


class InProcessPerceptionBridge:
    """Own one direct perception-event subscription for the active session.

    The public methods intentionally match the old socket-backed
    ``PerceptionBridge`` surface used by the decision HTTP handler. That keeps
    session policy unchanged while replacing only the internal transport.
    """

    def __init__(
        self,
        *,
        broker: EventBroker,
        ingest: EventIngest,
        registry: RuntimeSessionRegistry,
        service: DecisionService,
        danger: DangerConfirmController | None = None,
        evaluator: EventEvaluator = spawn_post_ingest_evaluation,
    ) -> None:
        self._broker = broker
        self._ingest = ingest
        self._registry = registry
        self._service = service
        self._danger = danger
        self._evaluator = evaluator
        self._lock = threading.Lock()
        self._session_id: str | None = None
        self._subscription: EventSubscription | None = None
        self._stop_event: threading.Event | None = None
        self._thread: threading.Thread | None = None

    @property
    def events_url(self) -> str:
        """Compatibility metadata for the decision health response."""

        return "in-process://perception/events"

    @property
    def safe_url(self) -> str:
        return self.events_url

    def attached(self) -> bool:
        with self._lock:
            return self._subscription is not None

    def connected(self) -> bool:
        with self._lock:
            thread = self._thread
            stop_event = self._stop_event
        return (
            thread is not None
            and thread.is_alive()
            and stop_event is not None
            and not stop_event.is_set()
        )

    def start_for(self, session_id: str) -> None:
        """Attach directly to one session's broker queue."""

        if not isinstance(session_id, str) or not session_id.strip():
            raise ValueError("session_id must be non-empty")
        session_id = session_id.strip()
        self.stop()
        self._ingest.claim_pull(session_id)
        subscription = self._broker.subscribe(session_id)
        stop_event = threading.Event()
        thread = threading.Thread(
            target=self._run,
            args=(session_id, subscription, stop_event),
            name=f"reme-in-process-bridge-{session_id}",
            daemon=True,
        )
        with self._lock:
            self._session_id = session_id
            self._subscription = subscription
            self._stop_event = stop_event
            self._thread = thread
        thread.start()

    def stop(self) -> None:
        """Detach and release ingest ownership; idempotent."""

        with self._lock:
            session_id = self._session_id
            subscription = self._subscription
            stop_event = self._stop_event
            thread = self._thread
            self._session_id = None
            self._subscription = None
            self._stop_event = None
            self._thread = None
        if stop_event is not None:
            stop_event.set()
        if session_id is not None and subscription is not None:
            self._broker.unsubscribe(session_id, subscription)
        self._ingest.release_pull()
        if thread is not None and thread is not threading.current_thread():
            thread.join(timeout=2.0)

    def _run(
        self,
        session_id: str,
        subscription: EventSubscription,
        stop_event: threading.Event,
    ) -> None:
        while not stop_event.is_set():
            try:
                event = subscription.get(timeout=0.25)
            except queue.Empty:
                continue
            if event is None:
                return
            self._consume(session_id, event)

    def _consume(self, session_id: str, event: RuntimeEvent) -> None:
        try:
            self._ingest.submit(
                event.to_payload(),
                active_session_id=self._registry.active_session_id(),
                source="pull",
            )
        except IngestError as exc:
            print(
                f"warning: dropped in-process perception event for {session_id}: "
                f"{exc.code}: {exc}",
                file=sys.stderr,
            )
            return
        self._evaluator(self._service, event, danger=self._danger)
