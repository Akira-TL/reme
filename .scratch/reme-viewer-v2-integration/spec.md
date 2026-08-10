# Reme Viewer v2 frontend contract integration

- Status: implemented and verified
- Date: 2026-08-10
- Owner: Frontend only
- Backend / Relay authority: `origin/feature/backend-cloud-demo-authority @ ab7fe54`
- Handoff: `Reme 前端接入交接：Backend - Relay 权威合同(1).md`

## Goal

Make the current Home and Family frontends consume the already implemented
Backend / Relay authority without recreating safety, consent, authorization or
TURN policy in the browser.

The target public flow is:

```text
Backend FamilyEvent
  -> Relay reme-viewer-v2 latest snapshot + updates
  -> Family presentation and acknowledgements

Backend MediaAuthorization
  -> Home direct CareDecision
  -> Relay MediaGrant
  -> grant-bound WebRTC using /api/rtc-config
```

## Scope

Frontend adapters and tests only:

1. Family connects with `Sec-WebSocket-Protocol: reme-viewer-v2`.
2. The exact `family_event` wire is accepted only when it contains:
   - `type`, `room_session_id`, `schema_version`, `runtime_session_id`,
     `revision`, `decision_timestamp_ms`, `published_at_ms`, and `care`;
   - the exact Backend family-safe `care` projection;
   - optional `elder_quote` only when Backend explicitly includes it;
   - `media_authorization` nested under `care`.
3. Family renders alarm and action-card semantics directly from
   `FamilyEvent.care`; it must not depend on the older frontend-only
   `family_delivery`, reason, source or uncertainty fields.
4. New alarm acknowledgement emits `acknowledge_alarm`; the legacy
   `confirm_alarm` name may remain accepted only for backwards-compatible
   inbound command execution. Action cards emit `confirm_action_card`.
5. Ordinary Family notifications have no invented third acknowledgement
   command.
6. Media playback requires both the active Backend `MediaAuthorization` and
   the matching Relay `MediaGrant`, with matching decision/scope/scene/runtime
   and unexpired leases.
7. `bathroom`, `privacy_mode=hidden`, and
   `privacy_mode=skeleton_only` are hard clear-video vetoes even when a grant
   exists.
8. Home consumes `privacy_mode` and nested `media_authorization` from its
   direct Backend `CareDecision` stream when requesting a Relay grant. The
   Monitor socket does not receive the v2 FamilyEvent stream; Relay performs
   the server-side match against its Backend-published FamilyEvent.
9. `/api/rtc-config` consumes the exact provider-neutral target wire:
   `{ iceServers, mode, credential_expires_at_ms }`, where mode is
   `local_network_only | stun_only | turn_configured`.
10. A reconnected v2 Viewer accepts Relay's latest FamilyEvent snapshot even
    when the snapshot revision equals the last revision seen before the
    disconnected connection. Older updates in the same active connection are
    still rejected.
11. The transport-only DemoState adapter publishes the exact target Relay v1
    shape. Its small `care` projection supports command routing and transport
    revocation only; Family never derives current business authority from it.

## Explicit non-goals

- No changes under `backend/` or `demo-relay/`.
- No browser-owned deadline, alarm escalation, consent timeout, media
  authorization, grant authority or TURN provider logic.
- No new `family_delivery`, `confirm_family_notification`, medical inference,
  raw-media JSON, prompt/debug payload or inferred elder quote.
- No Reme historical persistence contract; that remains the separate Backend
  handoff in `.scratch/frontend-public-mimo-handoff/backend-requirements.md`.

## Failure behaviour

- Unknown or extra protocol fields fail closed.
- An invalid FamilyEvent is not rendered as current authority.
- Disconnect immediately revokes local control and media transport authority.
- A retained pre-disconnect FamilyEvent may be displayed only as stale history;
  it cannot enable alarm side effects, acknowledgements or video.
- Missing/expired RTC credentials fall back to an explicit unavailable state;
  frontend code never embeds provider URLs or long-lived credentials.

## Acceptance

1. Protocol tests cover exact Viewer v2 FamilyEvent, nested
   MediaAuthorization, optional Backend quote, forbidden legacy shape and the
   exact RTC wire.
2. Reducer tests cover monotonic live revisions, disconnect fail-close and
   acceptance of Relay's latest equal-revision reconnect snapshot.
3. Media tests cover Authorization + MediaGrant binding and all three hard
   privacy vetoes.
4. Command tests cover `acknowledge_alarm`, `confirm_action_card`, legacy
   inbound compatibility and rejection of the removed notification command.
5. Home command execution and surface policy accept the new acknowledgement.
6. Frontend unit tests, ESLint, Vite build and route-build all pass.
