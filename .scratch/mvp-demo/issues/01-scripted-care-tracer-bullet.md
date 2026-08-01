# 01 — Scripted care tracer bullet

**What to build:** Run one command that consumes a derived synthetic pose sequence, emits a transparent `possible_fall` event candidate, performs a local check-in, and escalates to family notification after a simulated lack of response.

**Blocked by:** None — can start immediately.

**Status:** rejected — premature implementation

- [x] A normal upright sequence emits no event or escalation.
- [x] A worked fall-like sequence emits one event candidate with supporting measurements.
- [x] The response timeline shows local check-in before family notification.
- [x] A safe response stops escalation.
- [x] Low-visibility observations do not become a confident fall event.
- [x] The synthetic path creates no raw image/video files and makes no network calls.
- [x] The demo runs with one documented command.
- [x] Tests, lint, and type checking pass.

## Retrospective

This implementation proved only that a hand-authored synthetic state machine can run. It did not answer whether the supplied video yields usable pose data, whether the chosen fields represent real model output, whether fall detection is defensible, or whether this response policy fits the product. It is not an accepted project result.

Validated command:

```bash
uv run reme-demo --input examples/motion/fall_like.jsonl --response no_response
```

The next frontier item is the offline video-to-motion adapter using the team-supplied human video.
