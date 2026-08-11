# Cross-network TURN validation

Date: 2026-08-11
Status: BLOCKED — CloudCone managed firewall drops the TURN and relay ports

This file records only commands and browser observations actually completed in
this deployment batch. Secret values are intentionally omitted. A configured
service or a passing same-host test is not relabeled as cross-network success.

## Provider decision

- Cloudflare managed TURN was checked first. The existing Wrangler OAuth session
  can deploy Workers, but the TURN Keys API returned error `10001` (`Unable to
  authenticate request`). Creating a differently scoped token would require an
  account interaction, so the no-user-interaction fallback was used.
- coturn was installed on the existing `manifold_cloudcone` SSH server. Existing
  Docker services on 80/443 were left unchanged.
- No card, paid plan, DNS change, or Backend/Relay authority-contract change was
  made.

## Server deployment

Environment:

- Ubuntu 22.04 server at public IPv4 `74.48.114.52`;
- coturn `4.5.2` (`dan Eider`);
- listener `3478/udp` and `3478/tcp` on the public IPv4 only;
- relay allocation range `49160-49200`;
- coturn REST shared-secret authentication, 600-second browser credentials;
- TLS, DTLS, CLI, anonymous users, multicast peers, and private peer ranges are
  disabled or denied as appropriate for this demo.

Actual results:

| Check | Result | Evidence |
| --- | --- | --- |
| Package install and final `systemctl enable --now coturn` | PASS | Final service is active and enabled. The package's initial default anonymous service was detected and stopped before the secured config was started. |
| `ss -lntup` | PASS | coturn listens on public IPv4 port 3478 for UDP and TCP; it does not bind 80/443. |
| `turnutils_uclient` REST credential over UDP | PASS, same host | 12/12 messages, 0 lost. |
| `turnutils_uclient -t` REST credential over TCP | PASS, same host | 12/12 messages, 0 lost. |
| `iptables -S INPUT`, `nft list ruleset`, `ufw status verbose` | PASS as diagnosis | VM INPUT policy is ACCEPT and UFW is inactive; Docker forwarding rules do not govern the host-bound coturn listener. |
| 90-second metadata-only `tcpdump` on port 3478 during Browser retry | FAIL at edge | 0 packets captured; the request never reached the VM. |
| Temporary Cloudflare Worker `connect()` from the edge | FAIL at edge | Port 22 connected in 68 ms. Ports 3456, 3478, 5349, 8080, 8088, 8443, and 9000 timed out. The fixed-target probe Worker was deleted afterward. |

The CloudCone console documentation identifies its managed Cloud Firewall as the
place to add/apply public-interface TCP/UDP rules. The Codex in-app Browser
reached only the CloudCone login screen; it had no authenticated session. No API
credential exists in the local or server configuration. Consequently the agent
could not safely add the rules without user login.

Required CloudCone rules:

1. ACCEPT source any, destination `3478`, protocol TCP;
2. ACCEPT source any, destination `3478`, protocol UDP;
3. ACCEPT source any, destination `49160:49200`, protocol UDP;
4. apply the rules to the server's public network interface.

## Relay deployment

- Public endpoint: `https://relay.reme.maniforld.com`.
- Worker: `reme-public-demo-relay`.
- Deployed Worker version: `fb0e6a41-b95d-428d-9e6d-022781c2d219`.
- Worker secrets were set for the coturn HMAC key and Backend runtime-ingest
  token. Values were never printed or committed.
- Production non-secret bindings contain the exact STUN/TURN URLs and 600-second
  TTL.

Actual production checks:

| Request/check | Result |
| --- | --- |
| `GET /health` | 200 |
| `GET /api/status` | 200 |
| `GET /api/rtc-config` | 200; exact `{iceServers, mode, credential_expires_at_ms}`; `mode=turn_configured`; STUN plus TURN UDP/TCP; approximately 601 seconds remaining |
| Shared-secret exposure scan | PASS; the long-lived HMAC key is absent |
| Runtime ingest with wrong token | 401 |
| Runtime ingest with correct token and invalid `{}` body | 422, proving authentication without mutating FamilyEvent state |
| Relay tests | PASS, 28/28 |
| `npm run check` | PASS |
| `npm run dry-run` | PASS |

Relay JSON remains signalling/state-only. Existing tests continue to reject
JPEG, Blob, data URL, base64, audio/video bytes, and binary frames.

## Frontend deployment and gates

- Public frontend: `https://reme.maniforld.com`.
- Final production deployment in this batch:
  `dpl_5Cn8SnJdk1jPbgscr9jEgZZcrz58`.
- The first prebuilt upload omitted the already-existing production
  `VITE_REME_RELAY_URL` because the local Vercel environment snapshot was stale;
  the Browser truthfully showed `RTC 配置不可用（404）`. `vercel pull
  --environment=production` restored the exact Relay base, and the corrected
  prebuilt deployment replaced it.
- Vercel CLI 58.9.0 failed behind the local proxy under Node 26.5.0. The same CLI
  authenticated and deployed successfully under the bundled Node 24.14.0. This
  was a local CLI compatibility issue, not an account permission failure.

Final frontend commands after the TURN probe addition:

| Command | Result |
| --- | --- |
| `npm run typecheck:contracts` | PASS |
| `npm test` | PASS, 221/221 |
| `npm run lint` | PASS |
| `npm run build` | PASS; Vite 8.2.0, 1053 modules transformed |
| `npm run test:route-build` | PASS, 5/5 after allowing its local `127.0.0.1` preview listener; the sandbox-only attempt failed with `listen EPERM` |
| `vercel build --prod` | PASS with the synchronized production environment |
| `vercel deploy --prebuilt --prod --yes` | PASS under Node 24.14.0 |

The Debug-only relay probe is manual, or opt-in through
`/debug?debug=1&turnProbe=1`. It creates an empty data channel with
`iceTransportPolicy=relay`, uses one peer per configured TURN transport, records
only candidate type/protocol/completion, and always closes the peer. It requests
no camera/microphone, sends no media, and never returns or persists credentials.
Its deterministic tests pass 3/3.

## In-app Browser observations

Browser: Codex in-app Browser. The earlier engineering run reported Chrome
`151.0.0.0`; the browser control surface did not expose a more specific build in
this deployment pass.

- `/home`: rendered the home role with a non-white first screen.
- `/family`: rendered the Family role and skeleton/offline fallback.
- `/debug`: rendered the engineering role and required counters.
- Corrected production RTC configuration: `turn_configured`.
- TURN UDP probe: `无 relay candidate · timeout · ice_gathering_timeout`.
- TURN TCP probe: `无 relay candidate · complete`.
- Server packet capture during a manual retry: no port-3478 packets arrived.

Therefore browser relay-candidate acceptance is **not passed**. The UI fails
closed to skeleton as designed, but cross-network clear video is unavailable
until the CloudCone firewall rules are applied and the same Browser probe is
rerun.

## Cleanup and unmeasured claims

- The temporary Cloudflare TCP-probe Worker was deleted.
- Local and server-side temporary secret/config/script copies were deleted.
  Persistent secret material remains only in coturn's protected configuration,
  the Worker secret store, and the protected Backend environment file.
- No Playwright test suite or Playwright browser install was used in this batch.
- TURN/TLS on 443, HTTPS-only networks, two-peer media flow, a physical mobile
  device, camera FPS, background FPS, source switching, TURN bandwidth, and
  device capability are not claimed as passed.
