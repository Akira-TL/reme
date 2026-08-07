# Motion Data Format

Reme's core pipeline consumes derived human-motion observations. Raw video is handled only by a separate extraction adapter and is not part of the event or decision contract.

## JSONL schema

Store one JSON object per line, ordered by `offset_ms`:

```json
{"offset_ms": 0, "torso_angle_deg": 9.0, "center_y": 0.36, "visibility": 0.95}
```

| Field | Type | Range | Meaning |
|---|---:|---:|---|
| `offset_ms` | integer | `>= 0` | Milliseconds from the start of the motion sequence. |
| `torso_angle_deg` | number | `0..180` | Torso angle in degrees; the MVP convention treats values near `0` as upright and values near `90` as horizontal. |
| `center_y` | number | `0..1` | Normalized vertical body-center coordinate; larger values are lower in the frame or source coordinate system. |
| `visibility` | number | `0..1` | Aggregate confidence that the motion observation is sufficiently visible. This is input quality, not event accuracy. |

## Core privacy boundary

The core pipeline receives only these derived numbers. It does not receive images, encoded video, clothing information, facial information, or room pixels.

The current demo heuristic uses torso rotation, downward center movement, elapsed time, and visibility to produce a `possible_fall` event candidate. Its `confidence` value is an evidence score derived from those measurements; it is not clinically validated accuracy.

## Run examples

```bash
scripts/tools/run-legacy-motion-demo.sh --scenario fall-no-response
scripts/tools/run-legacy-motion-demo.sh --input examples/motion/fall_like.jsonl --response no_response
scripts/tools/run-legacy-motion-demo.sh --input examples/motion/normal.jsonl
```

## Offline video adapter contract

When the team provides a human-motion video, the extractor should emit this JSONL schema. The extractor may temporarily decode frames in memory, but the core event and decision pipeline must still receive only `MotionObservation` values.
