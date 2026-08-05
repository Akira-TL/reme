# Run LiteRT MoveNet on the target video

Type: task
Status: resolved

## Goal

Run the LiteRT MoveNet feasibility runner on the team's actual single-person action video and decide whether its skeleton continuity is sufficient for posture annotation and classification.

## Required input

- Target video path
- Official MoveNet Lightning `.tflite` model path
- Test machine identity and CPU information

## Measurements

- Video codec, resolution, FPS, duration, viewpoint, occlusion, and action segments
- Torso detection coverage
- Visible landmark jumps and missing limbs in important segments
- Mean and P95 `Interpreter.invoke()` latency
- End-to-end processing FPS and peak RSS
- Recovery after occlusion or leaving the frame

## Decision

Use the Go / Conditional Go / No-Go criteria in `../spec.md`. Do not start posture threshold tuning or fall-event logic until this issue has evidence.

## Answer

The team placed `148703662.mp4` in the repository root. The video is H.264, 1280×720, 30 FPS, 79 seconds, and 2370 frames.

Full-frame MoveNet Lightning FP16 reached 95.78% torso coverage. Adding the official-style previous-frame tracking crop raised coverage to 100%, raised mean frame confidence from 0.3849 to 0.5991, and reduced visible-keypoint displacement P95 from 0.03471 to 0.01886. The generated 79-second skeleton video contains all 2370 frames and no blank frames.

Decision: **Go for pose extraction and posture annotation**, using MoveNet Lightning FP16 with tracking crop as the current MoveNet baseline. This does not approve posture labels, fall detection, Raspberry Pi performance, or a permanent event schema.

Detailed evidence: `../results/2026-08-01-video-148703662.md`.

## Comments

The target video gate is complete. Manual viewing of the generated skeleton remains necessary before accepting individual action segments as correctly tracked.
