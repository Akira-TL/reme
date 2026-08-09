# Backend → Relay authority validation

Date: 2026-08-09
Result: Passed

## Frontend

- `npm test -- --test-reporter=dot`: 184 tests passed.
- `npm run lint`: passed.
- `npm run build`: production Vite build passed.

The tests cover exact FamilyEvent/RTC parsing, fixed-empty browser care state,
monotonic family revisions, backend Authorization matching, fail-closed media,
direct family timeline rendering and removal of the anonymous elder quote.

## Relay Worker

- `npm test -- --run`: 27 Durable Object/Worker tests passed.
- `npm run check`: generated binding check and TypeScript typecheck passed.
- `npm run dry-run`: Wrangler bundle dry-run passed.

The Worker integration suite required local `127.0.0.1` binding, so it was run
outside the restricted network sandbox. No deployment was performed. Wrangler
could not write its optional debug log inside the restricted macOS preferences
directory during the non-network checks; the commands themselves exited zero.

## Backend

- 122 targeted tests passed across family authority, launcher, deadlines,
  records, state machine and policy.
- Ruff passed for every changed Python source/test file.
- strict Mypy passed for the new family transport and launcher integration.

The targeted backend run includes the server-owned timeout flow, separate
family acknowledgements, kitchen/fall Authorization limits, runtime revision
reset, latest-wins Relay retry/rebind and local launcher secret wiring.

## Repository-wide constraints

The repository-wide test suite also includes hardware/model integration cases
that require ignored trained-model artifacts. Those artifacts are not part of
this change; the deterministic boundary suites above are the acceptance gate
for this implementation.
