import assert from "node:assert/strict";
import test from "node:test";
import {
  isFamilyConfirmationTimedOut,
  resolveFamilyConfirmationError,
  selectFamilyAcknowledgementCommand,
  shouldRetainFamilyConfirmationLease,
} from "./familyConfirmation.js";

test("告警与行动卡使用合同定义的两个确认命令", () => {
  assert.equal(selectFamilyAcknowledgementCommand({
    alarm: { trigger: "elder_report" },
    action_card: null,
  }), "acknowledge_alarm");
  assert.equal(selectFamilyAcknowledgementCommand({
    alarm: null,
    action_card: { status: "pending" },
  }), "confirm_action_card");
  assert.equal(selectFamilyAcknowledgementCommand({
    alarm: null,
    action_card: null,
    family_notification: "请尽快联系确认。",
    state: "family_notification_required",
  }), null);
  assert.equal(selectFamilyAcknowledgementCommand({
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

test("权威 decision 先更新时仍保留控制租约直到终态 ACK", () => {
  const sent = { commandId: "c-1", sentAtMs: 1_000 };
  assert.equal(shouldRetainFamilyConfirmationLease({
    pending: null,
    sent,
    ack: { command_id: "c-1", phase: "received" },
    nowMs: 1_100,
  }), true);
  assert.equal(shouldRetainFamilyConfirmationLease({
    pending: null,
    sent,
    ack: { command_id: "c-1", phase: "applied" },
    nowMs: 1_200,
  }), false);
  assert.equal(shouldRetainFamilyConfirmationLease({
    pending: null,
    sent,
    ack: { command_id: "c-1", phase: "received" },
    nowMs: 11_000,
  }), false);
});
