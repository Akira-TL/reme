# ADR-0009: Cloud demo runtime authority, FamilyEvent relay and TURN

- Status: Accepted for cloud demo
- Date: 2026-08-09
- Owner: Runtime / Relay
- Depends on: ADR-0003, ADR-0005, ADR-0007, ADR-0008

## Context

The hackathon demo may place the home-side machine and Family Viewer on different networks. A public Family page and a cloud Relay are therefore useful, but moving perception to the cloud would conflict with Reme's privacy-first architecture: routine camera frames, pose landmarks and model diagnostics are not cloud state.

The previous dual-device demo also let Home derive the Family `care.phase`, consent lifetime and `alarm_authoritative` summary before publishing them to Relay. That was sufficient for a local demo but made a browser part of the safety authority chain.

## Decision

### Local Runtime remains the business authority

The local Reme Runtime owns:

- pose / transition input and fall detection;
- `CareDecision` state transitions;
- autonomous interaction deadlines;
- `AlarmSignal` and alarm trigger provenance;
- action-card lifecycle;
- event-scoped clear-video authorization.

The runtime does not require a Home browser timer to advance `check_in_required` or a family-ack deadline.

### Cloud Relay receives a minimized FamilyEvent

The Runtime may publish `reme-family-event/v1` to the cloud Relay through authenticated server-to-server HTTP.

The projection contains only Family-facing business facts:

- runtime session and monotonic revision;
- decision id, state, action and risk level;
- family notification copy;
- privacy mode;
- alarm signal;
- optional action card;
- optional event-scoped media authorization.

It does not contain camera frames, pose landmarks, posture/model scores, visual-context frames, MiMo prompts or raw audio/video.

`elder_quote` is omitted by default and requires an explicit runtime configuration to be included.

### Viewer protocol compatibility

`reme-viewer-v1` remains the existing local-demo protocol and does not receive unknown `family_event` messages.

`reme-viewer-v2` receives the authoritative FamilyEvent snapshot on connect and subsequent FamilyEvent broadcasts.

This lets the backend/Relay deploy before a Family frontend migrates to the new event contract.

### Authorization and transport grant are separate

`MediaAuthorization` is a Runtime business fact. `media_grant` is a Relay transport permission.

Runtime authorization scopes are:

- `kitchen_moment`: explicit current-event consent, maximum 60 seconds;
- `fall_emergency`: current authoritative fall alarm, maximum 30 seconds.

Bathroom and `hidden` / `skeleton_only` privacy modes cannot produce clear-video authorization.

When a FamilyEvent is present, Relay validates media grants against the Runtime authorization and ignores Home-derived consent/alarm authority. The old Home-derived path remains only as a compatibility fallback for the existing v1 local demo when no FamilyEvent has ever been published.

### Cross-network media uses WebRTC + TURN

Relay provides `/api/rtc-config`. With TURN REST configuration, it generates short-lived credentials from a server-side shared secret. The secret is never returned to browsers or built into a frontend bundle.

Relay continues to carry only WebRTC signaling. RTP/SRTP media is not serialized into Relay JSON or persisted in Durable Object storage.

### Runtime ingest authentication

`POST /api/runtime/event` is server-to-server and requires a bearer token configured as a Worker secret. It is intentionally independent from browser Origin checks.

Stale or duplicate FamilyEvent revisions for the same runtime session are rejected.

## Compatibility boundary

ADR-0008 remains the demo privacy exception for the fixed Family room. This ADR does not turn the public demo room into production access control.

The cloud demo still does not claim:

- production family identity/account management;
- APNs / FCM / Web Push delivery;
- offline delivery receipts;
- durable cross-day family history;
- production-grade retention/revocation policy.

## Operational configuration

Local Runtime:

```text
REME_FAMILY_RELAY_ENDPOINT=https://<relay-host>/api/runtime/event
REME_FAMILY_RELAY_TOKEN=<shared runtime ingest token>
```

Optional, and disabled by default:

```text
REME_FAMILY_RELAY_INCLUDE_ELDER_QUOTE=1
```

Cloud Relay Worker secrets/bindings:

```text
RUNTIME_INGEST_TOKEN=<same runtime ingest token>
REME_STUN_URLS=stun:<turn-host>:3478
REME_TURN_URLS=turn:<turn-host>:3478?transport=udp,turns:<turn-host>:5349?transport=tcp
REME_TURN_SHARED_SECRET=<coturn REST shared secret>
REME_TURN_CREDENTIAL_TTL_SECONDS=3600
```

`RUNTIME_INGEST_TOKEN` and `REME_TURN_SHARED_SECRET` must be secrets in a public deployment, not committed values.

## Consequences

- Home browser failure no longer blocks backend safety deadlines or FamilyEvent production.
- Multiple online v2 Viewers consume one backend-authoritative state stream.
- Kitchen consent survives Home UI state loss for the lifetime of the Runtime authorization.
- Relay can fail closed on privacy mode / authorization even if a Home page reports permissive legacy state.
- Cross-NAT WebRTC becomes deployable once a compatible TURN service and frontend RTC-config consumption are present.
- The cloud Relay remains deliberately small: structured Family state, grant state and signaling, not perception or media storage.
