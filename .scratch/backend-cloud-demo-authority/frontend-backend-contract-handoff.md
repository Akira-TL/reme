# Reme Backend Contract Handoff — Cloud Demo

This document only records backend/Relay contract changes that frontend integration needs to be aware of. It does not prescribe frontend implementation.

## 1. Backend owns interaction deadlines

`response_timeout_ms` remains in CareDecision as the interaction-window duration, but the Runtime now advances timeout transitions autonomously.

A browser `response=none/source=timeout` is no longer required for correctness. Legacy timeout submissions remain accepted only when still current; late submissions become stale and cannot create a second alarm.

Relevant flow:

```text
check_in_required
-> backend deadline
-> family_notification_required
-> backend family-ack deadline
-> urgent_attention
```

Fall `need_help` alerts now also carry the family acknowledgement timeout, so an unacknowledged explicit help request can reach `urgent_attention`.

## 2. Fall confirm channels

Fall check-in decisions expose:

```json
"confirm_channels": ["frame", "voice"]
```

Frame, voice and backend timeout compete against the same backend state machine. Late paths become stale after another path has transitioned the event.

## 3. Family acknowledgement semantics

`InteractionResponse.response` now includes:

```text
alarm_acknowledged
card_confirmed
```

They are different backend business events.

- `alarm_acknowledged`: family acknowledgement of a fall safety alarm.
- `card_confirmed`: confirmation of an actual pending action card.

`card_confirmed` without a pending action card is rejected.

The Relay command schema adds the corresponding command names:

```text
acknowledge_alarm
confirm_action_card
```

The existing `confirm_alarm` command remains temporarily in the v1 Relay contract for compatibility, but it is no longer the target backend semantic contract.

## 4. CareDecision media authorization

CareDecision now has an optional field:

```json
"media_authorization": {
  "schema_version": "reme-media-authorization/v1",
  "authorization_id": "authorization-decision-0042",
  "decision_id": "decision-0042",
  "scene_id": "fall",
  "scope": "fall_emergency",
  "status": "active",
  "issued_at_ms": 123456,
  "expires_at_ms": 153456,
  "event_id": "transition-0001"
}
```

Scopes:

```text
kitchen_moment  <= 60 seconds
fall_emergency  <= 30 seconds
```

Kitchen authorization is created by explicit current-event consent. Fall authorization is created by an authoritative fall alarm.

No clear-video authorization is created for bathroom, `hidden`, or `skeleton_only` privacy modes.

Authorization disappears on replacement/resolution/reset/session replacement and expires according to backend time.

## 5. FamilyEvent

The Runtime can now publish a minimized authoritative Family event directly to cloud Relay.

Schema:

```text
reme-family-event/v1
```

Example:

```json
{
  "schema_version": "reme-family-event/v1",
  "runtime_session_id": "runtime-xxx",
  "revision": 42,
  "decision_timestamp_ms": 13000,
  "published_at_ms": 1800000000000,
  "care": {
    "decision_id": "decision-0042",
    "state": "family_notification_required",
    "action": "notify_family",
    "risk_level": 3,
    "family_notification": "呼叫老人未获回应，请尽快联系或前往查看。",
    "privacy_mode": "blurred",
    "alarm": {
      "channels": ["vibrate", "ring", "flash"],
      "trigger": "check_in_timeout"
    },
    "action_card": null,
    "media_authorization": null
  }
}
```

FamilyEvent deliberately excludes:

```text
camera frames
pose landmarks
posture/model scores
visual_context
elder_message
MiMo prompt/debug data
raw audio/video
```

`action_card.elder_quote` is omitted by default. It only appears if the Runtime is explicitly configured to publish it.

## 6. Viewer protocol versions

Existing:

```text
Sec-WebSocket-Protocol: reme-viewer-v1
```

remains compatible and does not receive the new FamilyEvent message.

New authoritative Family stream:

```text
Sec-WebSocket-Protocol: reme-viewer-v2
```

v2 receives messages shaped as:

```json
{
  "type": "family_event",
  "room_session_id": "room-xxx",
  "schema_version": "reme-family-event/v1",
  "runtime_session_id": "runtime-xxx",
  "revision": 42,
  "decision_timestamp_ms": 13000,
  "published_at_ms": 1800000000000,
  "care": {}
}
```

On v2 connection, Relay sends the latest stored FamilyEvent before subsequent live FamilyEvent updates.

For one `runtime_session_id`, FamilyEvent revisions are monotonic. Duplicate/stale revisions are rejected by Relay.

## 7. Runtime -> Relay API

The Runtime publisher uses:

```text
POST /api/runtime/event
Authorization: Bearer <runtime ingest token>
Content-Type: application/json
```

This is server-to-server traffic and does not rely on browser Origin.

Success:

```text
202 Accepted
```

Duplicate/stale revision:

```text
409 stale_family_revision
```

Invalid token:

```text
401 invalid_runtime_token
```

## 8. Relay media authority change

When a valid backend FamilyEvent exists for the active runtime session, Relay media-grant validation uses:

```text
FamilyEvent.care.media_authorization
FamilyEvent.care.privacy_mode
FamilyEvent.care.alarm (for fall scope)
```

Home-derived `care.consent` / `alarm_authoritative` is not accepted as business authority in that path.

The old Home-derived grant check remains only when no FamilyEvent has been published, to keep the existing v1 local demo compatible during migration.

## 9. Dynamic RTC configuration

Relay now provides:

```text
GET /api/rtc-config
```

Response shape:

```json
{
  "iceServers": [
    { "urls": ["stun:..."] },
    {
      "urls": ["turn:...", "turns:..."],
      "username": "<expiry>:reme-demo",
      "credential": "<temporary credential>"
    }
  ],
  "mode": "turn_configured",
  "credential_expires_at_ms": 1800000000000
}
```

Possible `mode` values:

```text
local_network_only
stun_only
turn_configured
```

TURN credentials are short-lived. The TURN shared secret is never returned in this response.

The endpoint returns `Cache-Control: no-store`.

## 10. Runtime/Relay configuration names

Local Runtime:

```text
REME_FAMILY_RELAY_ENDPOINT
REME_FAMILY_RELAY_TOKEN
REME_FAMILY_RELAY_INCLUDE_ELDER_QUOTE   # optional, off by default
```

Relay/Cloud environment:

```text
RUNTIME_INGEST_TOKEN
REME_STUN_URLS
REME_TURN_URLS
REME_TURN_SHARED_SECRET
REME_TURN_CREDENTIAL_TTL_SECONDS
```

No secret values are part of the repository contract.

## 11. Unchanged boundaries

The following remain unchanged:

- routine perception is local;
- Relay does not receive camera frames or pose/model diagnostics through FamilyEvent;
- raw video remains event-scoped WebRTC media rather than Relay JSON;
- bathroom clear video is forbidden;
- online Viewer limit remains 5;
- Relay still has one controller lease at a time;
- this demo does not provide APNs/FCM/Web Push delivery receipts or a production family account system.
