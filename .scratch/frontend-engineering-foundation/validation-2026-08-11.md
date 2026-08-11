# Frontend engineering foundation validation — 2026-08-11

## Outcome

The frontend engineering batch is implemented and all non-Playwright quality
gates pass after the final fixes. The current in-app Browser run completed the
previously blocked authoritative action-card confirmation path and found two
additional frontend integration defects, both fixed in `872ae75`.

This result is intentionally bounded. The in-app Browser exposed no usable
camera during this run, so current-run camera FPS, background capture, live
PoseFrame rendering, and successful source switching are not claimed. TURN and
cross-network WebRTC were also not tested.

## Scope and environment

- Branch: local `lbx-frontend`; validation began from
  `origin/lbx-frontend@a2c6e928`.
- Implementation base: `origin/develop/akira@d590eaa7`.
- Scope: frontend only. Backend and Relay authoritative contracts were not
  modified.
- Browser: Codex in-app Browser, Chrome `151.0.0.0` user agent.
- Reported platform: `MacIntel`; viewport `1280 × 720`; DPR `2`.
- Browser APIs present: `MediaStreamTrackProcessor`, `VideoFrame`,
  `OffscreenCanvas`, and `createImageBitmap`.
- Browser media result: `navigator.mediaDevices` existed, but the page reported
  no usable camera.
- Local services during acceptance:
  - Vite: `127.0.0.1:4174`
  - Backend: `127.0.0.1:8770`
  - Relay: `127.0.0.1:8787`
- Both the real locally configured MiMo mode and the repository's existing
  Backend mock mode were exercised. No credential value was printed.

## Command results

| Command | Result | Evidence |
| --- | --- | --- |
| `git fetch origin` | PASS | Local validation started after confirming `lbx-frontend` matched `origin/lbx-frontend@a2c6e928`. |
| `npm ci` | PASS | 219 packages installed. npm emitted only its informational `fsevents` `allow-scripts` warning. |
| `npm run typecheck:contracts` | PASS | No contract type errors. |
| `npm test` | PASS | 218/218 tests after all fixes. |
| `npm run lint` | PASS | ESLint completed with no findings. |
| `npm run build` | PASS | Vite 8.2.0; 1052 modules transformed. |
| `npm run test:route-build` | PASS | 5/5. The sandboxed attempt failed only because binding `127.0.0.1` returned `EPERM`; the identical command passed with local-listener permission. |
| `npx playwright install chromium` | NOT RUN | The user explicitly selected the in-app Browser and asked not to install/run Playwright locally. |
| `npm run e2e` | NOT RUN | Deliberately replaced by the in-app Browser acceptance below. Existing Playwright files remain for other collaborators. |

## Fixes found by real-browser acceptance

### Scripted elder response source

The acceptance control sends the repository's scripted dental reply with
`source: script`. The frontend client previously rejected it before the request
could reach Backend, even though the unchanged Backend contract permits
`user_input` or `script` for elder replies.

The client now accepts the exact Backend elder-source whitelist while retaining
`family_input` exclusively for `card_confirmed` and `alarm_acknowledged`.
Regression tests also prove the Family source cannot be reused for an elder
reply. In the real local stack, the scripted response reached
`POST /api/response` with HTTP 200 after the fix.

### Debug/phone presentation crash

The initial real run captured this application exception:

```text
TypeError: Cannot read properties of undefined (reading 'status')
at ChildPhone.jsx
```

Backend could project the `attention` phase while perception was still starting,
but the phone component indexed a fall-only presentation table that has no
`attention` entry. The presentation mapping is now a pure, tested helper; it
uses Backend-projected copy as soon as the demo session exists and displays an
explicit unavailable fallback for an unknown phase instead of crashing.

After the fix, the three route bodies remained non-empty during a five-second
soak and CDP recorded zero new `Runtime.exceptionThrown` events.

### Action-card executor exposure

The first authoritative action-card confirmation sent the correct
`confirm_action_card` command, but Monitor returned `command_not_supported`.
`useFallLiveLink` had exposed `confirmAlarm` but omitted Backend's independent
`confirmActionCard` action.

The decision-runtime action boundary now exports `confirmActionCard`, with a
regression test. Final in-app Browser trace:

1. Family sent one `reme-control-command/v1` whose command was only
   `confirm_action_card` for the current Backend decision.
2. Relay returned `control_ack: received`.
3. Backend applied `card_confirmed`.
4. Relay returned `control_ack: applied`, reason
   `action_card_confirmed`, at state revision 57.
5. Family changed the card from pending confirmation to the authoritative
   updated state.

No `acknowledge_alarm` command appeared in that action-card trace.

### WebRTC remote-track lifecycle

Viewer now observes the accepted remote video track's `ended` event. Track end
closes the transport, clears the media element, removes its listener, and
returns to the skeleton with an explicit failure reason. The lifecycle is
covered by a deterministic cleanup regression test.

