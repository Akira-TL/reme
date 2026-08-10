# Frontend engineering foundation validation — 2026-08-10

## Scope and environment

- Branch under validation: `lbx-frontend`, synced from `origin/lbx-frontend@51069067`
- Implementation base recorded by the handoff: `origin/develop/akira@d590eaa7`
- Scope: frontend only. Backend and Relay contracts were not changed.
- Host: Apple silicon MacBook Air, macOS 26.5.2 (25F84)
- Camera: `MacBook Air Camera (0000:0001)`
- Browser: Codex in-app Browser, Chrome 151.0.0.0 user agent
- Local services:
  - Backend: `127.0.0.1:8770`
  - Relay: `127.0.0.1:8787`
  - Vite: `127.0.0.1:4174`
- Relay required the bundled Node 24.14 runtime because the system Node 26.5 runtime is outside the Relay's supported range.
- MiMo configuration was loaded from the existing local config file without printing credentials.

## Command results

| Command | Result | Notes |
| --- | --- | --- |
| `git fetch origin` | PASS | Updated remote refs before validation. |
| Fast-forward local `lbx-frontend` to `origin/lbx-frontend` | PASS | Validation started at `51069067`. |
| `npm ci` | PASS | Installed 219 packages. npm reported its informational `allow-scripts` warning for `fsevents`; install succeeded. |
| `npm run typecheck:contracts` | PASS | Repeated after the frontend fix; no TypeScript contract errors. |
| `npm test` | PASS | Final run: 211/211 tests passed. The added regression test covers retaining the family control lease until a terminal ACK. |
| `npm run lint` | PASS | Repeated after the frontend fix. |
| `npm run build` | PASS | Vite 8.2.0; 1050 modules transformed. |
| `npm run test:route-build` | PASS | 5/5. The first sandboxed attempt could not bind `127.0.0.1` (`EPERM`); the same test passed when local-listener permission was granted. |
| `npx playwright install chromium` | STOPPED | Download was interrupted at the user's request to use the in-app Browser instead. It is not a validation result. |
| `npm run e2e` | NOT RUN | Deliberately replaced by the in-app Browser acceptance below. Playwright files remain in the branch for repeatable browser regression by future collaborators. |

## In-app Browser acceptance

### Routes and first render

- PASS: `/home`, `/family`, and `/debug` rendered their correct roles without a white screen.
- PASS: initial console inspection showed no application errors or warnings.
- OBSERVATION: under long-running camera/scenario work and hot reload, the in-app Browser's `/debug` renderer showed `This page crashed` twice. Opening a fresh in-app tab recovered immediately. No crash dump was available, so this run does not attribute the renderer crash to either the app or the Browser container.

### Camera pipeline and foreground rate

- PASS: camera capture used `track-worker` (`MediaStreamTrackProcessor` → Worker → `OffscreenCanvas`) and reported the 384 px JPEG path.
- PASS: one continuous foreground sample longer than five seconds observed:
  - Backend/input frames: 338 → 386 in 5 s = 9.6 FPS
  - Relay pose offered: 338 → 386 in 5 s = 9.6 FPS
  - Relay pose ACK: 336 → 386 in 5 s = 10.0 FPS
  - dropped: 0
  - backpressure: clear
  - frame age: 0 ms at the sampled endpoints
- NOT MEASURED: background-tab FPS. Every in-app Browser tab reported `document.visibilityState === "visible"`, so this environment could not create a truthful background sample.

### Session, source generation, and cleanup

- PASS: changing source generation from 1 to 2 preserved the same Backend runtime session (`live-camera-f60b8f2e-ded2-4d1e-80bc-c490682ba93c`).
- PASS: selecting the unavailable rear-camera direction failed closed, and returning to the front camera recovered without inventing media availability.
- PASS: stopping the demo closed the three observed WebSockets; no further frames arrived on those request IDs after closure. The UI returned to idle, the video track detached, and Backend runtime status reported `stopped`.
- PASS: Family cleared the last pose after stop and did not continue presenting the old quiet-state claim.
- PARTIAL: direct Worker/rAF/VideoFrame enumeration was not available from the in-app Browser. Deterministic disposal tests passed, and socket/media cleanup was observed, but this run does not claim process-level leak instrumentation.

