import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE,
  DEMO_EVENT_SCHEMA_VERSION,
  FRAME_SCHEMA_VERSION,
  KEYPOINT_NAMES,
  MEDIA_SIGNAL_SCHEMA_VERSION,
  advanceControllerEventSequence,
  controllerProtocols,
  createDemoEvent,
  createMediaGrantRequest,
  createMediaGrantRevoke,
  createMediaSignal,
  createPoseFrame,
  isDemoEvent,
  isControllerReady,
  isForwardedMediaSignal,
  isHeartbeatAck,
  isMediaGrantError,
  isMediaSignal,
  isPoseFrame,
  parseDemoEvent,
  parsePoseFrame,
  parseForwardedMediaSignal,
} from "./protocol.js";
import { containedContentRect, mapPointIntoContainedContent } from "./geometry.js";
import {
  createMonitorState,
  createViewerState,
  reduceMonitorState,
  reduceViewerState,
  selectViewerPresentation,
} from "./state.js";

function frame(sequence = 1, sessionId = "demo-session", overrides = {}) {
  return {
    schema_version: FRAME_SCHEMA_VERSION,
    session_id: sessionId,
    sequence,
    timestamp_ms: 1000 + sequence,
    source_width: 1280,
    source_height: 720,
    person_detected: true,
    landmark_quality: "usable",
    keypoints: KEYPOINT_NAMES.map((name) => ({ name, x: 0.5, y: 0.5, score: 0.9 })),
    ...overrides,
  };
}

test("pose contract accepts only an exact 17-point frame", () => {
  const valid = frame();
  assert.equal(isPoseFrame(valid), true);
  assert.deepEqual(parsePoseFrame(JSON.stringify(valid)), valid);
  assert.equal(isPoseFrame({ ...valid, image: "data:image/jpeg;base64,bad" }), false);
  assert.equal(isPoseFrame({ ...valid, keypoints: valid.keypoints.slice(1) }), false);
  assert.equal(isPoseFrame({ ...valid, source_width: 0 }), false);
  assert.equal(isPoseFrame({ ...valid, person_detected: false }), false);
  assert.equal(isPoseFrame({ ...valid, landmark_quality: "unavailable" }), false);
  assert.equal(
    isPoseFrame({
      ...valid,
      keypoints: valid.keypoints.map((point, index) =>
        index === 0 ? { ...point, x: Number.NaN } : point),
    }),
    false,
  );
});

test("estimator output maps x_norm/y_norm into the relay contract", () => {
  const keypoints = KEYPOINT_NAMES.map((name) => ({
    name,
    x_norm: 0.25,
    y_norm: 0.75,
    score: 0.8,
  }));
  const value = createPoseFrame({
    sessionId: "session-a",
    sequence: 7,
    timestampMs: 1234,
    sourceWidth: 1080,
    sourceHeight: 1920,
    personDetected: true,
    landmarkQuality: "usable",
    keypoints,
  });
  assert.equal(value.keypoints[0].x, 0.25);
  assert.equal(value.keypoints[0].y, 0.75);
  assert.equal("x_norm" in value.keypoints[0], false);
  assert.equal(
    createPoseFrame({
      sessionId: "session-a",
      sequence: 8,
      timestampMs: 1235,
      sourceWidth: 1080,
      sourceHeight: 1920,
      personDetected: true,
      landmarkQuality: "usable",
      keypoints: keypoints.map((point, index) =>
        index === 0 ? { ...point, name: "right_eye" } : point),
    }),
    null,
  );
});

test("pose detection and quality metadata obey the relay cross-field contract", () => {
  const degradedPoints = frame().keypoints.map((point, index) =>
    index === 15 ? { ...point, score: 0.1 } : point);
  assert.equal(isPoseFrame(frame(1, "session-a", {
    keypoints: degradedPoints,
    landmark_quality: "degraded",
  })), true);

  const unavailablePoints = frame().keypoints.map((point, index) =>
    [11, 12].includes(index) ? { ...point, score: 0.1 } : point);
  assert.equal(isPoseFrame(frame(2, "session-a", {
    keypoints: unavailablePoints,
    person_detected: false,
    landmark_quality: "unavailable",
  })), true);
  assert.equal(isPoseFrame(frame(3, "session-a", {
    person_detected: false,
    landmark_quality: "degraded",
  })), false);

  const zeroScorePoints = frame().keypoints.map((point) => ({ ...point, score: 0 }));
  assert.equal(isPoseFrame(frame(4, "session-a", {
    keypoints: zeroScorePoints,
  })), false);
  assert.equal(isPoseFrame(frame(5, "session-a", {
    person_detected: false,
    landmark_quality: "unavailable",
  })), false);

  const thresholdPoints = frame().keypoints.map((point) => ({ ...point, score: 0.21 }));
  assert.equal(isPoseFrame(frame(6, "session-a", {
    keypoints: thresholdPoints,
  })), true);
});

