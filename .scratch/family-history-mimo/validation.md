# Family history playback and MiMo summary validation

Date: 2026-08-11 (America/New_York; VPS UTC deployment continued into
2026-08-12)

Implementation commit: `3c5ab3a0f51a3615a3f02227361f28fcbd3b0b59`

Public release directory:
`/opt/reme-frontend/releases/20260812-3c5ab3a-history`

## Scope and contract boundary

- The Git diff against `origin/develop/akira` is empty under `backend/` and
  `demo-relay/`.
- The deployment reuses the repository owner's history fixture loader, Backend
  `DiarySummaryService`, MiMo adapter, summary cache, and Relay history
  contracts.
- The browser does not receive or store a MiMo API key.
- Mock identifies the structured behavior input. A ready summary is displayed
  only when Relay reports `summary.source=mimo`, the selected date matches, the
  summary input timeline revision matches the day revision, and the summary
  input count matches the displayed Mock count.
- Missing, failed, stale, or mismatched summaries fail closed to
  `摘要暂不可用`; the frontend does not supply a fixed narrative fallback.

## Local deterministic gates

Run from `frontend/` unless noted otherwise:

| Command | Result |
| --- | --- |
| `npm ci` | PASS; 219 packages installed from lockfile |
| `npm run typecheck:contracts` | PASS |
| `npm test` | PASS; 250/250 tests |
| `npm run lint` | PASS |
| `npm run build` | PASS; Vite 8.2.0, 1,060 modules; `FamilyApp-CAaTzQ02.js` and `FamilyApp-B8T07nL7.css` |
| `npm run test:route-build` | PASS; 6/6 routes/build checks |
| Relevant Backend/deployment history tests | PASS; 10/10 tests |
| Full Python test suite | PASS with one existing skip; the first sandbox run could not bind a socket, then the unsandboxed run from the repository model-fixture context passed |
| `ruff check deploy/vps/test_family_history_fixture.py` | PASS |
| Relay `npm run typecheck` with Node 22.23.1 | PASS |
| Relay `npm test` with Node 22.23.1 and an explicit writable Wrangler log path | PASS; 28/28 tests |
| `git diff --check` | PASS |
| `git diff --name-status origin/develop/akira -- backend demo-relay` | PASS; empty output |

The local machine did not have Docker, so local `docker compose config` was not
claimed. The same versioned release was validated on the target VPS with:

```text
REME_MODELS_DIR=/opt/reme-runtime/models docker compose \
  --project-directory /opt/reme-frontend/releases/20260812-3c5ab3a-history/deploy/vps \
  -f /opt/reme-frontend/releases/20260812-3c5ab3a-history/deploy/vps/compose.roadshow.yaml \
  config -q
```

Result: PASS.

## Local built-in browser

Environment: macOS 26.5.2, Codex in-app browser backed by Google Chrome 151.
The repository Playwright project was not used.

- Production preview `/family` rendered without a white screen or console
  errors.
- The home recording card rendered a compact `选择录像日期` select.
- The options covered August 4-11 plus the current day. August 9 exposed three
  clips, including the night safety clip.
- Selecting and playing the night safety clip produced a 21-second video with
  `readyState=4`, no media error, and active playback.
- The care page rendered 30 Mock life segments for August 11.
- Before public history import, the summary UI displayed the fail-closed state
  `摘要暂不可用` and explicitly said that no fixed summary replacement was
  used.
- A 390x844 viewport check showed the date select within the recording-card
  header without materially increasing card height.

## VPS deployment and real MiMo path

Only `reme-frontend` was rebuilt/recreated. Before deployment:

```text
/reme-frontend 2026-08-12T02:32:19.59211305Z running healthy
/reme-backend  2026-08-11T17:52:48.506114537Z running healthy
/reme-relay    2026-08-11T17:52:48.507580858Z running healthy
```

After deployment:

```text
/reme-frontend 2026-08-12T03:37:18.179656566Z running healthy
/reme-backend  2026-08-11T17:52:48.506114537Z running healthy
/reme-relay    2026-08-11T17:52:48.507580858Z running healthy
```

The unchanged Backend/Relay timestamps confirm that this correction did not
restart either authoritative service.

The one-shot `reme-history-loader` exited 0. It published timeline revision 2
and ready summary revision 1 for every date from August 4 through August 11.
The public summary API reported these real MiMo inputs:

| Date | Status | Timeline revision | Summary source/model | Input records |
| --- | --- | ---: | --- | ---: |
| 2026-08-04 | ready | 2 | mimo / mimo-v2.5 | 32 |
| 2026-08-05 | ready | 2 | mimo / mimo-v2.5 | 30 |
| 2026-08-06 | ready | 2 | mimo / mimo-v2.5 | 29 |
| 2026-08-07 | ready | 2 | mimo / mimo-v2.5 | 28 |
| 2026-08-08 | ready | 2 | mimo / mimo-v2.5 | 27 |
| 2026-08-09 | ready | 2 | mimo / mimo-v2.5 | 38 |
| 2026-08-10 | ready | 2 | mimo / mimo-v2.5 | 29 |
| 2026-08-11 | ready | 2 | mimo / mimo-v2.5 | 30 |

For August 11, Relay returned `source=mimo`, `model=mimo-v2.5`,
`input_event_count=30`, `input_timeline_revision=2`, and `status=ready`.

## Public surface checks

- `https://reme.maniforld.com/home`: HTTP 200 `text/html`.
- `https://reme.maniforld.com/family`: HTTP 200 `text/html`.
- `https://reme.maniforld.com/debug`: HTTP 200 `text/html`.
- Public Backend health: HTTP 200 with `status=ok`.
- Public Relay health: HTTP 200 with `ok=true`.
- The in-app browser rendered the public Family home with the date options,
  `8月9日 · 3段`, a playable-recording card, and `2 段演示录像` for the selected
  fallback day.
- All three public Mock MP4 assets accepted a byte-range request and returned
  HTTP 206, `video/mp4`, and the requested 1,024 bytes.

The built-in browser repeatedly timed out while inspecting/clicking the public
care-tab DOM after the successful public home render. Therefore this report
does not claim a second post-deployment visual assertion of the ready MiMo card.
The same UI branch was exercised locally, and the post-deployment public Relay
payload satisfies all of its date/revision/count/source gates. This browser-tool
timeout is recorded as a validation limitation rather than reported as a pass.

## Not evaluated in this change

- No physical camera, two-device WebRTC, TURN, cross-network media, or measured
  capture FPS assertion was made.
- No Backend/Relay contract or implementation was changed.
- No claim is made about hardware capability outside the tests above.
