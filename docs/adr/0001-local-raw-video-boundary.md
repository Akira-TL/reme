# ADR-0001: Keep raw video local and ephemeral in the MVP

- Status: Accepted
- Date: 2026-08-01

## Context

Reme's core promise is that routine care monitoring should not expose unnecessary private detail. A pipeline that uploads or persistently stores raw frames by default would undermine that promise before the privacy view is even evaluated.

The hackathon demo does not need forensic evidence retention. It needs a credible, observable privacy boundary and a functioning event pipeline.

## Decision

For the MVP:

- Raw camera frames are processed in memory on the local device.
- Raw frames are not written to disk.
- Raw frames are not uploaded to a cloud service or sent to the decision agent.
- Only derived pose observations, event candidates, and privacy-view output may leave the perception component.
- Any future evidence-retention mode requires a separate ADR covering consent, encryption, access control, retention, and auditability.

## Consequences

- The first demo can make a narrow and testable privacy claim.
- Debugging must use opt-in test clips or synthetic fixtures rather than silent recording.
- The system cannot provide forensic evidence from normal operation.
- Cloud-only pose inference is out of scope for the MVP.
