# Backend → Relay authoritative family state

Status: Implemented and verified
Date: 2026-08-09
Owner: backend contract + Relay transport; frontend presentation only

## Goal

The browser may publish capture, runtime and pose presentation state, but it
must not manufacture or re-interpret care state, privacy permission, safety
alarms, family tasks, or media authorization. The backend emits one exact,
monotonically revised `FamilyEvent`; Relay persists and replays that event to
every connected client.

## Frozen contracts

### `reme-family-event/v1`

Each event contains:

- `room_session_id`: Relay room generation, obtained by the backend from the
  authenticated Relay context endpoint;
- `runtime_session_id`: backend runtime session generation;
- `revision`: backend-owned, starts at `0` for each runtime session and
  strictly increases. Because the asynchronous publisher is latest-wins,
  Relay accepts the first observed revision of a new runtime even if an
  intermediate revision `0` clear was coalesced;
- `timestamp_ms`;
- `care`: a family-safe projection of the exact authoritative CareDecision, or
  `null` after reset/stop;
- `authorization`: the current backend media authorization, or `null`.

The projection carries only identifiers, state/action/risk, family message,
privacy mode, reason/uncertainty/provenance, visual-context metadata, alarm and
the actionable part of an action card. It excludes elder prompts, the elder's
verbatim action-card quote, model traces, pose landmarks and raw media because
the fixed public room has no household identity boundary.

Relay rejects a non-increasing revision within one runtime session. A changed
runtime session starts a new monotonic generation. Relay stores the last exact
event in SQLite and sends it to late/reconnecting Monitor and Family clients.

### `reme-media-authorization/v1`

An Authorization is a backend safety decision; a MediaGrant is a Relay
transport lease. They are deliberately separate.

- Kitchen: only a resolved, explicitly consented kitchen-share decision may
  issue `scope=kitchen_moment`, maximum 60 seconds.
- Fall: only an authoritative decision with a non-null alarm in the fall scene
  may issue `scope=fall_emergency`, maximum 30 seconds.
- `scene_id=bathroom` or `privacy_mode=hidden` is a hard veto.
- Authorization is bound to `authorization_id`, `decision_id`, `event_id`,
  runtime session, scene, scope, audience and expiry.
- Relay may issue a MediaGrant only for the exact active Authorization and caps
  its expiry at the Authorization expiry.
- Reset, session replacement, revocation or expiry invalidates active grants.

The fixed public demo room uses the closed audience
`public_demo_viewers`. Account-scoped audiences require a separate ADR.

### Backend ingress

Relay exposes backend-only endpoints protected by one bearer secret:

- `GET /api/backend/context`
- `POST /api/backend/family-event`

Secret comparison is timing safe. Browser CORS does not authorize these
routes. The backend publisher is asynchronous and latest-wins so Relay outage
cannot delay the safety state machine; it retries the current event and
refreshes room context on room replacement.

### RTC configuration

`GET /api/rtc-config` returns exact `reme-rtc-config/v1` with short-lived ICE
servers and expiry. With configured Cloudflare Realtime TURN credentials the
Worker obtains ephemeral TURN credentials server-side. Local development uses
STUN-only capability and never exposes long-lived TURN secrets to either
browser. TURN transports encrypted WebRTC packets only; Relay persists neither
SDP/media payloads nor media bytes.

## Frontend rule

Home may keep a CareDecision locally to render the elder interaction, but the
published `reme-demo-state/v4` always has the fixed empty care value
`{"phase":"idle","consent":"none","decision":null}`. Family renders
care/alarm/action-card/privacy from `FamilyEvent` only. Monitor requests
a Relay MediaGrant from the received backend Authorization, never from a local
care inference. Both WebRTC peers use the fetched RTC configuration.

All three validators (Monitor, Relay and Family) reject any non-empty
`demo_state.state.care`; this is not merely a convention followed by the
current React component.

## Verified backend prerequisites from the handoff

- server-owned decision deadlines advance check-in → family notification →
  urgent attention without a browser timeout producer, while stale legacy
  timeout submissions remain idempotent;
- fall check-in exposes concurrent `frame` and `voice` confirmation channels;
- alarm, ordinary family-notification and action-card acknowledgements use
  separate response values and state-machine guards.

## Explicit non-goals

- offline push notifications;
- accounts, household membership and user-scoped history;
- cloud media recording or decoded-frame persistence;
- support beyond the fixed demo room and the currently measured scenes.

## Acceptance

1. Backend tests prove revision/reset/retry and kitchen/fall authorization
   invariants.
2. Relay tests prove authenticated ingress, persistence/reconnect, revision
   rejection, Authorization-gated grants, expiry/revocation and RTC config.
3. Frontend tests prove strict FamilyEvent/RTC parsing and that published demo
   state contains no care decision.
4. Python tests/Ruff/Mypy, frontend tests/lint/build, and Relay
   tests/typecheck/dry-run pass.
