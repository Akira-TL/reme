# Main README refresh plan

Date: 2026-08-02

## Goal

Prepare the local `main` branch for the Xiaomi hackathon GitLab repository with a polished,
evidence-bounded README, while leaving the concurrently edited `lbx` worktree untouched.

## Baseline and safety boundary

- Work only in `/Users/maniforld/.codex/worktrees/c522/reme` on local `main@aeef9599`.
- Do not merge, rebase, reset, stash, clean, or check out files in
  `/Users/maniforld/Documents/reme`, where `lbx` is actively changing.
- Do not copy uncommitted `lbx` content into `main`.
- Use an explicit GitLab URL and `main:refs/heads/main` refspec; never use bare `git push`.
- Read the remote branch before push. Stop on divergence rather than overwriting it.

## Deliverables

1. Rewrite the root README around the implemented ABC demo rather than the obsolete
   feasibility-only narrative.
2. Add a local Reme hero asset and a person-free privacy-mode runtime screenshot.
3. Correct stale quick-start statements that reference a missing root launcher or removed
   browser TTS fallback.
4. Keep all claims within `CONTEXT.md` and accepted ADR boundaries: prototype, not a medical
   device; local decoding does not mean pixel-free processing; selected visual context may be
   sent explicitly; MiMo cannot cancel deterministic escalation.
5. Report pre-existing main health gaps instead of displaying false passing/coverage badges.

## Validation

- Render and inspect the hero and runtime screenshot.
- Check README local links and image targets.
- Run Python `ruff`, `mypy`, and `pytest`; distinguish pre-existing failures from changes made
  here.
- Run frontend tests, lint, and production build.
- Review the final diff from a fresh context.
- Commit only the explicit deliverable files, then verify `lbx` HEAD/status remains outside the
  commit.
