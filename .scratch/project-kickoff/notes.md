# Project kickoff notes

Date: 2026-08-01

## Current phase

Feasibility analysis, not implementation.

The repository was initialized correctly, but commit `61f2a9b` prematurely selected a motion-data schema, event heuristic, and response flow before the team supplied the video or validated any pose extractor. That commit is now classified as an unaccepted exploratory spike.

## Decisions that remain valid

- Project directory: `/home/Akira/projects/reme`.
- Git branch: `main`.
- CodeGraph is initialized.
- Agent instructions live in `AGENTS.md`.
- Specs, research, tickets, experiments, and handoffs live under `.scratch/`.
- Domain context lives in root `CONTEXT.md`; ADRs live under `docs/adr/`.
- Claims about accuracy, latency, privacy, hardware, and MiMo require measured evidence.

## Decisions withdrawn

The following are not accepted:

- JSONL as the motion-data contract;
- torso angle, body center, and visibility as sufficient fields;
- any hard-coded fall threshold;
- a fixed local-check-in then family-notification sequence;
- Raspberry Pi 4B as the inference device;
- MiMo as a decision authority;
- the claim that raw video is outside all processing.

## Ask Matt routing correction

The correct route is:

1. `/research` — identify credible candidate technologies and their platform/licensing constraints.
2. Wait for the actual video and target environment.
3. `/prototype` — run a throwaway comparison of MediaPipe Pose Landmarker and MoveNet on that video.
4. Record a go/conditional-go/no-go decision.
5. Use `/grill-with-docs` to decide the product and demo around the measured result.
6. Only then use `/to-spec` and `/to-tickets`.

## Active artifact

- Feasibility report: `.scratch/feasibility/feasibility-analysis.md`
- First experiment ticket: `.scratch/feasibility/issues/01-video-pose-feasibility.md`

## Current next action

The first experiment is blocked until the team supplies the video. After it arrives, inspect the media and compare pose extraction only. Do not implement fall detection, alert policy, MiMo integration, or Raspberry Pi deployment in that experiment.
