# Reme Domain Context

## Mission

Reme explores whether home-care monitoring can preserve a person's dignity while still surfacing safety-relevant information.

The team has confirmed two constraints:

- Source video may be decoded locally, but judge/family-facing output must not make the person easily identifiable.
- A usable MiMo API is available.

The current core feasibility question is whether the current CUDA development computer can sustain a single-person live-camera pipeline from MoveNet 2D landmarks to posture observations and a complete event-triggered MiMo interaction loop. Recorded video remains a later stability and playback path. In parallel, ADR-0012 permits a demo-only, display-only MediaPipe experiment for zero to four anonymous pose candidates; its target-phone capability Gate is still pending and it cannot feed fall, cooking, voice, care-card, or media-authority decisions. ADR-0013 permits a separate demo-only public-media reachability experiment: only a verified cooking event or Relay-authoritative escalated fall grant may expose a bounded live WebRTC track, assisted by short-lived TURN credentials; its target-network Gate is also pending. The final classifier, transition capability, Raspberry Pi role, and competition story remain open until measured.

## Primary user story

A family member wants timely awareness when an older adult may need help, while the older adult should not be routinely exposed through clear video. The working privacy output is a skeleton, silhouette, or strongly abstracted body representation.

## Current evidence boundary

### Raw video and MiMo visual context

A pose extractor must decode raw frames locally. The project must not claim that raw video is never processed or that all MiMo reasoning is pixel-free.

The current boundary is:

- source video is decoded locally during perception;
- structured pose events remain a supported MiMo input;
- selected keyframes or short clips may also be sent to MiMo when visual context materially improves privacy-state or care-state reasoning;
- visual transmission must be explicit, minimal, and observable in the demo rather than continuous background upload;
- presentation should still prefer skeletons, silhouettes, strongly abstracted views, or structured classifications;
- no additional raw-frame files are exported unless explicitly enabled for debugging.

### Judge-demo event media

The default judge/family-facing view remains privacy-preserving. The LBX judge demo has two narrow, identifiable-video exceptions defined by ADR-0011: a Relay-verified cooking activity under a bounded `kitchen_moment` grant, and a Relay-authoritative escalated fall under a matching bounded `fall_emergency` grant. Daily and fall-checking states remain abstract furniture plus skeleton; the fully private state remains skeleton-only and overrides every late grant or signal.

Authorized live media stays on WebRTC and never enters the Reme Durable Object, event store, KV, or application logs. When direct ICE is unavailable, ADR-0013 permits Cloudflare TURN to relay encrypted WebRTC packets using server-issued short-lived credentials. That means the project must not claim that an authorized live track never traverses a third-party relay; the defensible claim is that Reme's Relay does not receive, decode, or persist media frames. Long-lived TURN keys remain Worker secrets, and TURN availability does not create or extend a media grant.

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

MiMo API access is available. MiMo is not responsible for extracting landmarks. B consumes structured posture and transition results, runs deterministic guardrails, and calls MiMo only when an event requires explanation, communication, or additional reasoning. Selected keyframes or short clips may be sent when visual context is materially useful. MiMo must not be called continuously for every frame, and a late MiMo response cannot cancel a deterministic timeout escalation.

### Hardware

Raspberry Pi 4B and the Tuya display board are available assets, not predetermined architecture. Their role must be chosen after laptop feasibility is known and device-specific tests are run.

## Canonical runtime terms

- **Runtime session**: one C-controlled execution identified by a unique `session_id`. A and B separately confirm the actually effective profile; events from older sessions are discarded.
- **Live camera profile**: `camera + live perception + live decision`. This is the current P0 development path.
- **Recorded video profile**: `video + recorded perception + recorded decision`. This is a later stable playback path and does not rerun A or B during presentation.
- **Frame landmarks**: the human keypoints observed at one source time. Landmark confidence describes input quality, not posture or event accuracy.
- **Anonymous pose batch**: zero to four frame-local 17-point pose candidates from one source frame. Array order is not identity, and no cross-frame tracking or re-identification is implied.
- **Posture observation**: a static body-state hypothesis at one source-video time, such as `standing` or `lying`. A posture observation is not a care event.
- **Transition event**: a time-window hypothesis about a change between body states, such as `normal_transition` or `fall_like_transition`. A single `lying` observation cannot establish a transition event.
- **Care decision**: the decision layer's current recommendation about observation, check-in, family notification, privacy presentation, or degradation. It is distinct from perception output.
- **Interaction response**: the older adult's explicit, scripted, unclear, or absent response to a check-in. The response is an input to the next care decision, not a decision by itself.
- **Privacy mode**: the presentation instruction that determines whether source imagery is visible, blurred, replaced by a skeleton, or hidden. It does not change the underlying perception result.
- **Event-scoped media grant**: a Relay-authoritative, session/event/scope/audience-bound permission for a short live WebRTC track. It is independent from scene selection, ICE reachability, local clips, cards, and model confidence.
- **TURN credential**: a short-lived transport credential issued only after a matching active media grant. Its provider TTL may include bounded ICE setup headroom, but it never extends the application grant or permits media in the fully private state.

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
10. Evaluate event-scoped public media separately on recorded target devices and network pairs; an ICE configuration response, same-Wi-Fi success, or an active grant without a fresh remote frame cannot pass the public-media Gate.

## Current non-goals

- Production or medical-device claims.
- Guaranteed fall detection.
- Accuracy numbers without a labelled evaluation set.
- Multi-room or multi-person tracking.
- Identity or emotion recognition.
- A fixed JSON schema before model and classifier comparison.
- A fixed staged-alert policy before posture and transition classification are validated.
- Production-grade family identity, audit, adversarial media authorization, universal public-network reachability, SFU scaling, or medical-grade live monitoring.

## Open decisions

1. Which static posture classes can be validated with the available and newly recorded labelled data?
2. What geometric features and thresholds produce a defensible `unknown` policy?
3. Can the current computer sustain at least 15 FPS MoveNet and 5–10 Hz posture output under the live-camera profile?
4. Can ordinary lying-down motion be distinguished from a fall-like transition after the static classifier is stable?
5. What events should trigger MiMo, and when is visual context materially useful?
6. Which exact prerecorded videos and competition story should be produced after the live pipeline is stable?
7. Is Raspberry Pi 4B deployment worth the time and risk?
8. Does the isolated anonymous multi-pose projection pass its frozen target-phone Pilot and Holdout Gate without weakening the single-person authority path?
9. Does the grant-bound TURN path pass its frozen target-phone and cross-network Pilot/Holdout without weakening the four-scene privacy matrix or moving media into the Reme Relay?

## Repository status

Commit `61f2a9b` is an unaccepted exploratory spike created before feasibility analysis. Its schema, thresholds, and response flow are not domain decisions and must not be extended until the gates above are reviewed.
