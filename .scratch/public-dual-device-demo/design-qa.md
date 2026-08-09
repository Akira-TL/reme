# Reme 固定公开双端演示：Design QA

**Findings**

当前 fresh-reload 比较中没有仍可行动的 P0、P1 或 P2。上一轮设置页公开房间标签缺失已确认是旧 HMR 截图假象；最新设置页在同一视口稳定显示“固定公开演示房间 / 任何打开 Viewer 的人都可加入”。

- [P3] 次级说明文字比参考稿更小
  - Location: 公开房间副文案、时间线说明、设置项 detail、状态 pill。
  - Evidence: 实现使用较多 7–9 px 次级文字；参考稿在归一化后的 390 px 宽度上，类似层级通常约为 10–12 px。主标题、卡片标题和底部导航层级清楚，问题集中在说明文字。
  - Impact: 不破坏当前结构或主要任务，但真机上会降低扫读性，尤其是隐私说明和不可用原因。
  - Fix: 将隐私/失败说明优先提升到 10–11 px、`line-height: 1.4–1.5`；装饰性 eyebrow 可维持 9 px。调整后检查 390 px 下的换行与卡片高度。

- [P3] 设置页 chevron 暗示的可点击性不一致
  - Location: 外婆家 profile、分享授权、公开房间行。
  - Evidence: 这些行显示向右箭头，视觉语言与参考稿的详情入口一致，但当前截图/实现证据没有对应详情态；真实可操作项主要是两个 Switch 与远程控制抽屉。
  - Impact: 不阻断主流程，但可能让评委把静态行误解为详情入口。
  - Fix: 有详情就把整行改为语义 button/link 并提供 focus/pressed 状态；无详情就移除 chevron。

**Open Questions**

- `home-normal.png` 是在线、正常、带骨架的状态；最新实现是在线、正常、媒体正在启动且按授权规则隐藏原画。动态骨架和原画状态不能由静态截图精确比较，功能边界由本轮交互证据覆盖。
- `dashboard.png` 以“本周陪伴、生活片段、情绪变化”为内容目标；实现看板按本轮演示范围改为“同步摘要、当前能力、连接与失败可见性”。布局语言一致，但内容不应被解读为对原稿周报数据的复刻。
- 当前正式比较覆盖首页正常态、看板和设置页。其余四张江姐参考图可作为后续风险、紧急、浴室与厨房状态的补充覆盖，但不在本次三个目标的像素比较范围内。

**Implementation Checklist**

1. 后续将关键隐私/失败说明提升到至少 10–11 px，并检查 390 px 下的换行。
2. 为带 chevron 的设置行补真实详情交互或移除误导 affordance。
3. 真机验收时复查系统字体缩放、较长中文状态和安全区 inset，不沿用本轮 DPR 1 截图代替硬件证据。

**Follow-up Polish**

- 为“外婆家”准备独立、可授权使用的头像资源，可进一步贴近参考稿；当前使用 MUI Home 图标是避免把参考截图裁成资产的合理降级。
- 设置页比参考稿使用更高的行高和更少的首屏分组，因而需要滚动才能看到“连接”。这是功能优先的可接受偏离；若路演更强调“一屏扫完”，可将 68 px row 压缩到约 60–62 px。

## Comparison Target and Evidence

| Target | Source visual truth | Rendered implementation | State |
| --- | --- | --- | --- |
| Viewer 首页 | `frontend/src/assets/reference/home-normal.png` | `.scratch/public-dual-device-demo/evidence/viewer-home-390x844.png` | Source: online/normal; implementation: public room connected, Monitor online, LIVE/normal, media starting |
| Viewer 看板 | `frontend/src/assets/reference/dashboard.png` | `.scratch/public-dual-device-demo/evidence/viewer-dashboard-390x844.png` | Source: weekly companionship dashboard; implementation: live public-demo operational dashboard |
| Viewer 设置 | `frontend/src/assets/reference/settings.png` | `.scratch/public-dual-device-demo/evidence/viewer-settings-390x844.png` | Source: normal device settings; implementation: public-demo privacy, reminders and room status |
| Monitor | No matching Jiang reference target in this pass | `.scratch/public-dual-device-demo/evidence/monitor-1920x1080.png` | Demo running; backend ready, Relay online, 1/5 Viewer and active control state visible |

