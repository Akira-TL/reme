# Reme full-stack demo release validation

- Date: 2026-08-09
- Status: passed with declared capability limits
- Branch: `lbx-frontend`

## Intended URLs

- Home: `https://reme.maniforld.com/home`
- Family: `https://reme.maniforld.com/family`
- Debug: `https://reme.maniforld.com/debug`
- Relay health: `https://relay.reme.maniforld.com/health`

## Evidence

### Source and release targets

- Release commit: `6012da2f` (`lbx-frontend`)
- Vercel project: `lx050s-projects/reme`
- Vercel production deployment: `dpl_GMbxuqVDjcnPbrkPRLGYv6W8Z8m1`
- Vercel deployment URL: `https://reme-qizzxnlur-lx050s-projects.vercel.app`
- Cloudflare Worker: `reme-public-demo-relay`
- Cloudflare Worker version: `5b1c81f0-4c46-4e77-88ec-69fb19dde076`

### Automated release gates

- Frontend tests: 192 passed
- Frontend lint: passed
- Frontend production build: passed
- Frontend route/build assertions: 5 passed
- Frontend dependency audit: 0 vulnerabilities
- Relay tests: 27 passed
- Relay TypeScript/Wrangler check: passed
- Relay Wrangler dry run: passed (96.41 KiB, gzip 17.99 KiB)
- Python tests: 664 passed, 1 skipped
- Ruff: passed

### Production verification

- `/home`, `/family`, and `/debug` each return HTTP 200 from
  `https://reme.maniforld.com`.
- Browser navigation to `/family` resolved to the production origin with the
  expected `Reme · 家属端` title.
- `/` redirects to `/home`; legacy `/viewer.html` and
  `/typical-demo.html` redirect to `/family` and `/debug` respectively.
- The mistaken `monitor.reme.maniforld.com` Vercel alias was removed and now
  returns HTTP 404.
- Production responses include the configured CSP, Permissions-Policy,
  X-Frame-Options, and `nosniff` headers.
- Relay `/health`, `/api/status`, and `/api/rtc-config` return HTTP 200.
- Relay CORS accepts `https://reme.maniforld.com`; the removed monitor origin
  is rejected with HTTP 403.
- Required Worker secrets exist by name: `BACKEND_PUBLISH_TOKEN`,
  `TURN_KEY_ID`, and `TURN_KEY_API_TOKEN`. Values were not read or logged.

## Declared capability limits

- `/api/rtc-config` currently reports `stun_only`. Cross-NAT live video is not
  claimed until TURN credentials produce a measured `turn_ready` response.
- The Python perception and MiMo decision runtime remains a Home-device/local
  component by design; raw routine video is not deployed to Vercel or
  Cloudflare. No configured local Home runtime was present during this release,
  so the public `/home` surface is expected to expose its offline fallback until
  a Home device connects.
