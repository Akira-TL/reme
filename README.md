# Reme

Reme is a privacy-first care agent that aims to preserve a person's dignity while still detecting safety-relevant events.

## MVP hypothesis

An existing camera can provide useful care signals without exposing the full scene to family members:

1. Process the camera feed locally.
2. Replace the person with a skeleton or abstract avatar.
3. Detect a small set of event candidates, beginning with fall-like motion and prolonged inactivity.
4. Emit a structured event payload.
5. Let a decision agent choose whether to ask the person, notify family, or escalate.

The first demo should prove this end-to-end loop. It should not claim clinical-grade accuracy or production-ready privacy guarantees.

## Current stage

Discovery and technical validation. The repository intentionally starts small so the team can validate the riskiest assumptions before choosing a larger architecture.

## Repository layout

```text
.
├── AGENTS.md                 # Instructions for coding agents
├── CONTEXT.md                # Domain language and product boundaries
├── docs/
│   ├── adr/                  # Architecture decision records
│   └── agents/               # Agent workflow configuration
├── src/reme/                 # Product code
├── tests/                    # Deterministic tests
└── .scratch/                 # Specs, tickets, experiments, and handoffs
```

## Local development

```bash
uv sync --extra dev
uv run pytest
uv run ruff check .
```

## Immediate milestone

Build a laptop-webcam tracer bullet:

```text
camera frame -> pose landmarks -> privacy view -> event candidate JSON -> decision stub
```

Success means the pipeline runs locally, its latency is measured, raw frames are not persisted, and at least one scripted event can be reproduced reliably enough for a live demo.
