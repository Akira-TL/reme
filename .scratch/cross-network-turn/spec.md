# Cross-network TURN deployment spec

Status: blocked on CloudCone edge-firewall access
Date: 2026-08-11
Owner: frontend integration

## Goal

Enable event-scoped WebRTC media to gather relay candidates across NAT without
changing Backend or Relay authority contracts. The browser continues to obtain
the exact provider-neutral RTC response from `GET /api/rtc-config`; routine
frames, pose streams, and RTP media never enter Relay JSON or Durable Object
storage.

## Provider decision

Cloudflare managed TURN was evaluated first. The existing Wrangler OAuth login
can deploy Workers, but a read-only request to the account TURN Keys API returned
Cloudflare error `10001` (`Unable to authenticate request`). Obtaining the
additional account permission would require user reauthorization or a new API
token. Because the user explicitly requested a path requiring no account or card
interaction, deploy coturn to the already-authorized `manifold_cloudcone` SSH
server instead.

This decision does not change `ADR-0009`: Relay still emits short-lived
credentials and remains the only browser-facing credential service.

## Deployment shape

- TURN host: existing public SSH server, addressed by its public IP because the
  current wildcard Cloudflare DNS is proxied and the active OAuth token has no
  DNS-write permission.
- Listener: TURN over UDP and TCP on port `3478`.
- Relay allocation range: UDP `49160-49200`, deliberately narrow for the demo.
- Authentication: coturn REST shared secret; no static browser username or
  password.
- Credential TTL: 600 seconds.
- Relay Worker secrets: `REME_TURN_SHARED_SECRET` and the existing
  `RUNTIME_INGEST_TOKEN`; neither is committed.
- Relay Worker non-secret bindings: production origin allowlist, STUN/TURN URLs,
  and credential TTL.

The server already uses TCP/UDP 443, so this batch does not claim TURN/TLS on
443 or success through networks that permit only HTTPS. A later DNS-only record
and trusted certificate can add `turns:` without changing the HTTP contract.

## Fail-closed requirements

- Missing or half-configured TURN bindings make `/api/rtc-config` return 503.
- The shared secret is never returned; only the HMAC-derived temporary
  credential is sent to browsers.
- Bathroom, `hidden`, `skeleton_only`, expired/mismatched media authorization,
  and failed WebRTC remain skeleton-only.
- Relay WebSocket JSON must continue rejecting raw media, Blob/base64 media, and
  binary frames.
- Stopping or switching a media source must still close tracks, workers,
  `VideoFrame`s, animation callbacks, and peer connections.

## Acceptance gates

1. coturn service is active after reboot and listens only on the intended TURN
   and relay ports.
2. A REST credential generated independently from the shared secret completes a
   coturn allocation/echo test.
3. The deployed Relay returns the exact current RTC shape with
   `mode=turn_configured`, a future expiry no more than 600 seconds away, and no
   shared secret.
4. An actual browser gathers a `relay` ICE candidate with
   `iceTransportPolicy=relay` for both configured transports where supported.
5. Relay tests, typecheck, dry-run, frontend contract tests, lint, and production
   build pass after the deployment configuration change.
6. Public `/home`, `/family`, and `/debug` load from the deployed frontend with
   no first-screen white page; hardware/FPS claims remain unmade unless measured.

## Current blocker

The SSH deployment and all application contracts are complete, but CloudCone's
managed edge firewall drops every tested non-web port before packets reach the
VM. The guest has `INPUT ACCEPT`, UFW is inactive, and a packet capture observed
no port-3478 packets during an external allocation attempt. A Cloudflare edge
TCP probe reached port 22 in 68 ms but timed out on 3456, 3478, 5349, 8080,
8088, 8443, and 9000.

Completing acceptance gate 4 requires an authenticated CloudCone console session
to add these narrowly scoped rules to the server's public network interface:

- TCP and UDP destination port `3478`, source any;
- UDP destination range `49160:49200`, source any.

No existing 22/80/443 service will be multiplexed or reconfigured as a shortcut.
That would risk unrelated workloads and still would not open the UDP relay range.
