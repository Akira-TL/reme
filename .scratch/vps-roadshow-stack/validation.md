# Single-VPS roadshow validation

- Date: 2026-08-11
- Branch: `lbx-frontend`
- Owner authority: `origin/develop/akira@d590eaa7`
- VPS: `manifold_cloudcone`, Ubuntu 22.04.3 LTS x86_64
- Host tooling: Docker 29.3.1, Compose 5.1.1, Caddy 2.11.4,
  coturn package 4.5.2
- Local gate host: macOS 26.5.2 arm64, Node 26.5.0, npm 11.17.0

## Authority and repository gates

| Check | Result |
| --- | --- |
| `git fetch origin` | pass; owner ref remains `d590eaa7`, frontend remote remains `d27a21b3` before this change |
| `git diff --name-status origin/develop/akira -- backend demo-relay` | pass; empty |
| `python3 -m unittest deploy/vps/test_configure_roadshow_secrets.py deploy/vps/test_install_caddy_roadshow_site.py` | pass; 8 tests, including bind-mount inode preservation and explicit managed-block update |
| `uv run ruff check backend tests deploy/vps` | pass |
| `node --check deploy/vps/relay-entrypoint.mjs` | pass |
| `npm ci` in `frontend/` | pass; 219 packages |
| `npm run typecheck:contracts` | pass |
| `npm test` in `frontend/` | pass; 230/230 |
| `npm run lint` | pass |
| `npm run build` | pass; Vite 8.2.0, 1,055 modules |
| `npm run test:route-build` | pass; 6/6; required loopback bind outside the filesystem sandbox |
| `npm ci` in `demo-relay/` | pass; 91 packages; local Node 26 emits an engine warning, deployed image uses accepted Node 24 |
| `npm test` in `demo-relay/` | pass; 28/28 |
| `npm run check` in `demo-relay/` | pass; generated Worker types current and TypeScript clean |
| `npm run dry-run` in `demo-relay/` | pass; 117.36 KiB / 21.92 KiB gzip |
| `uv run pytest` | pass; 678 passed, 1 skipped |
| `uv run mypy backend` | baseline fail; 11 errors in exact owner Backend, so no authority code was changed |

Repository Playwright was intentionally not run. Browser acceptance uses the
Codex in-app browser per the user's instruction. No Playwright files were
deleted because they remain shared repository tooling and are not required by
the VPS runtime.

## VPS deployment

- Root-owned MiMo and TURN inputs were read by
  `configure-roadshow-secrets.py`; secret values were never printed.
- `/etc/reme/backend.env` and `/etc/reme/relay.dev.vars` are mode `0600` and
  contain the matching generated runtime-ingest token.
- Model assets are mounted read-only at `/app/models`.
- `reme-frontend`, `reme-backend`, and `reme-relay` are all healthy with zero
  published host ports. Each has a read-only root filesystem, `cap_drop: ALL`,
  and `no-new-privileges`.
- Caddy reaches all three services on `zhixia-biaoshu_frontend`; Frontend,
  Backend, and Relay health endpoints returned success.
- A temporary Backend `live_camera` session reached `starting`; the log recorded
  TensorFlow Lite XNNPACK delegate creation, proving the mounted MoveNet runtime
  loaded. The probe session then returned `stopped`.
- Relay RTC configuration returned `turn_configured`, one STUN URL, UDP/TCP TURN
  URLs, an ephemeral credential, and an expiry. Credential values were not
  recorded.
- Caddy full-config validation passed and the isolated Reme block was reloaded.
  Backup:
  `/opt/biaoshu-mono/infra/caddy/Caddyfile.before-reme-roadshow-20260811T145045Z`.
- The first installer write atomically replaced the host Caddyfile inode, so the
  already-running single-file bind mount continued to expose the old file. The
  live config was synchronized without restarting unrelated sites, and the
  installer now stages the candidate but overwrites the existing inode in
  place. The final mounted `/etc/caddy/Caddyfile` validates and reloads.
- `reme-history-loader` now mirrors local launcher startup by waiting for a
  healthy Relay and running the owner Backend's versioned fixture loader with
  `--skip-summaries`. It exited 0 and published revisions for 2026-08-04 through
  2026-08-11 without printing credentials or calling MiMo.
- Local workerd normalizes the public HTTPS browser Origin to the same-host HTTP
  form after TLS termination. The generated Relay allowlist now contains only
  those two exact origins. Relay remained private to the Docker network; after
  recreation, public same-origin health returned 200 and Viewer WebSocket
  handshakes returned 101 instead of 403.

## Public DNS and HTTPS acceptance

Cloudflare DNS was changed in the signed-in in-app dashboard:

- `reme.maniforld.com`: DNS-only A `74.48.114.52`, TTL 10 minutes;
- `monitor.reme.maniforld.com`: unchanged DNS-only CNAME
  `459ace11b47bcf46.vercel-dns-017.com`;
