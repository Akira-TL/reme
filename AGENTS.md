# Reme Agent Guide

## Project intent

Reme is a privacy-first care agent for home monitoring. The MVP should prove that an existing camera feed can be transformed into a privacy-preserving skeleton view, converted into structured event candidates, and passed to a decision layer that chooses an appropriate response.

The primary scenario is an older adult living alone or spending time alone at home. Other scenarios are extensions, not the MVP narrative.

## Before working

1. Read `CONTEXT.md` for domain language and current boundaries.
2. Read relevant ADRs under `docs/adr/` before changing architecture or privacy policy.
3. Read the active work item under `.scratch/<feature>/` before implementing.
4. When `.codegraph/` exists, use `codegraph explore` before broad grep/find when locating or understanding code.

## Engineering rules

- Prefer a thin end-to-end tracer bullet over isolated subsystems.
- Keep raw video local by default. Do not add cloud upload or persistent raw-video storage without an explicit ADR.
- Never invent accuracy, latency, supported-behaviour, or privacy claims. Record measured results and test conditions.
- Separate perception from decision-making: vision produces structured observations; the decision agent chooses actions.
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
