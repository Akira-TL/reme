# Frontend Engineering Foundation

- Status: implementation complete; local browser validation pending
- Owner: Frontend
- Date: 2026-08-10
- Baseline: `origin/develop/akira@d590eaa7`

## Goal

Turn the working React/Vite real-time demo into a clearer, testable frontend
foundation without redesigning Backend authority, Relay authority, routing, or
the proven camera path.

This is a gradual refactor. The current `/home`, `/family`, and `/debug`
surfaces, pathname-based lazy loading, camera-to-worker pipeline, FamilyEvent
contract, WebRTC authorization checks, and existing deterministic tests remain
in service throughout the work.

## Authority invariants

1. Backend exclusively owns pose/fall interpretation, CareDecision, safety
   deadlines, alarms, action cards, FamilyEvent, and MediaAuthorization.
2. Relay owns room transport, bounded queues, ACKs, WebRTC signaling, and
   MediaGrant validation; it never stores or transports raw media in JSON.
3. Browser runtime state may report capture/transport failures but may not
   synthesize a safety transition.
4. UI presentation state may interpolate or briefly retain a last good pose,
   but may not mutate the accepted Relay pose or create a new Backend result.
5. `bathroom`, `hidden`, and `skeleton_only` always fail closed for clear video.
6. Alarm acknowledgement is `acknowledge_alarm -> alarm_acknowledged`; action
   card confirmation is `confirm_action_card -> card_confirmed`.

## Baseline evidence

After installing the existing lockfile with `npm ci`:

- `npm test`: 205/205 passing.
- `npm run lint`: passing.
- `npm run build`: passing; pathname roles remain separate lazy chunks.
- `npm run test:route-build`: 5/5 passing when the sandbox permits the
  temporary `127.0.0.1` preview listener.

No product performance claim is inferred from this engineering baseline.

## Audit findings

### Responsibilities already working well

- `main.jsx` and `routing/appRoute.js` keep the three canonical paths behind
  dynamic imports without a second router.
- `usePerceptionRuntime` keeps `sceneId` and `sourceGeneration` outside its
  session-opening effect, so scene/source changes do not intentionally restart
  Backend perception.
- camera pacing and encoding prefer Worker + TrackProcessor + OffscreenCanvas,
  with a bounded WebSocket input buffer and an interval fallback.
- runtime/session and source-generation checks reject stale pose publication.
- MediaAuthorization and Relay MediaGrant are checked independently.

### Boundaries to improve in this batch

- `monitorRelay.js` combines wire schemas, validators, serialization,
  publication backpressure, claim persistence, and socket lifecycle.
- `viewerState.js` currently performs the presentation-only short pose hold in
  the Relay state reducer, mixing accepted transport state with display state.
- `SkeletonStage.jsx` owns canvas sizing, DPR, interpolation, freshness, and
  ResizeObserver/rAF lifecycle inline, which makes lifecycle behavior difficult
  to test.
- there is no real-browser regression suite for the canonical route shells,
  Family canvas output, alarm ACK semantics, or privacy fail-closed behavior.
- frontend architecture and styling ownership rules are not documented in one
  maintained source.

## Scope

### Phase A — protocol and display runtime boundaries

- Extract Monitor wire validation/serialization into a transport protocol
  module while preserving every exact schema and public export.
- Add gradual JSDoc/type checking only to the new contract boundary; do not
  migrate the application wholesale to TypeScript.
- Store the latest accepted PoseFrame as transport truth in `viewerState`.
- Move hold-last-good, interpolation, freshness, canvas/DPR resizing, and rAF
  cleanup into a presentation-only pose canvas runtime with deterministic
  tests.
- Keep source generation changes independent from Backend session lifetime.

### Phase B — browser E2E

- Add Playwright as a development-only dependency.
- Run Chromium against the actual Vite application and mocked exact HTTP/WS
  peers.
- Cover `/home`, `/family`, and `/debug` route identity.
- Cover Family DemoState + PoseFrame -> non-empty canvas.
- Cover authoritative alarm -> `acknowledge_alarm` command -> ACK/new Backend
  projection, without a frontend-authored resolution.
- Cover bathroom/unauthorized media remaining skeleton-only.

### Phase C — documentation and observability

- Add `docs/frontend-architecture.md` with stack, role, authority, camera, pose,
  FamilyEvent, WebRTC, Worker, state, styling, test, startup, HTTP/HTTPS,
  hackathon exception, and production P1 sections.
- Keep engineering-only counters on `/debug`; do not add them to `/family`.

## New dependency decision

### `@playwright/test` (development only)

Current Node tests can validate reducers and protocols but cannot prove actual
pathname boot, browser canvas pixels, MediaDevices behavior, or browser
WebSocket command flow. Playwright supplies a real Chromium execution boundary
and deterministic request/WebSocket fixtures.

- bundle cost: zero; devDependency is not imported by application code;
- runtime cost: zero in the shipped frontend;
- CI/local cost: a browser process and test time;
- lighter alternative: jsdom or more Node tests, rejected for these cases
  because neither exercises Canvas, MediaDevices, autoplay, or browser WebSocket
  behavior.

No state library, router, schema library, or CSS framework is added.

### `typescript` (development only)

The application remains JavaScript. `tsc` checks only the new transport and
viewer runtime contracts marked with `// @ts-check`; it emits no files and adds
no browser code. This establishes a narrow type gate without turning the batch
into a full TypeScript migration.

## Out of scope

- Backend, Relay Worker, CareDecision, FamilyEvent, or alarm-policy changes.
- Full TypeScript migration.
- Redux/Zustand or React Router.
- wholesale UI/CSS rewrite.
- claiming unmeasured FPS, background reliability, mobile support, TURN reach,
  or medical accuracy.

## Acceptance

1. All pre-existing frontend tests remain green.
2. New protocol/display tests prove exact validation, stale-session isolation,
   bounded publication, display-only hold, interpolation refusal across
   sessions, and cleanup.
3. Playwright passes for the three canonical routes and the selected authority,
   canvas, ACK, and privacy flows.
4. `npm run lint`, `npm run build`, and `npm run test:route-build` pass.
5. Browser evidence records observed behavior separately from unmeasured target
   FPS or physical-device gates.
6. Changes are committed as separate refactor and quality/docs commits, then
   fast-forward pushed to `origin/lbx-frontend` as explicitly requested.

## Validation handoff

The baseline commands above ran before the final E2E/docs batch. Per the user’s
instruction on 2026-08-10, no further test, build, or browser commands are run
in this workspace. The final diff is intentionally marked **local validation
pending** and the exact commands and physical-browser checks live in
`handoff.md`.
