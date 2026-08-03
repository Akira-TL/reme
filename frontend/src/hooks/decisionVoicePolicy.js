export const FALL_INQUIRY_DELAY_MS = 1000;
export const FALL_POST_PROMPT_GRACE_MS = 3000;

export function isFallCheckInDecision(payload) {
  return Boolean(
    payload?.state === "check_in_required"
      && payload?.dialogue_goal === "confirm_safety",
  );
}

export function getDecisionVoicePlan(payload, { force = false } = {}) {
  const isFallCheckIn = isFallCheckInDecision(payload);

  return {
    isFallCheckIn,
    allowPresetFallback: !isFallCheckIn,
    delayMs: isFallCheckIn && !force ? FALL_INQUIRY_DELAY_MS : 0,
    listenDuringPlayback: isFallCheckIn && !force,
  };
}

export function getVoiceCaptureWindowMs(payload) {
  return Number.isFinite(payload?.response_timeout_ms)
    && payload.response_timeout_ms > 0
    ? payload.response_timeout_ms
    : 2500;
}

export function getVoiceAlarmDelayMs(payload) {
  const configuredMs = getVoiceCaptureWindowMs(payload);
  if (!isFallCheckInDecision(payload)) return configuredMs;
  return FALL_POST_PROMPT_GRACE_MS;
}
