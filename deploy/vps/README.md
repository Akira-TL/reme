# Reme frontend-only SSH deployment

This package moves the static frontend off Vercel. It deliberately does not
implement or modify Backend/Relay. Deploy those exact components only from the
repository owner's authority branch, then place their public URLs in
`reme-config.js`.

## Authority check

From the repository root, this command must stay empty before a frontend-only
release:

```bash
git diff --name-status origin/develop/akira -- backend demo-relay
```

The accepted baseline for this work item is
`origin/develop/akira@d590eaa73dcc06ab050789d68413d535e7d92615`.

## Endpoint consequence

The owner's current Backend is a unified A+B process. Setting the perception
or camera-input URL to a VPS makes Home camera JPEGs travel to that VPS. To keep
routine frames on Home, retain the loopback values shown in
`reme-config.example.js`. Frontend cannot change this Backend placement fact.

## Prepare the VPS

The host needs Docker Compose and an existing reverse-proxy network. On the
current CloudCone host that network is `zhixia-biaoshu_frontend`.

Create a non-secret runtime config outside the checkout:

```bash
sudo install -d -m 0755 /etc/reme
sudo install -m 0644 deploy/vps/reme-config.example.js /etc/reme/frontend-config.js
sudoedit /etc/reme/frontend-config.js
```

Only the six documented public fields are accepted. Token, secret, key,
credential, cookie, or password fields make the frontend fail configuration
validation.

## Build and start

Run from the repository root:

```bash
REME_FRONTEND_CONFIG_FILE=/etc/reme/frontend-config.js \
  docker compose -f deploy/vps/compose.frontend.yaml config

REME_FRONTEND_CONFIG_FILE=/etc/reme/frontend-config.js \
  docker compose -f deploy/vps/compose.frontend.yaml up -d --build
```

The Compose project publishes no host port. Caddy reaches
`reme-frontend:8080` on the external network.

## Add Caddy without replacing existing sites

Review `Caddyfile.frontend`, append that one site block to the existing
Caddyfile, then validate before reloading:

```bash
docker exec biaoshu-caddy caddy validate --config /etc/caddy/Caddyfile
docker exec biaoshu-caddy caddy reload --config /etc/caddy/Caddyfile
```

If an owner-provided Backend or Relay uses another public origin, update both
`/etc/reme/frontend-config.js` and the Caddy `connect-src` allowlist. Do not use
`*`.

## Staged checks

```bash
docker inspect --format '{{.State.Health.Status}}' reme-frontend
docker exec reme-frontend wget -qO- http://127.0.0.1:8080/healthz
docker exec reme-frontend wget -qO- http://127.0.0.1:8080/home
docker exec reme-frontend wget -qO- http://127.0.0.1:8080/family
docker exec reme-frontend wget -qO- http://127.0.0.1:8080/debug
```

Also recheck unrelated public sites and confirm `ss -lntup` has no new Reme
listener.

## DNS and rollback

The CloudCone provider requires a coordinated IPv4 migration before
2026-09-01. Do not point the domain to the old IP immediately before that
cutover. Once the new IP and unrelated services are stable, update
`reme.maniforld.com`, wait for Caddy TLS, and run real Home/Family browser
acceptance.

Keep the Vercel deployment as rollback. Restoring the old DNS record returns
frontend hosting to Vercel; it does not roll back Backend/Relay, which remain
their owners' responsibility.