### Debug visibility

- PASS: `/debug` exposed frame age, dropped count, backpressure, capture transport, Relay state/pose offered/in-flight/ACK, protocol error, and WebRTC state.
- PASS: the sampled WebRTC status was `local_network_only`, idle, zero peers. TURN was not configured or tested.
- PASS: the sampled normal-flow MiMo status was request idle with zero visual frames.

### Family pose freshness

- PASS: live `DemoState` plus `PoseFrame` rendered the anonymous skeleton.
- PASS: stopping/disconnecting cleared the pose and media rather than retaining an old normal claim.
- PARTIAL: an explicit stale old-session pose was not injected through the real browser stack. The corresponding deterministic runtime/session/expiry tests passed.

### Family confirmation ACK race and frontend fix

The first real alarm acknowledgement exposed a frontend race:

1. Family sent only `acknowledge_alarm` for the current decision.
2. Relay returned `control_ack: received`.
3. Backend published the next resolved `FamilyEvent`.
4. Family released its controller lease before Relay emitted the terminal ACK.
5. Relay therefore emitted `control_ack: failed`, reason `controller_released`.

The frontend now tracks the sent confirmation independently of the newly projected decision and retains the lease until a terminal ACK or the bounded timeout.

Final real-browser trace after the fix:

1. `control_claim`
2. `acknowledge_alarm` for `decision-0025`
3. `control_ack: received`
4. `control_ack: applied`, reason `alarm_acknowledged`, `state_revision: 37`
5. one `control_release`

PASS: no `confirm_action_card` or unrelated command was sent in this alarm flow.

### Action card

- BLOCKED IN REAL ENVIRONMENT: repeated `proactive_check_in` runs reached the scripted dental response, but the local Backend/MiMo flow projected `urgent_attention` instead of a pending `action_card`. There was therefore no authoritative action card that the frontend was allowed to confirm.
- NOT CLAIMED: no real-browser `confirm_action_card` terminal ACK was observed.
- PASS (deterministic gates only): tests verify that a pending action card maps exclusively to `confirm_action_card`, invokes the independent action-card executor, and waits for the Relay/Backend contract result.
- This was not “fixed” in the frontend because the frontend is prohibited from inventing an action card or replacing Backend authority.

### Privacy and fail-closed behavior

- PASS, bathroom: Family showed the hard-privacy skeleton-only copy. Its video element had no `srcObject`, `readyState` 0, empty `currentSrc`, and 0×0 intrinsic dimensions.
- PASS, high privacy: with high-privacy display enabled during an authoritative alarm, Family still kept the video element detached (`srcObject=false`, `readyState=0`, 0×0) and retained the anonymous skeleton surface.
- PASS, authorization expiry: an unconfirmed 30-second event grant closed and Family returned to skeleton-only presentation after expiry.
- PARTIAL: authorization mismatch and forced WebRTC negotiation failure were not separately injected in the real browser. Their deterministic fail-closed tests passed.
- NOT TESTED: TURN reachability or cross-network media. The observed environment was explicitly local-network-only.

### Relay payload and MiMo audit

In one three-second DevTools sample:

- Relay pose WebSocket: 10 text pose offers and 10 `pose_accepted` responses; no binary frames; maximum text frame 1431 bytes; no JPEG/data URL/raw-media fields observed.
- Backend camera WebSocket: 35 text frame-metadata messages plus 35 binary image frames. Binary camera bytes stayed on the Backend camera channel, not the Relay JSON pose channel.
- Normal-flow debug status remained MiMo request idle with zero visual frames during the sample.

PASS for the sampled flow: Relay JSON contained no JPEG/Blob/base64/audio/video bytes, and no daily continuous pose/frame stream was sent to MiMo. This is a bounded sample, not a provider-wide packet-capture claim.

## Conclusion

The automated frontend gates pass and the alarm ACK race found during real-browser acceptance is fixed and revalidated. The whole handoff is **not fully accepted** because the real action-card ACK path could not be produced by the local Backend/MiMo environment, background FPS could not be measured in the in-app Browser, and TURN/cross-network plus separately forced authorization-mismatch/WebRTC-failure cases were not exercised on real devices.
