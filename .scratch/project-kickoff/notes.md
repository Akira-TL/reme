# Project kickoff notes

Date: 2026-08-01

## Current product statement

Reme is a privacy-first care agent that turns a local camera feed into a skeleton-based privacy view, emits structured event candidates, and uses a decision layer to choose a staged response.

Primary demo scenario: one older adult, one indoor camera, one reproducible fall-like event.

## Decisions already made

- Use the existing `/home/Akira/projects/reme` directory.
- Use Git with `main` as the initial branch.
- Use CodeGraph for repository navigation once indexed.
- Use `AGENTS.md` for agent instructions.
- Use local Markdown files under `.scratch/` for specs, tickets, handoffs, and investigation logs.
- Use a single root `CONTEXT.md` and root `docs/adr/`.
- Begin with Python and a small event contract; add CV dependencies only after the pose-model spike chooses them.
- Keep raw video local and ephemeral in the MVP.

## Ask Matt routing decision

This effort is greenfield, but the hackathon destination and primary user story are already visible. A full Wayfinder map would add overhead before the most urgent risk is tested.

Recommended route:

1. `grill-with-docs` to settle the MVP acceptance criteria and demo story.
2. `handoff` into a fresh prototype session for the runnable uncertainty.
3. `prototype` a laptop-webcam pipeline and measure candidate pose models.
4. `handoff` the findings back into the product thread.
5. `to-spec`, then `to-tickets` because the build spans multiple sessions and owners.
6. Run `implement` per ticket, blockers first, with tests for deterministic logic.

## First runnable question

Can a laptop webcam produce a stable privacy skeleton and a reproducible fall-like event candidate at demo-acceptable latency, without writing raw frames to disk?

## Prototype acceptance evidence

Record all results rather than relying on impressions:

- model and version;
- machine and camera used;
- average and p95 frame latency;
- approximate frames per second;
- CPU and memory observations;
- behaviour under partial occlusion;
- false triggers during scripted stand/sit/lie sequences;
- whether the privacy view leaks raw scene pixels;
- whether any frame files or network requests are created.

## Questions for the next `grill-with-docs` session

1. What exact 60–90 second live demo should the judges see?
2. Is laptop execution sufficient for judging, or must Raspberry Pi 4B execution be demonstrated?
3. What response should follow a possible fall in the demo: local voice check, family notification, or both?
4. Which MiMo capability must be real rather than mocked?
5. What is the minimum successful result if fall classification is unreliable?
6. Which claims are safe to make in the presentation, and which need measured evidence first?
