# Project kickoff notes

Date: 2026-08-01

## Current product statement

Reme is a privacy-first care agent that consumes derived human-motion data, emits structured event candidates, and uses a decision layer to choose a staged response.

Primary demo scenario: one older adult, one offline motion sequence, one reproducible fall-like event. A team-supplied human video will later be used by a separate video-to-motion adapter.

## Decisions already made

- Use the existing `/home/Akira/projects/reme` directory.
- Use Git with `main` as the initial branch.
- Use CodeGraph for repository navigation once indexed.
- Use `AGENTS.md` for agent instructions.
- Use local Markdown files under `.scratch/` for specs, tickets, handoffs, and investigation logs.
- Use a single root `CONTEXT.md` and root `docs/adr/`.
- Begin with Python and a small event contract; add CV dependencies only for the later offline video-to-motion adapter.
- Keep raw video outside the core event and decision pipeline.
- Do not use a live camera in the MVP; use motion data as the stable input contract.

## Ask Matt routing decision

This effort is greenfield, but the hackathon destination and primary user story are already visible. A full Wayfinder map would add overhead before the most urgent risk is tested.

Recommended route:

1. `grill-with-docs` to settle the MVP acceptance criteria and demo story.
2. Implement a narrow motion-data tracer bullet to settle the event and decision interfaces.
3. Use the supplied offline human video to prototype and measure a video-to-motion adapter.
4. Fold the adapter findings back into the product thread.
5. `to-spec`, then `to-tickets` because the build spans multiple sessions and owners.
6. Run `implement` per ticket, blockers first, with tests for deterministic logic.

## First runnable question

Can normalized motion data produce a transparent and reproducible fall-like event candidate and staged response without raw media entering the core pipeline?

## Prototype acceptance evidence

Record all results rather than relying on impressions:

For the motion-data core:

- exact JSONL schema and fixture;
- deterministic normal, fall-like, safe-response, no-response, and low-visibility results;
- whether any raw-media files or network requests are created.

For the later video adapter:

- model and version;
- machine and supplied source video;
- average and p95 frame latency;
- approximate processing frames per second;
- CPU and memory observations;
- behaviour under partial occlusion;
- false triggers during annotated stand/sit/lie/fall-like sequences;
- whether any decoded frame files or network requests are created.

## Questions for the next `grill-with-docs` session

1. The first 60–90 second demo uses motion data rather than a live camera.
2. Raspberry Pi 4B compatibility remains unclaimed until measured.
3. A possible fall triggers local check-in, then family notification after no response.
4. MiMo capability remains a later integration decision; deterministic safety policy is authoritative for the MVP.
5. If offline video extraction is unreliable, the truthful fallback is the derived-motion pipeline with the adapter marked unavailable.
6. Accuracy, latency, and hardware claims require measured evidence before entering the presentation.
