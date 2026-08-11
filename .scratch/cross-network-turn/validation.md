# Cross-network TURN validation

Date: 2026-08-11
Status: PASS for TURN/UDP relay-candidate gathering; TURN/TCP candidate unverified

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
| Pre-fix 90-second metadata-only `tcpdump` on port 3478 during Browser retry | FAIL at edge | 0 packets captured before the managed-firewall rules were added. |
| Pre-fix temporary Cloudflare Worker `connect()` from the edge | FAIL at edge | Port 22 connected in 68 ms while 3478 and the other sampled non-web ports timed out. The fixed-target probe Worker was deleted afterward. |
| CloudCone managed firewall | PASS | Applied exact ACCEPT rules on interface #0 for 3478/TCP, 3478/UDP, and 49160:49200/UDP from 0.0.0.0/0; the console returned `Firewall rules applied successfully`. Existing 22/80/443 rules were not changed. |
| Public TCP connection to 3478 after apply | PASS | `curl --connect-timeout 5 --max-time 7 -v telnet://74.48.114.52:3478` established TCP before timing out waiting for application bytes, as expected for a raw TURN listener without a request. |
| Post-fix metadata-only `tcpdump` during Browser probe | PASS for UDP | 14 packets captured, 15 seen by the filter, 0 kernel drops; bidirectional UDP request/response traffic was observed between the Browser public address and `74.48.114.52:3478`. No TCP TURN exchange was observed. |

The CloudCone console documentation identifies its managed Cloud Firewall as the
place to add/apply public-interface TCP/UDP rules. After the user authenticated,
the three required rules were added and applied through the console. No
CloudCone API credential was created or stored.

The same console displayed a provider-required IPv4 migration before 2026-09-01:
new IPv4 `148.135.34.65`, gateway `148.135.34.1`, netmask `255.255.255.128`.
Neither automatic nor manual migration was started because clicking the provider
action begins a 72-hour old-address retirement window. TURN currently remains on
`74.48.114.52`; migration needs a coordinated coturn listener, firewall, Relay
binding, deployment, and Browser revalidation.

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
- TURN UDP probe, first post-firewall run: `relay candidate × 1 · complete`.
- TURN UDP probe, second consecutive run: `relay candidate × 1 · complete`.
- The raw Debug result recorded candidate type `relay`, candidate protocol
  `udp`, gathering state `complete`, and URL
  `turn:74.48.114.52:3478?transport=udp`; no credentials were exposed.
- TURN TCP probe on both runs: `无 relay candidate · complete`.
- A simultaneous server capture observed 14 bidirectional UDP packets on port
  3478 with 0 kernel drops. It observed no TCP TURN exchange.

Therefore Browser relay-candidate acceptance is **passed for TURN/UDP**. The TCP
listener and public TCP connection both pass, but a TURN/TCP relay candidate was
not observed and is not claimed. Candidate gathering does not prove two-peer
media or event-authorized clear video; those remain separate unmeasured gates.

## Cleanup and unmeasured claims

- The temporary Cloudflare TCP-probe Worker was deleted.
- Local and server-side temporary secret/config/script copies were deleted.
  Persistent secret material remains only in coturn's protected configuration,
  the Worker secret store, and the protected Backend environment file.
- No Playwright test suite or Playwright browser install was used in this batch.
- TURN/TCP relay-candidate gathering, TURN/TLS on 443, HTTPS-only networks,
  two-peer media flow, a physical mobile device, camera FPS, background FPS,
  source switching, relay-range media traffic, TURN bandwidth, and device
  capability are not claimed as passed.
