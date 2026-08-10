import assert from "node:assert/strict";
import test from "node:test";
import {
  createFamilyTimelineState,
  FAMILY_TIMELINE_LIMIT,
  reduceFamilyTimeline,
} from "./familyTimeline.js";

function snapshot({
  room = "room-1",
  revision = 1,
  timestampMs = 1_000 + revision,
  scene = "living",
  capture = "idle",
  runtime = "degraded",
  grant = null,
} = {}) {
  return {
    schema_version: "reme-demo-state/v1",
    room_session_id: room,
    runtime_session_id: "runtime-1",
    state_revision: revision,
    timestamp_ms: timestampMs,
    state: {
      scene_id: scene,
      source_generation: 0,
      capture: {
        status: capture,
        source_id: capture === "active" ? "camera-user" : null,
        source_kind: capture === "active" ? "camera" : null,
        remote_video: capture === "active" ? "available" : "unavailable",
        error: null,
      },
      runtime: {
        status: runtime,
        capability: runtime === "ready" ? "live" : "unavailable",
        detail: null,
      },
      care: {
        phase: "idle",
        decision_id: null,
        consent: "none",
        alarm_authoritative: false,
        message: null,
      },
      media_grant: grant,
    },
  };
}

function mediaAuthorization({
  decisionId,
  scene = "kitchen",
  timestampMs = 1_000,
} = {}) {
  return {
    schema_version: "reme-media-authorization/v1",
    authorization_id: `authorization-${decisionId}`,
    decision_id: decisionId,
    scene_id: scene,
    scope: scene === "fall" ? "fall_emergency" : "kitchen_moment",
    status: "active",
    issued_at_ms: timestampMs,
    expires_at_ms: timestampMs + (scene === "fall" ? 30_000 : 60_000),
    event_id: `transition-${decisionId}`,
  };
}

