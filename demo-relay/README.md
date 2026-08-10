# Reme public demo Relay

Cloudflare Worker + SQLite Durable Object for the fixed `shared-live-demo`
prototype room. This room intentionally has no identity authentication and is
not a production privacy or access-control design.

The Relay coordinates transport/presentation state, a persisted backend-owned
`reme-family-event/v1`, a 17-point pose projection, one remote controller
lease, command acknowledgements, and event-scoped WebRTC signalling. It rejects
browser-authored care facts, binary WebSocket frames, raw-media fields, data
URLs, and JSON larger than 16 KiB. RTP media never passes through the Worker or
SQLite.

## Local development

```bash
npm ci
npm run types
cp .dev.vars.example .dev.vars
npm run dev -- --ip 127.0.0.1 --port 8787
```

The checked-in origin allowlist includes the single public product origin
`https://reme.maniforld.com`, the canonical Vercel deployment origin, and
the standard Vite development and preview ports `5173`, `4173`, and `4174` on
`localhost` and `127.0.0.1`. Add an explicit LAN origin before opening the
frontend from a phone; do not replace the allowlist with `*`.

The user-facing routes are `/home`, `/family`, and `/debug` on that one product
origin. `https://relay.reme.maniforld.com` is a transport-only HTTP/WebSocket
endpoint, not a separate product page or user-facing hostname.

The unified launcher creates a random `BACKEND_PUBLISH_TOKEN` and injects it
into both backend and Relay. Manual Wrangler development uses the ignored
`.dev.vars` file. `TURN_KEY_ID=local-disabled` makes `/api/rtc-config` return
STUN-only capability; public cross-NAT video therefore remains explicitly
unavailable until deployment configures Cloudflare Realtime TURN.

## HTTP and WebSocket entrypoints

- `GET /health`: stateless Worker health.
- `GET /api/rtc-config`: exact short-lived `reme-rtc-config/v1`; returns STUN
  locally and ephemeral STUN/TURN credentials in a configured deployment.
- `GET /api/status`: current public room status, without tokens.
- `POST /api/monitor/claim`: bodyless, passwordless producer claim. Returns a
  256-bit token, a new `room_session_id`, and a 30-second expiry. A live lease
  returns HTTP 409 with `retry_at_ms`, `server_time_ms`, and the clock-skew-safe
  relative `retry_after_ms`.
- `GET /ws/monitor`: protocols `reme-monitor-v1` and
  `reme-token-${producer_token}`.
- `GET /ws/viewer`: public protocol `reme-viewer-v1`, capped at five sockets.

Backend-only ingress requires `Authorization: Bearer
${BACKEND_PUBLISH_TOKEN}` and is not a browser API:

- `GET /api/backend/context`: current Relay `room_session_id`.
- `POST /api/backend/family-event`: persist and broadcast the exact latest
  backend FamilyEvent. Revisions must strictly increase within one runtime;
  exact retries are idempotent.

The Monitor sends `monitor_heartbeat` every 10 seconds. Producer and controller
leases both expire after 30 seconds. Authoritative state must also be refreshed
within 30 seconds; a stale-state alarm revokes event media, fails pending
commands, and broadcasts `state_unavailable(stale)`. One idempotent Durable
Object alarm handles all of these deadlines.

## Exact protocol shapes

All IDs use at most 128 ASCII letters, digits, `_`, or `-`.

Monitor lifecycle:

```json
{"type":"monitor_ready","room_name":"shared-live-demo","room_session_id":"room-...","expires_at_ms":0,"viewer_count":0,"max_viewers":5,"controller":null,"heartbeat_interval_ms":10000,"server_time_ms":0}
{"type":"monitor_heartbeat","room_session_id":"room-..."}
{"type":"monitor_heartbeat_ack","room_session_id":"room-...","expires_at_ms":0}
{"type":"control_revoke","room_session_id":"room-..."}
{"type":"monitor_release","room_session_id":"room-..."}
```

`control_revoke` is Monitor-only. It terminally fails the current room's
nonterminal commands, removes the controller lease, and broadcasts
`controller_status`. Viewer release, disconnect, and lease expiry use the same
fail-before-delete ordering.

Viewer lifecycle and controller lease:

```json
{"type":"viewer_ready","room_name":"shared-live-demo","viewer_id":"viewer-...","room_session_id":"room-...","monitor_online":true,"viewer_count":1,"max_viewers":5,"controller":null,"server_time_ms":0}
{"type":"viewer_presence","room_session_id":"room-...","viewer_count":1,"max_viewers":5,"monitor_online":true,"server_time_ms":0}
{"type":"control_claim","room_session_id":"room-..."}
{"type":"control_claim_result","status":"granted","room_session_id":"room-...","lease":{"lease_id":"lease-...","expires_at_ms":0}}
{"type":"control_heartbeat","room_session_id":"room-...","lease_id":"lease-..."}
{"type":"control_heartbeat_ack","room_session_id":"room-...","lease_id":"lease-...","expires_at_ms":0}
{"type":"control_release","room_session_id":"room-...","lease_id":"lease-..."}
{"type":"controller_status","room_session_id":"room-...","controller":{"viewer_id":"viewer-...","lease_id":"lease-...","expires_at_ms":0},"server_time_ms":0}
```