The source reference set spans 852 × 1846 and 853 × 1844 pixels. The three selected source truths (`home-normal.png`, `dashboard.png`, `settings.png`) are each 852 × 1846. Each was normalized to 390 × 844 before comparison. Viewer implementation screenshots are 390 × 844 pixels at a 390 × 844 CSS viewport and device pixel ratio 1. All three measured `overflowX = 0`. The combined comparison inputs are 780 × 844, with source on the left and implementation on the right, so each side remains a 1:1 390 × 844 image rather than a scaled thumbnail:

- `.scratch/public-dual-device-demo/evidence/home-comparison-390x844.png`
- `.scratch/public-dual-device-demo/evidence/dashboard-comparison-390x844.png`
- `.scratch/public-dual-device-demo/evidence/settings-comparison-390x844.png`

The Monitor evidence is 1920 × 1080 pixels at a 1920 × 1080 CSS viewport and DPR 1.

## Full-view Comparison Evidence

### Viewer 首页

- Composition: both views use a compact title, large rounded hero, prominent safety card, vertical timeline and persistent three-item bottom navigation. The implementation keeps 16–18 px mobile gutters and similar 17–22 px radii, so the main hierarchy reads consistently.
- Intentional additions: the fixed public-room strip consumes the space otherwise occupied by the iOS status region. The implementation intentionally does not duplicate the source screenshot's Dynamic Island, status bar or home indicator as web content.
- Intentional imagery change: the reference uses a stylized room illustration with a pose figure; the implementation uses the project's sharp living-room photograph plus a real canvas/video layer. The screenshot is not reused as a page background.
- State: the fresh capture now shows LIVE/connected, a green “一切正常” card, an active controller and current timeline facts. Original video remains hidden while the media source starts, matching the public-demo authorization boundary.
- Responsive result: no horizontal overflow, clipping or overlap is visible at 390 × 844; bottom navigation remains reachable.

### Viewer 看板

- Composition: both views use a large title, warm summary card, three highlighted metrics and a persistent bottom navigation. The implementation continues the same orange accent, soft border and rounded-surface language.
- Product-scope change: the implementation replaces the reference's weekly memory feed and trend chart with live status revision, original-video window, capability cards and connection truth. This is an intentional functional dashboard for the fixed public demo, not placeholder or invented health data.
- Responsive result: the 2 × 2 capability grid and connection list remain aligned at 390 × 844; the fixed navigation stays reachable with `overflowX = 0`.

### Viewer 设置

- Composition: the implementation preserves the warm orange accent, grouped white cards, rounded icon wells, title/detail/action rows, large profile card and fixed three-item navigation.
- Density: implementation rows are taller and include public-demo/privacy semantics, so fewer groups are above the fold than in the reference. Content remains vertically scrollable and the persistent navigation does not remove access to the page.
- Required state: high-privacy and risk-reminder switches are visible as real MUI controls; local processing and safety rules are clearly read-only.
- Required disclosure: the fresh capture continuously shows “固定公开演示房间 / 任何打开 Viewer 的人都可加入”, viewer count and current raw-video status; the earlier missing label is no longer present.
- Responsive result: no horizontal clipping is visible; the longer page remains vertically scrollable and the fixed navigation stays reachable with `overflowX = 0`.

### Monitor

- At 1920 × 1080 the top status rail, no-password start action, source selection, Relay/Viewer count, controller state, confirmation queue, four scenes, large live-stage area and phone simulation are all visible without horizontal overflow.
- The desktop composition uses the same warm neutral/orange tokens as Viewer and exposes unavailable states instead of simulating a healthy backend.
- There is no matching source image for Monitor in this pass, so this screenshot supports viewport/layout QA only, not source-fidelity claims.

## Focused-region Comparison Evidence

No additional focused crop was needed for this pass. Each of the three combined inputs is 780 × 844 and preserves both 390 × 844 sides at 1:1 pixel scale; titles, microcopy, icon alignment, switches, metric cards, status rows, card boundaries and bottom navigation were readable directly in the same comparison input. A focused crop would not add information beyond the full 1:1 comparison. The Monitor screenshot was also opened at its original 1920 × 1080 resolution.

## Mandatory Fidelity Surfaces

### Fonts and typography

- The implementation uses the native Apple/PingFang stack (`-apple-system`, `BlinkMacSystemFont`, `SF Pro Display`, `PingFang SC`, `Helvetica Neue`), which follows the reference's iOS-like Chinese typography.
- Main titles, card titles and navigation have a clear optical hierarchy with no visible truncation or broken wrapping.
- The 7–9 px secondary copy is visibly smaller than the reference and remains P3 follow-up; the privacy/failure copy should be enlarged first.

### Spacing and layout rhythm

