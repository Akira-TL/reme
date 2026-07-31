# Reme Domain Context

## Mission

Reme helps a person remain safe without turning their home into a place of continuous human surveillance.

The product value is not "a clearer camera." It is the minimum observation needed to detect and respond to risk while withholding irrelevant private detail.

## Primary user story

A family member wants to know whether an older adult living alone is safe. The older adult should not need to expose clothing, body details, facial expression, or the full state of the room during routine monitoring.

## Core terms

### Raw frame

An unmodified image from a camera. Raw frames are sensitive data and remain local by default. The MVP does not persist them.

### Privacy view

A derived visual representation that removes appearance and scene detail while retaining enough pose information for the demo. The first implementation is expected to be a 2D skeleton overlay on a blank or strongly abstracted background.

### Observation

A time-stamped machine-readable description produced by perception, such as body landmarks, pose state, motion features, and confidence. An observation is not yet a safety conclusion.

### Event candidate

A hypothesis produced from one or more observations, such as `possible_fall` or `prolonged_inactivity`. It includes confidence and supporting measurements. It is not an emergency declaration.

### Decision agent

The component that consumes event candidates and context, then chooses a response such as no action, local voice check-in, family notification, or escalation. For the hackathon, this may initially be a deterministic stub before MiMo integration.

### Care timeline

A privacy-preserving sequence of significant states and actions. It should summarize events rather than reconstruct a person's complete day.

### Escalation

A staged response that increases only when evidence or lack of response warrants it. A likely sequence is local check-in, family notification, then emergency guidance. Exact policy remains unresolved.

## MVP boundary

The MVP targets one person in one indoor camera view and demonstrates:

- local pose extraction;
- privacy-view rendering;
- one reproducible fall-like event;
- one prolonged-inactivity event if time permits;
- structured event output;
- a visible decision and response flow.

## Non-goals for the first demo

- Clinical diagnosis or medical-device claims.
- Guaranteed fall detection.
- Multi-room tracking.
- Identity recognition.
- Emotion recognition.
- Child, pet, vehicle, or institutional-care scenarios in the primary demo.
- Cloud storage of raw video.
- Forensic evidence retention.
- A production-ready mobile application.

## Open decisions

1. Which pose model gives acceptable laptop performance and can later run on Raspberry Pi 4B?
2. Is a blank-background skeleton sufficient, or must the scene also be abstracted for spatial context?
3. Which measurements define a fall-like event in the demo without pretending to be clinically validated?
4. What exact JSON contract connects perception to the decision agent?
5. Which actions should MiMo decide, and which must remain deterministic safety policy?
6. How will the demo prove that raw frames are not stored or uploaded?
7. What is the fallback when the body is occluded or pose confidence is low?
