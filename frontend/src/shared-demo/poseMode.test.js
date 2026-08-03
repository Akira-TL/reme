import assert from "node:assert/strict";
import test from "node:test";
import {
  FRAME_SCHEMA_VERSION,
  POSE_BATCH_SCHEMA_VERSION,
} from "./protocol.js";
import {
  POSE_MODE_MULTI,
  POSE_MODE_SINGLE,
  PoseEstimatorPoolClosedError,
  PoseInferenceTimeoutError,
  createPoseEstimatorPool,
  createSourceFrameFreshnessTracker,
  describePoseFrame,
  isFallAuthorityPoseFrame,
  isPoseInferenceContextCurrent,
  isSourceInferenceResultFresh,
  readSourceFrameMarker,
  releaseOwnedPoseCapture,
  runPoseInferenceWithDeadline,
  shouldArmManualFallDetection,
  sourceFrameAdvanced,
} from "./poseMode.js";

function estimator(name, disposals) {
  return {
    name,
    infer() {},
    async dispose() {
      disposals.push(name);
    },
  };
}

test("multi-pose frames are display-only and never feed fall authority", () => {
  assert.equal(isFallAuthorityPoseFrame(POSE_MODE_SINGLE, {
    schema_version: FRAME_SCHEMA_VERSION,
  }), true);
  assert.equal(isFallAuthorityPoseFrame(POSE_MODE_MULTI, {
    schema_version: POSE_BATCH_SCHEMA_VERSION,
  }), false);
  assert.equal(isFallAuthorityPoseFrame(POSE_MODE_SINGLE, {
    schema_version: POSE_BATCH_SCHEMA_VERSION,
  }), false);
  assert.equal(shouldArmManualFallDetection("fall", POSE_MODE_MULTI), false);
  assert.equal(shouldArmManualFallDetection("fall", POSE_MODE_SINGLE), true);
  assert.equal(shouldArmManualFallDetection("living", POSE_MODE_SINGLE), false);
});

test("pose summaries describe anonymous per-frame candidates without identity", () => {
  assert.deepEqual(describePoseFrame(POSE_MODE_SINGLE, {
    schema_version: FRAME_SCHEMA_VERSION,
    person_detected: true,
    landmark_quality: "degraded",
  }), { count: 1, quality: "degraded" });
  assert.deepEqual(describePoseFrame(POSE_MODE_MULTI, {
    schema_version: POSE_BATCH_SCHEMA_VERSION,
    poses: [
      { landmark_quality: "usable" },
      { landmark_quality: "degraded" },
    ],
  }), { count: 2, quality: "2 个匿名姿态 · 降级" });
  assert.deepEqual(describePoseFrame(POSE_MODE_MULTI, {
    schema_version: POSE_BATCH_SCHEMA_VERSION,
    poses: [],
  }), { count: 0, quality: "未检测到匿名姿态" });
});

test("source-frame evidence advances only with a new decoded frame", () => {
  const first = readSourceFrameMarker({
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 10 }),
    currentTime: 4,
  });
  assert.deepEqual(first, { kind: "decoded_frames", value: 10 });
  assert.equal(sourceFrameAdvanced(null, first), true);
  assert.equal(sourceFrameAdvanced(first, { ...first }), false);
  assert.equal(sourceFrameAdvanced(first, { ...first, value: 11 }), true);
  assert.equal(sourceFrameAdvanced(first, {
    kind: "webkit_decoded_frames",
    value: 11,
  }), false);
  assert.equal(readSourceFrameMarker({ currentTime: 2.5 }), null);
  assert.equal(readSourceFrameMarker({
    getVideoPlaybackQuality: () => ({ totalVideoFrames: 0 }),
    webkitDecodedFrameCount: 0,
  }), null);
});

test("source freshness fails closed without a reliable decoded-frame counter", () => {
  const tracker = createSourceFrameFreshnessTracker(3_000);
  assert.deepEqual(tracker.observe(null, 100), {
    advanced: false,
    reliable: false,
    stale: false,
  });
  assert.deepEqual(tracker.observe(null, 3_099), {
    advanced: false,
    reliable: false,
    stale: false,
  });
  assert.deepEqual(tracker.observe(null, 3_100), {
    advanced: false,
    reliable: false,
    stale: true,
  });
});

