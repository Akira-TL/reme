# Family care semantics

Status: Implemented
Date: 2026-08-09
Target: merged `lbx-frontend` line based on `619c0e2a`

## Problem

The current runtime carries the authoritative `action_card` and `alarm`
payloads, but presentation still maps every `family_notification_required`
state to an `emergency` phase and the decision machine uses the same
`_family_alert` helper for ordinary care delivery and deterministic safety
alarms. The Reme timeline also projects an action-card decision into a generic
care judgment, losing the distinction between an explanation and a family
task.

This makes four different product meanings look interchangeable:

1. a care judgment explaining a reliable observation;
2. a consented family action card;
3. an ordinary family notification;
4. a deterministic safety alarm.

## Canonical semantics

### Care judgment (判词)

- A read-only presentation of an authoritative `CareDecision` using its
  provenance, reason, uncertainty and bounded visual-context metadata.
- It may recommend continued observation or explain why the system asked a
  question.
- It is not a family task and never enables alarm effects, confirmation
  commands or media grants.
- It remains a Family-side presentation projection; no second authoritative
  assessment copy is introduced into Relay state.

### Action card

- A concrete family task in `CareDecision.action_card`.
- It is created only after the elder supplies a concrete need and explicitly
  consents to tell family.
- The elder quote is rebound by B to the actual submitted transcript.
- A pending card is non-emergency risk 2, has `alarm = null`, and uses only
  `confirm_action_card` / `card_confirmed` for acknowledgement.
- A card may be confirmed/resolved without being rewritten as an alarm.
- Pose, a long-sit trigger, a mock timeline judgment or the frontend cannot
  invent a diagnosis or an action card.

### Ordinary notification

- A bounded family-facing message without an action card or alarm, for example
  an explicitly consented kitchen-memory share or an unanswered non-fall care
  check-in.
- It uses only `confirm_family_notification` when acknowledgement is required.
- It never enables alarm effects or fall media.

### Safety alarm

- A deterministic danger-path delivery carrying a non-null
  `CareDecision.alarm` and risk 3 or 4.
- It is mutually exclusive with `action_card`.
- Only it enables alarm modal/ring/vibration/flash and fall media grant.
- It uses only `confirm_alarm` / `alarm_confirmed` for acknowledgement.
- MiMo can contribute bounded wording or fast-path evidence but cannot create,
  lower, cancel or delay the rule transition.

## Authoritative discriminator

`CareDecision` adds a B-owned closed field:

```text
family_delivery = none | notification | action_card | alarm
```

It is not a MiMo proposal field. B derives it while assembling the decision and
all Python/JavaScript/TypeScript validators enforce its payload invariants.
Consumers render this field; they do not infer delivery type from
`state`, `risk_level`, copy text or local phase.

The embedded CareDecision schema and Relay state schema must be version-bumped
because both use exact-shape validation.

## Family presentation

- `家` keeps the current immediate ActionCard and Alarm surfaces.
- `reme` renders current Relay decisions with explicit event kinds:
  `judgment`, `notification`, `action_card`, or `alarm`.
- An action-card timeline event carries the same authoritative card fields; it
  is not a second generated card.
- A safety alarm is labelled `安全告警`, never `主动关怀判词`.
- Fixed mock memory records remain clearly labelled judgments and cannot
  become a pending action card.

## Scripted demo path

The generic elder action “I need help” remains reason-free and therefore asks
for clarification. Debug/script mode gains an explicit concrete-need response
that submits the scripted elder text (`牙疼，饭咬不动。`) from the elder-side
surface. It demonstrates the product story but is not a detector claim or an
alarm.

## Acceptance

1. The merged dense Reme timeline and authority fixes both retain their tests.
2. Exact validators reject mismatched `family_delivery`, simultaneous
   `action_card + alarm`, a pending action card above risk 2, or an alarm below
   risk 3.
3. An explicit tooth-discomfort transcript plus consent produces a pending
   non-alarm action card; the generic need-help button alone does not invent a
   complaint.
4. Reme renders judgments, action cards, ordinary notifications and alarms as
   distinct event kinds sourced from one CareDecision.
5. Only `family_delivery=alarm` with non-null `alarm` starts alarm effects or
   authorizes fall media.
6. Frontend tests/lint/build/routes, backend tests/Ruff/Mypy and Relay
   tests/typecheck/dry-run all pass before commit.
