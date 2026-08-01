# 02 — Offline video-to-motion adapter spike

**What to build:** Use the team-supplied human video to evaluate an offline pose extractor behind the motion-observation seam and record whether it can produce stable derived motion data without placing raw video inside the event and decision pipeline.

**Blocked by:** Replaced by the feasibility gate under `.scratch/feasibility/`.

**Status:** superseded — do not implement against the existing motion contract

- [ ] Superseded: the feasibility experiment must inspect real model outputs before any motion-observation contract is chosen.
- [ ] The model, runtime, machine, source video, and exact test conditions are recorded.
- [ ] Average and P95 frame latency, approximate processing FPS, CPU, and memory are measured.
- [ ] Stand, sit, lie, partial occlusion, and fall-like transitions present in the source are annotated and exercised.
- [ ] False triggers, missed transitions, and unavailable states are recorded, not hidden.
- [ ] The core event/decision pipeline receives motion data only; raw video handling remains inside the extraction adapter.
- [ ] No raw frame images are exported unless explicitly required for debugging and documented.
- [ ] Raspberry Pi 4B support is claimed only if measured there.
