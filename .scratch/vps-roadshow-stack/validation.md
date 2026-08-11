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
| `python3 -m unittest deploy/vps/test_configure_roadshow_secrets.py deploy/vps/test_install_caddy_roadshow_site.py` | pass; 7 tests after the final test split |
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

## Pending public acceptance

Public DNS still resolves through the old Vercel CNAME
`459ace11b47bcf46.vercel-dns-017.com`. Caddy cannot obtain the
`reme.maniforld.com` certificate until that record is replaced with the VPS A
record `74.48.114.52`.

The existing Wrangler OAuth token has Zone read permission but no DNS write
permission. The in-app Cloudflare dashboard is at the sign-in page. Therefore
the DNS mutation and trusted-HTTPS browser acceptance are not claimed.

Not yet measured or claimed:

- `/home`, `/family`, and `/debug` against the new public VPS origin;
- physical camera/microphone permission and at least five seconds of foreground
  capture FPS;
- background-tab FPS;
- two real devices, actual relay ICE candidates, or TURN media transport;
- WebRTC authorized-video success/failure and all privacy fail-closed cases on
  the new public origin;
- real MiMo request/response from the roadshow browser flow.
