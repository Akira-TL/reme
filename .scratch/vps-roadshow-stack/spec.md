# Reme single-VPS roadshow stack

- Status: implementation approved
- Date: 2026-08-11
- Runtime authority: `origin/develop/akira@d590eaa7`
- Deployment target: `manifold_cloudcone`

## User decision

For the roadshow, every Reme-owned server process may run on the same SSH VPS.
The Xiaomi MiMo API remains an accepted external dependency. `/home` and
`/family` are browser clients, not separate servers: the VPS serves both pages,
while the roadshow laptop or phone executes them to access a camera and render
the UI.

## Required topology

```text
Roadshow browser /home ─┐
                        ├─ HTTPS/WSS ─ Caddy on one VPS
Roadshow browser /family┘                ├─ static Frontend
                                        ├─ owner unified Backend
                                        ├─ owner Relay on local workerd
                                        └─ coturn

Owner Backend ─ HTTPS ─ Xiaomi MiMo API
```

All HTTP and WebSocket browser traffic uses one trusted HTTPS origin. Caddy
strips `/_reme/runtime` before proxying to Backend and `/_reme/relay` before
proxying to Relay. coturn remains on its native UDP/TCP ports on the same VPS.

## Authority and privacy boundaries

1. Do not change `backend/` or `demo-relay/` business code. Deployment wrappers
   may package those exact owner trees.
2. Home still performs browser capture only. It uploads bounded 384px JPEGs to
   the owner Backend and never runs pose/fall inference.
3. Because Backend now runs on the VPS, those JPEGs leave the Home browser
   device. This is an explicit roadshow topology fact, not a hidden privacy
   claim.
4. Family receives Backend-authoritative pose/state through the owner Relay.
5. Relay JSON still rejects JPEG, Blob, base64, data URLs, and audio/video bytes.
6. Bathroom, `hidden`, `skeleton_only`, invalid/expired authorization, and
   WebRTC failure remain skeleton-only.
7. MiMo and TURN secrets stay in root-owned server files and never enter Git,
   Docker image layers, `reme-config.js`, browser bundles, or command lines.

## Relay runtime decision

The owner Relay uses Cloudflare Worker APIs and a SQLite Durable Object. For
this roadshow it runs unchanged under the repository-pinned Wrangler local
workerd/Miniflare runtime with `--persist-to`. This is sufficient for a single
VPS demo and requires no Cloudflare hosting account at runtime.

This does not claim Cloudflare edge distribution, managed Durable Object high
availability, multi-host failover, or production identity/access control.
The fixed public room remains a deliberate roadshow exception.

## Server services

- `reme-frontend`: immutable Vite build served by unprivileged Nginx.
- `reme-backend`: exact owner Python package plus pose dependencies; models are
  mounted read-only because trained model files are intentionally ignored.
- `reme-relay`: exact owner Relay plus Node 24/Wrangler; local Durable Object
  state is mounted persistently.
- `coturn`: existing host systemd service and existing public port range.
- `biaoshu-caddy`: existing Caddy container; add one Reme site block without
  replacing unrelated sites.

No Reme container publishes an HTTP port on the host. Caddy reaches all three
containers over the existing `zhixia-biaoshu_frontend` network.

## Secret inputs

`configure-roadshow-secrets.py` must create, without printing values:

- `/etc/reme/backend.env` from the existing root-owned MiMo env;
- `/etc/reme/relay.dev.vars` from the existing coturn REST secret plus one
  generated runtime-ingest token.

The Backend and Relay receive the same runtime-ingest token. The Relay and
coturn receive the same TURN REST shared secret. Rerunning configuration keeps
an existing valid runtime-ingest token rather than silently rotating it.

## Acceptance gates

1. `git diff origin/develop/akira -- backend demo-relay` is empty.
2. Secret generator tests and `--check` pass without printing secret values.
3. Frontend gates, Relay tests/typecheck, and Backend deterministic tests pass.
4. Docker Compose config and three image builds pass.
5. Backend, Relay, and Frontend healthchecks are healthy with no host HTTP port.
6. All three upstreams pass from Caddy's Docker network and the complete Caddy
   configuration validates before DNS cutover. Public HTTPS is tested only
   after DNS points at the VPS, because Caddy cannot obtain the public
   certificate beforehand.
7. After trusted HTTPS is active, the in-app browser proves `/home`, `/family`,
   and `/debug`, owner Backend pose, Relay state/pose ACK, and disconnect clear.
8. Report real TURN candidates and two-device media only if actually observed.

## Rollback

- Keep the old static/Vercel deployment until the single-VPS route passes.
- Caddy change is one separate site block and can be removed independently.
- Restore the previous DNS record to return traffic to the old frontend.
- Do not delete Relay state, Backend artifacts, coturn configuration, or prior
  releases during rollback.
