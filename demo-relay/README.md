# Reme shared live demo relay

This isolated Cloudflare Worker provides the single-room data plane for the demo:

- `GET /api/status`
- `POST /api/unlock` with `{ "key": "..." }`
- `POST /api/release` with `Authorization: Bearer <token>`
- `POST /api/activity/recognize` with the active Bearer token and exact
  `{ "image_b64": "<plain JPEG base64>" }`
- `POST /api/danger/voice` with the active Bearer token and exact
  `{ "event_id": "<active fall id>", "audio_b64": "<plain WAV base64>", "audio_format": "wav" }`
- `POST /api/scene/recognize` with the active Bearer token and one exact
  explicit visual sample: a preferred short MP4 clip or JPEG keyframe fallback
- `WS /ws/viewer` with subprotocol `reme-viewer-v1`
- `WS /ws/controller` with subprotocols `reme-controller-v1` and
  `reme-token-<token>`

The controller token is never placed in a URL. The only accepted published data is
the strict `movenet-17/v1-demo` frame contract: source dimensions, detection and
quality state, plus exactly 17 normalized MoveNet keypoints. `source_width` and
`source_height` must be safe integers from 1 through 16384. `person_detected=false`
requires `landmark_quality=unavailable`; a detected person must use `usable` or
`degraded`. Viewer sockets are read-only, and binary/media payloads are rejected.
The Durable Object stores the active lease plus bounded structured event, grant,
and authoritative event/frame sequence metadata in SQLite. Only the latest frame
sequence number is persisted; the latest pose payload lives on the active
controller's hibernation attachment and disappears with that socket.
Late viewers first receive `{ "type": "viewer_ready", "viewer_id": "..." }`, then
the latest persisted non-media `reme-demo-event/v1` state in event-sequence order,
and finally a fresh pose snapshot when available. Event and frame sequence state,
the latest scene/activity/card/alarm events, grant metadata, and the grant's fixed
viewer ID audience live in Durable Object SQLite. WebSocket attachments carry the
viewer ID or controller lease/frame snapshot across hibernation. No SDP, ICE
candidate, image, audio, video frame, or Blob is written to SQLite or an
attachment.

The first controller message is an authoritative resume cursor:

```json
{
  "type": "controller_ready",
  "session_id": "...",
  "lease_expires_at_ms": 0,
  "last_event_sequence": -1,
  "last_frame_sequence": -1
}
```

The Relay then sends a separate exact capability message without changing the
strict 3/5/6-field `controller_ready` rolling contract:

```json
{
  "type": "relay_capabilities",
  "activity_confirmation": "verified-activity-event/v1"
}
```

A current controller waits for this capability before starting continuous
kitchen activity sampling. Its public `activity_state(confirmed)` is carried
inside an `activity_confirmation` command, so an older Relay that cannot verify
the one-time receipt rejects the unknown wrapper without persisting or
broadcasting a false confirmed fact. The current Relay unwraps it only through
the same pre-persistence receipt check used for a legacy bare event. A previous
frontend may continue to send a bare confirmed activity during the bounded
rolling window; the new Relay validates it and returns the additive
`activity_verified=true` acknowledgement marker.

Each accepted event or frame must use a sequence strictly greater than its
corresponding cursor. A controller socket may reconnect with the same token and
session until the lease TTL expires; disconnecting the socket does not release
the lease, but it immediately revokes every active media grant for fail-closed
privacy.

An accepted fall `alarm_state(checking)` also creates a structured Durable Object
watchdog and schedules the room alarm at the earlier of its absolute response
deadline and current lease expiry. The same event may shorten that deadline but
cannot extend it. If the deadline arrives, the controller releases while still
checking, or its lease expires, the Durable Object atomically advances the event
sequence, persists `alarm_state(escalated)` with `check_in_timeout`, and broadcasts
it without waiting for the browser. Repeated alarm delivery is idempotent. A late
direct `checking -> resolved` transition is rejected after first persisting the
upgrade; a later explicit `escalated -> resolved` remains valid. Server-side
escalation does not manufacture a video grant when no controller is present.
The latest authoritative alarm is returned as strict `current_alarm` metadata in
`controller_ready`. An unresolved escalation survives lease replacement by being
rewritten into the new session with the same event and trigger but a new session
ID and sequence; stale offline safety state cannot erase it. Only a resolved event
whose trigger matches that authoritative escalation can close it. A structured
alarm checkpoint is updated in the same transaction as each watchdog transition.
On cold start it idempotently backfills pre-watchdog `alarm_state` rows and
monotonically reconciles any writes made while an older Worker version was active;
an already authoritative escalation cannot be reopened or have its trigger
rewritten by a higher client sequence.

`media_grant_request` is accepted only for a matching consented kitchen care card
or matching escalated fall alarm. The generated short-lived grant includes only
viewers connected at issuance; a late viewer never inherits it. Strict
`reme-media-signal/v1` SDP/ICE messages are then forwarded only between the
controller and those viewer IDs. Revocation, resolving the source event, leaving
its scene, releasing the lease, or losing the controller socket closes the grant;
the browser also enforces the published expiry timestamp.