## In-app Browser acceptance

### Routes and role boundaries

- PASS: `/home`, `/family`, and `/debug` all rendered non-empty first screens.
- PASS: `/home` presented the home capture role and did not expose the Debug
  surface.
- PASS: `/family` presented the Viewer role and did not expose Monitor producer
  controls.
- PASS: `/debug` presented the engineering surface and Monitor producer.
- PASS: the final five-second soak recorded no new runtime exception.

### Debug observability

PASS: `/debug` visibly contained all required counters and states:

- frame age;
- dropped input frames and backpressure;
- capture transport;
- Relay state ACK;
- Relay pose offered, in-flight, and ACK;
- Relay protocol error;
- WebRTC mode, producer state, peers, and latest reason.

These engineering labels were not present as a Debug panel on `/family`.

### Authoritative decision behavior

In real MiMo mode, the scripted elder reply reached Backend successfully. The
observed MiMo result took roughly seven seconds, while Backend's unchanged
deterministic reply deadline was 2.5 seconds. Backend therefore published its
timeout safety result first and the final authoritative state was
`urgent_attention`. The frontend did not extend, replace, or bypass that timer.

To finish the independent action-card transport acceptance without faking
frontend authority, the second run used Backend's existing `--mode mock` and
the repository fixture `examples/decision/mimo_mock/toothache_demo_01.json`.
Backend still created the CareDecision, consent transition, action card,
FamilyEvent, and `card_confirmed` result; the Browser only submitted the elder,
consent, and Family inputs.

The real alarm ACK was not repeated in this run. Its previously recorded
in-app Browser trace remains in `validation-2026-08-10.md`; the final 218-test
run also verifies the command separation and terminal-ACK lease behavior.

### Privacy and media fail-closed

- PASS, bathroom: Family displayed `浴室硬隐私 · 仅同步匿名骨架`.
- PASS, bathroom media element: no `srcObject`, `readyState === 0`, no intrinsic
  video dimensions (`0 × 0`), and no original-video-open copy.
- PASS, sampled control WebSocket: the action-card trace contained no
  JPEG/data URL/base64/Blob/audio/video payload marker.
- PASS, deterministic gates: hidden, skeleton-only, authorization mismatch,
  authorization expiry, WebRTC failure, stale signal, and track-ended cases all
  fail closed.
- NOT INJECTED IN THIS BROWSER RUN: hidden/skeleton-only authorization variants,
  forced authorization mismatch, and forced WebRTC negotiation failure.

### Camera, pose, and cleanup boundary

- The Browser exposed the preferred TrackProcessor/Worker-related APIs but no
  usable camera, so the capture chain could not produce a frame.
- A failed camera retry stayed visibly unavailable and caused zero new
  `/api/session` requests and zero Backend WebSocket create/close events in the
  sampled window.
- A successful source-generation change was not possible, so current-run
  session preservation across a real source switch is not claimed.
- Live Backend/Relay FPS, background-tab FPS, Family canvas continuity, and a
  real PoseFrame freshness transition were not measurable in this run.
- Worker/rAF/VideoFrame process-level enumeration was not available. Resource,
  generation, display freshness, disconnect, and socket disposal tests passed.
- All temporary Vite, Backend, and Relay processes were stopped after browser
  acceptance.

The earlier camera-capable evidence in `validation-2026-08-10.md` remains useful
historical evidence, but it is not relabeled as a result of this final commit.

## Engineering result against the attachment

- Final stack remains React 19, React DOM 19, Vite 8, MUI 9, Emotion, Tailwind
  4, native CSS, Node test, WebSocket, WebRTC, and browser media Workers.
- No runtime dependency was added in this follow-up.
- The foundation's only new dependencies remain development-only
  `@playwright/test` and `typescript`; neither enters the product bundle.
- Protocol validation lives under `transport/relay`; display-only pose
  selection and Canvas lifecycle live under `runtime/viewer`.
- React components no longer own the extracted Relay wire protocol or the
  display smoothing runtime.
- Backend authority, FamilyEvent shape, alarm semantics, and Relay contracts
  remain unchanged.
- Playwright assets were retained because they are shared repeatable tests for
  collaborators; this local user-selected validation used the in-app Browser.

## Remaining physical acceptance gates

These are deliberately reported as unmeasured rather than converted into pass:

1. foreground and background camera FPS for the final commit on a camera-capable
   browser;
2. live Backend landmarks/Relay pose rates and Family display continuity for
   the final commit;
3. successful real source switching plus process-level Worker/VideoFrame leak
   instrumentation;
4. explicit real-browser authorization-mismatch and negotiation-failure
   injection;
5. TURN reachability, cross-network media, and a physical mobile-device matrix.

## Code commit covered by this validation

- `872ae75 fix(frontend): close browser authority lifecycle gaps`
