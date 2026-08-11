# 家属端独立时间线 Design QA

## Comparison target

- User structural source: `/Users/maniforld/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/wxid_ty0kx0lu71hs22_3795/temp/RWTemp/2026-08/9e20f478899dc29eb19741386f9343c8/c5c8e825f8fbe2485e39a5a23a0a8ef8.jpg`
  - Original pixels: `1440×903`.
  - Compared region: left timeline panel, crop `604×800` at `(0,100)`, normalized to `638×844`.
- Existing mobile visual-system source: `/Users/maniforld/.codex/worktrees/5807/reme/frontend/src/assets/reference/home-normal.png`
  - Original pixels: `852×1846`.
  - Normalized to `390×844` with aspect-preserving scale/pad.
- Browser-rendered implementation: `/Users/maniforld/.codex/worktrees/5807/reme/.scratch/lbx-timeline/evidence/viewer-timeline-final-390x844.png`
  - CSS viewport: `390×844`.
  - Capture pixels: `390×844`; the in-app browser reported `devicePixelRatio=2`, while its capture API normalized output to CSS pixels.
  - State: isolated local Relay connected, Monitor publishing, five current-room structured events, today selected, entries collapsed.
- Full comparison input: `/Users/maniforld/.codex/worktrees/5807/reme/.scratch/lbx-timeline/evidence/timeline-comparison.png`
  - Pixels: `1418×844`.
  - Left to right: user structural source, existing mobile reference, implementation.

The user source is a desktop split screen rather than the same mobile viewport. The comparison therefore treats its day strip, vertical event rail, expandable rows, and information order as the structural target; the existing Reme mobile reference supplies typography, palette, radii, icon family, and bottom-navigation context.

## Browser evidence

- Default event list: `.scratch/lbx-timeline/evidence/viewer-timeline-final-390x844.png`.
- Expanded provenance state: `.scratch/lbx-timeline/evidence/viewer-timeline-expanded-390x844.png`.
- Past-day truthful empty state: `.scratch/lbx-timeline/evidence/viewer-timeline-past-empty-390x844.png`.
- Desktop centered-card response: `.scratch/lbx-timeline/evidence/viewer-timeline-desktop-1280x900.png`; actual page content viewport reported `1280×720`, shell `460px`, bottom navigation `440px`, and no horizontal overflow.
- Mobile layout metrics: `innerWidth=390`, `scrollWidth=390`, bottom navigation `370px`; all four actions measured `92px` wide and remained visible.
- Console: Viewer and Monitor both reported zero `error`/`warn` entries after interaction testing.

Primary interactions tested:

- switched among `首页 / 时间线 / 看板 / 设置` and confirmed the destination heading;
- selected a past day and confirmed the non-fabricated empty state;
- moved to the previous week, confirmed the next-week control became enabled, and returned to today;
- confirmed future navigation is disabled on the current week;
- expanded and collapsed an event, exposing `Relay 权威快照`, revision, and scene provenance;
- drove four real Monitor scene changes and confirmed five current-session timeline events;
- waited across keepalive updates and confirmed the event count remained stable after semantic deduplication.

## Full-view comparison

The implementation preserves the source hierarchy: date navigation first, session/context disclosure second, then a thin orange event rail with time, category, title, summary, and expandable rows. The four-item bottom navigation makes the timeline a true peer screen instead of leaving it embedded on Home. Warm white surfaces, orange selection, 16–20px radii, restrained shadows, and MUI rounded icons remain consistent with the existing mobile reference.

A separate focused crop was not required: the target timeline panel and implementation were each normalized to `844px` high in the combined comparison, and the date controls, event titles, summaries, markers, and bottom navigation remained legible at that scale. The expanded-state screenshot separately verifies the denser provenance content.

## Findings and comparison history

### Iteration 1

- [P2] Event copy was too small relative to both sources.
  - Location: `.timeline-event-time`, `.timeline-event-copy`, `.timeline-event-details`, week labels, and session note.
  - Evidence: the first browser capture used `8–11px` event text, while the mobile reference and desktop source use a visibly stronger scan hierarchy.
  - Impact: titles and summaries were harder to scan on a 390px family-device viewport.
  - Fix: raised event titles to `13px`, summaries to `10px`, time/session/details to `9–11px`, week labels to `9/15px`, and card minimum height to `82px`.
  - Post-fix evidence: `viewer-timeline-final-390x844.png` and the regenerated `timeline-comparison.png`.