test("source freshness accepts only a strictly increasing decoded-frame count", () => {
  const tracker = createSourceFrameFreshnessTracker(3_000);
  const frame10 = { kind: "decoded_frames", value: 10 };
  assert.deepEqual(tracker.observe(frame10, 100), {
    advanced: true,
    reliable: true,
    stale: false,
  });
  assert.equal(tracker.observe(frame10, 3_099).stale, false);
  assert.equal(tracker.observe(frame10, 3_100).stale, true);
  assert.deepEqual(tracker.observe({ ...frame10, value: 11 }, 3_101), {
    advanced: true,
    reliable: true,
    stale: false,
  });
});

test("alternating decoded counter APIs cannot keep a frozen frame alive", () => {
  const tracker = createSourceFrameFreshnessTracker(3_000);
  const decoded = { kind: "decoded_frames", value: 10 };
  const webkit = { kind: "webkit_decoded_frames", value: 10 };
  assert.equal(tracker.observe(decoded, 100).advanced, true);
  assert.equal(tracker.observe(webkit, 1_000).advanced, false);
  assert.equal(tracker.observe(decoded, 2_000).advanced, false);
  assert.equal(tracker.observe(webkit, 3_100).stale, true);
});

test("inference results require the same reliable counter and a bounded age", () => {
  const startedMarker = { kind: "decoded_frames", value: 10 };
  assert.equal(isSourceInferenceResultFresh({
    startedMarker,
    currentMarker: { ...startedMarker },
    elapsedMs: 2_999,
  }), true);
  assert.equal(isSourceInferenceResultFresh({
    startedMarker,
    currentMarker: { ...startedMarker },
    elapsedMs: 3_000,
  }), false);
  assert.equal(isSourceInferenceResultFresh({
    startedMarker,
    currentMarker: { kind: "webkit_decoded_frames", value: 11 },
    elapsedMs: 100,
  }), false);
  assert.equal(isSourceInferenceResultFresh({
    startedMarker,
    currentMarker: { ...startedMarker, value: 9 },
    elapsedMs: 100,
  }), false);
});

test("visibility resume rebases the deadline but still requires a newer decoded frame", () => {
  const tracker = createSourceFrameFreshnessTracker(3_000);
  const frame10 = { kind: "decoded_frames", value: 10 };
  assert.equal(tracker.observe(frame10, 100).advanced, true);
  tracker.rebase(frame10, 10_000);
  assert.deepEqual(tracker.observe(frame10, 10_001), {
    advanced: false,
    reliable: true,
    stale: false,
  });
  assert.equal(tracker.observe(frame10, 12_999).stale, false);
  assert.equal(tracker.observe(frame10, 13_000).stale, true);
  tracker.rebase(frame10, 20_000);
  assert.equal(tracker.observe({ ...frame10, value: 11 }, 20_001).advanced, true);
});

test("pose inference context invalidates across capture, mode, pool, or stream changes", () => {
  const pool = {};
  const stream = {};
  const expected = {
    captureGeneration: 3,
    inferenceGeneration: 8,
    poseMode: POSE_MODE_MULTI,
    estimatorPool: pool,
    stream,
  };
  assert.equal(isPoseInferenceContextCurrent(expected, { ...expected }), true);
  assert.equal(isPoseInferenceContextCurrent(expected, {
    ...expected,
    inferenceGeneration: 9,
  }), false);
  assert.equal(isPoseInferenceContextCurrent(expected, {
    ...expected,
    poseMode: POSE_MODE_SINGLE,
  }), false);
  assert.equal(isPoseInferenceContextCurrent(expected, {
    ...expected,
    stream: {},
  }), false);
});