Activity recognition is an independent bounded HTTP path. It accepts at most
900 KiB of JSON containing one JPEG, sends that one sample to the configured MiMo
chat-completions endpoint, and strictly returns `cooking`, `not_cooking`, or
`uncertain` with confidence, reason, model, and latency. The image never enters
the Durable Object or logs. Unlock attempts are limited per Cloudflare
client address in a one-minute in-memory window; the control key must still be
high entropy because Origin checking is not authentication for non-browser clients.

Danger voice recognition is a second, isolated HTTP path for event-triggered
check-in only; it is not a continuously listening hotword service. The relay accepts
one canonical 16 kHz, mono, PCM16 RIFF/WAVE of at most 10 seconds for the current
unexpired `alarm_state(checking)` event. It atomically consumes that event's single
MiMo budget before making one `mimo-v2.5` chat-completions request with
an official `data:audio/wav;base64,...` `input_audio`, JSON mode, and thinking
disabled. A failed upstream request does not
refund the budget, and a verdict arriving after the frozen alarm deadline or after
an alarm/scene change is rejected.

Successful voice responses strictly return `ok=true`, an intent from `safe`,
`need_help`, or `unclear`, a nullable transcript of at most 240 characters, the
model, and integer latency. Request JSON is capped at 450 KiB; the response body
and MiMo call are bounded independently. The audio and transcript never enter
WebSockets, Durable Object storage, event broadcasts, or logs. The Durable Object
stores only the event-scoped attempt marker, and Worker logs contain redacted
request/event IDs, `provider=xiaomi_mimo`, model, upstream status, latency,
outcome, and byte count.

Cloudflare automatic invocation logs are disabled in both environments so the
controller credential carried by the browser WebSocket subprotocol is not
persisted as request metadata. Custom structured logs remain enabled. An operator
running an explicit real-time tail can still inspect transient request metadata;
that privileged debugging path must not be left running during a live demo.

Scene recognition is a separate explicit MiMo visual request and does not change
the pose, event, or media-grant WebSocket contracts. The preferred request is a
short clip:

```json
{
  "visual_kind": "video_clip",
  "media_format": "mp4",
  "media_b64": "<plain MP4 base64>",
  "duration_ms": 2000
}
```

When short recording is unavailable, the controller may transparently fall back
to one keyframe:

```json
{
  "visual_kind": "keyframe",
  "media_format": "jpeg",
  "media_b64": "<plain JPEG base64>",
  "duration_ms": 0
}
```

The union is exact: MP4 duration is a safe integer from 250 through 4000 ms and a
JPEG duration is exactly zero. JSON is capped at 3 MiB, decoded MP4 at 2 MiB,
decoded JPEG at 640 KiB, request-body reading at 2 seconds, the complete request at
8 seconds, and the MiMo response at 64 KiB. The Durable Object permits one request
in flight and six paid attempts per controller session in each one-minute window;
upstream failures consume an attempt.

A successful response has the exact result fields `scene_id`, `confidence`,
`reason`, `temporal_evidence`, `model`, and `latency_ms`, plus `ok=true`.
`scene_id` is one of `living`, `kitchen`, `bathroom`, `fall`, or `uncertain`.
A keyframe can never claim temporal evidence. A `fall` result is only a visual
classification candidate: it does not create an alarm, bypass the local temporal
pose rule, or authorize family video.

The media exists only in the current MiMo request. It is never placed in Durable
Object storage, WebSockets, or logs. Custom logs contain only a random request ID,
provider/model, upstream status, latency, outcome, visual kind, media format,
declared duration, and decoded byte count; they omit media, Base64, model reason,
and credentials. Controller cancellation is propagated through both scene and
activity handlers to the corresponding upstream MiMo request.

## Local verification

```sh
npm install
npm run types
npm test
npm run check
CONTROL_KEY_SHA256=<64-character-test-digest> npm run dry-run
```

For local `wrangler dev`, place `CONTROL_KEY_SHA256` in an ignored `.dev.vars` file.
The value is the lowercase SHA-256 hex digest of the human-entered control key.
Place `MIMO_API_KEY` there as well when exercising activity, scene, or danger voice
recognition.

## Deployment inputs

Before a real deployment, set the production digest as a Worker secret:

```sh
npx wrangler secret put CONTROL_KEY_SHA256
npx wrangler secret put MIMO_API_KEY
```

`MIMO_BASE_URL` and `MIMO_MODEL` are non-secret Wrangler vars and default to
`https://api.xiaomimimo.com/v1` and `mimo-v2.5`. Secret values are never written
to `wrangler.jsonc`.

`ALLOWED_ORIGINS` is a controlled, comma-separated exact-match list. Successful
responses echo the matched request origin and include `Vary: Origin`; wildcard
origins are not used. Production accepts `https://reme.maniforld.com`,
`https://monitor.reme.maniforld.com`, and `https://reme-sage.vercel.app`, and binds the Worker custom domain
`relay.reme.maniforld.com`. The isolated `staging` environment uses a `workers.dev`
hostname and accepts `http://127.0.0.1:4174`, `http://127.0.0.1:4187`, and
`https://reme-sage.vercel.app`.