- [P2] Idle care-message updates could append duplicate “back to daily observation” entries.
  - Location: `frontend/src/shared-demo/familyTimeline.js` semantic change detection.
  - Evidence: the live Relay changed explanatory copy while care remained `idle`, causing the visual list to grow across keepalives.
  - Impact: the timeline could imply multiple life events where only status wording changed.
  - Fix: care entries now require phase, consent, alarm authority, or non-idle decision identity changes; message-only idle updates are ignored and covered by a deterministic test.
  - Post-fix evidence: event count remained `1 → 1` across timed keepalive checks, then grew only after four explicit Monitor scene changes.

### Final pass

No actionable P0/P1/P2 findings remain.

- Fonts and typography: uses the existing Apple/PingFang stack with readable mobile hierarchy, stable wrapping, and no truncation in the tested content.
- Spacing and layout rhythm: 16–18px mobile gutters, clear section separation, consistent radii, and 108px bottom content allowance keep the fixed navigation from hiding the final row.
- Colors and tokens: warm white/orange treatment matches both sources; privacy, warning, danger, normal, neutral, selected, and disabled states remain semantically distinct without inventing gradients.
- Image quality and assets: this screen needs no raster imagery. All visible action/category icons come from the project’s existing MUI Icons family; there are no placeholder images, handcrafted SVGs, or CSS substitutes for source assets.
- Copy and content: the UI explicitly says history is current-session only, distinguishes an empty day from a data failure, and does not fill a real timeline with mock life events.
- Accessibility and interaction: date and event controls are semantic buttons with labels, selected state, disabled state, `aria-expanded`, visible focus outlines, practical tap targets, and reduced-motion support inherited from the viewer stylesheet.
- Responsiveness: no horizontal overflow at `390×844`; the desktop card remains centered at `460px` and retains its four-item bottom navigation.

## Follow-up polish

- [P3] If a later authenticated history service returns very long generated diary text, add an explicit “展开日记” secondary block rather than allowing the event summary itself to become a long paragraph.

final result: passed

## 2026-08-11 本机录像回看更正

### Comparison target

- User source overview: `.scratch/family-activity-rhythm/evidence/reference-aor-overview.png`.
- User source focused strip: `.scratch/family-activity-rhythm/evidence/reference-activity-strip.png`.
- Empty implementation: `.scratch/family-activity-rhythm/evidence/13-recording-empty-390x844.png`.
- Playable implementation: `.scratch/family-activity-rhythm/evidence/14-recording-player-390x844.png`.
- Viewport: `390×844`; browser reported `innerWidth=390`, `scrollWidth=390`.

The correction changes the strip's product meaning. Orange is no longer a
structured activity-summary marker. It is a real, locally stored video segment;
clicking it enters the corresponding player inside the existing `/family`
experience. The implementation keeps the source's mint recording rail, orange
segment, time ticks and direct playback relationship while using Reme's existing
warm surfaces, type and bottom navigation.

### Interaction evidence

- A native MediaRecorder WebM was written to the production IndexedDB schema.
- Reloading `/family` surfaced exactly one orange segment from that Blob.
- Clicking the segment opened a native `<video controls autoplay>` with a blob URL
  and rendered the recorded frame.
- The back button restored the same day and recording timeline.
- QA storage and the temporary seed page were removed after verification.

### Findings

- [P1 fixed] The first iteration used activity timestamps as clickable markers,
  which implied recording playback without any recording asset. The strip now
  rejects metadata-only records and only renders a segment when a playable Blob
  exists.
- [P1 bounded] Same-browser IndexedDB is not cross-device family playback. The UI
  says “本机录像” and “这台设备 · 本机浏览器”; the feasibility result explicitly
  remains no-go for a remote-playback claim.
- [P2 fixed] Removing the selection bubble left unnecessary vertical space above
  the rail. The rail now sits directly below its instruction and preserves a
  44px focus/tap target for short clips.
- [P2 fixed] Empty history previously risked looking like a disabled feature.
  The card now states that no orange segment is shown without a real video body.

No actionable P0/P1/P2 visual findings remain for the same-browser prototype.

final result: passed for same-browser recording playback; cross-device playback not claimed
