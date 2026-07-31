# Domain Docs

This is a single-context repository.

## Before exploring or changing the project

- Read `CONTEXT.md` at the repository root.
- Read ADRs under `docs/adr/` that affect the area being changed.
- Use the vocabulary defined in `CONTEXT.md` in code, tests, tickets, and documentation.

If a required document does not exist, proceed without noise. Create or update domain documentation only when a term or hard-to-reverse decision is actually clarified.

## Layout

```text
/
├── CONTEXT.md
├── docs/adr/
└── src/
```

## Vocabulary discipline

Do not silently substitute synonyms for defined concepts. In particular, keep these distinctions explicit:

- an `observation` is measured data;
- an `event candidate` is a hypothesis;
- the `decision agent` chooses a response;
- an `escalation` is a policy-controlled action sequence.

## ADR conflicts

When proposed work conflicts with an existing ADR, state the conflict explicitly and either follow the ADR or open a deliberate decision to supersede it.
