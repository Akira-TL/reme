# ADR-0010: Backend-owned family state and media authorization

- Status: Accepted
- Date: 2026-08-09
- Owner: backend + Relay boundary
- Depends on: ADR-0001, ADR-0003, ADR-0005, ADR-0007, ADR-0008

## Context

The accepted demo already makes CareDecision authoritative in the backend,
but Home republishes that decision inside a browser-owned snapshot. Relay then
uses the republished snapshot to decide whether video may be shared. This
leaves the browser acting as a second safety authority and makes backend state
unrecoverable when Home disconnects.

The demo also constructs WebRTC peers with no ICE servers. That only works on
favourable local networks and does not define how TURN credentials remain out
of browser source and repository configuration.

## Decision

1. The backend publishes exact `reme-family-event/v1` directly to Relay. Its
   revision is monotonic per runtime session; Relay persists and replays the
   latest event.
2. Home's demo-state stream is transport/presentation state only. It carries
   no authoritative CareDecision.
3. Backend media Authorization and Relay MediaGrant are different records.
   Authorization states why media is allowed; MediaGrant states which
   transport lease is active. Relay issues a grant only when both its current
   transport state and the exact backend Authorization allow it.
4. Bathroom and `privacy_mode=hidden` are hard vetoes in both backend
   authorization creation and Relay enforcement.
5. Backend ingress is protected by a deployment secret and timing-safe bearer
   verification. The local launcher generates an ephemeral secret for its
   child processes.
6. Relay exposes short-lived RTC configuration. Cloudflare TURN key material
   stays in Worker secrets; browsers receive only ephemeral ICE credentials.
7. TURN and Relay are transport-only. Neither may persist raw video, audio,
   decoded frames, SDP offers/answers or ICE candidates.
8. The fixed unauthenticated room remains a demo exception. Offline push,
   accounts and durable family history are not implied by this ADR.
9. Since that room has no household identity boundary, the Family action-card
   projection omits the elder's verbatim quote. Authenticated household delivery
   may define a different projection only in a later ADR.

## Consequences

- Family state remains available across browser reconnects and is consistent
  for all viewers.
- A compromised/stale Home browser cannot mint a media permission.
- WebRTC works on TURN-required networks after deployment secrets are
  configured, while local development degrades explicitly to STUN-only.
- Production deployment must set `BACKEND_PUBLISH_TOKEN`, `TURN_KEY_ID` and
  `TURN_KEY_API_TOKEN`; no new paid Cloudflare product is required by the
  contract, but TURN usage follows the Cloudflare Realtime pricing/limits of
  the deployed account.
