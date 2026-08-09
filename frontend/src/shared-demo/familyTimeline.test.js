import assert from "node:assert/strict";
import test from "node:test";
import {
  createFamilyTimelineState,
  FAMILY_TIMELINE_LIMIT,
  reduceFamilyTimeline,
} from "./familyTimeline.js";

function careAssessment(overrides = {}) {
  return {
    verdict: "午间活动比近期基线少，建议先问候确认。",
    basis: "持续静坐触发轻量关怀事件",
    uncertainty: "medium",
    source: "mimo",
    action: "ask_elder",
    suggested_action: "已发起轻量问候，等待本人回应",
    status: "awaiting_response",
    visual_context: {
      sent_to_mimo: false,
      type: null,
      sample_count: null,
    },
    ...overrides,
  };
}

function careDecision({
  scene,
  care,
  decisionId,
  careMessage,
  assessment,
  alarm,
  delivery = "none",
  timestampMs,
}) {
  if (!decisionId) return null;
  const state = care === "checking"
    ? "check_in_required"
    : ["notification", "action_card", "alarm"].includes(delivery)
      ? "family_notification_required"
      : care === "resolved"
        ? "resolved"
        : "observe";
  const action = delivery === "alarm"
    ? "show_urgent_attention"
    : ["notification", "action_card"].includes(delivery)
      ? "notify_family"
      : assessment?.action || (care === "checking" ? "ask_elder" : "observe");
  return {
    schema_version: "reme-care-decision/v1-experiment",
    scene_id: scene,
    decision_id: decisionId,
    timestamp_ms: timestampMs,
    state,
    risk_level: delivery === "alarm" ? 3 : delivery === "action_card" ? 2 : 1,
    privacy_mode: "skeleton_only",
    family_notification: delivery === "none"
      ? null
      : careMessage || assessment?.verdict || "请家人查看最新关怀信息。",
    action,
    family_delivery: delivery,
    reason_summary: assessment?.verdict || assessment?.basis || careMessage || "当前关怀状态已更新。",
    uncertainty: assessment?.uncertainty || "unknown",
    fallback_used: false,
    source: assessment?.source || "rule",
    demo_mode: "live",
    action_card: delivery === "action_card" ? {
      event: assessment.verdict,
      system_judgment: assessment.basis,
      suggested_action: assessment.suggested_action,
      time_window: "当前",
      status: "pending",
    } : null,
    visual_context: assessment ? {
      ...assessment.visual_context,
      start_ms: null,
      end_ms: null,
    } : null,
    alarm: delivery === "alarm" ? alarm : null,
  };
}

function snapshot({
  room = "room-1",
  revision = 1,
  timestampMs = 1_000 + revision,
  scene = "living",
  capture = "idle",
  captureError = null,
  runtime = "degraded",
  runtimeDetail = null,
  grant = null,
} = {}) {
  return {
    schema_version: "reme-demo-state/v4",
    room_session_id: room,
    runtime_session_id: "runtime-1",
    state_revision: revision,
    timestamp_ms: timestampMs,
    state: {
      scene_id: scene,
      source_generation: 0,
      capture: {
        status: capture,
        source_id: null,
        source_kind: null,
        remote_video: "unavailable",
        error: captureError,
      },
      runtime: {
        status: runtime,
        capability: runtime === "ready" ? "live" : "unavailable",
        detail: runtimeDetail,
      },
      care: {
        phase: "idle",
        consent: "none",
        decision: null,
      },
      media_grant: grant,
    },
  };
}

function familyEvent({
  room = "room-1",
  runtimeSessionId = "runtime-1",
  revision = 0,
  timestampMs = 1_000 + revision,
  scene = "living",
  care = "idle",
  decisionId = null,
  careMessage = null,
  assessment = null,
  alarm = null,
  kitchenAuthorized = false,
  delivery = alarm ? "alarm" : kitchenAuthorized ? "notification" : "none",
} = {}) {
  const decision = careDecision({
    scene,
    care,
    decisionId,
    careMessage,
    assessment,
    alarm,
    delivery,
    timestampMs,
  });
  if (kitchenAuthorized && decision) {
    decision.state = "resolved";
    decision.risk_level = 0;
    decision.action = "notify_family";
    decision.family_delivery = "notification";
    decision.family_notification = "本人同意分享当前厨房片段。";
    decision.action_card = null;
  }
  return {
    schema_version: "reme-family-event/v1",
    room_session_id: room,
    runtime_session_id: runtimeSessionId,
    revision,
    timestamp_ms: timestampMs,
    care: decision,
    authorization: kitchenAuthorized ? {
      schema_version: "reme-media-authorization/v1",
      authorization_id: `authorization-${decisionId}`,
      decision_id: decisionId,
      event_id: decisionId,
      runtime_session_id: runtimeSessionId,
      scene_id: "kitchen",
      scope: "kitchen_moment",
      audience: "public_demo_viewers",
      status: "active",
      issued_at_ms: timestampMs,
      expires_at_ms: timestampMs + 60_000,
    } : null,
  };
}

