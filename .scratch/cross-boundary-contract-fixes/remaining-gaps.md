# Remaining cross-boundary gaps

Status: Gated follow-ups
Reviewed: 2026-08-09

The current patch closes the executable demo's server-deadline, ask-first frame,
family acknowledgement and privacy-presentation seams. The items below are not
silently implemented because each changes product architecture, deployment
authority or persistence policy.

## P1 — required before a real household deployment

1. **Identity, household routing and offline delivery**
   - The Relay is deliberately one unauthenticated public demo room with at
     most five online Viewers. A control lease prevents UI races; it is not
     authentication or recipient authorization.
   - There is no APNs/FCM/SMS fallback, delivery receipt or retry policy when
     the family page is offline.
   - Gate: choose identity/household ownership, recipient policy, notification
     provider and an auditable delivery state machine.

2. **Durable B deadline recovery**
   - B's monotonic scheduler survives browser closure and normal session/runtime
     lifecycle changes, but not a B process crash.
   - Gate: persist pending decision identity plus deadline and define restart,
     duplicate-alarm and late-response idempotency in an ADR.

3. **Prompt delivery versus reply-window start**
   - The safety deadline currently starts when B commits the decision. Home no
     longer owns the timer, but B cannot prove that a slow/unavailable client
     actually played the prompt before the reply window expired.
   - A's evidence-frame shortcut stays disabled for this reason.
   - Gate: define a server-owned delivery phase (bounded delivery deadline plus
     idempotent prompt receipt) without making safety escalation depend forever
     on a browser acknowledgement.

4. **Durable consent receipt**
   - Kitchen event-video authorization is still a short-lived Home-local receipt
     derived from the current B decision. It fails closed on reload, but B and
     Relay do not own the original consent record.
   - Gate: version a consent-grant/revoke record with subject, scope, audience,
     issued/expiry times and decision provenance.

5. **Persistent care history**
   - Family timeline data is presentation memory plus demo fixtures, not an
     authoritative cross-day history.
   - Gate: retention/privacy policy and an explicit persistent event schema.

## P1 — deployment seams

1. **Public-internet media requires TURN fallback**
   - The current WebRTC path intentionally reports LAN/STUN-only capability.
     Restrictive NAT/firewall pairs can therefore fail even while Relay state
     synchronization works.
   - Gate: a server-side short-lived TURN credential endpoint, abuse controls
     and usage monitoring. Never ship the long-lived TURN key to the browser.

2. **Production origins and URLs are not configured**
   - `demo-relay/wrangler.jsonc` allows localhost origins only.
   - A deployment must set the real HTTPS Home/Family origins and the frontend
     Relay URL; camera capture also requires a secure context on non-localhost.

3. **Fixed room sharding is demo-only**
   - `shared-live-demo` is intentionally one Durable Object coordination atom.
     A household product needs one independently authorized object per household
     or care session, plus lifecycle cleanup.

## P2 — contract maintainability

1. **Schema definitions are duplicated**
   - CareDecision and control-command vocabularies currently exist in Python,
     frontend validators, Monitor ingress and Relay TypeScript. The missing
     action-card Monitor command found in this review is evidence of drift risk.
   - Gate: promote versioned machine-readable schemas as the source of truth,
     generate/typesafe validators where practical, and add cross-runtime fixture
     parity to CI.

2. **Action-card capability depends on MiMo output**
   - The normal care action card is executable when the MiMo adapter returns a
     valid structured card. A missing cognition adapter cannot invent a safe
     card and must remain visibly unavailable/degraded.
   - Gate: define the product fallback (degraded status, human-authored template
     or feature unavailable); do not synthesize medical content in the client.
