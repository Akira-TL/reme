import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MULTIPOSE_CANDIDATES,
  MULTIPOSE_SCHEMA_VERSION,
  MultiPoseBrowserError,
  convertPoseLandmarkerResult,
  createMultiPoseBrowserEstimator,
  isAnonymousMultiPoseFrame,
  loadMultiPoseLandmarker,
} from "./multipose.js";
import { MOVENET_KEYPOINT_NAMES } from "./movenet.js";

const MAPPED_INDICES = [0, 2, 5, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

function mediapipePose({ offset = 0, visibility = 0.9 } = {}) {
  return Array.from({ length: 33 }, (_, index) => ({
    visibility,
    x: 0.2 + offset + index / 1000,
    y: 0.3 + offset + index / 1000,
    z: -0.1,
  }));
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function manualTimeout() {
  let callback = null;
  let cleared = false;
  return {
    clearTimeoutImpl() {
      cleared = true;
      callback = null;
    },
    fire() {
      callback?.();
    },
    get cleared() {
      return cleared;
    },
    setTimeoutImpl(nextCallback) {
      callback = nextCallback;
      return 1;
    },
  };
}

test("conversion emits distinct anonymous 17-point candidates in canonical order", () => {
  const frame = convertPoseLandmarkerResult(
    { landmarks: [mediapipePose(), mediapipePose({ offset: 0.25 })] },
    { inferenceMs: 12.5 },
  );

  assert.equal(frame.schema_version, MULTIPOSE_SCHEMA_VERSION);
  assert.equal(frame.inference_ms, 12.5);
  assert.equal(frame.poses.length, 2);
  assert.deepEqual(
    frame.poses[0].keypoints.map((point) => point.name),
    MOVENET_KEYPOINT_NAMES,
  );
  assert.deepEqual(
    frame.poses[0].keypoints.map((point) => point.x_norm),
    MAPPED_INDICES.map((index) => 0.2 + index / 1000),
  );
  assert.notDeepEqual(frame.poses[0].keypoints, frame.poses[1].keypoints);
  assert.notEqual(frame.poses[0], frame.poses[1]);
  assert.equal(frame.poses[0].landmark_quality, "usable");
  assert.equal(frame.poses[1].landmark_quality, "usable");
  assert.deepEqual(Object.keys(frame).sort(), ["inference_ms", "poses", "schema_version"]);
  for (const pose of frame.poses) {
    assert.deepEqual(Object.keys(pose).sort(), ["keypoints", "landmark_quality"]);
    assert.equal("id" in pose, false);
    assert.equal("person_id" in pose, false);
    assert.equal("pose_index" in pose, false);
    assert.equal("tracking_id" in pose, false);
  }
  assert.equal(isAnonymousMultiPoseFrame(frame), true);
});

test("conversion accepts four distinct anonymous candidates at the configured boundary", () => {
  const frame = convertPoseLandmarkerResult({
    landmarks: Array.from(
      { length: MAX_MULTIPOSE_CANDIDATES },
      (_, index) => mediapipePose({ offset: index * 0.1 }),
    ),
  });

  assert.equal(frame.poses.length, MAX_MULTIPOSE_CANDIDATES);
  assert.equal(isAnonymousMultiPoseFrame(frame), true);
  assert.equal(
    new Set(frame.poses.map((pose) => pose.keypoints[0].x_norm)).size,
    MAX_MULTIPOSE_CANDIDATES,
  );
});

test("conversion filters unusable detections and preserves degraded candidates", () => {
  const unusable = mediapipePose();
  for (const index of [11, 12, 23, 24]) unusable[index].visibility = 0.1;

  const degraded = mediapipePose();
  degraded[27].visibility = 0.1;

  const frame = convertPoseLandmarkerResult(
    { landmarks: [unusable, degraded] },
    { inferenceMs: 1, scoreThreshold: 0.2 },
  );
  assert.equal(frame.poses.length, 1);
  assert.equal(frame.poses[0].landmark_quality, "degraded");

  const empty = convertPoseLandmarkerResult({ landmarks: [] }, { inferenceMs: 0 });
  assert.deepEqual(empty.poses, []);
  assert.equal(isAnonymousMultiPoseFrame(empty), true);
});

test("conversion clamps visible coordinates but rejects corrupt confidence data", () => {
  const pose = mediapipePose();
  pose[0].x = -0.5;
  pose[0].y = 1.5;
  const frame = convertPoseLandmarkerResult({ landmarks: [pose] });
  assert.equal(frame.poses[0].keypoints[0].x_norm, 0);
  assert.equal(frame.poses[0].keypoints[0].y_norm, 1);

  const nonFinite = mediapipePose();
  nonFinite[11].x = Number.NaN;
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: [nonFinite] }),
    /contains a non-finite value/,
  );

  const invalidVisibility = mediapipePose();
  invalidVisibility[12].visibility = 1.1;
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: [invalidVisibility] }),
    /visibility must be between 0 and 1/,
  );

  for (const [field, value] of [
    ["x", "0.2"],
    ["y", false],
    ["visibility", "0.9"],
    ["visibility", null],
  ]) {
    const coercedPrimitive = mediapipePose();
    coercedPrimitive[11][field] = value;
    assert.throws(
      () => convertPoseLandmarkerResult({ landmarks: [coercedPrimitive] }),
      /contains a non-finite value/,
    );
  }
});

