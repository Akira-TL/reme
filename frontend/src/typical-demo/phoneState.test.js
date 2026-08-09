import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveFallDanger,
  mapDecisionStateToPhase,
  shouldAutoOpenFamilyVideo,
  shouldShowEmergencySheet,
} from "./phoneState.js";

test("CareDecision state maps to presentation phase only", () => {
  assert.equal(mapDecisionStateToPhase("check_in_required"), "checking");
  assert.equal(mapDecisionStateToPhase("consent_required"), "checking");
  assert.equal(mapDecisionStateToPhase("family_notification_required"), "emergency");
  assert.equal(mapDecisionStateToPhase("urgent_attention"), "emergency");
  assert.equal(mapDecisionStateToPhase("resolved"), "resolved");
  assert.equal(mapDecisionStateToPhase("observe"), "idle");
  assert.equal(isActiveFallDanger("candidate"), true);
});

test("alarm sheet and fall video depend on the current alarm, not phase", () => {
  const statusOnly = { state: "family_notification_required", alarm: null };
  const alarmDecision = {
    state: "urgent_attention",
    alarm: { channels: ["flash"], trigger: "visual_confirm" },
  };
  assert.equal(shouldShowEmergencySheet(statusOnly), false);
  assert.equal(shouldShowEmergencySheet(alarmDecision), true);
  assert.equal(shouldAutoOpenFamilyVideo("fall", alarmDecision), true);
  assert.equal(shouldAutoOpenFamilyVideo("living", alarmDecision), false);
  assert.equal(shouldAutoOpenFamilyVideo("fall", statusOnly), false);
});
