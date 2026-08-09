"""Backend-owned family state and Relay publication.

The browser-facing demo snapshot is deliberately not involved here.  One
authority projects final :class:`CareDecision` records, owns a monotonic
revision per runtime session, and creates the only media authorization that
Relay is allowed to turn into a transport grant.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Callable
from copy import deepcopy
from dataclasses import dataclass, replace
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from reme.runtime.decision.records import (
    CareDecision,
    DecisionAction,
    DecisionState,
    FamilyDelivery,
    PrivacyMode,
)
from reme.runtime.decision.session import RuntimeSessionRegistry

FAMILY_EVENT_SCHEMA_VERSION = "reme-family-event/v1"
MEDIA_AUTHORIZATION_SCHEMA_VERSION = "reme-media-authorization/v1"
BACKEND_CONTEXT_SCHEMA_VERSION = "reme-backend-relay-context/v1"

KITCHEN_AUTHORIZATION_TTL_MS = 60_000
FALL_AUTHORIZATION_TTL_MS = 30_000


class FamilyEventTransport(Protocol):
    """Non-blocking sink for a room-independent backend event draft."""

    def submit(self, event: dict[str, Any]) -> None: ...

    def close(self) -> None: ...


@dataclass(frozen=True, slots=True)
class MediaAuthorization:
    """Backend safety permission; distinct from Relay's WebRTC MediaGrant."""

    authorization_id: str
    decision_id: str
    event_id: str
    runtime_session_id: str
    scene_id: str
    scope: str
    audience: str
    status: str
    issued_at_ms: int
    expires_at_ms: int
    schema_version: str = MEDIA_AUTHORIZATION_SCHEMA_VERSION

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "authorization_id": self.authorization_id,
            "decision_id": self.decision_id,
            "event_id": self.event_id,
            "runtime_session_id": self.runtime_session_id,
            "scene_id": self.scene_id,
            "scope": self.scope,
            "audience": self.audience,
            "status": self.status,
            "issued_at_ms": self.issued_at_ms,
            "expires_at_ms": self.expires_at_ms,
        }


class FamilyEventAuthority:
    """Own the latest family event and media authorization for one runtime."""

    def __init__(
        self,
        *,
        registry: RuntimeSessionRegistry,
        transport: FamilyEventTransport | None = None,
        clock_ms: Callable[[], int] | None = None,
    ) -> None:
        self._registry = registry
        self._transport = transport
        self._clock_ms = clock_ms or (lambda: int(time.time() * 1000))
        self._lock = threading.RLock()
        self._runtime_session_id: str | None = None
        self._revision = -1
        self._care: dict[str, Any] | None = None
        self._authorization: MediaAuthorization | None = None
        self._current: dict[str, Any] | None = None
        self._expiry_timer: threading.Timer | None = None

    def begin_runtime(self, runtime_session_id: str) -> dict[str, Any]:
        """Start a new revision generation and explicitly clear old authority."""

        with self._lock:
            self._cancel_expiry_locked()
            self._runtime_session_id = runtime_session_id
            self._revision = -1
            self._care = None
            self._authorization = None
            return self._emit_locked()

    def publish_decision(self, decision: CareDecision) -> None:
        """Project one final decision and publish its authoritative family event."""

        with self._lock:
            runtime_session_id = self._registry.active_session_id()
            if runtime_session_id is None:
                # Recorded HTTP-only flows have no Relay room/runtime identity.
                return
            if runtime_session_id != self._runtime_session_id:
                self._cancel_expiry_locked()
                self._runtime_session_id = runtime_session_id
                self._revision = -1
                self._authorization = None
            self._care = family_care_projection(decision)
            next_authorization = authorization_for_decision(
                decision,
                runtime_session_id=runtime_session_id,
                active_scene_id=self._registry.active_scene_id(),
                now_ms=self._clock_ms(),
            )
            if next_authorization is None:
                self._authorization = self._inactive_authorization_locked("revoked")
                self._cancel_expiry_locked()
            else:
                self._authorization = next_authorization
                self._schedule_expiry_locked(next_authorization)
            self._emit_locked()

    def reset_scene(self) -> dict[str, Any] | None:
        """Clear care state and revoke media when an episode/scene is reset."""

        with self._lock:
            if self._runtime_session_id is None:
                return None
            self._care = None
            self._authorization = self._inactive_authorization_locked("revoked")
            self._cancel_expiry_locked()
            return self._emit_locked()

    def stop_runtime(self, runtime_session_id: str) -> dict[str, Any] | None:
        """Publish one final cleared event before the registry stops the runtime."""

        with self._lock:
            if self._runtime_session_id != runtime_session_id:
                return None
            self._care = None
            self._authorization = self._inactive_authorization_locked("revoked")
            self._cancel_expiry_locked()
            return self._emit_locked()

    def current_event(self) -> dict[str, Any] | None:
        with self._lock:
            return None if self._current is None else deepcopy(self._current)

    def close(self) -> None:
        with self._lock:
            self._cancel_expiry_locked()
        if self._transport is not None:
            self._transport.close()

    def _emit_locked(self) -> dict[str, Any]:
        assert self._runtime_session_id is not None
        self._revision += 1
        event: dict[str, Any] = {
            "schema_version": FAMILY_EVENT_SCHEMA_VERSION,
            "runtime_session_id": self._runtime_session_id,
            "revision": self._revision,
            "timestamp_ms": self._clock_ms(),
            "care": deepcopy(self._care),
            "authorization": (
                None if self._authorization is None else self._authorization.to_payload()
            ),
        }
        self._current = event
        if self._transport is not None:
            self._transport.submit(deepcopy(event))
        return deepcopy(event)

    def _inactive_authorization_locked(self, status: str) -> MediaAuthorization | None:
        current = self._authorization
        if current is None:
            return None
        if current.status != "active":
            return current
        return replace(current, status=status)

    def _schedule_expiry_locked(self, authorization: MediaAuthorization) -> None:
        self._cancel_expiry_locked()
        delay_seconds = max(0.0, (authorization.expires_at_ms - self._clock_ms()) / 1000)
        timer = threading.Timer(
            delay_seconds,
            self._expire_authorization,
            args=(authorization.authorization_id,),
        )
        timer.daemon = True
        self._expiry_timer = timer
        timer.start()

    def _cancel_expiry_locked(self) -> None:
        if self._expiry_timer is not None:
            self._expiry_timer.cancel()
            self._expiry_timer = None

    def _expire_authorization(self, authorization_id: str) -> None:
        with self._lock:
            current = self._authorization
            if (
                current is None
                or current.authorization_id != authorization_id
                or current.status != "active"
            ):
                return
            self._authorization = replace(current, status="expired")
            self._expiry_timer = None
            self._emit_locked()


