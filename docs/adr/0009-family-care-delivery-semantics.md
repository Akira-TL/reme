# ADR-0009: Separate care judgments, family tasks and safety alarms

- Status: Accepted
- Date: 2026-08-09
- Owner: B contract + C presentation
- Depends on: ADR-0005, ADR-0007, ADR-0008

## Context

Reme has one authoritative `CareDecision`, but its family-facing meanings were
not explicit enough. A consented action card and a deterministic fall alarm
could both use `state=family_notification_required`; the compatibility phase
then labelled both as `emergency`. Meanwhile the Reme timeline projected the
card into a generic care judgment and discarded most task semantics.

This does not fabricate an alarm today because C checks the nullable `alarm`
payload, but it leaves naming, risk presentation and future integrations easy
to misuse.

## Decision

1. A **care judgment** is an explanatory, read-only presentation of the current
   CareDecision. It has no independent authority.
2. A **family action card** is a concrete, consented, non-emergency task. A
   pending card is risk 2, has no alarm, and can only receive a card
   acknowledgement.
3. An **ordinary notification** has neither a card nor an alarm and can only
   receive a notification acknowledgement when one is pending.
4. A **safety alarm** carries a non-null alarm payload, is risk 3 or 4, is
   mutually exclusive with a card, and is the only delivery allowed to start
   alarm side effects or authorize fall-event video.
5. B publishes `family_delivery = none | notification | action_card | alarm`.
   MiMo cannot set it. Exact validators enforce correspondence with payloads
   and risk; C and Relay consume it rather than inferring semantics from state,
   risk or prose.
6. The Reme timeline may render the same decision in a task- or alarm-specific
   card, but it must not create a second action card or safety state.
7. Tooth discomfort remains one scripted non-emergency product example. It is
   learned only from the elder's actual response, never inferred from pose or
   emitted as a medical warning.

## Consequences

- The CareDecision and Relay exact schema versions must advance.
- Existing alarm safety invariants remain unchanged and become easier to
  audit.
- Family UI can show the same authoritative action card on the immediate home
  surface and in Reme history without duplicate state.
- Ordinary care messages no longer inherit an `emergency` presentation phase.
- Mock Reme judgments remain clearly non-authoritative history fixtures.
