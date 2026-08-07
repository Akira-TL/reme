# Build MotionBERT offline split-screen demo

Type: prototype
Status: resolved

## Goal

Precompute a MotionBERT 3D pose sequence from the target video's existing MoveNet JSONL and display the source video beside a synchronized interactive 3D skeleton.

## Answer

The offline path is working.

- Source: `148703662.mp4`, 1280×720, 30 FPS, 2370 frames.
- 2D input: `/tmp/reme-litert-lightning-f16-tracking-full/keypoints.jsonl`.
- Model: MotionBERT DSTFormer, OpenMMLab finetuned H36M checkpoint.
- Checkpoint mapping: 260/260 tensors loaded strictly.
- Inference: CUDA FP16, flip test, 243-frame windows, 81-frame stride, batch size 4.
- Latest measured inference: 2.95 seconds, about 803 output FPS, 681.981 MB peak CUDA memory.
- Output: `/tmp/reme-motionbert-output/poses3d.json`, 2370 finite frames.
- Demo server: `tmux` session `reme-motionbert-demo` on `127.0.0.1:8765`.
- URL: `http://127.0.0.1:8765/prototype/motionbert`.
- Chromium validation: dynamic DOM loaded 2370 frames, loading overlay hidden, no JavaScript/WebGL errors.

## Capability boundary

The right-hand view is a monocular, root-relative 3D pose estimate with a normalized display scale. It is not an absolute room coordinate, real distance measurement, or medical result.
