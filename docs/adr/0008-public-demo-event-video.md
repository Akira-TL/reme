# ADR-0008: Fixed public demo room with event-scoped family video

- Status: Accepted for demo
- Date: 2026-08-08
- Owner: Demo Surfaces / Relay
- Depends on: ADR-0003, ADR-0005, ADR-0007

## Context

The judge demo needs a passwordless Monitor and a separate family Viewer that can be opened on desktop or mobile. The selected demonstration mode uses one fixed public room and allows every connected Viewer to receive short-lived clear video during an explicitly authorized kitchen moment or an authoritative fall escalation.

This intentionally conflicts with the previous blanket statement that judge/family-facing output must never make a person easily identifiable. It is therefore a demo-only exception, not a production access-control or privacy design.

## Decision

- The room is deliberately unauthenticated. Exact Origin checks, connection limits and leases prevent accidental UI races but are not represented as authentication.
- Routine presentation remains skeleton/structured state. Bathroom presentation always denies clear video.
- A kitchen grant requires an explicit current-event consent result and lasts no more than 60 seconds.
- A fall grant requires the current authoritative escalated alarm and lasts no more than 30 seconds.
- Every online Viewer, including a Viewer joining during the remaining kitchen or fall grant, is in the grant audience. The UI must disclose the public audience count and remaining clear-video time.
- Clear video uses grant-bound WebRTC. RTP is not proxied, persisted or logged by the Relay. WebSocket and storage payloads reject raw-media fields.
- All grants are revoked on expiry, scene/source/runtime-session change, capture stop, producer loss or Relay authority loss.
- Browser media permissions and local file selection remain local user gestures. Viewer commands cannot bypass them.
- Viewer commands cannot cancel, reduce, fabricate or delay a deterministic safety escalation.

## Consequences

- The demo cannot claim that family-facing output is always de-identified or that the public room is production-secure.
- Anyone who can load the public Viewer during an active grant may see the temporary clear video. The product must show this plainly before capture starts and while a grant is live.
- A production design requires a separate ADR for identity, consent proof, encryption/access policy, audit, retention and revocation.
- Public deployment is not authorized by this ADR alone; cloud-demo deployment authority and runtime/Relay boundaries are defined by ADR-0009.