def family_care_projection(decision: CareDecision) -> dict[str, Any]:
    """Allowlist only fields the fixed Family demo is permitted to receive."""

    payload = decision.to_payload()
    keys = (
        "schema_version",
        "scene_id",
        "decision_id",
        "timestamp_ms",
        "state",
        "risk_level",
        "privacy_mode",
        "family_notification",
        "action",
        "family_delivery",
        "reason_summary",
        "uncertainty",
        "source",
        "fallback_used",
        "demo_mode",
        "action_card",
        "visual_context",
        "alarm",
    )
    projection = {key: payload[key] for key in keys}
    action_card = projection["action_card"]
    if action_card is not None:
        # The fixed public room has no household identity boundary. Preserve
        # actionable fields, but never publish the elder's verbatim quote to
        # anonymous demo viewers.
        projection["action_card"] = {
            key: value
            for key, value in action_card.items()
            if key != "elder_quote"
        }
    return projection


def authorization_for_decision(
    decision: CareDecision,
    *,
    runtime_session_id: str,
    active_scene_id: str | None,
    now_ms: int,
) -> MediaAuthorization | None:
    """Create an active Authorization only for the two accepted demo paths."""

    scene_id = active_scene_id or decision.scene_id
    if scene_id == "bathroom" or decision.privacy_mode is PrivacyMode.HIDDEN:
        return None

    scope: str | None = None
    ttl_ms = 0
    if (
        scene_id == "kitchen"
        and decision.scene_id == scene_id
        and decision.state is DecisionState.RESOLVED
        and decision.action is DecisionAction.NOTIFY_FAMILY
        and decision.family_delivery is FamilyDelivery.NOTIFICATION
        and decision.risk_level == 0
        and decision.family_notification is not None
        and decision.action_card is None
        and decision.alarm is None
        and not decision.consent_required
    ):
        scope = "kitchen_moment"
        ttl_ms = KITCHEN_AUTHORIZATION_TTL_MS
    elif (
        scene_id == "fall"
        and decision.scene_id == scene_id
        and decision.alarm is not None
        and decision.family_delivery is FamilyDelivery.ALARM
        and decision.state
        in {
            DecisionState.FAMILY_NOTIFICATION_REQUIRED,
            DecisionState.URGENT_ATTENTION,
        }
    ):
        scope = "fall_emergency"
        ttl_ms = FALL_AUTHORIZATION_TTL_MS
    if scope is None:
        return None

    return MediaAuthorization(
        authorization_id=f"authorization-{decision.decision_id}",
        decision_id=decision.decision_id,
        event_id=decision.decision_id,
        runtime_session_id=runtime_session_id,
        scene_id=scene_id,
        scope=scope,
        audience="public_demo_viewers",
        status="active",
        issued_at_ms=now_ms,
        expires_at_ms=now_ms + ttl_ms,
    )


