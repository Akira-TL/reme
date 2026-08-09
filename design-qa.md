# Reme 主动关怀时间线 Design QA

## Comparison target

- Structural source: `.scratch/lbx-care-assessments/evidence/source-family-timeline-reference.png`
  - Pixels: `604×800`, cropped from `(0,100)` to `(604,900)` in the user-provided `1440×903` screenshot so unrelated browser chrome and chat content do not enter the repository.
  - Intended use: the left-side week selector, vertical chronology, expandable event rows, and warm neutral hierarchy. The source is a desktop split view; its chat panel is not part of this implementation target.
- Browser-rendered implementation: `.scratch/lbx-care-assessments/evidence/reme-aug11-desktop-1440x894.png`
  - CSS viewport and capture pixels: `1440×894`; `devicePixelRatio=1`.
  - State: family surface, `reme` selected, 2026-08-11 selected, two collapsed Mock assessments, Relay unavailable.
- Full comparison input: `.scratch/lbx-care-assessments/evidence/reference-vs-reme-desktop.png`
  - Pixels: `2125×894`.
  - Source timeline crop normalized to `675×894` on the left; implementation at native `1440×894` on the right, separated by 10px. Both are compared at the same visible height.
- Mobile implementation: `.scratch/lbx-care-assessments/evidence/reme-aug11-mobile-390x844.png`
  - CSS viewport and capture pixels: `390×844`; `devicePixelRatio=1`.
- Merged home implementation: `.scratch/lbx-care-assessments/evidence/home-mobile-390x844.png`.

The result intentionally adapts the source rather than cloning the whole screenshot: Reme is an independent application surface with a persistent bottom navigation, while the source’s right-hand chat panel is outside the requested scope.

## Browser evidence

Primary interactions tested in the in-app browser:

- switched among `家 / reme / 设置` and confirmed the destination content and selected state;
- confirmed `家` contains both the live home state and the former dashboard sections (`本次同步摘要`, `当前能力`, `连接与失败可见性`), with no separate `看板` action;
- navigated from the 8 月 11 日 week to the prior week, selected 8 月 4 日, and confirmed two explicitly labeled Mock assessments;
- expanded a Mock card and confirmed source, uncertainty, data provenance, room context, and the no-diagnosis/no-raw-media disclosure;
- checked `390×844` and `1440×894`; both reported `scrollWidth === clientWidth`;
- checked console output after the navigation fix; only Vite connection and React DevTools informational messages remained, with no warning or error.

## Full-view comparison

The implementation keeps the source’s useful structural cues: date navigation leads the page, the selected day uses the warm orange accent, entries follow a thin vertical rail, and each entry exposes time, classification, summary, and details. It deliberately replaces the source’s long diary paragraph with concise, actionable cards: verdict, basis, uncertainty, suggested action, and progress. The persistent heart action is now labeled `reme`, making the timeline a peer destination rather than an embedded dashboard section.

The mobile capture serves as the focused-region comparison because it keeps the week control, card typography, Mock provenance, and bottom-navigation labels legible at their actual target size. No further crop is needed.

## Findings and comparison history

### Iteration 1

- [P1] Bottom navigation rendered but did not change pages.
  - Location: `frontend/src/shared-demo/ViewerApp.jsx`, family/demo children of `BottomNavigation`.
  - Evidence: clicking `reme` or `设置` left the `家` content visible; MUI logged that `BottomNavigation` does not accept a Fragment child, and all labels had `opacity: 0`.
  - Impact: the core Reme destination was inaccessible and its requested label was not visible.
  - Fix: supplied keyed `BottomNavigationAction` arrays as direct MUI children for both family and demo surfaces.
  - Post-fix evidence: all three labels have `opacity: 1`; clicking each action updates the heading and selected state; the console has no MUI warnings. The final mobile and desktop screenshots were captured after this fix.

### Final pass

No actionable P0/P1/P2 findings remain.

- Fonts and typography: the existing Apple/PingFang system stack preserves the source’s calm sans-serif character. Headings, card verdicts, metadata, and labels remain readable at 390px without truncation.
- Spacing and layout rhythm: the date strip, intro, Mock disclosure, and event list have consistent 14–20px gaps and warm rounded surfaces. The fixed bottom bar retains content allowance and does not create horizontal overflow.
- Colors and visual tokens: warm white, restrained orange, pale green, and pale violet carry the source’s low-alarm character while keeping selected, mock, normal, and unavailable states distinct. No new gradient is used.
- Image quality and asset fidelity: the target requires no content photography. Visible UI icons use the project’s MUI rounded-icon family; there are no placeholders, handcrafted SVGs, emoji substitutes, or CSS-drawn assets.
- Copy and content: the page consistently says `reme · remember me`, labels the fixtures as `Mock` and `非真实家庭历史`, avoids medical certainty, and distinguishes verdict, basis, suggestion, and progress.
- Accessibility and interaction: bottom navigation, dates, arrows, and expandable entries are semantic controls with visible labels, selected/pressed/disabled states, and practical tap targets.
- Responsiveness: no horizontal overflow at either tested viewport. The desktop shell is intentionally narrower than the source’s two-pane layout because only the independent Reme surface is in scope.

## Follow-up polish

- [P3] If a later persistent-history service introduces long summaries, clamp the collapsed verdict to three lines and keep the complete text in the expanded detail region.

final result: passed
