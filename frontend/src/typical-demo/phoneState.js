const ACTIVE_DANGER_PHASES = new Set(["candidate", "checking", "emergency"]);

export function isFallSafetyDecision(payload) {
  if (!payload || typeof payload !== "object") return false;
  if (payload.dialogue_goal === "confirm_safety") return true;
  if (payload.alarm) return true;
  const channels = Array.isArray(payload.confirm_channels) ? payload.confirm_channels : [];
  return channels.includes("frame") && channels.includes("voice");
}

export function isActiveFallDanger(phase) {
  return ACTIVE_DANGER_PHASES.has(phase);
}

export function shouldShowEmergencySheet(phase) {
  return phase === "emergency";
}

export function shouldAutoOpenFamilyVideo(sceneId, phase) {
  return sceneId !== "bathroom" && phase === "emergency";
}

export function shouldCloseFamilyVideo(phase) {
  return phase === "resolved" || phase === "idle";
}

export function shouldStopAlarmForDecision(payload) {
  return payload?.state === "resolved";
}

export function shouldStopAlarmForResponse(response) {
  return response === "safe" || response === "card_confirmed";
}
