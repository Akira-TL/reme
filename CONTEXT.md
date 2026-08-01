# Reme Domain Context

## Mission

Reme explores whether home-care monitoring can preserve a person's dignity while still surfacing safety-relevant information.

The team has confirmed two constraints:

- Source video may be decoded locally, but judge/family-facing output must not make the person easily identifiable.
- A usable MiMo API is available.

The current feasibility question is therefore whether human pose sequences from the supplied video can be classified into useful body states and transitions. The pose extractor, classification method, MiMo input contract, Raspberry Pi role, and final demo workflow remain open until measured.

## Primary user story

A family member wants timely awareness when an older adult may need help, while the older adult should not be routinely exposed through clear video. The working privacy output is a skeleton, silhouette, or strongly abstracted body representation.

## Current evidence boundary

### Raw video

A pose extractor must decode raw frames locally. The project must not claim that raw video is never processed. The intended privacy claim is narrower:

- source video stays local during perception;
- raw frames are not sent to MiMo;
- presentation and downstream reasoning use skeletons, silhouettes, strongly abstracted views, or structured classifications;
- no additional raw-frame files are exported unless explicitly enabled for debugging.

### Pose extraction

MediaPipe Pose Landmarker and MoveNet are the first candidate extractors. No extractor or permanent landmark schema is accepted until both are tested on the supplied video.

### Static posture classification

The first experiment may use these provisional labels:

- `standing`
- `sitting`
- `lying`
- `bending_or_crouching`
- `unknown`

These labels exist for annotation and evaluation; they are not yet a permanent product API.

### Temporal transition classification

A fall is not a static pose. The first experiment separates temporal transitions into:

- `normal_transition`
- `fall_like_transition`
- `uncertain_transition`

The classifier must use a sequence window rather than a single frame. It must expose uncertainty when keypoints are missing or the motion is ambiguous.

### MiMo

MiMo API access is available. MiMo is not responsible for extracting landmarks. Its candidate input is a structured summary containing posture labels, confidence, recent state transitions, candidate events, and user response state. Its candidate role is natural-language explanation, check-in dialogue, and summary generation. The exact contract remains open until classification evidence is reviewed.

### Hardware

Raspberry Pi 4B and the Tuya display board are available assets, not predetermined architecture. Their role must be chosen after laptop feasibility is known and device-specific tests are run.

## Feasibility gates

1. Inspect the supplied video's codec, resolution, frame rate, duration, viewpoints, occlusion, and action segments.
2. Compare at least MediaPipe Pose Landmarker and MoveNet SinglePose Lightning on the same video.
3. Measure pose detection coverage, keypoint continuity, visible failures, processing time, CPU, and memory.
4. Annotate posture and transition segments that actually occur in the video.
5. Compare a transparent geometric posture baseline with a lightweight learned classifier when data volume permits.
6. Evaluate posture classes with per-class precision, recall, F1, confusion matrix, and abstention/unknown rate.
7. Evaluate normal versus fall-like transitions separately from static posture.
8. Define the smallest structured result MiMo needs only after the classification gate passes.
9. Evaluate Raspberry Pi deployment separately; failure on Pi must not invalidate laptop results.

## Current non-goals

- Production or medical-device claims.
- Guaranteed fall detection.
- Accuracy numbers without a labelled evaluation set.
- Multi-room or multi-person tracking.
- Identity or emotion recognition.
- Sending raw video to MiMo.
- A fixed JSON schema before model and classifier comparison.
- A fixed staged-alert policy before posture and transition classification are validated.

## Open decisions

1. Is the supplied video suitable for reliable single-person pose extraction?
2. Which candidate extractor produces the most stable skeleton?
3. Which static posture labels are defensible on the available footage?
4. Can ordinary lying-down motion be distinguished from a fall-like transition?
5. When must the system return `unknown` or `uncertain_transition`?
6. What minimal structured classification should be sent to MiMo?
7. Is Raspberry Pi 4B deployment worth the time and risk?
8. What exact 60–90 second judge experience should be built after the technical gates are answered?

## Repository status

Commit `61f2a9b` is an unaccepted exploratory spike created before feasibility analysis. Its schema, thresholds, and response flow are not domain decisions and must not be extended until the gates above are reviewed.