State and pose are the exact `reme-demo-state/v4` and
`reme-pose-frame-17/v1` contracts exported by `src/protocol.ts`. Monitor state
must publish `state.media_grant=null` and the fixed empty care projection
`{"phase":"idle","consent":"none","decision":null}`. Any Home-authored care
fact is rejected. The Relay projects its own active grant for Viewers. A new
Viewer receives the current transport state, the persisted latest FamilyEvent,
and only a pose received within the last 2.5 seconds.

Family care, alarm, privacy mode and action-card facts come only from
`reme-family-event/v1`, whose care projection uses
`reme-care-decision/v1-experiment`. Its B-owned `family_delivery` explicitly
separates `none`, `notification`, `action_card`, and `alarm`; only
`family_delivery=alarm` with a non-null `alarm` may drive emergency UI, alert
channels, or fall video. The event carries separate room/runtime generations
and a backend-owned revision. Its `reme-media-authorization/v1` is a business
authorization; it is not a WebRTC MediaGrant. In the anonymous fixed room,
Family action cards omit the elder's verbatim quote.

Commands are sent directly from the controller Viewer to the Relay and then
unchanged to the Monitor:

```json
{"schema_version":"reme-control-command/v1","room_session_id":"room-...","command_id":"cmd-...","command_sequence":1,"issued_at_ms":0,"expires_at_ms":0,"expected_state_revision":1,"command":{"name":"start_capture"}}
{"type":"control_ack","room_session_id":"room-...","command_id":"cmd-...","phase":"received","timestamp_ms":0,"state_revision":null,"reason":null}
```

ACK phases are `received`, `awaiting_local_confirmation`, `applied`, `rejected`,
or `failed`. The Relay caches exact valid `command_id` values, including
pre-controller and invalid-sequence rejections; a byte-order-independent
equivalent retry receives the cached ACK. Terminal history is bounded to the
most recent 256 rows in the active room.

Media grant and signalling:

```json
{"type":"media_grant_request","room_session_id":"room-...","runtime_session_id":"runtime-...","event_id":"authorization-...","scope":"kitchen_moment","expires_in_ms":60000}
{"type":"media_grant_revoke","room_session_id":"room-...","grant_id":"grant-..."}
{"type":"media_grant","room_session_id":"room-...","grant":{"grant_id":"grant-...","event_id":"authorization-...","scope":"kitchen_moment","expires_at_ms":0,"status":"active"},"audience":"all_viewers","reason":null}
{"schema_version":"reme-media-signal/v1","room_session_id":"room-...","grant_id":"grant-...","target_id":"monitor","signal_type":"offer","signal":{"type":"offer","sdp":"..."}}
{"schema_version":"reme-media-signal/v1","room_session_id":"room-...","grant_id":"grant-...","target_id":"viewer-...","signal_type":"answer","signal":{"type":"answer","sdp":"..."}}
```

The Relay adds `from_id` when forwarding a signal. Each Viewer creates a
`recvonly` video peer and sends the offer to `monitor`; the Monitor answers that
specific `viewer_id`. ICE always targets the opposite peer. A Viewer joining
during either active grant receives the remaining grant projection and starts
the same offer flow immediately. Kitchen grants require the exact active
backend `kitchen_moment` Authorization plus `family_delivery=notification`, and
last at most 60 seconds. Fall grants require the exact active
`fall_emergency` Authorization, whose FamilyEvent must carry
`family_delivery=alarm` and a valid alarm, and last at most 30 seconds. Bathroom,
`privacy_mode=hidden`, Authorization loss/expiry, source/session/scene changes,
capture loss, stale transport authority, and producer loss revoke the grant
fail-closed. Re-requesting a grant cannot extend it beyond the backend
Authorization deadline.

## Deployment secrets

Production must set three Worker secrets; never commit their values or expose
them through Vite variables:

```bash
npx wrangler secret put BACKEND_PUBLISH_TOKEN
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_API_TOKEN
```

Generate `BACKEND_PUBLISH_TOKEN` as at least 32 random bytes and configure the
backend publisher with the same value:

```bash
REME_FAMILY_RELAY_URL=https://your-relay-worker.example
REME_FAMILY_RELAY_PUBLISH_TOKEN=<same value as BACKEND_PUBLISH_TOKEN>
```

Those two backend settings are server-only. If either is absent, the backend
keeps its local safety state machine running but disables Relay publication and
logs the incomplete configuration instead of leaking a partial credential.

`TURN_KEY_ID` and `TURN_KEY_API_TOKEN` are the Cloudflare Realtime TURN key ID
and API token. The Worker exchanges them server-side for one-hour ephemeral ICE
credentials. A deployment under different domains must replace the checked-in
`ALLOWED_ORIGINS` with its exact HTTPS Home and Family origins. The
implementation does not require a separate Reme media server or cloud recording
store; TURN account usage is subject to the deployed Cloudflare account's
current limits and pricing.

## Verification

```bash
npm test
npm run check
npm run dry-run
npm audit
```

`wrangler types` generates `worker-configuration.d.ts`; do not hand-maintain the
`Env` binding interface. No deploy command is part of this local phase.
