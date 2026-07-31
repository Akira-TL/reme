# 01 — Scripted care tracer bullet

**What to build:** Run one command that consumes a derived synthetic pose sequence, emits a transparent `possible_fall` event candidate, performs a local check-in, and escalates to family notification after a simulated lack of response.

**Blocked by:** None — can start immediately.

**Status:** resolved

- [x] A normal upright sequence emits no event or escalation.
- [x] A worked fall-like sequence emits one event candidate with supporting measurements.
- [x] The response timeline shows local check-in before family notification.
- [x] A safe response stops escalation.
- [x] Low-visibility observations do not become a confident fall event.
- [x] The synthetic path creates no raw image/video files and makes no network calls.
- [x] The demo runs with one documented command.
- [x] Tests, lint, and type checking pass.

## Answer

The core pipeline now accepts normalized `MotionObservation` values from deterministic scenarios or JSONL files. It emits an explainable `possible_fall` event candidate, chooses local check-in first, and notifies family only after `no_response`. The evidence score is explicitly marked as non-clinical. The synthetic CLI path was tested with network sockets disabled and in an empty working directory; it opened no socket and created no file.

Validated command:

```bash
uv run reme-demo --input examples/motion/fall_like.jsonl --response no_response
```

The next frontier item is the offline video-to-motion adapter using the team-supplied human video.