- no unrelated DNS record was edited.

After the old recursive cache expired, ordinary curl resolved the public host
to `74.48.114.52` and returned HTTP 200 with TLS verification result 0. Caddy
stored a Let's Encrypt certificate under its persistent data directory. Direct
same-origin checks returned:

| URL | Result |
| --- | --- |
| `/home` | 200 `text/html` |
| `/family` | 200 `text/html` |
| `/debug?debug=1&turnProbe=1` | 200 `text/html` |
| `/_reme/runtime/api/health` | 200, Backend `status: ok` |
| `/_reme/relay/health` | 200, Relay room `shared-live-demo` |
| `/_reme/runtime/api/runtime/capabilities` | 200, owner runtime contract |

## In-app browser acceptance

- Environment: Codex in-app Google Chrome 151.0.0.0 on macOS 26.5.2; public
  origin `https://reme.maniforld.com`.
- `/home`: title `Reme · 居家端`; first paint rendered the Home capture role,
  showed media not started and waiting for Backend keypoints, and had zero
  console errors. No camera or microphone permission was requested.
- `/family`: title `Reme · 家属端`; after the Relay allowlist fix the UI reported
  the public demo connection as connected, showed three current browser tabs,
  and Caddy recorded `reme-viewer-v2` WebSocket status 101. The `reme` tab loaded
  the Backend-owned, explicitly Mock-labelled Aug 4-11 history; Aug 11 displayed
  six life segments and 24-hour coverage. Zero console errors were recorded.
- `/debug`: title `Reme · 调试前端`; first paint and the runtime panel rendered.
  It exposed frame age, sent/dropped frames, capture transport, backpressure,
  Relay state/pose offered/in-flight/ACK, protocol error, WebRTC state, MiMo
  status, and raw bounded debug JSON. Zero console errors were recorded.
- The TURN probe observed one UDP `relay` candidate and no TCP relay candidate.
  This proves only the reported UDP candidate gathering in this browser, not
  two-device media transport or TURN TCP capability.

Still not measured or claimed:

- physical camera/microphone permission and at least five seconds of foreground
  capture FPS;
- background-tab FPS;
- source-generation restart/leak behavior with a physical camera;
- two real devices or actual TURN media transport;
- WebRTC authorized-video success/failure and all privacy fail-closed cases on
  the new public origin;
- live acknowledge-alarm, action-card confirmation, and Backend/Relay ACK;
- real MiMo request/response from the roadshow browser flow.

## Family local-visual parity update

The public Family surface was updated after the initial roadshow cutover so it
uses the exact locally accepted UI from `codex/family-home-simplify@400487d5`.
The four post-foundation frontend commits were replayed on top of
`origin/lbx-frontend@ea806be4`. The one source commit that also carried a
Backend history fixture and Backend tests was split: only its frontend and
local validation files were retained. The final authority check remained
empty:

```text
git diff --name-status origin/lbx-frontend -- backend demo-relay
```

Fresh gates on the integrated frontend passed:

| Command | Result |
| --- | --- |
| `npm ci` | pass; 219 packages |
| `npm run typecheck:contracts` | pass |
| `npm test` | pass; 248/248 |
| `npm run lint` | pass |
| `npm run build` | pass; Vite 8.2.0, 1,059 modules |
| `npm run test:route-build` | pass; 6/6; required loopback bind outside the filesystem sandbox |

The locally integrated build produced the same Family stylesheet as the
accepted `400487d5` build (`FamilyApp-BtRVm0bV.css`, SHA-1
`2009422319c8d86573158ce33183f590979bfb4b`). In the in-app browser the local
production preview rendered the accepted orange Reme visual language, complete
August calendar, explicit August 4-11 demo markers, 30 August 11 life records,
activity/device/care filters, recording playback card, and the three-item
Family navigation.

Only `reme-frontend` was rebuilt and recreated on the VPS. `reme-backend`,
`reme-relay`, Caddy, and all persistent volumes were left running. After the
update all three services were healthy. The public Family assets downloaded
through `https://reme.maniforld.com` matched both the local build and the
running container byte for byte:

| Asset | SHA-256 |
| --- | --- |
| `FamilyApp-BtRVm0bV.css` | `375344bb2aa7e915422576c93578c9f1a295875f193728fa9555edd5093adce2` |
| `FamilyApp-iHzxmgWH.js` | `b560962ca6b5d369c748d6f985b8e93c6daba6217b08ff7788ae469104725412` |

`/family`, Backend health, and Relay health each returned HTTPS 200 with TLS
verification success after the replacement. The frontend container started at
`2026-08-11T17:20:12Z`; the unchanged Backend and Relay retained their earlier
start times, confirming that the visual update did not restart authority
services.
