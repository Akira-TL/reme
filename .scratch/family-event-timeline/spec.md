# Family event timeline

Status: resolved and integrated

## Goal

Replace the `/family` current-state placeholders with an honest event timeline that helps a family viewer understand what changed during the current page connection.

The event reducer is consumed by the standalone `时间线` bottom-navigation page. Home no longer embeds a second copy of the list.

## Product boundary

- Record only authoritative `demo_state` revisions and applied family alarm-confirmation acknowledgements that this page actually receives.
- Keep the history in memory for the current page and room session only. Refreshing the page or joining a new room session starts a new timeline.
- Do not infer a person's location from a demo scene. Describe scene changes as updates made by the home endpoint.
- Do not record viewer count or the unauthenticated public-room connection as a household event; those facts remain in the public-room banner.
- Keep previously received entries visible during a disconnect, but label them as past page records that do not represent the current scene.
- Do not add persistence, a backend history schema, retention policy, cloud upload, or medical/safety claims in this work item.

## Event sources

- First authoritative state received in the current room session.
- Changes to scene, capture, local runtime, care phase, consent, and time-limited media grant.
- An `applied` acknowledgement for the family action `confirm_alarm`.

## Behaviour

- Newest events appear first.
- Replayed or duplicate state revisions and acknowledgements do not create duplicates.
- State revisions older than the last observed revision are ignored.
- A room-session change clears the prior room's entries before accepting the new room's state.
- The list is bounded to the 12 most recent entries.
- An empty, connecting, and interrupted state each have explicit copy.

## Acceptance

- `/family` no longer presents viewer count, runtime status, and current room as if they were three historical entries.
- The first state creates one clearly labelled sync entry; subsequent meaningful state changes create event entries with their source timestamp.
- Unchanged keepalive revisions do not add noise.
- Refresh disclosure makes it clear that this is not durable history.
- The timeline remains readable at a 390 px mobile viewport and the existing desktop family layout.
- Pure event reduction is covered by deterministic tests; frontend lint, full tests, and production build pass.

## Validation

- `node --test src/shared-demo/familyTimeline.test.js`: 7/7 passed, including replay suppression, revision ordering, room reset, ACK deduplication, and the 12-entry bound.
- `npm test`: 168/168 frontend tests passed.
- `npm run lint`: passed.
- `npm run build`: production build passed.
- An isolated checkout of only this work item's staged changes also passed all 144 baseline-plus-timeline tests, lint, and production build.
- Live `/family` inspection showed the first authoritative snapshot as one `开始同步` entry rather than three current-state placeholders.
- Chrome device emulation at `390 × 844` measured `documentElement.scrollWidth === 390`; the timeline occupied `x=16..374`, and no element crossed the viewport boundary.

## Standalone-page integration validation

- The reducer now supplies the dedicated fourth bottom-navigation page, including applied alarm-confirmation ACK events and interrupted-state disclosure.
- Idle care copy/decision churn is ignored so explanatory keepalives cannot fabricate repeated household events.
- Final `lbx-frontend` integration verification: frontend `npm test` 155/155, lint, build, route-build 4/4; Relay 20/20 plus typecheck; `git diff --check` passed.
