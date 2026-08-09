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
  captureError = null,
  runtime = "degraded",
  runtimeDetail = null,
  care = "idle",
  decisionId = null,
  consent = "none",
  careMessage = null,
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

test("the first authoritative state creates one honest connection baseline", () => {
  const state = observe(createFamilyTimelineState(), snapshot());

  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].kind, "sync");
  assert.equal(state.events[0].label, "开始同步");
  assert.match(state.events[0].detail, /客厅日常/);
  assert.match(state.events[0].detail, /采集未开始/);
  assert.doesNotMatch(state.events[0].title, /当前位于/);
  assert.doesNotMatch(state.events[0].detail, /在线访问端/);
});

test("unchanged keepalives and replayed revisions do not create timeline noise", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 3 }));
  state = observe(state, snapshot({ revision: 4 }));
  state = observe(state, snapshot({ revision: 4, scene: "kitchen" }));
  state = observe(state, snapshot({ revision: 2, scene: "bathroom" }));

  assert.equal(state.lastStateRevision, 4);
  assert.equal(state.events.length, 1);
  assert.match(state.events[0].detail, /客厅日常/);
});

test("authoritative revision order wins when a source timestamp moves backwards", () => {
  let state = observe(createFamilyTimelineState(), snapshot({
    revision: 1,
    timestampMs: 2_000,
  }));
  state = observe(state, snapshot({
    revision: 2,
    timestampMs: 1_000,
    scene: "kitchen",
  }));

  assert.equal(state.events[0].kind, "scene");
  assert.equal(state.events[0].timestampMs, 1_000);
  assert.equal(state.events[1].kind, "sync");
});

test("meaningful state transitions become timestamped events in priority order", () => {
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
    careMessage: "正在询问本人是否安全",
    grant: {
      grant_id: "grant-1",
      event_id: "event-1",
      scope: "kitchen_moment",
      expires_at_ms: 4_000,
      status: "active",
    },
  }));

  assert.deepEqual(
    state.events.slice(0, 6).map((event) => event.kind),
    ["care", "media", "consent", "scene", "capture", "runtime"],
  );
  assert.equal(state.events.at(-1).kind, "sync");
  assert.match(
    state.events.find((event) => event.kind === "scene").detail,
    /不等同于对人员位置的判断/,
  );
});

test("room-session changes discard the previous room timeline", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ room: "room-1" }));
  state = observe(state, snapshot({ room: "room-1", revision: 2, scene: "kitchen" }));
  state = reduceFamilyTimeline(state, {
    type: "observe",
    roomSessionId: "room-2",
    snapshot: null,
    acks: [],
  });

  assert.equal(state.roomSessionId, "room-2");
  assert.equal(state.events.length, 0);
  assert.equal(state.lastStateRevision, null);

  state = observe(state, snapshot({ room: "room-2", revision: 1, scene: "bathroom" }));
  assert.equal(state.events.length, 1);
  assert.match(state.events[0].detail, /浴室隐私/);
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
  assert.equal(state.events[0].title, "家属端已确认收到告警");
});

test("the in-memory timeline remains bounded to its newest events", () => {
  let state = observe(createFamilyTimelineState(), snapshot({ revision: 1 }));
  for (let revision = 2; revision <= 20; revision += 1) {
    state = observe(state, snapshot({
      revision,
      timestampMs: revision * 1_000,
      scene: revision % 2 === 0 ? "kitchen" : "living",
    }));
  }

  assert.equal(state.events.length, FAMILY_TIMELINE_LIMIT);
  assert.equal(state.events[0].timestampMs, 20_000);
  assert.equal(state.events.at(-1).timestampMs, 9_000);
});