test("contain geometry letterboxes portrait source without stretching keypoints", () => {
  const rect = containedContentRect(1080, 1920, 1000, 500);
  assert.deepEqual(rect, { x: 359.375, y: 0, width: 281.25, height: 500 });
  assert.deepEqual(mapPointIntoContainedContent({ x: 0.5, y: 0.5, score: 0.9 }, rect), {
    x: 500,
    y: 250,
    score: 0.9,
  });
});

test("viewer reducer rejects duplicate and out-of-order sequence numbers", () => {
  let state = createViewerState();
  state = reduceViewerState(state, { type: "frame", frame: frame(2), receivedAtMs: 2000 });
  const duplicate = reduceViewerState(state, { type: "frame", frame: frame(2), receivedAtMs: 3000 });
  const older = reduceViewerState(state, { type: "frame", frame: frame(1), receivedAtMs: 4000 });
  assert.equal(duplicate, state);
  assert.equal(older, state);
  const nextSession = reduceViewerState(state, {
    type: "frame",
    frame: frame(0, "session-b"),
    receivedAtMs: 5000,
  });
  assert.equal(nextSession.frame.session_id, "session-b");
});

test("viewer reducer and presentation keep degraded and unavailable distinct from live", () => {
  let state = createViewerState();
  const degraded = frame(1, "session-a", {
    keypoints: frame().keypoints.map((point, index) =>
      index === 15 ? { ...point, score: 0.1 } : point),
    landmark_quality: "degraded",
  });
  state = reduceViewerState(state, { type: "frame", frame: degraded, receivedAtMs: 1000 });
  assert.deepEqual(selectViewerPresentation(state, 1100), { kind: "degraded", ageMs: 100 });

  const unavailable = frame(2, "session-a", {
    keypoints: frame().keypoints.map((point, index) =>
      [11, 12].includes(index) ? { ...point, score: 0.1 } : point),
    person_detected: false,
    landmark_quality: "unavailable",
  });
  state = reduceViewerState(state, { type: "frame", frame: unavailable, receivedAtMs: 1200 });
  assert.deepEqual(selectViewerPresentation(state, 1300), { kind: "unavailable", ageMs: 100 });
  assert.deepEqual(selectViewerPresentation(state, 4000), { kind: "stale", ageMs: 2800 });
});

test("monitor reducer makes failures explicit and release forgets the session", () => {
  let state = createMonitorState();
  state = reduceMonitorState(state, { type: "unlocking" });
  state = reduceMonitorState(state, { type: "unlocked", sessionId: "session-a" });
  state = reduceMonitorState(state, { type: "degraded", error: "模型加载失败" });
  assert.equal(state.phase, "degraded");
  assert.equal(state.error, "模型加载失败");
  assert.deepEqual(reduceMonitorState(state, { type: "released" }), createMonitorState());
  assert.deepEqual(
    reduceMonitorState(state, { type: "session_expired", error: "租约已到期" }),
    { ...createMonitorState(), error: "租约已到期" },
  );
});

test("controller token is carried only by WebSocket subprotocol", () => {
  assert.deepEqual(controllerProtocols("a1b2"), ["reme-controller-v1", "reme-token-a1b2"]);
  assert.throws(() => controllerProtocols("not a token"), /hexadecimal/);
});