function observe(state, currentSnapshot, acks = [], currentFamilyEvent = null) {
  return reduceFamilyTimeline(state, {
    type: "observe",
    roomSessionId: currentSnapshot?.room_session_id
      || currentFamilyEvent?.room_session_id
      || state.roomSessionId,
    snapshot: currentSnapshot,
    familyEvent: currentFamilyEvent,
    acks,
  });
}

test("an initial snapshot without a reliable care assessment stays out of the main timeline", () => {
  const state = observe(createFamilyTimelineState(), snapshot());

  assert.equal(state.lastStateRevision, 1);
  assert.equal(state.events.length, 0);
  assert.equal(state.lastSnapshot.sceneId, "living");
});

test("an authoritative assessment becomes a family-facing care judgment", () => {
  const currentSnapshot = snapshot();
  const state = observe(createFamilyTimelineState(), currentSnapshot, [], familyEvent({
    care: "checking",
    decisionId: "decision-1",
    assessment: careAssessment({
      visual_context: {
        sent_to_mimo: true,
        type: "keyframes",
        sample_count: 2,
      },
    }),
  }));

  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, "judgment");
  assert.equal(state.events[0].label, "MiMo 关怀判断");
  assert.equal(state.events[0].statusLabel, "等待回应");
  assert.match(state.events[0].title, /建议先问候/);
  assert.equal(state.events[0].suggestedAction, "已发起轻量问候，等待本人回应");
  assert.deepEqual(state.events[0].visualContext, {
    sentToMimo: true,
    type: "keyframes",
    sampleCount: 2,
  });
  assert.equal(state.events[0].captureLabel, "采集未开始");
  assert.equal(state.events[0].runtimeLabel, "本地运行时降级");
});

test("judgment, action card and alarm remain three distinct timeline products", () => {
  const currentSnapshot = snapshot({ revision: 1 });
  let state = observe(createFamilyTimelineState(), currentSnapshot, [], familyEvent({
    revision: 1,
    decisionId: "decision-judgment",
    assessment: careAssessment(),
  }));
  state = observe(state, currentSnapshot, [], familyEvent({
    revision: 2,
    timestampMs: 2_000,
    care: "attention",
    decisionId: "decision-card",
    delivery: "action_card",
    assessment: careAssessment({ verdict: "牙齿不舒服，需要家属协助" }),
  }));
  state = observe(state, currentSnapshot, [], familyEvent({
    revision: 3,
    timestampMs: 3_000,
    scene: "fall",
    care: "emergency",
    decisionId: "decision-alarm",
    careMessage: "检测到确定性安全风险，请立即联系本人。",
    delivery: "alarm",
    alarm: { channels: ["ring", "flash"], trigger: "visual_confirm" },
  }));

  assert.deepEqual(state.events.map((event) => event.kind), [
    "alarm",
    "action_card",
    "judgment",
  ]);
  assert.equal(state.events[0].label, "安全告警");
  assert.equal(state.events[0].tone, "danger");
  assert.equal(state.events[1].label, "家属行动卡");
  assert.equal(state.events[1].actionCard.event, "牙齿不舒服，需要家属协助");
  assert.equal(state.events[2].label, "MiMo 关怀判断");
});

test("keepalives and system-only changes do not become household judgments", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  state = observe(state, snapshot({ revision: 2, scene: "kitchen" }));
  state = observe(state, snapshot({ revision: 3, capture: "active" }));
  state = observe(state, snapshot({ revision: 4, runtime: "ready" }));
  state = observe(state, snapshot({ revision: 3, care: "emergency" }));

  assert.equal(state.lastStateRevision, 4);
  assert.equal(state.events.length, 0);
});

test("a changed CareDecision creates a new judgment while a replay does not", () => {
  const currentSnapshot = snapshot();
  let state = observe(createFamilyTimelineState(), currentSnapshot, [], familyEvent({
    revision: 1,
    decisionId: "decision-1",
    assessment: careAssessment({ status: "observing", action: "observe" }),
  }));
  state = observe(state, currentSnapshot, [], familyEvent({
    revision: 2,
    decisionId: "decision-1",
    assessment: careAssessment({ status: "observing", action: "observe" }),
  }));
  state = observe(state, currentSnapshot, [], familyEvent({
    revision: 3,
    care: "checking",
    decisionId: "decision-2",
    assessment: careAssessment(),
  }));

  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].stateRevision, 3);
  assert.equal(state.events[1].stateRevision, 1);
});

