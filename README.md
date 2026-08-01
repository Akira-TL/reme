# Reme

Reme is a privacy-first care agent that aims to preserve a person's dignity while still detecting safety-relevant events.

## Working hypothesis

A locally processed human-action video may be convertible into a privacy-preserving skeleton or abstract view that retains enough motion information to classify body states and safety-relevant transitions. This is not yet proven on the team's video or hardware.

The team has a usable MiMo API. The current uncertainty is pose extraction and posture/transition classification, not API availability. Pose model, classifier, permanent schema, Raspberry Pi role, MiMo input contract, and demo workflow remain open until feasibility experiments are reviewed.

## Current stage

Feasibility analysis. The current priority is to validate the source video, compare pose extraction routes, classify static postures, and determine whether normal transitions can be distinguished from fall-like transitions.

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

The existing `reme-demo` command and motion-data files came from an early exploratory spike. They are not an accepted architecture and should not be used to constrain the feasibility experiments.

## Immediate milestone

Run the first feasibility gate after the team supplies a video:

```text
inspect video -> compare pose extractors -> annotate posture windows -> evaluate posture/transition classifiers -> decide go/no-go
```

Do not define alert policy or a permanent MiMo payload before this gate. See `.scratch/feasibility/feasibility-analysis.md` and `.scratch/feasibility/posture-classification-protocol.md`.
