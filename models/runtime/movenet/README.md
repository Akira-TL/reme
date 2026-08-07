# Team-supplied MoveNet runtime asset

This directory packages the team-supplied TensorFlow Lite weight used by Reme's optional
backend JPEG inference lane.

## Artifact record

| Field | Value |
|---|---|
| Model | MoveNet Lightning FP16-compatible single-pose model |
| Format | TensorFlow Lite, float16; source filename identifies v4 |
| File | `movenet_lightning_f16_v4.tflite` |
| Size | 4,758,512 bytes |
| SHA-256 | `0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab` |
| Input contract | `[1, 192, 192, 3]`, `uint8` |
| Output contract | `[1, 1, 17, 3]`, `float32` |

The binary was supplied by the Reme team for the competition repository. Its tensor contract
was validated locally with `ai-edge-litert` before commit.

## Provenance status

The current project records conflict and must not be collapsed into a stronger claim:

- a team-owner record describes the asset as team-trained/exported;
- an earlier `upstream/lbx` feasibility report records the identical byte size and SHA-256
  after downloading MoveNet Lightning FP16 v4 from TensorFlow Hub.

Until the team owner reconciles the training, initialization and export history, this repository
describes the file only as **team-supplied**. It must not be presented as independently trained
or as an independently verified official Google binary. The owner explicitly requested its
publication in the competition repository; that direction does not replace provenance and
redistribution-rights documentation.

Google's official
[MoveNet.SinglePose model card](https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf)
is referenced only for the compatible 17-keypoint interface and its known use limitations.
The model card and its Apache-2.0 notice do not, by themselves, resolve which provenance record
applies to this binary. Preserve all applicable upstream attribution and reconcile the rights
chain before redistributing the weight outside the team owner's competition delivery.

Verify the packaged artifact after clone:

```bash
shasum -a 256 models/runtime/movenet/movenet_lightning_f16_v4.tflite
```

This model estimates a single person's 17 pose keypoints. It does not include Reme's
downstream posture classifier, is not an identity model or medical device, and is not evidence
that any posture or transition accuracy target has been met. Google's model card lists
surveillance and identity recognition as out-of-scope uses; Reme uses the compatible interface
only in an unvalidated, privacy-first care prototype and does not imply Google's endorsement of
this scenario.
