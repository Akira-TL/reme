import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_CONFIRMATION_PROTOCOL,
  CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE,
  DEMO_EVENT_SCHEMA_VERSION,
  FRAME_SCHEMA_VERSION,
  KEYPOINT_NAMES,
  MAX_POSES_PER_BATCH,
  MEDIA_SIGNAL_SCHEMA_VERSION,
  POSE_BATCH_SCHEMA_VERSION,
  POSE_PROJECTION_PROTOCOL,
  POSE_PROJECTION_RESET_SCHEMA_VERSION,
  advanceControllerEventSequence,
  controllerProtocols,
  createActivityConfirmation,
  createDemoEvent,
  createMediaGrantRequest,
  createMediaGrantRevoke,
  createMediaSignal,
  createPoseBatchFrame,
  createPoseProjectionReset,
  createPoseFrame,
  isDemoEvent,
  isControllerReady,
  isForwardedMediaSignal,
  isHeartbeatAck,
  isMediaGrantError,
  isMediaSignal,
  isPoseBatchFrame,
  isPoseProjectionUnavailable,
  isPoseProjectionCapabilities,
  isPoseProjectionReset,
  isPoseFrame,
  isRelayCapabilities,
  parsePoseBatchFrame,
  parseDemoEvent,
  parsePoseFrame,
  parsePoseProjectionUnavailable,
  parsePoseWireFrame,
  parseForwardedMediaSignal,
  transitionActivityConfirmationCapability,
  transitionPoseProjectionCapability,
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

function batchPose(overrides = {}) {
  return {
    landmark_quality: "usable",
    keypoints: KEYPOINT_NAMES.map((name, index) => ({
      name,
      x: 0.1 + (index / 100),
      y: 0.2 + (index / 100),
      score: 0.9,
    })),
    ...overrides,
  };
}

