import assert from "node:assert/strict";
import test from "node:test";
import {
  isActiveFallDanger,
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

test("只有跌倒紧急阶段自动开放家属现场画面", () => {
  assert.equal(shouldAutoOpenFamilyVideo("fall", "emergency"), true);
  assert.equal(shouldAutoOpenFamilyVideo("fall", "checking"), false);
  assert.equal(shouldAutoOpenFamilyVideo("fall", "resolved"), false);
  assert.equal(shouldAutoOpenFamilyVideo("kitchen", "idle"), false);
});

test("安全回应和已化解决策都停止本地警报", () => {
  assert.equal(shouldStopAlarmForResponse("safe"), true);
  assert.equal(shouldStopAlarmForResponse("card_confirmed"), true);
  assert.equal(shouldStopAlarmForResponse("need_help"), false);
  assert.equal(shouldStopAlarmForDecision({ state: "resolved" }), true);
  assert.equal(shouldStopAlarmForDecision({ state: "urgent_attention" }), false);
});
