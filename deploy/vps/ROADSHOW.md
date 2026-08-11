# Single-VPS roadshow deployment

This deployment runs the immutable frontend, the repository owner's unified
Backend, and the repository owner's Relay on one VPS. The existing host coturn
service supplies TURN. Xiaomi MiMo remains the only application API outside the
VPS.

`/home` and `/family` are two browser roles served by the same frontend. They
are not server processes. A roadshow laptop or phone executes those pages so it
can use its camera and display the family view.

## Safety boundary

The deployment does not modify `backend/` or `demo-relay/`. Verify before every
release:

```bash
git diff --name-status origin/develop/akira -- backend demo-relay
```

When Backend runs on the VPS, Home's bounded JPEGs cross the network to that
VPS. Relay JSON still contains only structured state, pose, control, and
SDP/ICE signalling. Event media is browser-to-browser WebRTC and may use coturn.

## Server preparation

Required existing inputs:

- Docker Compose;
- the external Caddy network `zhixia-biaoshu_frontend`;
- active coturn with `use-auth-secret` and `static-auth-secret`;
- root-owned `/root/.config/reme/mimo.env` containing `MIMO_API_KEY`;
- the three accepted model assets under a private server model directory.

Generate the Backend and Relay env files without displaying values:

```bash
sudo python3 deploy/vps/configure-roadshow-secrets.py \
  --public-ip 74.48.114.52 \
  --check

sudo python3 deploy/vps/configure-roadshow-secrets.py \
  --public-ip 74.48.114.52
```

The files are written with mode 0600:

```text
/etc/reme/backend.env
/etc/reme/relay.dev.vars
```

## Build and start

```bash
REME_MODELS_DIR=/opt/reme-runtime/models \
  docker compose -f deploy/vps/compose.roadshow.yaml config

REME_MODELS_DIR=/opt/reme-runtime/models \
  docker compose -f deploy/vps/compose.roadshow.yaml up -d --build
```

No Reme HTTP port is published on the host. The existing Caddy container
reaches `reme-frontend:8080`, `reme-backend:8770`, and `reme-relay:8787` through
the shared Docker network. After Relay becomes healthy, the one-shot
`reme-history-loader` container runs the repository owner's
`reme.runtime.history.demo_loader --skip-summaries`. This mirrors local startup:
it publishes the versioned, explicitly labeled mock history fixture to Relay
without making a MiMo API request. Family never generates or falls back to this
fixture in the browser.

Append `Caddyfile.roadshow` as its own site block, then validate before reload:

```bash
sudo python3 deploy/vps/install-caddy-roadshow-site.py \
  --check \
  --caddyfile /path/to/existing/Caddyfile \
  --site-file deploy/vps/Caddyfile.roadshow

sudo python3 deploy/vps/install-caddy-roadshow-site.py \
  --caddyfile /path/to/existing/Caddyfile \
  --site-file deploy/vps/Caddyfile.roadshow

docker exec biaoshu-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec biaoshu-caddy caddy reload --config /etc/caddy/Caddyfile
```

For a later deployment-owned block update, review the diff and pass
`--update-managed`. The installer still refuses unmanaged hosts and malformed
or duplicated markers.

The installer refuses an unmanaged conflicting host, appends only the isolated
Reme block, and writes a timestamped backup before changing the existing file.
The local Relay process runs as root inside the container only so it can read
the root-owned bind-mounted env file and copy it into tmpfs. Every Linux
capability is dropped, the root filesystem is read-only, and no host port is
published. The container is a trusted single-tenant roadshow runtime, not a
hardened multi-tenant Worker sandbox.

The Relay origin allowlist contains exactly the public HTTPS origin and the
same-host HTTP form that local workerd sees after Caddy terminates TLS. The
Relay has no published host port; do not replace this pair with `*` or add an
unrelated origin.

## DNS cutover

After the upstream health checks and Caddy validation pass, replace the old
`reme.maniforld.com` Vercel CNAME with an A record for the VPS public IP. Do not
change the apex or unrelated hostnames. Wait for public DNS to resolve to the
VPS, then let Caddy obtain the certificate and run browser acceptance. If the
acceptance fails, restore the previous CNAME; do not delete the running stack or
its persistent volumes while investigating.

## Health and acceptance

```bash
docker inspect --format '{{.State.Health.Status}}' reme-frontend
docker inspect --format '{{.State.Health.Status}}' reme-backend
docker inspect --format '{{.State.Health.Status}}' reme-relay
docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' reme-history-loader
docker exec biaoshu-caddy wget -qO- http://reme-backend:8770/api/health
docker exec biaoshu-caddy wget -qO- http://reme-relay:8787/health
docker exec biaoshu-caddy wget -qO- http://reme-frontend:8080/healthz
```

The expected loader result is `exited 0`. Its logs list only published fixture
dates and revisions; they must not print the runtime token or MiMo key.

After DNS and Caddy TLS are active, verify `/home`, `/family`, and `/debug` in
the browser. Do not claim TURN transport, two-device media, physical-device
camera behavior, or FPS until each is observed in that environment.
