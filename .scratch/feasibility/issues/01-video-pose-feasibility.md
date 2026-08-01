# 01 — Validate pose extraction on the supplied video

**What to investigate:** Determine whether the team-supplied video can produce a continuous and useful human skeleton representation suitable for posture classification, and compare candidate extractors without defining downstream alert architecture.

**Blocked by:** The team supplying the actual video file and identifying the target laptop environment.

**Status:** blocked

- [ ] Record codec, resolution, frame rate, duration, camera viewpoint, visible actions, occlusion, and scene cuts.
- [ ] Run MediaPipe Pose Landmarker in video mode on the same source.
- [ ] Run MoveNet SinglePose Lightning on the same source.
- [ ] Save only derived visualizations or metrics agreed for the experiment; do not silently export raw frames.
- [ ] Measure detected-pose frame coverage, visible keypoint jumps, average and P95 frame time, CPU, and memory.
- [ ] Compare performance on standing, sitting, lying, falling-like, occluded, and out-of-frame segments that actually exist in the video.
- [ ] Record setup friction, package/platform support, model licensing, and reproducibility commands.
- [ ] Produce a go, conditional-go, or no-go decision for skeleton visualization and downstream posture classification.
- [ ] Export model-native landmarks and confidence values for the classification experiment without prematurely freezing a project-wide schema.
- [ ] Do not implement response escalation, Raspberry Pi deployment, or MiMo prompt logic in this ticket.

## Expected answer

A cited and measured comparison showing whether a skeleton privacy view and posture-classification input are technically credible on the exact video. The answer must identify which extractor should feed the classification experiment and which limitations remain unsupported.
