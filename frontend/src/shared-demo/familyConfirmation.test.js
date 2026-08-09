import assert from "node:assert/strict";
import test from "node:test";
import {
  isFamilyConfirmationTimedOut,
  resolveFamilyConfirmationError,
  selectFamilyAcknowledgementCommand,
} from "./familyConfirmation.js";

test("告警、行动卡和普通家属通知使用互不混淆的确认命令", () => {
  assert.equal(selectFamilyAcknowledgementCommand({
    family_delivery: "alarm",
    alarm: { trigger: "elder_need_help" },
    action_card: null,
  }), "confirm_alarm");
  assert.equal(selectFamilyAcknowledgementCommand({
    family_delivery: "action_card",
    alarm: null,
    action_card: { status: "pending" },
  }), "confirm_action_card");
  assert.equal(selectFamilyAcknowledgementCommand({
    family_delivery: "notification",
    alarm: null,
    action_card: null,
    family_notification: "请尽快联系确认。",
    state: "family_notification_required",
  }), "confirm_family_notification");
  assert.equal(selectFamilyAcknowledgementCommand({
    family_delivery: "none",
    alarm: null,
    action_card: null,
    family_notification: "已处理。",
    state: "resolved",
  }), null);
});

test("缺少本地失败对象时不会读取空值", () => {
  assert.equal(resolveFamilyConfirmationError({ decisionId: undefined, failure: null }), "");
  assert.equal(resolveFamilyConfirmationError({ decisionId: "d-1", failure: null, ackError: "回执失败" }), "回执失败");
});

test("只展示当前 decision 的本地失败", () => {
  assert.equal(resolveFamilyConfirmationError({
    decisionId: "d-2",
    failure: { decisionId: "d-1", message: "旧告警失败" },
  }), "");
  assert.equal(resolveFamilyConfirmationError({
    decisionId: "d-2",
    failure: { decisionId: "d-2", message: "当前告警失败" },
  }), "当前告警失败");
});

test("当前本地失败优先于 ACK 失败", () => {
  assert.equal(resolveFamilyConfirmationError({
    decisionId: "d-3",
    failure: { decisionId: "d-3", message: "未取得处理权限" },
    ackError: "Relay 拒绝",
  }), "未取得处理权限");
});

test("告警确认等待超时但终态 ACK 不会误判超时", () => {
  const sent = { commandId: "c-1", sentAtMs: 1_000 };
  assert.equal(isFamilyConfirmationTimedOut({ sent, ack: null, nowMs: 10_999 }), false);
  assert.equal(isFamilyConfirmationTimedOut({ sent, ack: null, nowMs: 11_000 }), true);
  assert.equal(isFamilyConfirmationTimedOut({ sent, ack: { phase: "applied" }, nowMs: 20_000 }), false);
});
