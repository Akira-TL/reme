# Reme Agent Guide

## Project intent

Reme is a privacy-first care concept currently validating pose-based posture classification. Local video decoding is allowed, judge/family-facing imagery must not make a person easily identifiable, and a MiMo API is available. No pose extractor, classifier, permanent schema, alert policy, or hardware role is accepted until the relevant feasibility gate is measured and reviewed.

The primary scenario is an older adult living alone or spending time alone at home. Other scenarios are extensions, not the MVP narrative.

## Before working

1. Read `CONTEXT.md` for domain language and current boundaries.
2. Read relevant ADRs under `docs/adr/` before changing architecture or privacy policy.
3. Read the active work item under `.scratch/<feature>/` before implementing.
4. When `.codegraph/` exists, use `codegraph explore` before broad grep/find when locating or understanding code.

## Engineering rules

- Do not implement product architecture before the relevant feasibility question has a written hypothesis, experiment, evidence, and go/no-go result.
- Treat commit `61f2a9b` as an unaccepted exploratory spike; do not extend its schema or thresholds.
- Prefer narrow feasibility experiments over end-to-end product code.
- Keep raw video local during experiments. Do not add cloud upload or persistent decoded-frame storage without an explicit ADR.
- Never invent accuracy, latency, supported-behaviour, or privacy claims. Record measured results and test conditions.
- Separate pose extraction, static posture classification, temporal transition classification, and MiMo interaction; measure each seam independently.
- Keep event schemas explicit, versioned, and testable.
- Design the demo around failure visibility: confidence, fallback state, and unavailable capability must be shown rather than hidden.
- Put temporary investigation notes, local tickets, specs, and handoffs under `.scratch/`; do not leave planning only in chat.
- Use tests for deterministic domain logic. Treat model inference and hardware integration as adapters behind small interfaces.

## Agent skills

### Issue tracker

Issues and specs are tracked as local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical local triage status vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
