import assert from "node:assert/strict";
import test from "node:test";
import {
  FALL_INQUIRY_DELAY_MS,
  FALL_POST_PROMPT_GRACE_MS,
  FALL_VOICE_CAPTURE_MS,
  getDecisionVoicePlan,
  getVoiceAlarmDelayMs,
  getVoiceCaptureWindowMs,
  isFallCheckInDecision,
} from "./decisionVoicePolicy.js";

const FALL_CHECK_IN = {
  state: "check_in_required",
  dialogue_goal: "confirm_safety",
  voice_asset: "/voice/fall_check_in.m4a",
};

test("fall check-in waits one second and forbids preset fallback", () => {
  assert.equal(isFallCheckInDecision(FALL_CHECK_IN), true);
  assert.deepEqual(getDecisionVoicePlan(FALL_CHECK_IN), {
    isFallCheckIn: true,
    allowPresetFallback: false,
    delayMs: FALL_INQUIRY_DELAY_MS,
    listenDuringPlayback: true,
  });
  assert.equal(FALL_INQUIRY_DELAY_MS, 1000);
});

test("manual replay of a fall check-in starts immediately", () => {
  assert.deepEqual(getDecisionVoicePlan(FALL_CHECK_IN, { force: true }), {
    isFallCheckIn: true,
    allowPresetFallback: false,
    delayMs: 0,
    listenDuringPlayback: false,
  });
});

test("fall check-in timing does not depend on a preset asset", () => {
  assert.deepEqual(getDecisionVoicePlan({
    ...FALL_CHECK_IN,
    voice_asset: null,
  }), {
    isFallCheckIn: true,
    allowPresetFallback: false,
    delayMs: FALL_INQUIRY_DELAY_MS,
    listenDuringPlayback: true,
  });
});

test("non-fall dialogue keeps the existing MiMo-first path", () => {
  const consent = {
    state: "consent_required",
    dialogue_goal: "request_consent",
    voice_asset: "/voice/consent_request.m4a",
  };
  assert.equal(isFallCheckInDecision(consent), false);
  assert.deepEqual(getDecisionVoicePlan(consent), {
    isFallCheckIn: false,
    allowPresetFallback: true,
    delayMs: 0,
    listenDuringPlayback: false,
  });
});

test("fall alarm waits three seconds after the prompt has actually ended", () => {
  const decision = { ...FALL_CHECK_IN, response_timeout_ms: 3000 };
  assert.equal(getVoiceCaptureWindowMs(decision), 2000);
  assert.equal(getVoiceAlarmDelayMs(decision), 3000);
  assert.equal(FALL_VOICE_CAPTURE_MS, 2000);
  assert.equal(FALL_POST_PROMPT_GRACE_MS, 3000);
});

test("non-fall recording and deadline keep the configured response window", () => {
  const decision = {
    state: "check_in_required",
    dialogue_goal: "understand_need",
    response_timeout_ms: 2500,
  };
  assert.equal(getVoiceCaptureWindowMs(decision), 2500);
  assert.equal(getVoiceAlarmDelayMs(decision, 8000), 2500);
});
