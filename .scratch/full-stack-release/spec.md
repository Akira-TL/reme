# Reme full-stack demo release

- Status: approved-for-release
- Date: 2026-08-09
- Target branch: `lbx-frontend`

## Public surface

The release has one user-facing origin and three application routes:

- `https://reme.maniforld.com/home`
- `https://reme.maniforld.com/family`
- `https://reme.maniforld.com/debug`

`https://relay.reme.maniforld.com` is the Cloudflare Relay transport endpoint.
It is not a fourth user-facing page. No `monitor.*` product hostname is part of
this release contract.

## Deployment topology

- Vercel serves the Vite frontend and rewrites the three routes to
  `index.html`.
- Cloudflare Workers + SQLite Durable Object distribute structured state,
  FamilyEvent records, WebRTC signalling and short-lived RTC configuration.
- The Python perception/decision runtime stays on the Home device. Routine
  camera frames and model diagnostics are not deployed to the cloud.
- MiMo and Relay publish credentials remain server-only.

## Release gates

1. Frontend tests, lint, production build and route-build assertions pass.
2. Relay tests, type/config checks and Wrangler dry-run pass.
3. Python tests and Ruff pass; any repository-wide pre-existing type failures
   remain explicitly recorded rather than hidden.
4. Production URLs return success, all three routes load the same app shell,
   and the frontend connects only to the configured Relay origin.
5. The release preserves failure visibility for missing Home runtime, MiMo or
   TURN capability. It does not claim production identity, offline push,
   medical accuracy or cross-NAT video unless actually verified.
