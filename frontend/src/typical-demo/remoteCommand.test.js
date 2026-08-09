import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDemoState,
  classifyControlCommand,
  createControlAck,
  mediaGrantEligibility,
  parseControlCommand,
} from "./remoteCommand.js";

function command(name, payload = {}, overrides = {}) {
  return {
    schema_version: "reme-control-command/v1",
    room_session_id: "room-1",
    command_id: "command-1",
    command_sequence: 1,
    issued_at_ms: 1_000,
    expires_at_ms: 10_000,
    expected_state_revision: 4,
    command: { name, ...payload },
    ...overrides,
  };
}

const context = {
  roomSessionId: "room-1",
  stateRevision: 4,
  sceneId: "living",
  decisionId: "decision-1",
  activeSafetyEvent: false,
  sources: [{ id: "front-camera", disabled_reason: null }],
};

test("控制命令使用 exact-shape 且拒绝未知命令", () => {
  assert.ok(parseControlCommand(command("select_scene", { scene_id: "kitchen" })));
  assert.equal(parseControlCommand(command("select_scene", { scene_id: "kitchen", hidden: true })), null);
  assert.equal(parseControlCommand(command("open_raw_video")), null);
});

test("旧房间、过期命令和旧 revision 均在 Monitor 再次 fail-close", () => {
  assert.equal(classifyControlCommand(command("reset_demo", {}, {
    room_session_id: "old-room",
  }), context, 2_000).code, "stale_room_session");
  assert.equal(classifyControlCommand(command("reset_demo"), context, 11_000).code, "command_expired");
  assert.equal(classifyControlCommand(command("reset_demo", {}, {
    expected_state_revision: 3,
  }), context, 2_000).code, "stale_state_revision");
});

test("涉及系统权限的源选择和开始采集等待 Monitor 本机确认", () => {
  assert.equal(classifyControlCommand(
    command("select_source", { source_id: "front-camera" }),
    context,
    2_000,
  ).disposition, "awaiting_local_confirmation");
  assert.equal(classifyControlCommand(command("start_capture"), context, 2_000).code,
    "local_confirmation_required");
  assert.equal(classifyControlCommand(
    command("select_source", { source_id: "missing" }),
    context,
    2_000,
  ).code, "source_unavailable");
});

test("旧 decision 与会降低当前安全状态的命令直接拒绝", () => {
  assert.equal(classifyControlCommand(
    command("submit_response", { decision_id: "old-decision", response: "safe" }),
    context,
    2_000,
  ).code, "stale_decision");
  const safetyContext = { ...context, activeSafetyEvent: true, sceneId: "fall" };
  assert.equal(classifyControlCommand(
    command("select_scene", { scene_id: "living" }),
    safetyContext,
    2_000,
  ).code, "safety_event_active");
  assert.equal(classifyControlCommand(command("reset_demo"), safetyContext, 2_000).code,
    "safety_event_active");
  assert.equal(classifyControlCommand(command("stop_capture"), safetyContext, 2_000).code,
    "safety_event_active");
});

