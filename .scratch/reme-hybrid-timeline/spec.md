# Reme Mock → realtime hybrid timeline

- Status: implemented
- Date: 2026-08-10
- Owner: Frontend
- Product timezone: Asia/Shanghai

## Decision

The public Reme timeline uses one explicit source boundary:

```text
before 2026-08-10 12:00 Asia/Shanghai  -> mock_fixture
at/after 2026-08-10 12:00 Asia/Shanghai -> realtime Backend / Relay only
```

“8 月 10 日早上” includes the `00:00–05:59`, `06:00–09:59` and
`10:00–11:59` dayparts. `12:00` is the first realtime minute.

## Product intent

- Historical Mock demonstrates the intended 7×24 product experience that the
  current team cannot reconstruct as real history.
- The realtime window demonstrates only capabilities actually emitted by the
  current Backend / Relay.
- Missing realtime data stays visibly empty. Frontend must never fill it with
  generated Mock rows or a fixed MiMo summary.
- Every mixed day exposes the cutoff and the source of its records.

## Frontend behaviour

1. August 4–9 remain full-day, explicitly labelled Mock history.
2. August 10 keeps Mock rows only before 12:00 and merges realtime events only
   at/after 12:00.
3. August 11 is a realtime-only display date and contains no fixture rows.
4. Realtime FamilyEvent-derived care records are merged into their daypart,
   not duplicated in a second historical section.
5. If Relay is connected but no realtime event exists, show “尚未收到真实记录”.
6. If Relay is interrupted, show an explicit interrupted state while retaining
   already received in-memory realtime records as stale presentation only.
7. MiMo daily-summary input may include pre-cutoff Mock facts plus post-cutoff
   realtime facts for August 10, but never a post-cutoff Mock fact.

## Backend handoff

The historical API must preserve record-level source and use the same cutoff.
After the cutoff, TimelineDayState/CareThread/DiarySummaryState may contain only
Backend/Relay-derived records. No account or login scope is introduced.

## Acceptance

- No `mock_fixture` timestamp is at or after the cutoff.
- August 10 reports 12 Mock coverage hours; August 11 reports zero.
- The date strip still shows August 4–11.
- Realtime events before the cutoff are not mixed into the historical display.
- Empty and interrupted realtime states are visible and do not claim success.
- Unit tests, lint, production build and three-route build pass.
