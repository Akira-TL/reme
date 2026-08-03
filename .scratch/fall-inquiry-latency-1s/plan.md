# Fall inquiry onset: 1 second

## Baseline

- Base commit: `aeef9599ba9788094873dfc98326540d989f8275`.
- B already emits a rule-sourced fall check-in immediately after a qualifying fall/lying event.
- C currently asks MiMo TTS first and can fall back to the local `fall_check_in.m4a`.

## Change

1. Recognize the deterministic fall check-in (`check_in_required` + `confirm_safety`).
2. Start the MiMo TTS request immediately, then begin playback no earlier than 1,000 ms after the decision reaches C. A fall inquiry must never use or fall back to `voice_asset`.
3. As soon as MiMo prompt playback starts, record the real microphone for 2,000 ms and immediately send that WAV to MiMo.
4. Do not infer the prompt tail from `audio.duration` at playback start: base64 audio can report an unavailable duration then. Keep the active prompt audio reference as a session-level hard gate: clear the prior countdown at `playing`, and prevent stale/fallback timers from any older decision id from submitting while it is playing. Arm the deterministic deadline only from that prompt's actual `ended` event, with a fresh 3,000 ms grace period. A captured reply already submitted to MiMo blocks timeout submission while ASR is in flight; a safe result cancels it, while an empty/error result executes an already elapsed deadline.
5. Upload without a local noise gate; a safe reply such as “我还好” resolves the episode and plays MiMo's safety acknowledgement.
6. Keep manual replay immediate and MiMo-only on the fall path; do not restore browser `speechSynthesis`.
7. Do not change fall thresholds or the family acknowledgement timer. Keep non-fall check-ins at their existing 2,500 ms response window.

## Verification

- Unit-test the MiMo-only voice plan for fall, missing-preset, manual-replay, and non-fall decisions.
- Unit-test B's fall-only 2,000 ms response contract.
- Run frontend tests, lint, and production build.
- Restart the complete ABC stack from the new commit.
- Trigger a synthetic fall in Chrome and verify a MiMo TTS request starts immediately, no preset asset is fetched, and real microphone capture lasts 2 seconds.
