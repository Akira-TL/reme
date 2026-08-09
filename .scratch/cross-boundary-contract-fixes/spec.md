# Frontend/backend authority seam fixes

Status: Implemented and verified
Date: 2026-08-09
Target branch: `lbx-frontend`

## Goal

Close the current demo's executable authority gaps without moving safety state
transitions back into the browser. Home, Relay and Family render or forward
backend facts; only genuine elder/family gestures travel back as responses.

## In scope

1. **Server-owned response deadlines**
   - A runtime deadline adapter is owned by B and keyed by scene + decision.
   - B schedules it exactly once when a timeout-bearing decision is committed.
   - A real response, replacement decision, scene/session reset or runtime
     shutdown cancels the old deadline atomically.
   - Expiry calls a dedicated deterministic state-machine timeout transition;
     it does not fabricate a browser `InteractionResponse`.
   - `response_deadline_ms` is emitted as display metadata. Scheduling uses a
     monotonic timer; the wall-clock value is only for countdown/reconnect UI.

2. **Danger confirmation remains ask-first and is executable**
   - Restore the accepted ADR-0007 `frame + voice` confirmation contract.
   - Home may submit one frame only after the elder prompt has finished
     playback. It must not auto-upload a frame merely because a decision was
     received.
   - A's transition evidence is not auto-uploaded until there is a server-side
     prompt-delivery receipt; silently alarming before the question is heard is
     forbidden.

3. **Separate every family acknowledgement kind**
   - `alarm_confirmed`, `card_confirmed`, and
     `family_notification_confirmed` are distinct B response values.
   - Relay commands are likewise distinct: `confirm_alarm`,
     `confirm_action_card`, and `confirm_family_notification`.
   - B rejects the acknowledgement kind when it does not match the pending
     decision. Family renders a real confirmation action for pending ordinary
     action cards and ordinary family notifications.

4. **Execute `privacy_mode`**
   - Home maps `visible`, `blurred`, `skeleton_only`, and `hidden` to actual
     render modes; no decision fails closed to skeleton-only.
   - Bathroom and `hidden` are hard vetoes for clear media.
   - An active ADR-0008 event grant may override routine `blurred` or
     `skeleton_only` presentation, but never bathroom/`hidden`.
   - Relay revokes an existing grant if a newer authoritative decision changes
     privacy to `hidden`.

## Out of scope / still gated

- Production identity, recipient routing, offline push delivery and receipts.
- Persistent cross-day care history.
- Public-internet WebRTC/TURN deployment and production origin configuration.
- Persisting deadline recovery across a B process crash. This patch guarantees
  browser independence and orderly runtime reset/shutdown, not process-crash
  recovery; durable recovery needs a persistence ADR.
- Replacing the frontend-local kitchen media authorization with a durable B
  consent receipt. It remains fail-closed on reload and is tracked below.
- Machine-readable schema generation/parity and prompt-delivery receipts.

The concrete follow-up seams and their gates are recorded in
`remaining-gaps.md`.

## Acceptance

- A backend integration test observes escalation after the Home/browser side
  performs no timeout submission.
- A response/reset before expiry prevents the stale timeout from publishing.
- Danger policy/server/E2E tests agree on frame + voice and frame submission is
  sequenced after prompt playback in frontend unit coverage.
- Alarm, action-card and ordinary family-notification confirmation each succeed
  only on the matching pending decision across B, Home, Relay and Family tests.
- Privacy mapping and hidden/grant precedence have pure unit tests; Relay tests
  cover grant denial and revocation.
- Backend decision tests, frontend tests/lint/build/routes and Relay tests/check
  all pass before the second push.
