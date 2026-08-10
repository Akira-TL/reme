import assert from "node:assert/strict";
import test from "node:test";
import {
  careDecisionMessage,
  hasCurrentAlarm,
  isCareDecision,
  mapCareDecisionToPhase,
  projectCareDecision,
} from "./careDecision.js";

function validDecision(overrides = {}) {
  return {
    schema_version: "reme-care-decision/v1-experiment",
    scene_id: "fall",
    decision_id: "decision-1",
    timestamp_ms: 1_000,
    state: "urgent_attention",
    risk_level: 4,
    privacy_mode: "skeleton_only",
    need_dialogue: false,
    dialogue_goal: null,
    elder_message: null,
    family_notification: "请家人立即确认。",
    action: "show_urgent_attention",
    family_delivery: "alarm",
    reason_summary: "当前决策要求立即关注。",
    uncertainty: "low",
    fallback_used: false,
    source: "rule",
    demo_mode: "live",
    consent_required: false,
    response_timeout_ms: null,
    response_deadline_ms: null,
    action_card: null,
    visual_context: {
      sent_to_mimo: true,
      type: "keyframes",
      start_ms: 900,
      end_ms: 1_000,
      sample_count: 3,
    },
    alarm: { channels: ["vibrate", "flash"], trigger: "visual_confirm" },
    voice_asset: null,
    confirm_channels: null,
    ...overrides,
  };
}

function backendDecision(overrides = {}) {
  const target = structuredClone(validDecision(overrides));
  delete target.family_delivery;
  delete target.response_deadline_ms;
  target.schema_version = "reme-care-decision/v0-experiment";
  target.media_authorization = null;
  return target;
}

test("CareDecision projection preserves the exact authoritative snapshot", () => {
  const decision = validDecision();
  const projected = projectCareDecision(decision);
  assert.equal(isCareDecision(projected), true);
  assert.deepEqual(projected, decision);
  assert.notEqual(projected, decision);
  assert.notEqual(projected.alarm, decision.alarm);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.alarm.channels), true);
});

test("target Backend CareDecision stays exact and does not regain removed fields", () => {
  const decision = backendDecision();
  const projected = projectCareDecision(decision);
  assert.equal(isCareDecision(projected), true);
  assert.deepEqual(projected, decision);
  assert.equal(Object.hasOwn(projected, "family_delivery"), false);
  assert.equal(Object.hasOwn(projected, "response_deadline_ms"), false);
});

test("CareDecision rejects invented fields and invalid alarm semantics", () => {
  assert.equal(isCareDecision({ ...validDecision(), inferred_safe: true }), false);
  assert.equal(isCareDecision(validDecision({
    voice_asset: "data:audio/wav;base64,AAAA",
    elder_message: "请回答我。",
  })), false);
  assert.equal(isCareDecision(validDecision({
    state: "family_notification_required",
    action: "notify_family",
    family_delivery: "notification",
    alarm: null,
  })), true);
  assert.equal(isCareDecision(validDecision({
    state: "observe",
    alarm: { channels: ["ring"], trigger: "visual_confirm" },
  })), false);
  assert.equal(isCareDecision(validDecision({
    alarm: { channels: ["ring", "ring"], trigger: "visual_confirm" },
  })), false);
  assert.equal(isCareDecision(validDecision({
    response_timeout_ms: 8_000,
    response_deadline_ms: 9_000,
  })), true);
  assert.equal(isCareDecision(validDecision({
    response_timeout_ms: null,
    response_deadline_ms: 9_000,
  })), false);
  assert.equal(isCareDecision(validDecision({
    family_delivery: "action_card",
    state: "family_notification_required",
    risk_level: 2,
    action: "notify_family",
    alarm: null,
    action_card: {
      event: "牙齿不舒服",
      elder_quote: "饭咬不动",
      system_judgment: "本人表达了具体生活困难",
      suggested_action: "今天联系本人并协助预约",
      time_window: "今天",
      status: "pending",
    },
  })), true);
  assert.equal(isCareDecision(validDecision({
    action_card: {
      event: "疑似跌倒",
      elder_quote: "没有回应",
      system_judgment: "需要立即关注",
      suggested_action: "立即联系本人",
      time_window: "现在",
      status: "pending",
    },
  })), false);
  assert.equal(isCareDecision(validDecision({
    state: "family_notification_required",
    risk_level: 1,
    family_notification: null,
    action: "observe",
    family_delivery: "none",
    alarm: null,
  })), false);
});

test("presentation helpers map explicit delivery without inventing alarm authority", () => {
  assert.equal(mapCareDecisionToPhase({
    state: "check_in_required",
    family_delivery: "none",
  }), "checking");
  assert.equal(mapCareDecisionToPhase({
    state: "family_notification_required",
    family_delivery: "notification",
  }), "attention");
  assert.equal(mapCareDecisionToPhase({
    state: "urgent_attention",
    family_delivery: "alarm",
  }), "emergency");
  assert.equal(mapCareDecisionToPhase({ state: "normal", family_delivery: "none" }), "idle");
  const statusOnly = validDecision({
    state: "family_notification_required",
    action: "notify_family",
    family_delivery: "notification",
    alarm: null,
  });
  assert.equal(hasCurrentAlarm(statusOnly), false);
  assert.equal(careDecisionMessage(statusOnly), "请家人立即确认。");
});