class RelayFamilyEventTransport:
    """Latest-wins retrying publisher for authenticated backend Relay ingress."""

    def __init__(
        self,
        *,
        relay_url: str,
        token: str,
        retry_seconds: float = 0.5,
        context_poll_seconds: float = 5.0,
        timeout_seconds: float = 2.0,
        autostart: bool = True,
    ) -> None:
        self._relay_url = relay_url.rstrip("/") + "/"
        self._token = token
        self._retry_seconds = retry_seconds
        self._context_poll_seconds = context_poll_seconds
        self._timeout_seconds = timeout_seconds
        self._condition = threading.Condition()
        self._latest: tuple[int, dict[str, Any]] | None = None
        self._next_sequence = 0
        self._delivered_sequence = -1
        self._delivered_room_session_id: str | None = None
        self._closed = False
        self._thread: threading.Thread | None = None
        if autostart:
            self._thread = threading.Thread(
                target=self._run,
                name="reme-family-relay-publisher",
                daemon=True,
            )
            self._thread.start()

    def submit(self, event: dict[str, Any]) -> None:
        with self._condition:
            if self._closed:
                return
            sequence = self._next_sequence
            self._next_sequence += 1
            self._latest = (sequence, deepcopy(event))
            self._condition.notify_all()

    def deliver_pending_once(self) -> bool:
        """Deliver the current draft once; exposed for deterministic tests."""

        with self._condition:
            item = self._latest
        if item is None:
            return True
        sequence, event = item
        context = self._request_json("GET", "api/backend/context")
        if (
            context.get("schema_version") != BACKEND_CONTEXT_SCHEMA_VERSION
            or not isinstance(context.get("room_session_id"), str)
        ):
            raise ValueError("Relay returned an invalid backend context")
        room_session_id = context["room_session_id"]
        if (
            sequence <= self._delivered_sequence
            and room_session_id == self._delivered_room_session_id
        ):
            return True
        exact_event = {**event, "room_session_id": room_session_id}
        result = self._request_json(
            "POST",
            "api/backend/family-event",
            exact_event,
        )
        if result.get("accepted_revision") != event.get("revision"):
            raise ValueError("Relay did not acknowledge the FamilyEvent revision")
        with self._condition:
            self._delivered_sequence = max(self._delivered_sequence, sequence)
            self._delivered_room_session_id = room_session_id
        return True

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=max(1.0, self._timeout_seconds + 0.25))

    def _run(self) -> None:
        while True:
            with self._condition:
                while not self._closed and self._latest is None:
                    self._condition.wait()
                if self._closed:
                    return
                if self._latest is not None and self._latest[0] <= self._delivered_sequence:
                    # Periodically detect Relay room replacement without
                    # generating a request every retry-backoff interval. A new
                    # backend event wakes the condition immediately.
                    self._condition.wait(self._context_poll_seconds)
                    if self._closed:
                        return
            try:
                self.deliver_pending_once()
            except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
                print(f"warning: FamilyEvent Relay delivery failed; retrying: {exc}")
                with self._condition:
                    if not self._closed:
                        self._condition.wait(self._retry_seconds)

    def _request_json(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body = None
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._token}",
            "User-Agent": "reme-backend/1",
        }
        if payload is not None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = Request(
            urljoin(self._relay_url, path),
            data=body,
            headers=headers,
            method=method,
        )
        with urlopen(request, timeout=self._timeout_seconds) as response:  # noqa: S310
            raw = response.read()
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("Relay response must be a JSON object")
        return value


def build_relay_family_transport_from_env() -> RelayFamilyEventTransport | None:
    """Create the publisher only when both private backend settings exist."""

    relay_url = os.environ.get("REME_FAMILY_RELAY_URL", "").strip()
    token = os.environ.get("REME_FAMILY_RELAY_PUBLISH_TOKEN", "").strip()
    if not relay_url and not token:
        return None
    if not relay_url or not token:
        print("warning: incomplete FamilyEvent Relay configuration; publisher disabled")
        return None
    return RelayFamilyEventTransport(relay_url=relay_url, token=token)
