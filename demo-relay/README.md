# Reme shared live demo relay

This isolated Cloudflare Worker provides the single-room data plane for the demo:

- `GET /api/status`
- `POST /api/unlock` with `{ "key": "..." }`
- `POST /api/release` with `Authorization: Bearer <token>`
- `WS /ws/viewer` with subprotocol `reme-viewer-v1`
- `WS /ws/controller` with subprotocols `reme-controller-v1` and
  `reme-token-<token>`

The controller token is never placed in a URL. The only accepted published data is
the strict `movenet-17/v1-demo` frame contract: source dimensions, detection and
quality state, plus exactly 17 normalized MoveNet keypoints. `source_width` and
`source_height` must be safe integers from 1 through 16384. `person_detected=false`
requires `landmark_quality=unavailable`; a detected person must use `usable` or
`degraded`. Viewer sockets are read-only, and binary/media payloads are rejected.
The Durable Object stores only the active lease in SQLite; its latest frame lives
on the active controller's hibernation attachment and disappears with that socket.
Late viewers receive that snapshot only while both the lease and the 2.5-second
frame freshness window remain valid. Unlock attempts are limited per Cloudflare
client address in a one-minute in-memory window; the control key must still be
high entropy because Origin checking is not authentication for non-browser clients.

## Local verification

```sh
npm install
npm run types
npm test
npm run check
CONTROL_KEY_SHA256=<64-character-test-digest> npm run dry-run
```

For local `wrangler dev`, place `CONTROL_KEY_SHA256` in an ignored `.dev.vars` file.
The value is the lowercase SHA-256 hex digest of the human-entered control key.

## Deployment inputs

Before a real deployment, set the production digest as a Worker secret:

```sh
npx wrangler secret put CONTROL_KEY_SHA256
```

`ALLOWED_ORIGINS` is a controlled, comma-separated exact-match list. Successful
responses echo the matched request origin and include `Vary: Origin`; wildcard
origins are not used. Production accepts `https://reme.maniforld.com`,
`https://monitor.reme.maniforld.com`, and `https://reme-sage.vercel.app`, and binds the Worker custom domain
`relay.reme.maniforld.com`. The isolated `staging` environment uses a `workers.dev`
hostname and accepts `http://127.0.0.1:4174`, `http://127.0.0.1:4187`, and
`https://reme-sage.vercel.app`.