test("conversion fails visibly on malformed or over-capacity results", () => {
  assert.throws(
    () => convertPoseLandmarkerResult(null),
    /must contain a landmarks array/,
  );
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: [mediapipePose().slice(0, 32)] }),
    /exactly 33 landmarks/,
  );
  assert.throws(
    () => convertPoseLandmarkerResult({
      landmarks: Array.from({ length: MAX_MULTIPOSE_CANDIDATES + 1 }, () => mediapipePose()),
    }),
    /returned 5 poses/,
  );
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: [] }, { maxPoses: 0 }),
    /maxPoses must be an integer/,
  );
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: [] }, { inferenceMs: Number.NaN }),
    /inferenceMs must be a non-negative finite number/,
  );
});

test("strict contract rejects identity metadata and malformed pose fields", () => {
  const frame = convertPoseLandmarkerResult({ landmarks: [mediapipePose()] });
  assert.equal(isAnonymousMultiPoseFrame({ ...frame, person_id: "someone" }), false);
  assert.equal(isAnonymousMultiPoseFrame({
    ...frame,
    poses: [{ ...frame.poses[0], tracking_id: "stable-across-frames" }],
  }), false);
  assert.equal(isAnonymousMultiPoseFrame({
    ...frame,
    poses: [{ ...frame.poses[0], landmark_quality: "unavailable" }],
  }), false);
  assert.equal(isAnonymousMultiPoseFrame({
    ...frame,
    poses: [{
      ...frame.poses[0],
      keypoints: frame.poses[0].keypoints.map((point, index) =>
        index === 0 ? { ...point, score: Number.NaN } : point),
    }],
  }), false);
});

test("strict contract rejects sparse arrays and quality inconsistent with scores", () => {
  const frame = convertPoseLandmarkerResult({ landmarks: [mediapipePose()] });
  const sparsePoses = [];
  sparsePoses.length = 1;
  assert.equal(isAnonymousMultiPoseFrame({ ...frame, poses: sparsePoses }), false);

  const sparseKeypoints = [];
  sparseKeypoints.length = MOVENET_KEYPOINT_NAMES.length;
  assert.equal(isAnonymousMultiPoseFrame({
    ...frame,
    poses: [{ ...frame.poses[0], keypoints: sparseKeypoints }],
  }), false);
  assert.equal(isAnonymousMultiPoseFrame({
    ...frame,
    poses: [{ ...frame.poses[0], landmark_quality: "degraded" }],
  }), false);

  const hiddenTorso = frame.poses[0].keypoints.map((point) =>
    new Set(["left_shoulder", "right_shoulder", "left_hip", "right_hip"]).has(point.name)
      ? { ...point, score: 0.1 }
      : point);
  assert.equal(isAnonymousMultiPoseFrame({
    ...frame,
    poses: [{ keypoints: hiddenTorso, landmark_quality: "degraded" }],
  }), false);

  const sparseMediaPipePoses = [];
  sparseMediaPipePoses.length = 1;
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: sparseMediaPipePoses }),
    /must contain a landmarks array/,
  );
});

