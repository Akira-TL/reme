# Reme frontend-only VPS migration

- Status: frontend implemented and locally accepted; production cutover pending
- Date: 2026-08-11
- Owner: Frontend
- Backend authority baseline: `origin/develop/akira@d590eaa7`

## Scope correction

This work item deploys and configures only the frontend. It does not split,
rewrite, patch, containerize, or otherwise invent Backend or Relay behavior.

The repository owner's current `backend/` and `demo-relay/` trees are the sole
authority. The working branch has been checked against
`origin/develop/akira@d590eaa7`; both trees are identical. If those services
need a different topology or public endpoint, their owner must implement and
deploy it first. Frontend then consumes the published contracts.

## Deployment fact that cannot be hidden by frontend code

The current owner Backend is one unified A perception + B decision process.
Home sends its bounded camera JPEGs to the configured perception input
WebSocket. Therefore:

- when that URL is `ws://127.0.0.1:8770/ws/camera-input`, routine JPEGs remain
  on the Home device;
- when that URL points at a VPS, routine JPEGs leave the Home device and travel
  to that VPS;
- loading the static frontend from the VPS does not itself move camera pixels;
  changing the Backend endpoint does.

Frontend cannot make a remote Backend perform local inference, and it must not
substitute browser pose inference, fall inference, alarms, or media authority.
Until the owner publishes a different Backend contract, the privacy-preserving
frontend default remains the owner's local loopback runtime.

## Frontend target

Create one immutable static frontend image that can be deployed by SSH without
Vercel. Public, non-secret endpoints are supplied at container start rather
than baked permanently into the Vite bundle, so a Backend/Relay owner can
change deployment hosts without asking Frontend to rebuild application code.

Runtime public configuration may contain only:

- perception HTTP URL;
- perception camera-input WebSocket URL;
- decision HTTP URL;
- Relay HTTP base URL;
- public MiMo model/configured display flags.

It must never contain MiMo keys, TURN shared secrets, runtime-ingest tokens,
Cloudflare credentials, cookies, or SSH credentials.

## Required frontend behavior

1. `/home`, `/family`, and `/debug` keep their existing roles and canonical
   redirects.
2. Home calls the exact owner Backend contracts. It uploads bounded JPEGs only
   to the configured perception WebSocket and draws Backend
   `frame_landmarks`; it never runs browser pose or fall inference.
3. Family obtains skeleton/FamilyEvent through the exact Relay contracts; it
   never calls a made-up Backend adapter.
4. Alarm confirmation sends only `acknowledge_alarm`; action-card confirmation
   sends only `confirm_action_card`; both wait for existing ACKs.
5. Bathroom, `hidden`, `skeleton_only`, expired/mismatched authorization, and
   WebRTC failure remain fail-closed skeleton-only.
6. Runtime configuration failure is visible and does not silently fall back to
   a permissive remote endpoint.
7. The default checked-in configuration preserves local Backend URLs and the
   same-origin Relay proxy path.

## VPS packaging

- Build with the repository-pinned Node/npm lockfile.
- Serve static files from a dedicated unprivileged web container.
- Publish no application port on the host; the existing Caddy container reaches
  it through its existing external Docker network.
- Mount a read-only `reme-config.js` generated from a documented non-secret
  example.
- Add a separate `reme.maniforld.com` Caddy host block; never replace the
  unrelated existing site block.
- Preserve the current Content Security Policy, loopback Backend access,
  camera/microphone permissions, SPA rewrites, and immutable asset caching.
- Keep Vercel as rollback until the SSH version passes real browser acceptance.

## Backend and Relay handoff inputs

The frontend deployment accepts URLs only after the owner provides them:

```text
REME_PUBLIC_PERCEPTION_HTTP_URL=<owner Backend URL>
REME_PUBLIC_PERCEPTION_INPUT_WS_URL=<owner camera-input WS URL>
REME_PUBLIC_DECISION_HTTP_URL=<owner Backend URL>
REME_PUBLIC_RELAY_URL=<owner Relay base URL>
```

For the current privacy-preserving owner topology, the first three remain
Home-loopback URLs. The Relay URL may be the existing public Relay or a future
owner-deployed VPS Relay. Frontend does not self-host or rewrite Relay in this
work item.

## Acceptance gates

### Repository

1. `git diff origin/develop/akira -- backend demo-relay` remains empty.
2. Runtime-config parser tests cover valid overrides, missing fields, unsafe
   protocols, and secret-like keys.
3. Contract typecheck, all frontend Node tests, ESLint, Vite build, and route
   build pass.
4. The production bundle contains no secret values and no browser pose/model
   assets.
5. Container build and `docker compose config` pass.

### Staged SSH deployment

1. The frontend container is healthy and reachable from the existing Caddy
   network without a new host listener.
2. Direct-IP/Host-header smoke tests load `/home`, `/family`, and `/debug` with
   no first-screen server error.
3. Existing unrelated Caddy routes remain healthy.
4. No DNS change is made until the CloudCone IPv4 migration is coordinated.

### Final browser acceptance after DNS/TLS

1. A trusted HTTPS certificate serves the three routes.
2. Home's actual network log proves the selected Backend destination. If it is
   loopback, routine frames stay local; if the owner supplies a VPS URL, report
   that frames leave Home rather than claiming otherwise.
3. Family consumes owner Relay state/pose and clears disconnect, old-session,
   and expired frames.
4. Confirmations and all privacy fail-closed cases retain existing semantics.
5. Measure FPS, TURN transport, and two-device media on the actual devices;
   never infer them from a static deploy.

## Cutover and rollback

- The provider-required CloudCone IP migration affects unrelated services and
  needs a separately coordinated approval.
- After the new IP is stable, point `reme.maniforld.com` to Caddy and verify TLS
  before removing the Vercel alias.
- Restore the previous DNS record to roll back frontend hosting.
- Do not delete Vercel or Cloudflare resources as part of this frontend-only
  change; Backend/Relay owners decide their own cutover and rollback.

## Non-claims

- This frontend work does not complete Backend or Relay VPS migration.
- It does not solve a remote unified Backend's raw-frame privacy consequence.
- It does not prove real device FPS, cross-network media, TURN/TCP/TLS, or
  production identity/delivery.
