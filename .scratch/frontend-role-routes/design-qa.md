# Reme 三端前端 Design QA

- Date: 2026-08-09
- Branch: `codex/frontend-role-routes`
- Base: `origin/lbx-frontend@961361dcd3b843d8e56ae20b5bf0025b3cdfed3c`
- Result: `passed`
- Scope: local preview only; no cloud, DNS, deployment, backend, model, MiMo, Relay schema, or safety-policy mutation

## Source truth

This is a role split and responsive refinement of the existing `lbx-frontend` visual system, not a new visual language. The implementation keeps the established warm orange, off-white surfaces, rounded cards, room imagery, skeleton stage, and three-tab family navigation.

The user-directed differences are intentional:

- `/home` and `/family` are native full-viewport pages without device chrome.
- `/debug` retains the existing Akira ABC same-screen layout and simulated phone because it is an engineering surface.
- Product routes display unavailable/degraded truth instead of scripted success.

Visual sources:

- `frontend/src/assets/reference/home-normal.png`
- `.scratch/public-dual-device-demo/evidence/viewer-home-390x844.png`
- `.scratch/public-dual-device-demo/evidence/monitor-1920x1080.png`

## Comparison input

- Reference viewport: 390 × 844
- Implementation viewport: 390 × 844
- Combined evidence: `.scratch/frontend-role-routes/evidence/family-comparison-390x844.png`
- Current implementation: `.scratch/frontend-role-routes/evidence/final-family-390x844.png`

The source screenshot shows a connected state; the implementation screenshot deliberately shows the locally observed offline state because no production-like services or synthetic success state were enabled during QA. Geometry, hierarchy, spacing, palette, navigation, and responsive behavior were compared directly; status copy was assessed for truthful degradation rather than pixel equality.

## Browser matrix

Verified in the Codex in-app browser against the production build served locally:

| Surface | Viewports | Result |
| --- | --- | --- |
| `/home` | 320×568, 390×844, 430×932, 768×1024, 1440×900 | no horizontal overflow, no phone shell, primary controls ≥44 px |
| `/family` | 320×568, 390×844, 430×932, 768×1024 | no horizontal overflow, no phone shell, bottom navigation ≥44 px |
| `/debug` | 1440×900, 1920×1080 | ABC same-screen layout and simulated phone retained |

Additional browser checks:

- `/viewer.html?session=qa#family` canonicalizes to `/family?session=qa#family`.
- `/typical-demo.html?debug=1#tools` canonicalizes to `/debug?debug=1#tools`.
- Unknown paths render an explicit 404 instead of mounting Home or Debug.
- Home and Family produce no console errors or warnings in the verified offline state.
- Family explicitly discloses that the demo connection has no account verification and anyone with the link can join.
- Family DOM contains no remote-control, source-selection, scripted-fall, or Debug controls.
- Home DOM contains no phone shell or scripted/debug controls.

## Automated verification

- `npm test`: 128/128 tests passed in an isolated clone containing only this staged patch.
- `npm run lint`: passed for the complete frontend source tree and tracked configuration.
- `npm run build`: passed; Vite produced independently lazy-loaded Home, Family, and Debug route chunks.
- `npm run test:route-build`: 4/4 passed, including manifest isolation and live production-preview fallback for `/home`, `/family`, and `/debug`.
- `demo-relay npm test`: 19/19 contract tests passed.

## Findings and resolution history

| Priority | Finding | Resolution |
| --- | --- | --- |
| P0 | Family offline first render could dereference a null confirmation failure and crash. | Added a null-safe presentation helper and regression tests. |
| P1 | Home showed static “状态平稳/正在活动” copy while perception and decision services were offline. | Home now shows “尚未开始关怀” or “关怀能力暂不可用”; static scene text is not presented as a live fact. |
| P1 | Product surfaces inherited simulated-device framing and fixed phone proportions. | Home and Family now use `100dvh`, safe-area insets, full viewport width, and zero outer border/radius/shadow. |
| P1 | Family inherited presentation controls that could expose source, scene, and scripted actions. | Family hides the control drawer and keeps only current authoritative alarm acknowledgement. |
| P1 | Home retained a realistic static room image before capture started, which looked like a live feed. | Home now uses a neutral unavailable stage until a real local media source is ready. |
| P1 | Home could keep showing a stale check-in or consent prompt after the decision connection dropped. | Non-authoritative prompts now fail closed; only a latched emergency stays visible and is labeled historical. |
| P1 | A running backend could make Home look ready even when local camera permission or media startup failed. | Product availability now requires both the live A/B link and a ready local media source; the relayed runtime also degrades when capture is unavailable. |
| P1 | Danger-frame upload was silent and a successful local API acceptance could be mistaken for MiMo delivery. | Home now shows frame submission in progress, accepted, or failed for the exact decision; accepted copy says the MiMo verdict is still asynchronous. Debug keeps the request record. |
| P1 | Product copy did not disclose the real microphone request and MiMo voice path. | Home discloses permission timing and question-window recording; Family states that question audio may go to MiMo while the Family page receives no home microphone stream. |
| P2 | Public fixed-room access was described as a family-only connection. | Home and Family now state that there is no account verification and every online Viewer with the link can join. |
| P2 | Privacy copy could imply a pixel-free MiMo path. | Both product surfaces disclose that selected single frames or short clips may be sent to MiMo for event confirmation, separately from Viewer media grants. |
| P2 | Family could show a green offline label, a default “living room” fact, or “everything normal” without a reliable pose. | Offline styling is neutral; missing/stale state hides the room image and scene; active idle copy only says the care link is running and explicitly makes no safety guarantee. |
| P2 | Mobile family connection count split vertically inside the banner. | Replaced the mobile grid item with centered flex layout and no-wrap copy. |
| P2 | Active media-grant copy overflowed the 320 px Family banner. | Live-grant text wraps, and the smallest viewport uses a one-column status grid. |
| P2 | A build-only route isolation test was auto-discovered before `dist` existed. | The artifact assertion now has a non-test filename and runs only after `npm run build` through `test:route-build`. |
| P2 | Public-access disclosure was low contrast and its countdown sat in a repeatedly announced live region. | The disclosure uses darker text, while only a stable grant-start message is announced to assistive technology. |
| P2 | Generated Vercel/LiteRT assets prevented the repository lint command from representing source quality. | ESLint now ignores generated build/runtime directories; `npm run lint` passes. |

## Evidence

- `.scratch/frontend-role-routes/evidence/final-home-390x844.png`
- `.scratch/frontend-role-routes/evidence/final-home-1440x900.png`
- `.scratch/frontend-role-routes/evidence/final-family-390x844.png`
- `.scratch/frontend-role-routes/evidence/family-dashboard-390x844.png`
- `.scratch/frontend-role-routes/evidence/family-settings-390x844.png`
- `.scratch/frontend-role-routes/evidence/final-debug-1440x900.png`
- `.scratch/frontend-role-routes/evidence/final-debug-1920x1080.png`

## Non-visual acceptance still requiring physical devices

This Design QA does not claim physical iOS/Android camera permission, microphone/autoplay behavior, cross-device WebRTC/TURN, or repeated source-switch endurance. Those remain explicit manual acceptance items and are not represented as completed product capabilities.
