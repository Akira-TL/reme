"""Event-scoped media authorization records owned by the decision runtime.

An authorization is a business fact (why clear video may be opened), not a
WebRTC transport grant.  Relay may later mint one or more short-lived media
grants from one still-valid authorization.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

MEDIA_AUTHORIZATION_SCHEMA_VERSION = "reme-media-authorization/v1"
KITCHEN_AUTHORIZATION_TTL_MS = 60_000
FALL_AUTHORIZATION_TTL_MS = 30_000


class MediaAuthorizationError(ValueError):
    """Raised when an event-scoped media authorization is malformed."""


class MediaAuthorizationScope(StrEnum):
    KITCHEN_MOMENT = "kitchen_moment"
    FALL_EMERGENCY = "fall_emergency"


class MediaAuthorizationStatus(StrEnum):
    ACTIVE = "active"


@dataclass(frozen=True, slots=True)
class MediaAuthorization:
    authorization_id: str
    decision_id: str
    scene_id: str
    scope: MediaAuthorizationScope
    issued_at_ms: int
    expires_at_ms: int
    event_id: str | None = None
    status: MediaAuthorizationStatus = MediaAuthorizationStatus.ACTIVE
    schema_version: str = MEDIA_AUTHORIZATION_SCHEMA_VERSION

    def __post_init__(self) -> None:
        if self.schema_version != MEDIA_AUTHORIZATION_SCHEMA_VERSION:
            raise MediaAuthorizationError("unsupported media authorization schema")
        for field_name, value in (
            ("authorization_id", self.authorization_id),
            ("decision_id", self.decision_id),
            ("scene_id", self.scene_id),
        ):
            if not isinstance(value, str) or not value.strip():
                raise MediaAuthorizationError(f"{field_name} must be a non-empty string")
        if not isinstance(self.scope, MediaAuthorizationScope):
            raise MediaAuthorizationError("scope must be a MediaAuthorizationScope")
        if not isinstance(self.status, MediaAuthorizationStatus):
            raise MediaAuthorizationError("status must be a MediaAuthorizationStatus")
        if isinstance(self.issued_at_ms, bool) or not isinstance(self.issued_at_ms, int):
            raise MediaAuthorizationError("issued_at_ms must be an integer")
        if isinstance(self.expires_at_ms, bool) or not isinstance(self.expires_at_ms, int):
            raise MediaAuthorizationError("expires_at_ms must be an integer")
        if self.issued_at_ms < 0 or self.expires_at_ms <= self.issued_at_ms:
            raise MediaAuthorizationError("expires_at_ms must be after issued_at_ms")
        if self.event_id is not None and (
            not isinstance(self.event_id, str) or not self.event_id.strip()
        ):
            raise MediaAuthorizationError("event_id must be null or a non-empty string")

    @property
    def ttl_ms(self) -> int:
        return self.expires_at_ms - self.issued_at_ms

    def to_payload(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "authorization_id": self.authorization_id,
            "decision_id": self.decision_id,
            "scene_id": self.scene_id,
            "scope": self.scope.value,
            "status": self.status.value,
            "issued_at_ms": self.issued_at_ms,
            "expires_at_ms": self.expires_at_ms,
            "event_id": self.event_id,
        }


def parse_media_authorization(data: object) -> MediaAuthorization:
    if not isinstance(data, dict):
        raise MediaAuthorizationError("media authorization must be an object")
    allowed = {
        "schema_version",
        "authorization_id",
        "decision_id",
        "scene_id",
        "scope",
        "status",
        "issued_at_ms",
        "expires_at_ms",
        "event_id",
    }
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise MediaAuthorizationError(
            f"media authorization has unexpected fields: {', '.join(unknown)}"
        )
    try:
        return MediaAuthorization(
            schema_version=data.get("schema_version", MEDIA_AUTHORIZATION_SCHEMA_VERSION),
            authorization_id=data["authorization_id"],
            decision_id=data["decision_id"],
            scene_id=data["scene_id"],
            scope=MediaAuthorizationScope(data["scope"]),
            status=MediaAuthorizationStatus(data.get("status", "active")),
            issued_at_ms=data["issued_at_ms"],
            expires_at_ms=data["expires_at_ms"],
            event_id=data.get("event_id"),
        )
    except (KeyError, TypeError, ValueError) as exc:
        if isinstance(exc, MediaAuthorizationError):
            raise
        raise MediaAuthorizationError(f"invalid media authorization: {exc}") from exc
