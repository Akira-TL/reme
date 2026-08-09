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

function careDecision(overrides = {}) {
  return {
    schema_version: "reme-care-decision/v0-experiment",
    scene_id: "living",
    decision_id: "decision-1",
    timestamp_ms: 1_000,
    state: "observe",
    risk_level: 1,
    privacy_mode: "skeleton_only",
    need_dialogue: false,
    dialogue_goal: null,
    elder_message: null,
    family_notification: null,
    action: "observe",
    reason_summary: "姿态与场景信息综合判断。",
    uncertainty: "medium",
    fallback_used: false,
    source: "mimo",
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
    alarm: null,
    voice_asset: null,
    confirm_channels: null,
    ...overrides,
  };
}

test("控制命令使用 exact-shape 且拒绝未知命令", () => {
  assert.ok(parseControlCommand(command("select_scene", { scene_id: "kitchen" })));
  assert.equal(parseControlCommand(command("select_scene", { scene_id: "kitchen", hidden: true })), null);
  assert.equal(parseControlCommand(command("open_raw_video")), null);
  assert.ok(parseControlCommand(command("confirm_action_card", {
    decision_id: "decision-1",
  })));
  assert.ok(parseControlCommand(command("confirm_family_notification", {
    decision_id: "decision-1",
  })));
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
      decision_id: "hidden-fall",
      privacy_mode: "hidden",
      alarm: { channels: ["ring"], trigger: "visual_confirm" },
    },
  }).code, "decision_privacy_hidden");
  assert.equal(mediaGrantEligibility({
    sceneId: "fall",
    careDecision: {
      scene_id: "fall",
      decision_id: "fall-authority",
      state: "urgent_attention",
      alarm: { channels: ["flash"], trigger: "visual_confirm" },
    },
    now: 1_000,
  }).durationMs, 30_000);
  assert.equal(mediaGrantEligibility({
    sceneId: "fall",
    careDecision: {
      scene_id: "fall",
      decision_id: "fall-authority",
      state: "urgent_attention",
      alarm: { channels: ["ring"], trigger: "visual_confirm" },
    },
    now: 11_000,
  }).durationMs, 30_000);
  assert.equal(mediaGrantEligibility({
    sceneId: "fall",
    careDecision: {
      scene_id: "fall",
      decision_id: "fall-authority",
      state: "urgent_attention",
      alarm: null,
    },
    now: 1_000,
  }).allowed, false);
});

test("权威状态显式区分 room session 与 runtime session", () => {
  const decision = careDecision();
  const state = buildDemoState({
    roomSessionId: "room-1",
    runtimeSessionId: "runtime-9",
    stateRevision: 7,
    sceneId: "living",
    sourceGeneration: 3,
    source: { id: "front-camera", kind: "camera", label: "前置", remote_video: "available" },
    capture: { active: true },
    runtime: { state: "running", inputMode: "jpeg", personDetected: true, skeletonSource: "a_backend" },
    care: {
      phase: "checking",
      decision,
    },
  });
  assert.equal(state.room_session_id, "room-1");
  assert.equal(state.runtime_session_id, "runtime-9");
  assert.notEqual(state.room_session_id, state.runtime_session_id);
  assert.equal(state.state.source_generation, 3);
  assert.equal(state.state.runtime.status, "ready");
  assert.equal(state.state.runtime.capability, "live");
  assert.equal(state.schema_version, "reme-demo-state/v3");
  assert.deepEqual(state.state.care.decision, decision);
  assert.equal(state.state.care.phase, "idle");
});

test("本地 candidate 与调用方 phase 不能伪造 Relay 关怀状态", () => {
  const base = {
    roomSessionId: "room-1",
    runtimeSessionId: "runtime-9",
    stateRevision: 8,
    sceneId: "fall",
    source: { id: "front-camera", kind: "camera", remote_video: "available" },
    capture: { active: true },
    runtime: { state: "running", inputMode: "jpeg" },
  };
  const candidate = buildDemoState({
    ...base,
    care: { phase: "candidate", consent: "none", decision: null },
  });
  assert.equal(candidate.state.care.phase, "idle");
  assert.equal(candidate.state.care.decision, null);

  const checking = buildDemoState({
    ...base,
    care: {
      phase: "emergency",
      consent: "none",
      decision: careDecision({
        scene_id: "fall",
        state: "check_in_required",
        need_dialogue: true,
        elder_message: "您还好吗？",
        action: "ask_elder",
      }),
    },
  });
  assert.equal(checking.state.care.phase, "checking");
  assert.equal(checking.state.care.decision.state, "check_in_required");
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