function batchFrame(sequence = 1, sessionId = "demo-session", overrides = {}) {
  return {
    schema_version: POSE_BATCH_SCHEMA_VERSION,
    session_id: sessionId,
    sequence,
    timestamp_ms: 1000 + sequence,
    source_width: 1280,
    source_height: 720,
    poses: [batchPose(), batchPose()],
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

test("pose batch contract accepts only zero to four anonymous detected poses", () => {
  const valid = batchFrame();
  assert.equal(isPoseBatchFrame(valid), true);
  assert.deepEqual(parsePoseBatchFrame(JSON.stringify(valid)), valid);
  assert.deepEqual(parsePoseWireFrame(JSON.stringify(valid)), valid);
  assert.deepEqual(parsePoseWireFrame(JSON.stringify(frame())), frame());
  assert.equal(isPoseFrame(valid), false);
  assert.equal(isPoseBatchFrame(frame()), false);
  assert.equal(isPoseBatchFrame(batchFrame(2, "session-a", { poses: [] })), true);
  assert.equal(
    isPoseBatchFrame(batchFrame(3, "session-a", {
      poses: Array.from({ length: MAX_POSES_PER_BATCH }, () => batchPose()),
    })),
    true,
  );

  const noTorso = batchPose({
    keypoints: batchPose().keypoints.map((point, index) => (
      [11, 12].includes(index) ? { ...point, score: 0 } : point
    )),
    landmark_quality: "degraded",
  });
  const invalid = [
    { ...valid, person_count: valid.poses.length },
    { ...valid, person_detected: true },
    { ...valid, poses: Array(1) },
    { ...valid, poses: [...valid.poses, batchPose(), batchPose(), batchPose()] },
    { ...valid, poses: [{ ...batchPose(), person_id: "person-1" }] },
    { ...valid, poses: [{ ...batchPose(), pose_index: 0 }] },
    { ...valid, poses: [{ ...batchPose(), landmark_quality: "unavailable" }] },
    { ...valid, poses: [noTorso] },
    { ...valid, poses: [{ ...batchPose(), keypoints: batchPose().keypoints.slice(1) }] },
    { ...valid, video: "forbidden" },
  ];
  for (const value of invalid) assert.equal(isPoseBatchFrame(value), false);

  const sparsePoses = [];
  sparsePoses.length = 1;
  assert.equal(isPoseBatchFrame(batchFrame(4, "session-a", { poses: sparsePoses })), false);
  const sparseKeypoints = [];
  sparseKeypoints.length = KEYPOINT_NAMES.length;
  assert.equal(isPoseBatchFrame(batchFrame(5, "session-a", {
    poses: [{ ...batchPose(), keypoints: sparseKeypoints }],
  })), false);
});

test("pose batch creator maps normalized model output without identity metadata", () => {
  const modelPose = {
    landmark_quality: "usable",
    keypoints: KEYPOINT_NAMES.map((name, index) => ({
      name,
      x_norm: index / 20,
      y_norm: index / 25,
      score: 0.9,
    })),
  };
  const value = createPoseBatchFrame({
    sessionId: "session-a",
    sequence: 7,
    timestampMs: 1234,
    sourceWidth: 1080,
    sourceHeight: 1920,
    poses: [modelPose],
  });
  assert.equal(value.schema_version, POSE_BATCH_SCHEMA_VERSION);
  assert.equal(value.poses.length, 1);
  assert.deepEqual(Object.keys(value.poses[0]).sort(), ["keypoints", "landmark_quality"]);
  assert.equal(value.poses[0].keypoints[1].x, 0.05);
  assert.equal("person_id" in value.poses[0], false);
  assert.equal(createPoseBatchFrame({
    sessionId: "session-a",
    sequence: 8,
    timestampMs: 1235,
    sourceWidth: 1080,
    sourceHeight: 1920,
    poses: [{ ...modelPose, person_id: "person-1" }],
  }), null);
  assert.equal(createPoseBatchFrame({
    sessionId: "session-a",
    sequence: 8,
    timestampMs: 1235,
    sourceWidth: 1080,
    sourceHeight: 1920,
    poses: [{ ...modelPose, landmark_quality: undefined, landmarkQuality: "usable" }],
  }), null);
  assert.equal(createPoseBatchFrame({
    sessionId: "session-a",
    sequence: 8,
    timestampMs: 1235,
    sourceWidth: 1080,
    sourceHeight: 1920,
    poses: Array.from({ length: MAX_POSES_PER_BATCH + 1 }, () => modelPose),
  }), null);
  for (const [field, value] of [
    ["x_norm", "0.25"],
    ["y_norm", null],
    ["score", true],
  ]) {
    assert.equal(createPoseBatchFrame({
      sessionId: "session-a",
      sequence: 9,
      timestampMs: 1236,
      sourceWidth: 1080,
      sourceHeight: 1920,
      poses: [{
        ...modelPose,
        keypoints: modelPose.keypoints.map((point, index) => (
          index === 0 ? { ...point, [field]: value } : point
        )),
      }],
    }), null);
  }
});

test("pose projection reset consumes the shared cursor without inventing a pose", () => {
  const reset = createPoseProjectionReset({
    sessionId: "session-a",
    sequence: 11,
    timestampMs: 1200,
    poseMode: "multi",
  });
  assert.deepEqual(reset, {
    schema_version: POSE_PROJECTION_RESET_SCHEMA_VERSION,
    session_id: "session-a",
    sequence: 11,
    timestamp_ms: 1200,
    pose_mode: "multi",
  });
  assert.equal(isPoseProjectionReset(reset), true);
  assert.deepEqual(parsePoseWireFrame(JSON.stringify(reset)), reset);
  assert.equal(isPoseProjectionReset({ ...reset, poses: [] }), false);
  assert.equal(isPoseProjectionReset({ ...reset, pose_mode: "automatic" }), false);
});

test("controller-loss projection unavailable is exact and never consumes a frame sequence", () => {
  const unavailable = {
    type: "pose_projection_unavailable",
    session_id: "session-a",
    timestamp_ms: 1201,
    through_sequence: 11,
    pose_mode: "multi",
  };
  assert.equal(isPoseProjectionUnavailable(unavailable), true);
  assert.deepEqual(parsePoseProjectionUnavailable(JSON.stringify(unavailable)), unavailable);
  assert.equal(isPoseProjectionUnavailable({ ...unavailable, sequence: 12 }), false);
  assert.equal(isPoseProjectionUnavailable({ ...unavailable, pose_mode: "automatic" }), false);
  assert.equal(parsePoseWireFrame(JSON.stringify(unavailable)), null);
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

test("viewer reducer shares one monotonic cursor across single and batch frames", () => {
  let state = createViewerState();
  state = reduceViewerState(state, { type: "frame", frame: frame(2), receivedAtMs: 2000 });
  state = reduceViewerState(state, {
    type: "frame",
    frame: batchFrame(3),
    receivedAtMs: 3000,
  });
  assert.equal(state.frame.schema_version, POSE_BATCH_SCHEMA_VERSION);
  assert.equal(state.frame.sequence, 3);
  assert.deepEqual(selectViewerPresentation(state, 3100), { kind: "live", ageMs: 100 });

  const duplicateSingle = reduceViewerState(state, {
    type: "frame",
    frame: frame(3),
    receivedAtMs: 4000,
  });
  const olderBatch = reduceViewerState(state, {
    type: "frame",
    frame: batchFrame(1),
    receivedAtMs: 5000,
  });
  assert.equal(duplicateSingle, state);
  assert.equal(olderBatch, state);

  state = reduceViewerState(state, {
    type: "frame",
    frame: batchFrame(0, "session-b", { poses: [] }),
    receivedAtMs: 6000,
  });
  assert.equal(state.sessionId, "session-b");
  assert.deepEqual(selectViewerPresentation(state, 6100), { kind: "unavailable", ageMs: 100 });

  state = reduceViewerState(state, {
    type: "frame",
    frame: batchFrame(1, "session-b", {
      poses: [batchPose(), batchPose({
        landmark_quality: "degraded",
        keypoints: batchPose().keypoints.map((point, index) => (
          index === 15 ? { ...point, score: 0.1 } : point
        )),
      })],
    }),
    receivedAtMs: 6200,
  });
  assert.deepEqual(selectViewerPresentation(state, 6300), { kind: "degraded", ageMs: 100 });
});

test("projection reset and disconnect clear old skeletons immediately", () => {
  const started = reduceViewerState(createViewerState(), {
    type: "frame",
    frame: batchFrame(4, "session-a"),
    receivedAtMs: 1000,
  });
  const reset = createPoseProjectionReset({
    sessionId: "session-a",
    sequence: 5,
    timestampMs: 1001,
    poseMode: "single",
  });
  const cleared = reduceViewerState(started, {
    type: "frame",
    frame: reset,
    receivedAtMs: 1001,
  });
  assert.equal(cleared.frame.schema_version, POSE_PROJECTION_RESET_SCHEMA_VERSION);
  assert.deepEqual(selectViewerPresentation(cleared, 1002), { kind: "waiting", ageMs: 1 });
  assert.deepEqual(selectViewerPresentation(cleared, 4002), { kind: "stale", ageMs: 3001 });

  const disconnected = reduceViewerState(cleared, { type: "disconnected" });
  assert.equal(disconnected.frame, null);
  assert.equal(disconnected.receivedAtMs, null);
  assert.deepEqual(selectViewerPresentation(disconnected, 1003), {
    kind: "waiting",
    ageMs: null,
  });
});

test("authoritative controller loss clears the projection without consuming its cursor", () => {
  const started = reduceViewerState(createViewerState(), {
    type: "frame",
    frame: batchFrame(4, "session-a"),
    receivedAtMs: 1000,
  });
  const cleared = reduceViewerState(started, {
    type: "pose_projection_unavailable",
    message: {
      type: "pose_projection_unavailable",
      session_id: "session-a",
      timestamp_ms: 1001,
      through_sequence: 4,
      pose_mode: "multi",
    },
    receivedAtMs: 1001,
  });
  assert.equal(cleared.frame, null);
  assert.equal(cleared.poseMode, "multi");
  assert.equal(cleared.receivedAtMs, null);
  assert.deepEqual(selectViewerPresentation(cleared, 1002), {
    kind: "waiting",
    ageMs: null,
  });
});

test("late controller-loss unavailability cannot clear a newer resumed frame", () => {
  const resumed = reduceViewerState(createViewerState(), {
    type: "frame",
    frame: batchFrame(8, "session-a"),
    receivedAtMs: 2000,
  });
  const unchanged = reduceViewerState(resumed, {
    type: "pose_projection_unavailable",
    message: {
      type: "pose_projection_unavailable",
      session_id: "session-a",
      timestamp_ms: 2001,
      through_sequence: 7,
      pose_mode: "single",
    },
    receivedAtMs: 2001,
  });
  assert.equal(unchanged, resumed);
  assert.equal(unchanged.frame.sequence, 8);
  assert.equal(unchanged.poseMode, "multi");
});

test("controller-loss clear keeps the sequence barrier and ignores an old session", () => {
  const started = reduceViewerState(createViewerState(), {
    type: "frame",
    frame: batchFrame(8, "session-new"),
    receivedAtMs: 2000,
  });
  const cleared = reduceViewerState(started, {
    type: "pose_projection_unavailable",
    message: {
      type: "pose_projection_unavailable",
      session_id: "session-new",
      timestamp_ms: 2001,
      through_sequence: 8,
      pose_mode: "multi",
    },
    receivedAtMs: 2001,
  });
  const duplicate = reduceViewerState(cleared, {
    type: "frame",
    frame: batchFrame(8, "session-new"),
    receivedAtMs: 2002,
  });
  assert.equal(duplicate, cleared);
  const oldSessionUnavailable = reduceViewerState(cleared, {
    type: "pose_projection_unavailable",
    message: {
      type: "pose_projection_unavailable",
      session_id: "session-old",
      timestamp_ms: 2003,
      through_sequence: 99,
      pose_mode: "single",
    },
    receivedAtMs: 2003,
  });
  assert.equal(oldSessionUnavailable, cleared);
  assert.equal(oldSessionUnavailable.sessionId, "session-new");

  const olderSameSessionUnavailable = reduceViewerState(cleared, {
    type: "pose_projection_unavailable",
    message: {
      type: "pose_projection_unavailable",
      session_id: "session-new",
      timestamp_ms: 2004,
      through_sequence: 7,
      pose_mode: "single",
    },
    receivedAtMs: 2004,
  });
  assert.equal(olderSameSessionUnavailable, cleared);
  assert.equal(olderSameSessionUnavailable.poseMode, "multi");
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

test("verified activity confirmation is a capability-gated wrapper, never a public event", () => {
  const event = createDemoEvent({
    sessionId: "session-a",
    eventSequence: 12,
    timestampMs: 1_000,
    eventType: "activity_state",
    payload: {
      activity: "cooking",
      phase: "confirmed",
      source: "mimo_visual",
      confidence: 0.87,
      reason: "连续样本显示人物正在备菜",
    },
  });
  const command = createActivityConfirmation(event);
  assert.deepEqual(command, {
    type: "activity_confirmation",
    protocol: ACTIVITY_CONFIRMATION_PROTOCOL,
    event,
  });
  assert.equal(isDemoEvent(command), false);
  assert.equal(createActivityConfirmation({
    ...event,
    payload: { ...event.payload, phase: "candidate" },
  }), null);
  assert.equal(isRelayCapabilities({
    type: "relay_capabilities",
    activity_confirmation: ACTIVITY_CONFIRMATION_PROTOCOL,
  }), true);
  assert.equal(isRelayCapabilities({
    type: "relay_capabilities",
    activity_confirmation: "legacy-generic-ack",
  }), false);
  assert.equal(isRelayCapabilities({
    type: "relay_capabilities",
    activity_confirmation: ACTIVITY_CONFIRMATION_PROTOCOL,
    extra: true,
  }), false);
});

test("activity confirmation capability is monotonic for one controller connection", () => {
  assert.equal(
    transitionActivityConfirmationCapability("pending", "supported"),
    "supported",
  );
  assert.equal(
    transitionActivityConfirmationCapability("pending", "timeout"),
    "unsupported",
  );
  assert.equal(
    transitionActivityConfirmationCapability("unsupported", "supported"),
    "unsupported",
  );
  assert.equal(
    transitionActivityConfirmationCapability("supported", "timeout"),
    "supported",
  );
  assert.throws(
    () => transitionActivityConfirmationCapability("pending", "unknown"),
    /invalid activity confirmation capability signal/,
  );
});

test("pose projection capability is exact and monotonic for one controller connection", () => {
  assert.equal(isPoseProjectionCapabilities({
    type: "pose_projection_capabilities",
    pose_projection: POSE_PROJECTION_PROTOCOL,
  }), true);
  assert.equal(isPoseProjectionCapabilities({
    type: "pose_projection_capabilities",
    pose_projection: "legacy-pose-batch",
  }), false);
  assert.equal(isPoseProjectionCapabilities({
    type: "pose_projection_capabilities",
    pose_projection: POSE_PROJECTION_PROTOCOL,
    extra: true,
  }), false);
  assert.equal(
    transitionPoseProjectionCapability("pending", "supported"),
    "supported",
  );
  assert.equal(
    transitionPoseProjectionCapability("pending", "timeout"),
    "unsupported",
  );
  assert.equal(
    transitionPoseProjectionCapability("unsupported", "supported"),
    "unsupported",
  );
  assert.equal(
    transitionPoseProjectionCapability("supported", "timeout"),
    "supported",
  );
  assert.throws(
    () => transitionPoseProjectionCapability("pending", "unknown"),
    /invalid pose projection capability signal/,
  );
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
  const preCursorReady = {
    type: "controller_ready",
    session_id: ready.session_id,
    lease_expires_at_ms: ready.lease_expires_at_ms,
  };
  assert.equal(isControllerReady(preCursorReady), true);
  assert.equal(isControllerReady({ ...preCursorReady, cursor: -1 }), false);
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
