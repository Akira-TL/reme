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

function snapshot({
  room = "room-1",
  revision = 1,
  timestampMs = 1_000 + revision,
  scene = "living",
  capture = "idle",
  captureError = null,
  runtime = "degraded",
  runtimeDetail = null,
  care = "idle",
  decisionId = null,
  consent = "none",
  careMessage = null,
  assessment = null,
  grant = null,
} = {}) {
  return {
    schema_version: "reme-demo-state/v2",
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
        phase: care,
        decision_id: decisionId,
        consent,
        alarm_authoritative: care === "emergency",
        message: careMessage,
        assessment,
      },
      media_grant: grant,
    },
  };
}

function observe(state, currentSnapshot, acks = []) {
  return reduceFamilyTimeline(state, {
    type: "observe",
    roomSessionId: currentSnapshot?.room_session_id || state.roomSessionId,
    snapshot: currentSnapshot,
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
  const state = observe(createFamilyTimelineState(), snapshot({
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
  assert.equal(state.events[0].kind, "assessment");
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
  let state = observe(createFamilyTimelineState(), snapshot({
    revision: 1,
    decisionId: "decision-1",
    assessment: careAssessment({ status: "observing", action: "observe" }),
  }));
  state = observe(state, snapshot({
    revision: 2,
    decisionId: "decision-1",
    assessment: careAssessment({ status: "observing", action: "observe" }),
  }));
  state = observe(state, snapshot({
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
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  state = observe(state, snapshot({
    revision: 2,
    timestampMs: 2_000,
    scene: "kitchen",
    capture: "active",
    runtime: "ready",
    care: "checking",
    decisionId: "decision-1",
    consent: "pending",
    assessment: careAssessment(),
    grant: {
      grant_id: "grant-1",
      event_id: "decision-1",
      scope: "kitchen_moment",
      expires_at_ms: 4_000,
      status: "active",
    },
  }));

  assert.deepEqual(
    state.events.map((event) => event.kind),
    ["assessment", "consent", "media"],
  );
  assert.equal(state.events.some((event) => event.kind === "scene"), false);
  assert.equal(state.events.some((event) => event.kind === "capture"), false);
  assert.equal(state.events.some((event) => event.kind === "runtime"), false);
});

test("a care phase without an assessment is labeled as progress, not a MiMo verdict", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  state = observe(state, snapshot({
    revision: 2,
    care: "checking",
    decisionId: "decision-fallback",
    careMessage: "奶奶，您还好吗？",
  }));

  assert.equal(state.events[0].kind, "care");
  assert.equal(state.events[0].label, "关怀进展");
  assert.doesNotMatch(state.events[0].title, /MiMo/);
  assert.equal(state.events[0].assessmentSource, null);
});

test("room-session changes discard the previous room timeline", () => {
  let state = observe(createFamilyTimelineState(), snapshot({
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

test("the in-memory timeline remains bounded to its newest judgments", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  for (let revision = 2; revision <= 20; revision += 1) {
    state = observe(state, snapshot({
      revision,
      timestampMs: revision * 1_000,
      decisionId: `decision-${revision}`,
      assessment: careAssessment({ verdict: `第 ${revision} 次关怀判断` }),
    }));
  }

  assert.equal(state.events.length, FAMILY_TIMELINE_LIMIT);
  assert.equal(state.events[0].timestampMs, 20_000);
  assert.equal(state.events.at(-1).timestampMs, 9_000);
});
