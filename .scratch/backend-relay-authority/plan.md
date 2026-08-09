# Backend → Relay authority implementation plan

Status: Completed
Date: 2026-08-09

1. [x] Freeze the exact FamilyEvent, media Authorization and RTC config contracts.
2. [x] Add a backend FamilyEvent authority and non-blocking authenticated Relay
   publisher; integrate it with decision publication and runtime lifecycle.
3. [x] Persist/replay FamilyEvent in the Durable Object and enforce it as the sole
   authority for Relay MediaGrant creation.
4. [x] Add the short-lived Cloudflare TURN/STUN configuration endpoint and consume
   it from both WebRTC peers.
5. [x] Stop Home from publishing care decisions and make Family render the direct
   FamilyEvent.
6. [x] Update interface docs, run the complete verification matrix and commit the
   isolated branch.