test("late capture cleanup stops only owned resources and never clears a newer capture", async () => {
  const stopped = [];
  const disposed = [];
  const oldStream = {
    getTracks: () => [{ stop: () => stopped.push("old-track") }],
  };
  const newStream = {};
  const oldPool = { dispose: async () => disposed.push("old-pool") };
  const newPool = {};
  const streamRef = { current: newStream };
  const estimatorPoolRef = { current: newPool };
  const video = { srcObject: newStream };
  await releaseOwnedPoseCapture({
    stream: oldStream,
    estimatorPool: oldPool,
    video,
    streamRef,
    estimatorPoolRef,
  });
  assert.equal(streamRef.current, newStream);
  assert.equal(estimatorPoolRef.current, newPool);
  assert.equal(video.srcObject, newStream);
  assert.deepEqual(stopped, ["old-track"]);
  assert.deepEqual(disposed, ["old-pool"]);
});

test("never-settling pose inference fails within the source freshness deadline", async () => {
  await assert.rejects(
    runPoseInferenceWithDeadline(() => new Promise(() => {}), 5),
    PoseInferenceTimeoutError,
  );
  await assert.rejects(
    runPoseInferenceWithDeadline(() => {
      throw new Error("sync inference failure");
    }, 50),
    /sync inference failure/,
  );
});

test("estimator pool lazily deduplicates each mode and disposes both", async () => {
  const loads = [];
  const disposals = [];
  const pool = createPoseEstimatorPool({
    single: async () => {
      loads.push("single");
      return estimator("single", disposals);
    },
    multi: async () => {
      loads.push("multi");
      return estimator("multi", disposals);
    },
  });

  const [first, duplicate] = await Promise.all([
    pool.load(POSE_MODE_SINGLE),
    pool.load(POSE_MODE_SINGLE),
  ]);
  assert.equal(first, duplicate);
  assert.deepEqual(loads, ["single"]);
  assert.equal(pool.peek(POSE_MODE_MULTI), null);
  await pool.load(POSE_MODE_MULTI);
  await pool.dispose();
  assert.deepEqual(disposals.sort(), ["multi", "single"]);
  await assert.rejects(pool.load(POSE_MODE_SINGLE), PoseEstimatorPoolClosedError);
});

test("estimator resolving after pool close is immediately disposed", async () => {
  const disposals = [];
  let resolveLoader;
  const pool = createPoseEstimatorPool({
    single: () => new Promise((resolve) => {
      resolveLoader = resolve;
    }),
    multi: async () => estimator("multi", disposals),
  });
  const loading = pool.load(POSE_MODE_SINGLE);
  await Promise.resolve();
  await pool.dispose();
  resolveLoader(estimator("late-single", disposals));
  await assert.rejects(loading, PoseEstimatorPoolClosedError);
  assert.deepEqual(disposals, ["late-single"]);
  assert.equal(pool.peek(POSE_MODE_SINGLE), null);
});

test("pool disposal is bounded even when a model loader never settles", async () => {
  const pool = createPoseEstimatorPool({
    single: () => new Promise(() => {}),
    multi: async () => estimator("multi", []),
  });
  void pool.load(POSE_MODE_SINGLE);
  await Promise.resolve();
  await pool.dispose();
  assert.equal(pool.isClosed(), true);
  await assert.rejects(pool.load(POSE_MODE_MULTI), PoseEstimatorPoolClosedError);
});

test("pool disposal is bounded when an active estimator dispose never settles", async () => {
  const pool = createPoseEstimatorPool({
    single: async () => ({
      infer() {},
      dispose: () => new Promise(() => {}),
    }),
    multi: async () => estimator("multi", []),
  });
  await pool.load(POSE_MODE_SINGLE);
  await pool.dispose();
  assert.equal(pool.isClosed(), true);
});

test("invalidating a poisoned estimator forces the next load to create a replacement", async () => {
  let loads = 0;
  const pool = createPoseEstimatorPool({
    single: async () => estimator("single", []),
    multi: async () => {
      loads += 1;
      return {
        infer() {},
        dispose: () => new Promise(() => {}),
      };
    },
  });
  const first = await pool.load(POSE_MODE_MULTI);
  assert.equal(pool.invalidate(POSE_MODE_MULTI), true);
  assert.equal(pool.peek(POSE_MODE_MULTI), null);
  const replacement = await pool.load(POSE_MODE_MULTI);
  assert.notEqual(replacement, first);
  assert.equal(loads, 2);
  await pool.dispose();
});
