import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveFallDanger,
  mapCareDecisionToPhase,
  shouldAutoOpenFamilyVideo,
  shouldShowEmergencySheet,
} from "./phoneState.js";

test("CareDecision delivery maps to presentation phase only", () => {
  assert.equal(mapCareDecisionToPhase({ state: "check_in_required", family_delivery: "none" }), "checking");
  assert.equal(mapCareDecisionToPhase({ state: "consent_required", family_delivery: "none" }), "checking");
  assert.equal(mapCareDecisionToPhase({
    state: "family_notification_required",
    family_delivery: "notification",
  }), "attention");
  assert.equal(mapCareDecisionToPhase({
    state: "urgent_attention",
    family_delivery: "alarm",
  }), "emergency");
  assert.equal(mapCareDecisionToPhase({ state: "resolved", family_delivery: "none" }), "resolved");
  assert.equal(mapCareDecisionToPhase({ state: "observe", family_delivery: "none" }), "idle");
  assert.equal(isActiveFallDanger("candidate"), true);
});

test("alarm sheet and fall video depend on the current alarm, not phase", () => {
  const statusOnly = {
    state: "family_notification_required",
    family_delivery: "notification",
    alarm: null,
  };
  const alarmDecision = {
    state: "urgent_attention",
    family_delivery: "alarm",
    alarm: { channels: ["flash"], trigger: "visual_confirm" },
  };
  assert.equal(shouldShowEmergencySheet(statusOnly), false);
  assert.equal(shouldShowEmergencySheet(alarmDecision), true);
  assert.equal(shouldAutoOpenFamilyVideo("fall", alarmDecision), true);
  assert.equal(shouldAutoOpenFamilyVideo("living", alarmDecision), false);
  assert.equal(shouldAutoOpenFamilyVideo("fall", statusOnly), false);
});
