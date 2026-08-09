import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeekDays,
  createTimelineState,
  dateKeyFromTimestamp,
  filterTimelineEventsByDate,
  ingestTimelineSnapshot,
  projectTimelineEvents,
  shiftDateKey,
  timelineDateHeading,
} from "./timeline.js";

function snapshot({
  room = "room-1",
  runtimeSession = "runtime-1",
  revision = 1,
  timestamp = new Date(2026, 7, 9, 10, 0).getTime(),
  scene = "living",
  captureStatus = "active",
  runtimeStatus = "ready",
  carePhase = "idle",
  consent = "none",
  alarm = false,
  message = null,
  grant = null,
} = {}) {
  return {
    schema_version: "reme-demo-state/v1",
    room_session_id: room,
    runtime_session_id: runtimeSession,
    state_revision: revision,
    timestamp_ms: timestamp,
    state: {
      scene_id: scene,
      source_generation: 1,
      capture: {
        status: captureStatus,
        source_id: "camera-user",
        source_kind: "camera",
        remote_video: "available",
        error: null,
      },
      runtime: { status: runtimeStatus, capability: "live", detail: null },
      care: {
        phase: carePhase,
        decision_id: carePhase === "idle" ? null : "decision-1",
        consent,
        alarm_authoritative: alarm,
        message,
      },
      media_grant: grant,
    },
  };
}

test("initial snapshot creates one truthful session event", () => {
  const next = ingestTimelineSnapshot(createTimelineState(), "room-1", snapshot());
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].title, "本次家庭状态已接入");
  assert.equal(next.events[0].details[0].value, "Relay 权威快照");
});

test("keepalive revisions do not fabricate timeline events", () => {
  const first = snapshot();
  let state = ingestTimelineSnapshot(createTimelineState(), "room-1", first);
  state = ingestTimelineSnapshot(state, "room-1", snapshot({ revision: 2 }));
  state = ingestTimelineSnapshot(state, "room-1", snapshot({
    revision: 3,
    message: "日常观察文案更新",
  }));
  assert.equal(state.events.length, 1);
  assert.equal(state.lastSnapshot.state_revision, 3);
});

test("meaningful snapshot changes create separate typed events", () => {
  const previous = snapshot();
  const next = snapshot({
    revision: 2,
    scene: "bathroom",
    captureStatus: "stopping",
    runtimeStatus: "degraded",
  });
  const events = projectTimelineEvents(previous, next);
  assert.deepEqual(events.map((event) => event.kind), ["scene", "device", "runtime"]);
  assert.equal(events[0].tone, "privacy");
});

test("authoritative emergency is presented as a danger event", () => {
  const events = projectTimelineEvents(snapshot(), snapshot({
    revision: 2,
    scene: "fall",
    carePhase: "emergency",
    alarm: true,
    message: "请尽快确认",
  }));
  assert.equal(events[0].kind, "care");
  assert.equal(events[0].tone, "danger");
  assert.equal(events[0].summary, "请尽快确认");
});

test("room changes clear prior history before accepting the new room", () => {
  let state = ingestTimelineSnapshot(createTimelineState(), "room-1", snapshot());
  state = ingestTimelineSnapshot(state, "room-2", null);
  assert.equal(state.roomSessionId, "room-2");
  assert.equal(state.events.length, 0);
  state = ingestTimelineSnapshot(state, "room-2", snapshot({ room: "room-2" }));
  assert.equal(state.events.length, 1);
  assert.match(state.events[0].id, /^room-2:/);
});

test("history is bounded to the newest eighty structured events", () => {
  let state = ingestTimelineSnapshot(createTimelineState(), "room-1", snapshot());
  for (let revision = 2; revision <= 95; revision += 1) {
    state = ingestTimelineSnapshot(state, "room-1", snapshot({
      revision,
      scene: revision % 2 === 0 ? "kitchen" : "living",
      timestamp: new Date(2026, 7, 9, 10, revision).getTime(),
    }));
  }
  assert.equal(state.events.length, 80);
  assert.equal(state.events[0].details[1].value, "revision 95");
});

test("week model starts on Monday, disables future days and filters by date", () => {
  const now = new Date(2026, 7, 9, 12, 0).getTime();
  const todayKey = dateKeyFromTimestamp(now);
  const days = buildWeekDays(todayKey, now);
  assert.deepEqual(days.map((day) => day.weekday), ["一", "二", "三", "四", "五", "六", "日"]);
  assert.equal(days[6].today, true);
  assert.equal(days.some((day) => day.disabled), false);
  assert.equal(shiftDateKey(todayKey, -7), "2026-08-02");
  assert.equal(timelineDateHeading(todayKey, now), "今天 · 星期日");

  const events = [
    { id: "today", dateKey: todayKey },
    { id: "past", dateKey: "2026-08-08" },
  ];
  assert.deepEqual(filterTimelineEventsByDate(events, todayKey), [events[0]]);
});