function familyEvent({
  room = "room-1",
  runtimeSessionId = "runtime-1",
  revision = 1,
  timestampMs = 1_000 + revision,
  decisionId = `decision-${revision}`,
  state = "observe",
  action = "observe",
  riskLevel = 1,
  familyNotification = null,
  privacyMode = "skeleton_only",
  alarm = null,
  actionCard = null,
  authorization = null,
} = {}) {
  return {
    type: "family_event",
    schema_version: "reme-family-event/v1",
    room_session_id: room,
    runtime_session_id: runtimeSessionId,
    revision,
    decision_timestamp_ms: timestampMs - 100,
    published_at_ms: timestampMs,
    care: {
      decision_id: decisionId,
      state,
      action,
      risk_level: riskLevel,
      family_notification: familyNotification,
      privacy_mode: privacyMode,
      alarm,
      action_card: actionCard,
      media_authorization: authorization,
    },
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

test("DemoState presentation changes stay out of the care timeline", () => {
  let state = observe(createFamilyTimelineState(), snapshot());
  state = observe(state, snapshot({ revision: 2, scene: "kitchen" }));
  state = observe(state, snapshot({
    revision: 3,
    scene: "kitchen",
    capture: "active",
    runtime: "ready",
  }));

  assert.equal(state.lastStateRevision, 3);
  assert.equal(state.events.length, 0);
  assert.equal(state.lastSnapshot.sceneId, "kitchen");
});

test("FamilyEvent care is shown as Backend authority without invented MiMo provenance", () => {
  const state = observe(
    createFamilyTimelineState(),
    snapshot(),
    [],
    familyEvent({
      state: "family_notification_required",
      action: "notify_family",
      riskLevel: 2,
      familyNotification: "午间活动比近期少，建议先问候确认。",
    }),
  );

  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, "notification");
  assert.equal(state.events[0].label, "家属通知");
  assert.equal(state.events[0].assessmentSource, "backend");
  assert.equal(state.events[0].captureLabel, "采集未开始");
  assert.equal(state.events[0].runtimeLabel, "本地运行时降级");
  assert.equal(state.events[0].timestampMs, 1_001);
});

test("action card and alarm remain separate FamilyEvent products", () => {
  const currentSnapshot = snapshot();
  let state = observe(createFamilyTimelineState(), currentSnapshot, [], familyEvent({
    revision: 1,
    state: "family_notification_required",
    action: "notify_family",
    riskLevel: 2,
    familyNotification: "今天需要家属协助。",
    actionCard: {
      event: "牙齿不舒服",
      system_judgment: "本人表达了具体生活困难",
      suggested_action: "今天联系本人并协助预约",
      time_window: "今天",
      status: "pending",
    },
  }));
  state = observe(state, currentSnapshot, [], familyEvent({
    revision: 2,
    timestampMs: 2_000,
    state: "urgent_attention",
    action: "show_urgent_attention",
    riskLevel: 4,
    familyNotification: "检测到确定性安全风险，请立即联系本人。",
    alarm: { channels: ["ring", "flash"], trigger: "visual_confirm" },
  }));

  assert.deepEqual(state.events.map((event) => event.kind), ["alarm", "action_card"]);
  assert.equal(state.events[0].tone, "danger");
  assert.equal(state.events[1].actionCard.event, "牙齿不舒服");
});

test("FamilyEvent replay does not duplicate a presentation", () => {
  const currentSnapshot = snapshot();
  const firstEvent = familyEvent({
    revision: 1,
    state: "family_notification_required",
    action: "notify_family",
    familyNotification: "请联系本人。",
  });
  let state = observe(createFamilyTimelineState(), currentSnapshot, [], firstEvent);
  state = observe(state, currentSnapshot, [], { ...firstEvent, revision: 2, published_at_ms: 2_000 });
  state = observe(state, currentSnapshot, [], familyEvent({
    revision: 3,
    timestampMs: 3_000,
    decisionId: "decision-new",
    state: "family_notification_required",
    action: "notify_family",
    familyNotification: "新的关怀通知。",
  }));

  assert.equal(state.events.length, 2);
  assert.equal(state.events[0].stateRevision, 3);
  assert.equal(state.events[1].stateRevision, 1);
});

test("authorization and Relay grant are recorded without becoming business authority", () => {
  const authorization = mediaAuthorization({ decisionId: "decision-kitchen", timestampMs: 2_000 });
  const currentSnapshot = snapshot({
    revision: 2,
    timestampMs: 2_000,
    scene: "kitchen",
    capture: "active",
    runtime: "ready",
    grant: {
      grant_id: "grant-1",
      event_id: "decision-kitchen",
      scope: "kitchen_moment",
      expires_at_ms: 4_000,
      status: "active",
    },
  });
  const state = observe(createFamilyTimelineState(), currentSnapshot, [], familyEvent({
    revision: 1,
    timestampMs: 2_000,
    decisionId: "decision-kitchen",
    state: "resolved",
    action: "notify_family",
    riskLevel: 0,
    familyNotification: "本人同意分享当前厨房片段。",
    privacyMode: "blurred",
    authorization,
  }));

  assert.deepEqual(state.events.map((event) => event.kind), [
    "notification",
    "consent",
    "media",
  ]);
});

test("a status without family copy remains a neutral care progress item", () => {
  const state = observe(createFamilyTimelineState(), snapshot(), [], familyEvent({
    state: "check_in_required",
    action: "ask_elder",
  }));

  assert.equal(state.events[0].kind, "care");
  assert.equal(state.events[0].label, "关怀进展");
  assert.doesNotMatch(state.events[0].title, /MiMo/);
});

test("room-session changes discard the previous room timeline", () => {
  let state = observe(createFamilyTimelineState(), snapshot(), [], familyEvent({
    familyNotification: "请关注。",
  }));
  state = reduceFamilyTimeline(state, {
    type: "observe",
    roomSessionId: "room-2",
    snapshot: null,
    familyEvent: null,
    acks: [],
  });

  assert.equal(state.roomSessionId, "room-2");
  assert.equal(state.events.length, 0);
  assert.equal(state.lastStateRevision, null);
});

test("only acknowledge_alarm and confirm_action_card create acknowledgement entries", () => {
  let state = observe(createFamilyTimelineState(), snapshot());
  const acks = [
    {
      command_id: "command-alarm",
      command_name: "acknowledge_alarm",
      phase: "applied",
      timestamp_ms: 3_000,
      state_revision: 2,
      reason: null,
    },
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
  ];
  state = observe(state, null, acks);
  state = observe(state, null, acks);

  assert.deepEqual(
    state.events.map((event) => event.title),
    ["家属已经确认收到行动卡", "家属已经确认收到告警"],
  );
});

test("the in-memory timeline remains bounded to its newest FamilyEvents", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  for (let revision = 2; revision <= 20; revision += 1) {
    state = observe(state, null, [], familyEvent({
      revision,
      timestampMs: revision * 1_000,
      state: "family_notification_required",
      action: "notify_family",
      familyNotification: `第 ${revision} 次关怀通知`,
    }));
  }

  assert.equal(state.events.length, FAMILY_TIMELINE_LIMIT);
  assert.equal(state.events[0].timestampMs, 20_000);
  assert.equal(state.events.at(-1).timestampMs, 9_000);
});