test("demo events use exact scene, activity, care-card, alarm, and grant payloads", () => {
  const base = {
    sessionId: "session-a",
    eventSequence: 1,
    timestampMs: 1_000,
  };
  const events = [
    createDemoEvent({
      ...base,
      eventType: "scene_state",
      payload: { scene_id: "living", visual_mode: "abstract_environment" },
    }),
    createDemoEvent({
      ...base,
      eventSequence: 2,
      eventType: "activity_state",
      payload: {
        activity: "cooking",
        phase: "confirmed",
        source: "mimo_visual",
        confidence: 0.82,
        reason: "持续观察到备菜和锅具操作",
      },
    }),
    createDemoEvent({
      ...base,
      eventSequence: 3,
      eventType: "care_card",
      payload: {
        card_id: "card-1",
        event_id: "activity-1",
        kind: "family_heartbeat",
        title: "厨房里的家庭心跳",
        body: "检测到一段做饭时光，等待本人决定是否分享。",
        occurred_at_ms: 1_000,
        share_state: "consent_pending",
      },
    }),
    createDemoEvent({
      ...base,
      eventSequence: 4,
      eventType: "alarm_state",
      payload: {
        event_id: "fall-1",
        phase: "checking",
        trigger: "fall_transition",
        message: "刚才的动作有些突然，您还好吗？",
        response_deadline_ms: 9_000,
        media_scope: "none",
      },
    }),
    createDemoEvent({
      ...base,
      eventSequence: 5,
      eventType: "media_grant",
      payload: {
        grant_id: "grant-1",
        event_id: "fall-1",
        scope: "fall_emergency",
        expires_at_ms: 31_000,
        status: "active",
      },
    }),
  ];

  for (const event of events) {
    assert.notEqual(event, null);
    assert.equal(isDemoEvent(event), true);
    assert.deepEqual(parseDemoEvent(JSON.stringify(event)), event);
  }
  assert.equal(events[0].schema_version, DEMO_EVENT_SCHEMA_VERSION);
});

test("demo event privacy cross-fields fail closed", () => {
  const event = createDemoEvent({
    sessionId: "session-a",
    eventSequence: 1,
    timestampMs: 1_000,
    eventType: "scene_state",
    payload: { scene_id: "bathroom", visual_mode: "skeleton_only" },
  });
  assert.equal(isDemoEvent({
    ...event,
    payload: { scene_id: "bathroom", visual_mode: "abstract_environment" },
  }), false);
  assert.equal(isDemoEvent({
    ...event,
    payload: { ...event.payload, video: "forbidden" },
  }), false);

  const checking = createDemoEvent({
    sessionId: "session-a",
    eventSequence: 2,
    timestampMs: 1_000,
    eventType: "alarm_state",
    payload: {
      event_id: "fall-1",
      phase: "checking",
      trigger: "fall_transition",
      message: "正在确认安全",
      response_deadline_ms: 9_000,
      media_scope: "none",
    },
  });
  assert.equal(isDemoEvent({
    ...checking,
    payload: { ...checking.payload, media_scope: "fall_emergency" },
  }), false);
  assert.equal(createDemoEvent({
    sessionId: "session-a",
    eventSequence: 3,
    timestampMs: 1_000,
    eventType: "media_grant",
    payload: {
      grant_id: "grant-1",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_at_ms: 1_000,
      status: "active",
    },
  }), null);
});

test("alarm state accepts the event-scoped voice intent trigger", () => {
  const event = createDemoEvent({
    sessionId: "session-a",
    eventSequence: 6,
    timestampMs: 1_000,
    eventType: "alarm_state",
    payload: {
      event_id: "fall-voice-1",
      phase: "resolved",
      trigger: "voice_intent",
      message: "语音回应确认安全。",
      response_deadline_ms: null,
      media_scope: "none",
    },
  });
  assert.notEqual(event, null);
  assert.equal(isDemoEvent(event), true);
});

test("media signalling accepts only bounded exact SDP and ICE messages", () => {
  const offer = createMediaSignal({
    grantId: "grant-1",
    targetId: "viewer-1",
    signalType: "offer",
    signal: { sdp: "v=0" },
  });
  assert.equal(offer.schema_version, MEDIA_SIGNAL_SCHEMA_VERSION);
  assert.equal(isMediaSignal(offer), true);
  assert.equal(isMediaSignal({ ...offer, video: "no" }), false);

  const forwarded = { ...offer, from_id: "controller" };
  assert.equal(isForwardedMediaSignal(forwarded), true);
  assert.deepEqual(parseForwardedMediaSignal(JSON.stringify(forwarded)), forwarded);

  const ice = createMediaSignal({
    grantId: "grant-1",
    targetId: "controller",
    signalType: "ice_candidate",
    signal: { candidate: "candidate:1", sdp_mid: "0", sdp_mline_index: 0 },
  });
  assert.equal(isMediaSignal(ice), true);
  assert.equal(createMediaSignal({
    grantId: "grant-1",
    targetId: "controller",
    signalType: "ice_candidate",
    signal: { candidate: "candidate:1", sdp_mid: "0" },
  }), null);
});

