const ACTIVE_DANGER_PHASES = new Set(["candidate", "checking", "emergency"]);

export function isActiveFallDanger(phase) {
  return ACTIVE_DANGER_PHASES.has(phase);
}

export function shouldShowEmergencySheet(phase) {
  return phase === "emergency";
}

export function shouldAutoOpenFamilyVideo(sceneId, phase) {
  return sceneId === "fall" && phase === "emergency";
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
