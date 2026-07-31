# Reme

Reme is a privacy-first care agent that aims to preserve a person's dignity while still detecting safety-relevant events.

## MVP hypothesis

Derived human-motion data can provide useful care signals without exposing the full scene to family members:

1. Extract normalized pose or motion data from an offline source.
2. Keep raw video outside the core event and decision pipeline.
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
uv run mypy src
```

Run the deterministic motion-data demo:

```bash
uv run reme-demo --scenario fall-no-response
uv run reme-demo --input examples/motion/fall_like.jsonl --response no_response
```

The JSONL exchange format is documented in `docs/motion-data-format.md`.

## Immediate milestone

Build a motion-data tracer bullet:

```text
motion data -> pose observations -> event candidate JSON -> staged decision
```

Success means the pipeline runs locally from JSON/JSONL motion data, creates no raw-media artifacts, and reproduces at least one fall-like event and response sequence. A later adapter will extract the same observation format from the team-supplied offline video.
