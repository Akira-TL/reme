import assert from "node:assert/strict";
import test from "node:test";
import { projectCareAssessment } from "./careAssessment.js";

function decision(overrides = {}) {
  return {
    decision_id: "decision-1",
    state: "check_in_required",
    reason_summary: "午间活动低于个人近期基线，值得先问候确认",
    family_notification: null,
    uncertainty: "medium",
    source: "mimo",
    action: "ask_elder",
    family_delivery: "none",
    action_card: null,
    alarm: null,
    visual_context: null,
    ...overrides,
  };
}

test("projects a minimal structured MiMo assessment without raw media", () => {
  assert.deepEqual(projectCareAssessment(decision()), {
    presentation_kind: "judgment",
    verdict: "午间活动低于个人近期基线，值得先问候确认",
    basis: "午间活动低于个人近期基线，值得先问候确认",
    uncertainty: "medium",
    source: "mimo",
    action: "ask_elder",
    suggested_action: "已发起轻量问候，等待本人回应",
    status: "awaiting_response",
    action_card: null,
    alarm: null,
    visual_context: {
      sent_to_mimo: false,
      type: null,
      sample_count: null,
    },
  });
});

test("prefers the family verdict and an explicit action-card suggestion", () => {
  const assessment = projectCareAssessment(decision({
    state: "family_notification_required",
    family_notification: "外婆说牙齿不舒服，已经同意告诉家人。",
    action: "notify_family",
    family_delivery: "action_card",
    action_card: {
      event: "牙齿不舒服",
      elder_quote: "饭咬不动",
      system_judgment: "本人表达了具体生活困难",
      suggested_action: "今天帮外婆预约口腔科",
      time_window: "今天",
      status: "pending",
    },
  }));

  assert.equal(assessment.presentation_kind, "action_card");
  assert.equal(assessment.verdict, "牙齿不舒服");
  assert.equal(assessment.basis, "本人表达了具体生活困难");
  assert.equal(assessment.suggested_action, "今天帮外婆预约口腔科");
  assert.equal(assessment.status, "family_notified");
  assert.equal(Object.hasOwn(assessment.action_card, "elder_quote"), false);
});

test("keeps a deterministic alarm distinct from a care judgment", () => {
  const assessment = projectCareAssessment(decision({
    state: "urgent_attention",
    family_notification: "检测到确定性安全风险，请立即联系本人。",
    action: "show_urgent_attention",
    family_delivery: "alarm",
    alarm: { channels: ["ring", "flash"], trigger: "visual_confirm" },
  }));

  assert.equal(assessment.presentation_kind, "alarm");
  assert.equal(assessment.verdict, "检测到确定性安全风险，请立即联系本人。");
  assert.deepEqual(assessment.alarm.channels, ["ring", "flash"]);
  assert.equal(assessment.action_card, null);
});

test("records minimal visual provenance without carrying image data", () => {
  const assessment = projectCareAssessment(decision({
    visual_context: {
      sent_to_mimo: true,
      type: "keyframes",
      start_ms: 100,
      end_ms: 800,
      sample_count: 2,
      image_data: "must-not-project",
    },
  }));

  assert.deepEqual(assessment.visual_context, {
    sent_to_mimo: true,
    type: "keyframes",
    sample_count: 2,
  });
  assert.equal(JSON.stringify(assessment).includes("image_data"), false);
});

test("rejects decisions whose required closed-vocabulary fields are invalid", () => {
  assert.equal(projectCareAssessment(decision({ source: "guessed" })), null);
  assert.equal(projectCareAssessment(decision({ action: "call_doctor" })), null);
  assert.equal(projectCareAssessment(decision({ state: "diagnosed" })), null);
  assert.equal(projectCareAssessment(decision({ reason_summary: "" })), null);
  assert.equal(projectCareAssessment(decision({
    visual_context: { sent_to_mimo: true, type: "photo", sample_count: 1 },
  })), null);
});

test("preserves refusal through unknown uncertainty and a degraded status", () => {
  const assessment = projectCareAssessment(decision({
    state: "degraded",
    source: "degraded",
    uncertainty: "unexpected",
    action: "observe",
    reason_summary: "当前信息不足，只能继续观察",
  }));

  assert.equal(assessment.uncertainty, "unknown");
  assert.equal(assessment.status, "degraded");
  assert.match(assessment.suggested_action, /继续安静观察/);
});
