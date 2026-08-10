import { mapCareDecisionToPhase } from "../shared-demo/careDecision.js";

const ACTIVE_DANGER_PHASES = new Set(["candidate", "checking", "emergency"]);

export { mapCareDecisionToPhase };

export function isActiveFallDanger(phase) {
  return ACTIVE_DANGER_PHASES.has(phase);
}

export function shouldShowEmergencySheet(decision) {
  return Boolean(decision?.alarm);
}

export function shouldAutoOpenFamilyVideo(sceneId, decision) {
  return sceneId === "fall"
    && Boolean(decision?.alarm);
}
