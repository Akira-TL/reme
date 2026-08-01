# Build LiteRT MoveNet feasibility runner

Type: prototype
Status: resolved

## Question

Can the repository run an official MoveNet SinglePose Lightning `.tflite` model through the current LiteRT Python package while exporting only derived skeleton data?

## Answer

Yes for the execution path. `.scratch/litert-movenet-feasibility/run.py` loads the model with `ai_edge_litert.interpreter.Interpreter`, decodes video locally, writes a black-background skeleton MP4, writes 17-keypoint JSONL, and records latency/resource measurements.

A 12-frame smoke test using the official model completed successfully. This does not answer whether the team's target video is suitable or whether posture/fall classification works.

## Evidence

- LiteRT package tested: `ai-edge-litert==2.1.6`
- Input tensor observed: `[1, 192, 192, 3]`, `uint8`
- Output tensor observed: `[1, 1, 17, 3]`, `float32`
- Static smoke input: 12/12 frames met the experiment's torso visibility definition
- `ruff` and Python bytecode compilation passed

## Comments

The runner is deliberately kept under `.scratch/` and is not an accepted product adapter or schema.
