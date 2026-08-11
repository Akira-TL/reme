# Reme frontend and owner-runtime validation

- Date: 2026-08-11
- Branch: `lbx-frontend`
- Owner authority: `origin/develop/akira@d590eaa73dcc06ab050789d68413d535e7d92615`
- Local host: macOS 26.5.2 (25F84), Apple Silicon MacBook Air
- Browser: Codex in-app Chromium 151.0.0.0
- Camera: `MacBook Air Camera (0000:0001)`
- Frontend toolchain: Node v26.5.0, npm 11.17.0
- Backend Python: 3.12.13 through `uv`

## Authority result

The owner branch is already an ancestor of `lbx-frontend`; no merge commit is
needed. A final `git fetch origin` left the owner ref at `d590eaa7`.

```text
git merge-base --is-ancestor origin/develop/akira HEAD  -> exit 0
git diff --name-status origin/develop/akira -- backend demo-relay  -> empty
```

The current `backend/` and `demo-relay/` trees are therefore byte-for-byte the
same Git trees as the repository owner's authority branch. This frontend work
does not add an alternative Backend or Relay.

## Owner Backend and Relay startup

The exact owner Backend was started unchanged:

```text
cd backend
uv run --extra pose python -m reme.runtime.server \
  --host 127.0.0.1 --port 8770 \
  --input-adapter c_ws_server --browser-input-mode jpeg
```

Observed results:

- `/api/health` returned `status: ok`.
- `/api/runtime/capabilities` reported the owner `c_ws` JPEG input contract,
  JPEG inference enabled, landmarks input disabled, and raw-video persistence
  disabled.
- During the camera session the owner runtime reported its MoveNet TFLite,
  posture classifier with geometry fallback, and deterministic MIL gate loaded.

The exact owner Relay was started unchanged on an unused local port:

```text
cd demo-relay
/Users/maniforld/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node \
  node_modules/wrangler/bin/wrangler.js dev --ip 127.0.0.1 --port 8788
```

`/health` returned `{"ok":true,"room_name":"shared-live-demo"}`. An unrelated
developer Relay already listening on 8787 was not stopped or modified.

## Final repository gates

All commands were run from `frontend/` after the final code changes:

| Command | Result |
| --- | --- |
| `npm ci` | PASS, 219 packages installed; only the existing `fsevents` allow-scripts warning |
| `npm run typecheck:contracts` | PASS |
| `npm test` | PASS, 230/230 |
| `npm run lint` | PASS |
| `npm run build` | PASS, Vite 8.2.0, 1,055 modules transformed |
| `npm run test:route-build` | PASS, 6/6 |
| `git diff --check` | PASS |

`npm test` includes the no-browser-pose boundary check. It also covers exact
confirmation commands, Relay JSON media-byte rejection, stale runtime/session
clearing, and bathroom/`hidden`/`skeleton_only`/authorization/WebRTC fail-closed
logic. These deterministic tests are not presented as physical-device proof.

## In-app browser acceptance

Playwright test files and the Playwright runner were not used. The acceptance
was run interactively in the Codex in-app browser against the owner Backend and
Relay through local SSH forwards.

### Routes and Home capture

- `/home`, `/family`, and `/debug` each rendered their correct role with no
  blank first screen.
- Home received a real `MacBook Air Camera` stream and used
  `TrackProcessor -> Worker -> OffscreenCanvas -> 384px JPEG`.
- A foreground rolling observation displayed 9.2 successful uploads/s, 229
  successful frames, zero input drops, and clear backpressure. The target was
  shown separately as 10 FPS.
- With the Home tab backgrounded, a later rolling observation displayed 8.6
  successful uploads/s and the successful-frame counter advanced from 229 to
  486, still with zero reported input drops and clear backpressure. This is one
  local observation, not a guaranteed background FPS claim.
- Changing the source generation from 1 to 2 kept the same owner Backend
  session, `live-camera-b69d1cbd-70d6-4d51-8e85-799b99cfb9ac`.
- Stopping the demo left the media permission idle, Relay idle, decision socket
  closed, Backend session stopped, measured FPS cleared, and no stale model or
  pose state exposed.

### Debug and Family

- Debug visibly reported frame age, drops, backpressure, capture transport,
  Relay state and pose offered/in-flight/ACK, protocol error, and WebRTC state.
- With the exact owner Relay on the allowed 4174 origin, Monitor and Family
  joined room session `room-ea2e9bec...`; state and pose ACK counters advanced,
  the Relay socket was connected, and no protocol error was shown.
- Family rendered the owner Backend PoseFrame: its 1448 x 999 skeleton canvas
  contained 29,032 non-transparent pixels during the live pose.
- After Monitor stopped, Family changed to unavailable/offline and the same
  canvas contained zero non-transparent pixels. This proves the tested
  disconnect path clears the old skeleton.
- A separate attempt to switch the live owner runtime from Night to Bathroom
  did not commit the scene change in the browser. Bathroom browser acceptance
  is therefore **not passed or claimed**; the deterministic privacy tests pass,
  but the owner runtime scene-switch rejection needs owner-side follow-up if a
  live Bathroom demonstration is required.
- No live alarm or action-card event was produced in this run, so browser clicks
  for those two confirmations were not claimed. Their exact command separation
  and ACK-waiting behavior passed deterministic tests.

The public Relay rejected the non-allowlisted 4175 tunnel origin with 403 and
the UI exposed that failure. The exact local owner Relay was therefore used for
the successful end-to-end room/pose validation on its allowlisted 4174 origin.

## CloudCone staged frontend

The final frontend image was built on the authorized CloudCone VPS in the
isolated directory
`/opt/reme-frontend/releases/20260811-lbx-frontend-staging`.

- `docker compose ... config`: PASS.
- `docker compose ... up -d --build`: PASS.
- `reme-frontend` health: `healthy`.
- Runtime config mount: checked-in `reme-config.example.js`, read-only.
- Docker network: existing `zhixia-biaoshu_frontend`.
- Published host ports: none (`8080/tcp: null`).
- Existing Caddy container fetched `/home`, `/family`, and `/debug`: HTTP 200.
- Existing public `hyxs.art` and `ps.maniforld.com`: HTTP 200 after staging.

This is a frontend-only staged container. Caddy configuration, DNS, TLS,
Cloudflare, the CloudCone IP migration, and the existing public sites were not
changed. The owner Backend and Relay were proven locally but were not invented,
patched, or deployed as new VPS services by this frontend work item.

## Explicit non-claims

- TURN UDP/TCP/TLS and cross-network two-device media were not tested; the
  owner Relay reported `local_network_only`.
- No real phone/tablet pair or non-local camera was tested.
- MiMo was unconfigured, so no live MiMo request/response was claimed.
- No production domain or certificate serves this staged Reme container yet.
- No assertion is made that 9.2 or 8.6 FPS generalizes beyond the stated local
  browser, camera, and observation.