- Mobile gutters, card radii, icon wells, group gaps and bottom navigation match the warm, rounded rhythm of the source.
- The required public-room strip and conditional failure-visibility blocks intentionally increase vertical density. Settings consequently scrolls more than the reference; no collision or inaccessible persistent control is visible.
- Monitor's desktop grid remains aligned at 1920 × 1080 and retains the major control/status regions above the fold.

### Colors and visual tokens

- The implementation's `#ff5a00` accent, warm whites, dark brown/black text, green normal state and red emergency state map coherently to the source palette.
- Offline/unavailable gray is an intentional semantic extension. Primary labels and controls have clear contrast; small muted copy should be enlarged before further lightening.

### Image quality and asset fidelity

- The living-room image is sharp, correctly cropped and integrated into the rounded stage without stretching or visible compression artifacts.
- MUI icons form one consistent family; there are no emoji, text-glyph stand-ins, fake logos or screenshot-derived UI assets.
- The reference screenshot is used only as visual truth, never as a page background. The stylized elder portrait and room illustration are not extracted from the screenshot; the current MUI/profile and project photo replacements are explicit product constraints, with a P3 opportunity for a dedicated licensed portrait asset.

### Copy and content

- Public-room, viewer count, runtime, control and raw-video boundary copy is coherent and stands alone without implying production authentication, privacy compliance, medical accuracy or unmeasured health insight.
- Dynamic copy correctly differs from the reference's hard-coded sample data. The required public-room identity and disclosure copy is continuously visible in all three fresh captures.

## Interaction, Responsive, and Accessibility Evidence

Primary browser interactions already exercised in the local demo:

- no-password Viewer entry and public-room viewer count;
- bottom navigation between Viewer pages;
- one Viewer claiming the controller lease;
- a remote scene command reaching terminal `applied` / `scene_selected` ACK;
- a display-source request stopping at `awaiting_local_confirmation`, followed by explicit Monitor-side rejection rather than optimistic success;
- Monitor revoking the active controller lease;
- switching to bathroom while original video remained unavailable;
- high-privacy and notification switches turning off and back on, with the original values restored;
- navigation across 首页、看板、设置.

The provided captures show stable mobile Viewer layout at 390 × 844, DPR 1, `overflowX = 0`, and desktop Monitor layout at 1920 × 1080. CSS includes separate mobile/desktop drawer behavior and a reduced-motion path. Important icon buttons and Switch inputs have accessible names; status/unavailable regions use status/alert semantics; primary buttons are approximately 42–48 px. The P3 microcopy-size issue remains, and chevron rows should become semantic controls if they are intended to navigate.

The final fresh QA run started at `2026-08-09T02:28:35.308Z`. After fresh reload and the interactions above, both Monitor and Viewer recorded 0 console errors and 0 console warnings.

## Comparison History

### Iteration 1 — 2026-08-08

- Evidence opened in the same comparison inputs:
  - `.scratch/public-dual-device-demo/evidence/home-comparison-390x844.png`
  - `.scratch/public-dual-device-demo/evidence/settings-comparison-390x844.png`
- P0: none.
- P1: none.
- P2: settings capture does not show the required public-room identity label.
- Diagnosis: the screenshot came from an old HMR state rather than the stable fresh-rendered UI.
- Fix made in response: full fresh reload, same-view re-capture and regeneration of the side-by-side comparison; no product CSS change was required.

### Iteration 2 — 2026-08-09

- Fresh QA start: `2026-08-09T02:28:35.308Z`.
- Post-fix visual evidence opened in the same comparison inputs:
  - `.scratch/public-dual-device-demo/evidence/home-comparison-390x844.png`
  - `.scratch/public-dual-device-demo/evidence/dashboard-comparison-390x844.png`
  - `.scratch/public-dual-device-demo/evidence/settings-comparison-390x844.png`
- The settings banner now visibly and stably includes “固定公开演示房间 / 任何打开 Viewer 的人都可加入”.
- P0: none.
- P1: none.
- P2: none remaining.
- P3: small secondary copy and static chevron affordance remain as non-blocking polish.
- All three Viewer captures: 390 × 844 CSS, DPR 1, `overflowX = 0`.
- Console: Monitor 0 errors / 0 warnings; Viewer 0 errors / 0 warnings.

## Hardware and Network Test Boundary

This visual QA result is distinct from device acceptance. Real camera permission, front/back camera switching, screen capture chooser, local file chooser, two-device WebRTC, TURN/cross-NAT behavior, late Viewer joins and the 20-source/scene-switch loop still require physical-device/manual testing. Those gaps do not by themselves block visual QA, but no claim about real hardware or production privacy follows from these screenshots.

final result: passed
