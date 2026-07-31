# 02 — Offline video-to-motion adapter spike

**What to build:** Use the team-supplied human video to evaluate an offline pose extractor behind the motion-observation seam and record whether it can produce stable derived motion data without placing raw video inside the event and decision pipeline.

**Blocked by:** 01 — Scripted care tracer bullet.

**Status:** ready-for-agent

- [ ] The adapter reads a local video file and emits normalized derived landmarks through the existing motion-observation contract.
- [ ] The model, runtime, machine, source video, and exact test conditions are recorded.
- [ ] Average and P95 frame latency, approximate processing FPS, CPU, and memory are measured.
- [ ] Stand, sit, lie, partial occlusion, and fall-like transitions present in the source are annotated and exercised.
- [ ] False triggers, missed transitions, and unavailable states are recorded, not hidden.
- [ ] The core event/decision pipeline receives motion data only; raw video handling remains inside the extraction adapter.
- [ ] No raw frame images are exported unless explicitly required for debugging and documented.
- [ ] Raspberry Pi 4B support is claimed only if measured there.
