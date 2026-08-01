# ADR-0002: Use derived motion data as the core pipeline input

- Status: Rejected as premature
- Date: 2026-08-01

## Context

The first project framing treated a live camera feed as the starting point of the MVP. The team has chosen a narrower and more controllable boundary: the event and decision system should operate on human-motion data. An offline video containing human movement will be supplied later and used only to validate a separate extraction adapter.

This change makes the core behaviour reproducible before a specific pose model, camera runtime, or hardware platform is selected.

## Rejection

This decision was made before validating the supplied video, candidate pose models, hardware constraints, or product flow. It incorrectly fixed a motion schema and core boundary before evidence existed.

The JSONL contract, event thresholds, and staged response created under this ADR are exploratory only. They must not constrain the feasibility experiments or be presented as accepted architecture.

## Consequences

- Work returns to feasibility analysis.
- The team will compare pose extractors on the actual source video before defining a data contract.
- No event detector, response policy, Raspberry Pi role, or MiMo role is accepted yet.
- The exploratory code may later be deleted, rewritten, or retained only as a historical spike.
