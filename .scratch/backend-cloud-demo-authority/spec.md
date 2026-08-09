# Backend Cloud Demo Authority

## Goal

Support the hackathon demo when Home and Family are on different networks without moving routine perception to the cloud.

## Roles

- **Runtime / Decision**: local business authority for CareDecision, deadlines, alarm, action-card and media authorization.
- **Relay**: cloud distribution, Viewer leases, WebRTC signaling and media grants.
- **Media Producer**: Home-side browser holding the local MediaStream.
- **Family Viewer**: remote browser consuming Relay state/media.

No legacy A/B/C ownership labels are used by this spec.

## Invariants

1. Routine camera frames, pose landmarks, model scores and perception debug state are not FamilyEvent payloads.
2. Backend deadlines advance without browser JS timers.
3. Fall check-in offers `frame + voice`; timeout remains deterministic fallback.
4. `alarm_acknowledged` and `card_confirmed` are distinct response values.
5. `MediaAuthorization` is a backend business fact; `media_grant` is Relay transport permission.
6. Kitchen authorization requires explicit consent and lasts <= 60s.
7. Fall authorization requires an authoritative fall alarm and lasts <= 30s.
8. Bathroom / hidden / skeleton-only never authorize clear video.
9. FamilyEvent omits `elder_quote` unless explicitly configured.
10. Viewer v1 remains compatible; Viewer v2 receives authoritative FamilyEvent.
11. Runtime ingest is bearer-authenticated server-to-server traffic.
12. TURN shared secrets never enter frontend bundles.

## FamilyEvent

Schema: `reme-family-event/v1`.

Minimum content:

```text
runtime_session_id
revision
decision_timestamp_ms
published_at_ms
care.decision_id
care.state
care.action
care.risk_level
care.family_notification
care.privacy_mode
care.alarm
care.action_card
care.media_authorization
```

## Runtime -> Relay

```text
POST /api/runtime/event
Authorization: Bearer <RUNTIME_INGEST_TOKEN>
Content-Type: application/json
```

Duplicate/stale revisions for the same runtime session are rejected.

## RTC config

```text
GET /api/rtc-config
```

Returns dynamic `iceServers`. When TURN REST is configured, credentials are short-lived and generated server-side from the coturn shared secret.

## Compatibility

If no FamilyEvent has been published, Relay keeps the existing v1 Home-derived grant checks so the old local demo remains usable. Once a FamilyEvent exists for the runtime session, backend media authorization takes precedence and Home consent/alarm summary cannot authorize clear video.
