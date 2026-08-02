# ADR-0005: Check-in first, deterministic escalation, no model cancellation

- Status: Accepted
- Date: 2026-08-01
- Owner: B (decision layer)
- Related: ADR-0003 (minimal visual context), `.scratch/abc-interface/spec.md` sections 10-11,
  `.scratch/handoff/2026-08-01-spec-crosscheck.md` section 8.2

## Context

The demo narrative and the shared contract both need a single, defensible
answer to "what happens when the model is slow, wrong, or silent during a
possible emergency". In this project "alert" means pushing a notification to
the family view; it never means calling external emergency services.

Two pressures conflict: the check-in dialogue is the product's core gesture of
respect (ask the person first), while a fall with no response must escalate
without depending on a cloud round trip.

## Decision

Three invariants, in order:

1. **Check-in first.** A high-confidence fall-like transition produces a
   rule-sourced check-in decision immediately, with a mandatory
   `response_timeout_ms` countdown. MiMo is not consulted on this path.
2. **Deterministic escalation.** When the countdown expires and C submits
   `response = none / source = timeout`, the rules emit
   `family_notification_required` (and `urgent_attention` after a second
   timeout) with `source = rule`, without waiting for any in-flight MiMo call.
3. **No model cancellation.** A MiMo result that arrives after a rule
   escalation is discarded. MiMo output can never lower, cancel, or delay an
   escalation; it may only contribute wording on non-escalation paths.

## Implementation anchors

- `reme.decision.state_machine`: timeout transitions are rule-only
  (`mimo_task is None`); escalations raise a monotonic `risk_floor`.
- `reme.decision.guardrails.violates_risk_floor`: outbound decisions may not
  map below the session's risk floor.
- `reme.decision.policy.DecisionService`: a generation compare-and-swap
  discards MiMo results that lost the race against a rule transition.
- `reme.decision.mimo.schema.MimoProposal`: the proposal type has no `action`,
  no `decision_id`, no `response_timeout_ms` and no `source`, and each task
  restricts the `state` values the model may suggest — a cancellation is not
  expressible at the type level.
- Degraded output (`state = degraded, fallback_used = true`) exists only on
  MiMo-backed paths; rule paths never degrade.

## Consequences

- The demo can honestly claim: dialogue is model-shaped, safety is rule-shaped.
- MiMo latency (measured 1.7-5.9s) affects wording, never escalation timing.
- The conservative consent-timeout default (no answer means no family
  notification) is a separate product choice recorded in the state machine and
  may be revisited without touching these invariants.