test("converted contract is immutable and detached from MediaPipe result mutation", () => {
  const source = mediapipePose();
  const frame = convertPoseLandmarkerResult({ landmarks: [source] });
  const originalX = frame.poses[0].keypoints[0].x_norm;
  source[0].x = 0.99;

  assert.equal(frame.poses[0].keypoints[0].x_norm, originalX);
  assert.equal(Object.isFrozen(frame), true);
  assert.equal(Object.isFrozen(frame.poses), true);
  assert.equal(Object.isFrozen(frame.poses[0]), true);
  assert.equal(Object.isFrozen(frame.poses[0].keypoints), true);
  assert.equal(Object.isFrozen(frame.poses[0].keypoints[0]), true);
});

test("estimator rejects invalid configuration before loading browser runtime", async () => {
  await assert.rejects(
    createMultiPoseBrowserEstimator({ maxPoses: 5 }),
    (error) => error instanceof MultiPoseBrowserError && /between 1 and 4/.test(error.message),
  );
  await assert.rejects(
    createMultiPoseBrowserEstimator({ delegate: "AUTO" }),
    /delegate must be CPU or GPU/,
  );
  await assert.rejects(
    createMultiPoseBrowserEstimator({ modelUrl: "" }),
    /modelUrl must be a non-empty URL/,
  );
  await assert.rejects(
    createMultiPoseBrowserEstimator({ loadTimeoutMs: 0 }),
    /loadTimeoutMs must be a positive finite number/,
  );
  await assert.rejects(
    createMultiPoseBrowserEstimator({ scoreThreshold: 0.3 }),
    /scoreThreshold is fixed at 0.2/,
  );
  assert.throws(
    () => convertPoseLandmarkerResult({ landmarks: [] }, { scoreThreshold: 0.3 }),
    /scoreThreshold is fixed at 0.2/,
  );
});

test("bounded loader closes a PoseLandmarker that resolves after timeout", async () => {
  const creation = deferred();
  const creationStarted = deferred();
  const timer = manualTimeout();
  let closeCalls = 0;
  const pending = loadMultiPoseLandmarker({
    clearTimeoutImpl: timer.clearTimeoutImpl,
    createOptions: { runningMode: "VIDEO" },
    loadTimeoutMs: 100,
    loadVisionTasks: async () => ({
      FilesetResolver: {
        forVisionTasks: async () => ({ wasm: true }),
      },
      PoseLandmarker: {
        createFromOptions() {
          creationStarted.resolve();
          return creation.promise;
        },
      },
    }),
    setTimeoutImpl: timer.setTimeoutImpl,
  });
  await creationStarted.promise;
  timer.fire();
  await assert.rejects(pending, /load timed out after 100ms/);

  creation.resolve({
    close() {
      closeCalls += 1;
    },
    detectForVideo() {},
  });
  await Promise.resolve();
  assert.equal(closeCalls, 1);
  assert.equal(timer.cleared, false);
});

test("bounded loader does not start model creation after fileset timeout", async () => {
  const fileset = deferred();
  const filesetStarted = deferred();
  const timer = manualTimeout();
  let createCalls = 0;
  const pending = loadMultiPoseLandmarker({
    clearTimeoutImpl: timer.clearTimeoutImpl,
    createOptions: {},
    loadTimeoutMs: 50,
    loadVisionTasks: async () => ({
      FilesetResolver: {
        forVisionTasks() {
          filesetStarted.resolve();
          return fileset.promise;
        },
      },
      PoseLandmarker: {
        async createFromOptions() {
          createCalls += 1;
          return { close() {}, detectForVideo() {} };
        },
      },
    }),
    setTimeoutImpl: timer.setTimeoutImpl,
  });
  await filesetStarted.promise;
  timer.fire();
  await assert.rejects(pending, /load timed out after 50ms/);

  fileset.resolve({ wasm: true });
  await Promise.resolve();
  assert.equal(createCalls, 0);
});

test("bounded loader clears its deadline after successful creation", async () => {
  const timer = manualTimeout();
  const landmarker = { close() {}, detectForVideo() {} };
  const loaded = await loadMultiPoseLandmarker({
    clearTimeoutImpl: timer.clearTimeoutImpl,
    createOptions: {},
    loadTimeoutMs: 100,
    loadVisionTasks: async () => ({
      FilesetResolver: { forVisionTasks: async () => ({ wasm: true }) },
      PoseLandmarker: { createFromOptions: async () => landmarker },
    }),
    setTimeoutImpl: timer.setTimeoutImpl,
  });
  assert.equal(loaded, landmarker);
  assert.equal(timer.cleared, true);
});