test("浴室硬门、厨房当前授权和跌倒权威升级决定 grant", () => {
  assert.equal(mediaGrantEligibility({
    sceneId: "bathroom",
    careDecision: { state: "urgent_attention" },
  }).code, "bathroom_video_forbidden");
  assert.equal(mediaGrantEligibility({
    sceneId: "kitchen",
    careDecision: { scene_id: "kitchen", decision_id: "decision-shared" },
    kitchenAuthorization: {
      sceneId: "kitchen",
      requestDecisionId: "decision-question",
      decisionId: "decision-shared",
      expiresAtMonotonicMs: 70_000,
    },
    now: 1_000,
  }).durationMs, 60_000);
  assert.equal(mediaGrantEligibility({
    sceneId: "kitchen",
    careDecision: {
      scene_id: "kitchen",
      decision_id: "decision-notification-without-receipt",
      action: "notify_family",
      family_notification: "不能据此推断授权",
    },
  }).allowed, false);
  assert.equal(mediaGrantEligibility({
    sceneId: "kitchen",
    careDecision: { scene_id: "kitchen", decision_id: "decision-shared" },
    kitchenAuthorization: {
      sceneId: "kitchen",
      requestDecisionId: "decision-question",
      decisionId: "decision-shared",
      expiresAtMonotonicMs: 1_500,
    },
    now: 1_000,
  }).allowed, false);
  assert.equal(mediaGrantEligibility({
    sceneId: "kitchen",
    careDecision: { scene_id: "kitchen", decision_id: "decision-shared" },
    kitchenAuthorization: {
      sceneId: "kitchen",
      requestDecisionId: "decision-question",
      decisionId: "decision-shared",
      expiresAtMonotonicMs: 31_000,
    },
    now: 11_000,
  }).durationMs, 20_000);
  assert.equal(mediaGrantEligibility({
    sceneId: "fall",
    careDecision: {
      scene_id: "fall",
      decision_id: "fall-authority",
      state: "urgent_attention",
    },
    fallAuthorization: {
      sceneId: "fall",
      decisionId: "fall-authority",
      expiresAtMonotonicMs: 31_000,
    },
    now: 1_000,
  }).durationMs, 30_000);
  assert.equal(mediaGrantEligibility({
    sceneId: "fall",
    careDecision: {
      scene_id: "fall",
      decision_id: "fall-authority",
      state: "urgent_attention",
    },
    fallAuthorization: {
      sceneId: "fall",
      decisionId: "fall-authority",
      expiresAtMonotonicMs: 31_000,
    },
    now: 11_000,
  }).durationMs, 20_000);
  assert.equal(mediaGrantEligibility({
    sceneId: "fall",
    careDecision: {
      scene_id: "fall",
      decision_id: "fall-authority",
      state: "urgent_attention",
    },
    fallAuthorization: {
      sceneId: "fall",
      decisionId: "fall-authority",
      expiresAtMonotonicMs: 1_500,
    },
    now: 1_000,
  }).allowed, false);
});

test("权威状态显式区分 room session 与 runtime session", () => {
  const state = buildDemoState({
    roomSessionId: "room-1",
    runtimeSessionId: "runtime-9",
    stateRevision: 7,
    sceneId: "living",
    sourceGeneration: 3,
    source: { id: "front-camera", kind: "camera", label: "前置", remote_video: "available" },
    capture: { active: true },
    runtime: { state: "running", inputMode: "jpeg", personDetected: true, skeletonSource: "a_backend" },
    care: { phase: "idle" },
  });
  assert.equal(state.room_session_id, "room-1");
  assert.equal(state.runtime_session_id, "runtime-9");
  assert.notEqual(state.room_session_id, state.runtime_session_id);
  assert.equal(state.state.source_generation, 3);
  assert.equal(state.state.runtime.status, "ready");
  assert.equal(state.state.runtime.capability, "live");
});

test("ACK 明确区分等待本机确认和终态", () => {
  const ack = createControlAck({
    roomSessionId: "room-1",
    commandId: "command-1",
    phase: "awaiting_local_confirmation",
    code: "local_confirmation_required",
    stateRevision: 4,
    timestampMs: 2_000,
  });
  assert.equal(ack.phase, "awaiting_local_confirmation");
  assert.equal(ack.state_revision, 4);
  assert.equal(ack.reason, "local_confirmation_required");
  assert.deepEqual(Object.keys(ack).sort(), [
    "command_id",
    "phase",
    "reason",
    "room_session_id",
    "state_revision",
    "timestamp_ms",
    "type",
  ]);
  assert.throws(() => createControlAck({
    roomSessionId: "room-1",
    commandId: "command-1",
    phase: "maybe",
    code: "invalid",
    stateRevision: 4,
  }));
});
