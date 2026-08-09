# Reme public demo Relay

Cloudflare Worker + SQLite Durable Object for the fixed `shared-live-demo`
prototype room. This room intentionally has no identity authentication and is
not a production privacy or access-control design.

The Relay coordinates structured state, a 17-point pose projection, one remote
controller lease, command acknowledgements, and event-scoped WebRTC signalling.
It rejects binary WebSocket frames, raw-media fields, data URLs, and JSON larger
than 16 KiB. RTP media never passes through the Worker or SQLite.

## Local development

```bash
npm ci
npm run types
npm run dev -- --ip 127.0.0.1 --port 8787
```

The checked-in origin allowlist includes the standard Vite development and
preview ports `5173`, `4173`, and `4174` on `localhost` and `127.0.0.1`. Add an
explicit LAN origin before opening the frontend from a phone; do not replace the
allowlist with `*`.

This local stage provides signalling only and deliberately has no TURN
credential service. Cross-NAT clear video must be shown as unavailable/LAN-only
until the separately approved deployment phase configures short-lived TURN
credentials.

## HTTP and WebSocket entrypoints

- `GET /health`: stateless Worker health.
- `GET /api/status`: current public room status, without tokens.
- `POST /api/monitor/claim`: bodyless, passwordless producer claim. Returns a
  256-bit token, a new `room_session_id`, and a 30-second expiry. A live lease
  returns HTTP 409 with `retry_at_ms`, `server_time_ms`, and the clock-skew-safe
  relative `retry_after_ms`.
- `GET /ws/monitor`: protocols `reme-monitor-v1` and
  `reme-token-${producer_token}`.
- `GET /ws/viewer`: public protocol `reme-viewer-v1`, capped at five sockets.

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

State and pose are the exact `reme-demo-state/v3` and
`reme-pose-frame-17/v1` contracts exported by `src/protocol.ts`. Monitor state
must publish `state.media_grant=null`; the Relay projects its own active grant
for Viewers. In v3, `state.care.decision` is the exact current
`reme-care-decision/v0-experiment` snapshot (or `null`); `phase` is presentation
metadata and never substitutes for `decision.alarm`. A new Viewer receives the
current state and only a pose received within the last 2.5 seconds.

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
{"type":"media_grant_request","room_session_id":"room-...","runtime_session_id":"runtime-...","event_id":"decision-...","scope":"kitchen_moment","expires_in_ms":60000}
{"type":"media_grant_revoke","room_session_id":"room-...","grant_id":"grant-..."}
{"type":"media_grant","room_session_id":"room-...","grant":{"grant_id":"grant-...","event_id":"decision-...","scope":"kitchen_moment","expires_at_ms":0,"status":"active"},"audience":"all_viewers","reason":null}
{"schema_version":"reme-media-signal/v1","room_session_id":"room-...","grant_id":"grant-...","target_id":"monitor","signal_type":"offer","signal":{"type":"offer","sdp":"..."}}
{"schema_version":"reme-media-signal/v1","room_session_id":"room-...","grant_id":"grant-...","target_id":"viewer-...","signal_type":"answer","signal":{"type":"answer","sdp":"..."}}
```

The Relay adds `from_id` when forwarding a signal. Each Viewer creates a
`recvonly` video peer and sends the offer to `monitor`; the Monitor answers that
specific `viewer_id`. ICE always targets the opposite peer. A Viewer joining
during either active grant receives the remaining grant projection and starts
the same offer flow immediately. Kitchen grants require current-event consent
and last at most 60 seconds. Fall grants require the current event's exact
`care.decision.decision_id` plus a non-null `care.decision.alarm`, and last at
most 30 seconds. Bathroom, source/session/scene changes,
capture loss, stale authority, producer loss, and expiry all revoke the grant
fail-closed. A repeated grant for the same room event can use only the time
remaining before that event's first persisted grant deadline; it cannot restart
the 60/30-second window.

## Verification

```bash
npm test
npm run check
npm run dry-run
npm audit
```

`wrangler types` generates `worker-configuration.d.ts`; do not hand-maintain the
`Env` binding interface. No deploy command is part of this local phase.
