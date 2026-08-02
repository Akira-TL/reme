# Reme shared live demo relay

This isolated Cloudflare Worker provides the single-room data plane for the demo:

- `GET /api/status`
- `POST /api/unlock` with `{ "key": "..." }`
- `POST /api/release` with `Authorization: Bearer <token>`
- `POST /api/activity/recognize` with the active Bearer token and exact
  `{ "image_b64": "<plain JPEG base64>" }`
- `WS /ws/viewer` with subprotocol `reme-viewer-v1`
- `WS /ws/controller` with subprotocols `reme-controller-v1` and
  `reme-token-<token>`

The controller token is never placed in a URL. The only accepted published data is
the strict `movenet-17/v1-demo` frame contract: source dimensions, detection and
quality state, plus exactly 17 normalized MoveNet keypoints. `source_width` and
`source_height` must be safe integers from 1 through 16384. `person_detected=false`
requires `landmark_quality=unavailable`; a detected person must use `usable` or
`degraded`. Viewer sockets are read-only, and binary/media payloads are rejected.
The Durable Object stores the active lease plus bounded structured event, grant,
and authoritative event/frame sequence metadata in SQLite. Only the latest frame
sequence number is persisted; the latest pose payload lives on the active
controller's hibernation attachment and disappears with that socket.
Late viewers first receive `{ "type": "viewer_ready", "viewer_id": "..." }`, then
the latest persisted non-media `reme-demo-event/v1` state in event-sequence order,
and finally a fresh pose snapshot when available. Event and frame sequence state, the latest
scene/activity/card/alarm events, grant metadata, and the grant's fixed viewer ID
audience live in Durable Object SQLite. WebSocket attachments carry the viewer ID
or controller lease/frame snapshot across hibernation. No SDP, ICE candidate,
image, audio, video frame, or Blob is written to SQLite or an attachment.

The first controller message is an authoritative resume cursor:

```json
{
  "type": "controller_ready",
  "session_id": "...",
  "lease_expires_at_ms": 0,
  "last_event_sequence": -1,
  "last_frame_sequence": -1
}
```

Each accepted event or frame must use a sequence strictly greater than its
corresponding cursor. A controller socket may reconnect with the same token and
session until the lease TTL expires; disconnecting the socket does not release
the lease, but it immediately revokes every active media grant for fail-closed
privacy.

`media_grant_request` is accepted only for a matching consented kitchen care card
or matching escalated fall alarm. The generated short-lived grant includes only
viewers connected at issuance; a late viewer never inherits it. Strict
`reme-media-signal/v1` SDP/ICE messages are then forwarded only between the
controller and those viewer IDs. Revocation, resolving the source event, leaving
its scene, releasing the lease, or losing the controller socket closes the grant;
the browser also enforces the published expiry timestamp.

Activity recognition is an independent bounded HTTP path. It accepts at most
900 KiB of JSON containing one JPEG, sends that one sample to the configured MiMo
chat-completions endpoint, and strictly returns `cooking`, `not_cooking`, or
`uncertain` with confidence, reason, model, and latency. The image never enters
the Durable Object or logs. Unlock attempts are limited per Cloudflare
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
Place `MIMO_API_KEY` there as well when exercising activity recognition.

## Deployment inputs

Before a real deployment, set the production digest as a Worker secret:

```sh
npx wrangler secret put CONTROL_KEY_SHA256
npx wrangler secret put MIMO_API_KEY
```

`MIMO_BASE_URL` and `MIMO_MODEL` are non-secret Wrangler vars and default to
`https://api.xiaomimimo.com/v1` and `mimo-v2.5`. Secret values are never written
to `wrangler.jsonc`.

`ALLOWED_ORIGINS` is a controlled, comma-separated exact-match list. Successful
responses echo the matched request origin and include `Vary: Origin`; wildcard
origins are not used. Production accepts `https://reme.maniforld.com`,
`https://monitor.reme.maniforld.com`, and `https://reme-sage.vercel.app`, and binds the Worker custom domain
`relay.reme.maniforld.com`. The isolated `staging` environment uses a `workers.dev`
hostname and accepts `http://127.0.0.1:4174`, `http://127.0.0.1:4187`, and
`https://reme-sage.vercel.app`.
