import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveFallDanger,
  isFallSafetyDecision,
  shouldAutoOpenFamilyVideo,
  shouldCloseFamilyVideo,
  shouldShowEmergencySheet,
  shouldStopAlarmForDecision,
  shouldStopAlarmForResponse,
} from "./phoneState.js";

test("安全确认后手机退出危险与自动视频状态", () => {
  assert.equal(isActiveFallDanger("emergency"), true);
  assert.equal(isActiveFallDanger("resolved"), false);
  assert.equal(shouldShowEmergencySheet("emergency"), true);
  assert.equal(shouldShowEmergencySheet("resolved"), false);
  assert.equal(shouldCloseFamilyVideo("resolved"), true);
});

test("跌倒询问与普通关怀询问保持可区分", () => {
  assert.equal(isFallSafetyDecision({ dialogue_goal: "confirm_safety" }), true);
  assert.equal(isFallSafetyDecision({ confirm_channels: ["frame", "voice"] }), true);
  assert.equal(isFallSafetyDecision({ alarm: { trigger: "visual_confirm" } }), true);
  assert.equal(isFallSafetyDecision({ state: "check_in_required", dialogue_goal: "understand_need" }), false);
});

test("任意非浴室场景进入紧急阶段都会临时开放家属现场画面", () => {
  assert.equal(shouldAutoOpenFamilyVideo("fall", "emergency"), true);
  assert.equal(shouldAutoOpenFamilyVideo("living", "emergency"), true);
  assert.equal(shouldAutoOpenFamilyVideo("kitchen", "emergency"), true);
  assert.equal(shouldAutoOpenFamilyVideo("bathroom", "emergency"), false);
  assert.equal(shouldAutoOpenFamilyVideo("fall", "checking"), false);
  assert.equal(shouldAutoOpenFamilyVideo("fall", "resolved"), false);
});

test("安全回应和已化解决策都停止本地警报", () => {
  assert.equal(shouldStopAlarmForResponse("safe"), true);
  assert.equal(shouldStopAlarmForResponse("card_confirmed"), true);
  assert.equal(shouldStopAlarmForResponse("need_help"), false);
  assert.equal(shouldStopAlarmForDecision({ state: "resolved" }), true);
  assert.equal(shouldStopAlarmForDecision({ state: "urgent_attention" }), false);
});
