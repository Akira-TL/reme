# ADR-0002: Use derived motion data as the core pipeline input

- Status: Accepted
- Date: 2026-08-01

## Context

The first project framing treated a live camera feed as the starting point of the MVP. The team has chosen a narrower and more controllable boundary: the event and decision system should operate on human-motion data. An offline video containing human movement will be supplied later and used only to validate a separate extraction adapter.

This change makes the core behaviour reproducible before a specific pose model, camera runtime, or hardware platform is selected.

## Decision

- The core pipeline accepts normalized `MotionObservation` values rather than images or encoded video.
- The initial exchange format is JSONL with relative time, torso angle, normalized vertical body center, and visibility.
- Event detection and staged response logic must be testable using synthetic and recorded motion-data fixtures.
- Offline video-to-motion extraction is an adapter behind this contract.
- Raw video and decoded frames do not enter the event or decision modules.
- The first adapter evaluation will use the human-motion video supplied by the team.
- Live camera capture is not part of the MVP.

## Consequences

- Development can proceed in WSL2 without camera access or computer-vision dependencies.
- Demo behaviour is deterministic and can be rehearsed from a committed motion-data fixture.
- The project cannot yet claim that it extracts stable pose data from real video; that claim requires the separate adapter spike.
- The initial motion schema is intentionally small and may need an ADR-backed revision after testing the supplied video.
- ADR-0001's privacy boundary remains in force, but its camera-first implementation assumption is replaced by this adapter-based architecture.
