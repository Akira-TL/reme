# Plan

1. Add B's deadline adapter, timeout transition and deadline metadata; wire
   lifecycle cancellation and backend integration tests.
2. Restore the danger dual-channel contract while moving Home frame submission
   behind completed prompt playback.
3. Split alarm/action-card/plain-notification acknowledgements through Python,
   Monitor, Relay and Family, including the missing Family controls.
4. Add privacy presentation mapping plus Relay media-grant veto/revocation.
5. Run the full scoped validation, record results, commit, fetch/recheck and
   fast-forward push `origin/lbx-frontend`.

## Verification result

- Backend decision/danger/emergency scoped suite: passed.
- Frontend unit tests: 179 passed; ESLint, production build and four route-build
  assertions passed.
- Relay: 25 tests passed; generated bindings, TypeScript and Wrangler dry-run
  passed.
- Python Ruff and strict Mypy checks passed.
- `git diff --check` passed.