test("assessment, authorization and privacy results keep care-first priority", () => {
  const currentSnapshot = snapshot({
    revision: 2,
    timestampMs: 2_000,
    scene: "kitchen",
    capture: "active",
    runtime: "ready",
    grant: {
      grant_id: "grant-1",
      event_id: "authorization-decision-1",
      scope: "kitchen_moment",
      expires_at_ms: 4_000,
      status: "active",
    },
  });
  const state = observe(createFamilyTimelineState(), currentSnapshot, [], familyEvent({
    revision: 1,
    timestampMs: 2_000,
    scene: "kitchen",
    care: "checking",
    decisionId: "decision-1",
    assessment: careAssessment(),
    kitchenAuthorized: true,
  }));

  assert.deepEqual(
    state.events.map((event) => event.kind),
    ["notification", "consent", "media"],
  );
  assert.equal(state.events.some((event) => event.kind === "scene"), false);
  assert.equal(state.events.some((event) => event.kind === "capture"), false);
  assert.equal(state.events.some((event) => event.kind === "runtime"), false);
});

test("Family derives a sourced assessment from the current FamilyEvent", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  state = observe(state, snapshot({ revision: 2 }), [], familyEvent({
    revision: 2,
    care: "checking",
    decisionId: "decision-fallback",
    careMessage: "奶奶，您还好吗？",
  }));

  assert.equal(state.events[0].kind, "judgment");
  assert.equal(state.events[0].label, "安全规则判断");
  assert.doesNotMatch(state.events[0].title, /MiMo/);
  assert.equal(state.events[0].assessmentSource, "rule");
});

test("room-session changes discard the previous room timeline", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ room: "room-1" }), [], familyEvent({
    room: "room-1",
    decisionId: "decision-1",
    assessment: careAssessment(),
  }));
  state = reduceFamilyTimeline(state, {
    type: "observe",
    roomSessionId: "room-2",
    snapshot: null,
    acks: [],
  });

  assert.equal(state.roomSessionId, "room-2");
  assert.equal(state.events.length, 0);
  assert.equal(state.lastStateRevision, null);
});

test("an applied family alarm acknowledgement is recorded exactly once", () => {
  let state = observe(createFamilyTimelineState(), snapshot());
  const ack = {
    command_id: "command-1",
    command_name: "confirm_alarm",
    phase: "applied",
    timestamp_ms: 3_000,
    state_revision: 2,
    reason: null,
  };
  state = observe(state, null, [ack]);
  state = observe(state, null, [ack]);
  state = observe(state, null, [{ ...ack, command_id: "command-2", phase: "failed" }]);

  assert.equal(
    state.events.filter((event) => event.kind === "acknowledgement").length,
    1,
  );
  assert.equal(state.events[0].title, "家属已经确认收到告警");
  assert.equal(state.events[0].source, "command_ack");
});

test("action-card and plain-notification acknowledgements are recorded distinctly", () => {
  let state = observe(createFamilyTimelineState(), snapshot());
  state = observe(state, null, [
    {
      command_id: "command-card",
      command_name: "confirm_action_card",
      phase: "applied",
      timestamp_ms: 3_100,
      state_revision: 3,
      reason: null,
    },
    {
      command_id: "command-notification",
      command_name: "confirm_family_notification",
      phase: "applied",
      timestamp_ms: 3_200,
      state_revision: 4,
      reason: null,
    },
  ]);

  const titles = state.events
    .filter((event) => event.kind === "acknowledgement")
    .map((event) => event.title);
  assert.deepEqual(titles, [
    "家属已经确认收到通知",
    "家属已经确认收到行动卡",
  ]);
});

test("the in-memory timeline remains bounded to its newest judgments", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  for (let revision = 2; revision <= 20; revision += 1) {
    state = observe(state, snapshot({
      revision,
      timestampMs: revision * 1_000,
    }), [], familyEvent({
      revision,
      timestampMs: revision * 1_000,
      care: "checking",
      decisionId: `decision-${revision}`,
      assessment: careAssessment({ verdict: `第 ${revision} 次关怀判断` }),
    }));
  }

  assert.equal(state.events.length, FAMILY_TIMELINE_LIMIT);
  assert.equal(state.events[0].timestampMs, 20_000);
  assert.equal(state.events.at(-1).timestampMs, 9_000);
});
