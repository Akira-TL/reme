# ADR-0003: Allow minimal visual context to be sent to MiMo

- Status: Accepted
- Date: 2026-08-01

Reme may send selected keyframes or short video clips to MiMo when visual context materially improves privacy-state or care-state reasoning. This supersedes ADR-0001's absolute prohibition on sending raw frames to the decision agent.

The structured-event path remains available, but it is no longer the only permitted MiMo input. Visual transmission must be explicit, minimal, observable in the demo, and limited to the current decision request rather than continuous background upload.

## Consequences

- B may compare structured-only and visual-context MiMo paths on the same scenario.
- Requests must record whether images or video were transmitted, their sampling window, and the selected demo mode.
- Visual inputs should use the smallest useful number of frames or shortest useful clip.
- Raw frames and clips are not retained by the local application after the request unless an explicit debugging mode is enabled.
- Product and privacy claims must state that selected visual content can be sent to MiMo; the project must not claim that all downstream reasoning is pixel-free.
- Long-term retention, production consent, encryption, access control, and provider-side data policy remain outside the hackathon MVP and require later decisions.
