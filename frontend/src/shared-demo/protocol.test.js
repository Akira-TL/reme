import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_SCHEMA_VERSION,
  KEYPOINT_NAMES,
  controllerProtocols,
  createPoseFrame,
  isPoseFrame,
  parsePoseFrame,
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
});

test("controller token is carried only by WebSocket subprotocol", () => {
  assert.deepEqual(controllerProtocols("a1b2"), ["reme-controller-v1", "reme-token-a1b2"]);
  assert.throws(() => controllerProtocols("not a token"), /hexadecimal/);
});