test("media grant commands are scope-bound and short-lived", () => {
  assert.deepEqual(
    createMediaGrantRequest({ eventId: "fall-1", scope: "fall_emergency", expiresInMs: 30_000 }),
    {
      type: "media_grant_request",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_in_ms: 30_000,
    },
  );
  assert.equal(
    createMediaGrantRequest({ eventId: "fall-1", scope: "fall_emergency", expiresInMs: 120_000 }),
    null,
  );
  assert.deepEqual(createMediaGrantRevoke("grant-1"), {
    type: "media_grant_revoke",
    grant_id: "grant-1",
  });
  assert.equal(createMediaGrantRevoke("bad grant"), null);
});

test("controller event blocks leave deterministic room for Relay grant events", () => {
  const afterFirstControllerEvent = advanceControllerEventSequence(0, 0);
  assert.equal(afterFirstControllerEvent, CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE);

  assert.equal(
    advanceControllerEventSequence(afterFirstControllerEvent, 1),
    CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE,
  );
  assert.equal(
    advanceControllerEventSequence(
      afterFirstControllerEvent,
      CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE,
    ),
    CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE * 2,
  );
  assert.throws(() => advanceControllerEventSequence(-1, 0), TypeError);
});

test("controller resume messages require exact authoritative cursors", () => {
  const ready = {
    type: "controller_ready",
    session_id: "session-a",
    lease_expires_at_ms: 31_000,
    last_event_sequence: -1,
    last_frame_sequence: 42,
    current_alarm: null,
  };
  assert.equal(isControllerReady(ready), true);
  const legacyReady = { ...ready };
  delete legacyReady.current_alarm;
  assert.equal(isControllerReady(legacyReady), true);
  assert.equal(isControllerReady({ ...ready, last_frame_sequence: -2 }), false);
  assert.equal(isControllerReady({ ...ready, token: "forbidden" }), false);
  assert.equal(isControllerReady({ ...ready, session_id: "bad session" }), false);
  const currentAlarm = createDemoEvent({
    sessionId: "session-a",
    eventSequence: 7,
    timestampMs: 30_000,
    eventType: "alarm_state",
    payload: {
      event_id: "fall-123",
      phase: "escalated",
      trigger: "check_in_timeout",
      message: "完整问询窗口没有收到回应，规则已进入告警状态。",
      response_deadline_ms: null,
      media_scope: "fall_emergency",
    },
  });
  assert.equal(isControllerReady({
    ...ready,
    last_event_sequence: 7,
    current_alarm: currentAlarm,
  }), true);
  assert.equal(isControllerReady({
    ...ready,
    last_event_sequence: 6,
    current_alarm: currentAlarm,
  }), false);
  assert.equal(isControllerReady({
    ...ready,
    last_event_sequence: 7,
    current_alarm: { ...currentAlarm, session_id: "session-b" },
  }), false);

  assert.equal(isHeartbeatAck({
    type: "heartbeat_ack",
    lease_expires_at_ms: 45_000,
  }), true);
  assert.equal(isHeartbeatAck({
    type: "heartbeat_ack",
    lease_expires_at_ms: 45_000,
    session_id: "session-a",
  }), false);
});

test("media grant errors use an exact closed controller contract", () => {
  assert.equal(isMediaGrantError({ type: "error", error: "no_connected_viewers" }), true);
  assert.equal(isMediaGrantError({ type: "error", error: "media_grant_not_eligible" }), true);
  assert.equal(isMediaGrantError({ type: "error", error: "media_grant_already_active" }), true);
  assert.equal(isMediaGrantError({ type: "error", error: "unknown" }), false);
  assert.equal(isMediaGrantError({
    type: "error",
    error: "no_connected_viewers",
    detail: "forbidden expansion",
  }), false);
});
