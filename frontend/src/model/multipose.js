import {
  KEYPOINT_SCORE_THRESHOLD,
  MAX_POSES_PER_BATCH,
  POSE_BATCH_SCHEMA_VERSION,
} from "../shared-demo/protocol.js";
import {
  MOVENET_KEYPOINT_NAMES,
  deriveLandmarkQuality,
  torsoDetected,
} from "./movenet.js";

export const MULTIPOSE_SCHEMA_VERSION = POSE_BATCH_SCHEMA_VERSION;
export const MAX_MULTIPOSE_CANDIDATES = MAX_POSES_PER_BATCH;

const DEFAULT_MODEL_URL = "/mediapipe/pose_landmarker_lite.task";
const DEFAULT_WASM_URL = "/mediapipe/wasm";
const DEFAULT_LOAD_TIMEOUT_MS = 15_000;
const MEDIAPIPE_LANDMARK_COUNT = 33;

// MediaPipe Pose Landmarker uses 33 landmarks. These indices select the same
// ordered 17 anatomical points exposed by the existing MoveNet adapter.
const MEDIAPIPE_TO_MOVENET_INDICES = Object.freeze([
  0, // nose
  2, // left_eye
  5, // right_eye
  7, // left_ear
  8, // right_ear
  11, // left_shoulder
  12, // right_shoulder
  13, // left_elbow
  14, // right_elbow
  15, // left_wrist
  16, // right_wrist
  23, // left_hip
  24, // right_hip
  25, // left_knee
  26, // right_knee
  27, // left_ankle
  28, // right_ankle
]);

const FRAME_KEYS = Object.freeze(["inference_ms", "poses", "schema_version"]);
const POSE_KEYS = Object.freeze(["keypoints", "landmark_quality"]);
const KEYPOINT_KEYS = Object.freeze(["name", "score", "x_norm", "y_norm"]);

export class MultiPoseBrowserError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MultiPoseBrowserError";
  }
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === value.length
    && keys.every((key, index) => key === String(index));
}

function isNormalizedScore(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isNormalizedCoordinate(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function assertUnitInterval(value, label) {
  if (!isNormalizedScore(value)) {
    throw new MultiPoseBrowserError(`${label} must be between 0 and 1`);
  }
}

function assertSchemaScoreThreshold(value) {
  if (value !== KEYPOINT_SCORE_THRESHOLD) {
    throw new MultiPoseBrowserError(
      `scoreThreshold is fixed at ${KEYPOINT_SCORE_THRESHOLD} for ${MULTIPOSE_SCHEMA_VERSION}`,
    );
  }
}

function assertMaxPoses(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_MULTIPOSE_CANDIDATES) {
    throw new MultiPoseBrowserError(
      `maxPoses must be an integer between 1 and ${MAX_MULTIPOSE_CANDIDATES}`,
    );
  }
}

/**
 * Strict wire-ready contract check. A pose intentionally has no stable ID,
 * array index field, tracking token, or detection metadata.
 */
export function isAnonymousMultiPoseFrame(
  value,
  scoreThreshold = KEYPOINT_SCORE_THRESHOLD,
) {
  if (scoreThreshold !== KEYPOINT_SCORE_THRESHOLD) return false;
  if (!hasExactKeys(value, FRAME_KEYS)) return false;
  if (value.schema_version !== MULTIPOSE_SCHEMA_VERSION) return false;
  if (!Number.isFinite(value.inference_ms) || value.inference_ms < 0) return false;
  if (!isDenseArray(value.poses) || value.poses.length > MAX_MULTIPOSE_CANDIDATES) {
    return false;
  }

  return value.poses.every((pose) => {
    if (!hasExactKeys(pose, POSE_KEYS)
      || !new Set(["usable", "degraded"]).has(pose.landmark_quality)
      || !isDenseArray(pose.keypoints)
      || pose.keypoints.length !== MOVENET_KEYPOINT_NAMES.length
      || !pose.keypoints.every((keypoint, index) =>
      hasExactKeys(keypoint, KEYPOINT_KEYS)
      && keypoint.name === MOVENET_KEYPOINT_NAMES[index]
      && isNormalizedCoordinate(keypoint.x_norm)
      && isNormalizedCoordinate(keypoint.y_norm)
      && isNormalizedScore(keypoint.score))) {
      return false;
    }
    try {
      if (!torsoDetected(pose.keypoints, scoreThreshold)) return false;
      return deriveLandmarkQuality(pose.keypoints, true, scoreThreshold)
        === pose.landmark_quality;
    } catch {
      return false;
    }
  });
}

function clampCoordinate(value) {
  return Math.min(1, Math.max(0, value));
}

function convertLandmarkPose(landmarks, poseIndex, scoreThreshold) {
  if (!isDenseArray(landmarks) || landmarks.length !== MEDIAPIPE_LANDMARK_COUNT) {
    throw new MultiPoseBrowserError(
      `MediaPipe pose ${poseIndex} must contain exactly ${MEDIAPIPE_LANDMARK_COUNT} landmarks`,
    );
  }

  const keypoints = MEDIAPIPE_TO_MOVENET_INDICES.map((landmarkIndex, index) => {
    const landmark = landmarks[landmarkIndex];
    const x = landmark?.x;
    const y = landmark?.y;
    const score = landmark?.visibility;
    if (
      typeof x !== "number"
      || typeof y !== "number"
      || typeof score !== "number"
      || ![x, y, score].every(Number.isFinite)
    ) {
      throw new MultiPoseBrowserError(
        `MediaPipe pose ${poseIndex} landmark ${landmarkIndex} contains a non-finite value`,
      );
    }
    assertUnitInterval(score, `MediaPipe pose ${poseIndex} landmark ${landmarkIndex} visibility`);
    return Object.freeze({
      name: MOVENET_KEYPOINT_NAMES[index],
      x_norm: clampCoordinate(x),
      y_norm: clampCoordinate(y),
      score,
    });
  });

  const frozenKeypoints = Object.freeze(keypoints);
  if (!torsoDetected(frozenKeypoints, scoreThreshold)) return null;

  return Object.freeze({
    keypoints: frozenKeypoints,
    landmark_quality: deriveLandmarkQuality(frozenKeypoints, true, scoreThreshold),
  });
}

/**
 * Convert one synchronous MediaPipe result into anonymous per-frame poses.
 * Unusable detections are omitted instead of being promoted into a person.
 */
export function convertPoseLandmarkerResult(
  result,
  {
    inferenceMs = 0,
    maxPoses = MAX_MULTIPOSE_CANDIDATES,
    scoreThreshold = KEYPOINT_SCORE_THRESHOLD,
  } = {},
) {
  assertMaxPoses(maxPoses);
  assertSchemaScoreThreshold(scoreThreshold);
  if (!Number.isFinite(inferenceMs) || inferenceMs < 0) {
    throw new MultiPoseBrowserError("inferenceMs must be a non-negative finite number");
  }
  if (!result || !isDenseArray(result.landmarks)) {
    throw new MultiPoseBrowserError("MediaPipe result must contain a landmarks array");
  }
  if (result.landmarks.length > maxPoses) {
    throw new MultiPoseBrowserError(
      `MediaPipe returned ${result.landmarks.length} poses; configured maximum is ${maxPoses}`,
    );
  }

  const poses = [];
  result.landmarks.forEach((landmarks, poseIndex) => {
    const pose = convertLandmarkPose(landmarks, poseIndex, scoreThreshold);
    if (pose) poses.push(pose);
  });

  const frame = Object.freeze({
    schema_version: MULTIPOSE_SCHEMA_VERSION,
    poses: Object.freeze(poses),
    inference_ms: inferenceMs,
  });
  if (!isAnonymousMultiPoseFrame(frame, scoreThreshold)) {
    throw new MultiPoseBrowserError("converted MediaPipe result violates the anonymous pose contract");
  }
  return frame;
}

function monotonicNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function assertUrl(value, label) {
  if ((typeof value !== "string" && !(value instanceof URL)) || String(value).length === 0) {
    throw new MultiPoseBrowserError(`${label} must be a non-empty URL`);
  }
}

function assertLoadTimeout(value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MultiPoseBrowserError("loadTimeoutMs must be a positive finite number");
  }
}

/**
 * Bound all asynchronous MediaPipe initialization behind one deadline. If the
 * native landmarker resolves after that deadline, it is closed immediately so
 * an abandoned camera-mode switch cannot leave a WASM graph alive.
 */
export async function loadMultiPoseLandmarker({
  clearTimeoutImpl = clearTimeout,
  createOptions,
  loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
  loadVisionTasks = () => import("@mediapipe/tasks-vision"),
  setTimeoutImpl = setTimeout,
  wasmUrl = DEFAULT_WASM_URL,
} = {}) {
  assertLoadTimeout(loadTimeoutMs);
  if (typeof clearTimeoutImpl !== "function" || typeof setTimeoutImpl !== "function") {
    throw new MultiPoseBrowserError("load timeout functions must be callable");
  }
  if (typeof loadVisionTasks !== "function") {
    throw new MultiPoseBrowserError("loadVisionTasks must be callable");
  }

  let deadlineReached = false;
  const timeoutError = new MultiPoseBrowserError(
    `MediaPipe multi-pose model load timed out after ${loadTimeoutMs}ms`,
  );
  let timeoutId;
  const timeout = new Promise((resolve, reject) => {
    timeoutId = setTimeoutImpl(() => {
      deadlineReached = true;
      reject(timeoutError);
    }, loadTimeoutMs);
  });
  const setup = (async () => {
    const visionTasks = await loadVisionTasks();
    if (deadlineReached) throw timeoutError;
    if (typeof visionTasks?.FilesetResolver?.forVisionTasks !== "function"
      || typeof visionTasks?.PoseLandmarker?.createFromOptions !== "function") {
      throw new MultiPoseBrowserError("MediaPipe vision runtime has an unexpected API");
    }
    const fileset = await visionTasks.FilesetResolver.forVisionTasks(wasmUrl);
    if (deadlineReached) throw timeoutError;
    const candidate = await visionTasks.PoseLandmarker.createFromOptions(fileset, createOptions);
    if (deadlineReached) {
      try {
        candidate?.close?.();
      } catch {
        // The deadline failure remains authoritative; cleanup was attempted.
      }
      throw timeoutError;
    }
    if (!candidate
      || typeof candidate.detectForVideo !== "function"
      || typeof candidate.close !== "function") {
      candidate?.close?.();
      throw new MultiPoseBrowserError("MediaPipe PoseLandmarker has an unexpected API");
    }
    return candidate;
  })();

  try {
    return await Promise.race([setup, timeout]);
  } finally {
    if (!deadlineReached) clearTimeoutImpl(timeoutId);
  }
}

/**
 * Create a local-only MediaPipe Pose Landmarker configured for up to four real
 * detections. The package is loaded lazily so viewer bundles never initialize
 * camera inference merely by importing shared presentation code.
 */
export async function createMultiPoseBrowserEstimator({
  delegate = "CPU",
  loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
  maxPoses = MAX_MULTIPOSE_CANDIDATES,
  minPoseDetectionConfidence = 0.5,
  minPosePresenceConfidence = 0.5,
  minTrackingConfidence = 0.5,
  modelUrl = DEFAULT_MODEL_URL,
  scoreThreshold = KEYPOINT_SCORE_THRESHOLD,
  wasmUrl = DEFAULT_WASM_URL,
} = {}) {
  assertUrl(modelUrl, "modelUrl");
  if (typeof wasmUrl !== "string" || wasmUrl.length === 0) {
    throw new MultiPoseBrowserError("wasmUrl must be a non-empty directory URL");
  }
  if (!new Set(["CPU", "GPU"]).has(delegate)) {
    throw new MultiPoseBrowserError("delegate must be CPU or GPU");
  }
  assertMaxPoses(maxPoses);
  assertLoadTimeout(loadTimeoutMs);
  assertSchemaScoreThreshold(scoreThreshold);
  assertUnitInterval(minPoseDetectionConfidence, "minPoseDetectionConfidence");
  assertUnitInterval(minPosePresenceConfidence, "minPosePresenceConfidence");
  assertUnitInterval(minTrackingConfidence, "minTrackingConfidence");

  let landmarker;
  try {
    landmarker = await loadMultiPoseLandmarker({
      createOptions: {
        baseOptions: {
          delegate,
          modelAssetPath: String(modelUrl),
        },
        minPoseDetectionConfidence,
        minPosePresenceConfidence,
        minTrackingConfidence,
        numPoses: maxPoses,
        outputSegmentationMasks: false,
        runningMode: "VIDEO",
      },
      loadTimeoutMs,
      wasmUrl,
    });
  } catch (error) {
    if (error instanceof MultiPoseBrowserError) throw error;
    throw new MultiPoseBrowserError("failed to load the MediaPipe multi-pose browser model", {
      cause: error,
    });
  }

  const details = Object.freeze({
    delegate,
    loadTimeoutMs,
    maxPoses,
    modelUrl: String(modelUrl),
    schemaVersion: MULTIPOSE_SCHEMA_VERSION,
    scoreThreshold,
    wasmUrl,
  });
  let closed = false;
  let inferenceQueue = Promise.resolve();
  let lastTimestamp = -1;
  let disposal = null;

  function inferOne(source, requestedTimestamp) {
    if (!source || (typeof source !== "object" && typeof source !== "function")) {
      throw new MultiPoseBrowserError("infer(source) requires a browser image source");
    }
    let timestamp = requestedTimestamp ?? monotonicNow();
    if (!Number.isFinite(timestamp) || timestamp < 0) {
      throw new MultiPoseBrowserError("inference timestamp must be a non-negative finite number");
    }
    if (timestamp <= lastTimestamp) timestamp = lastTimestamp + 0.001;
    lastTimestamp = timestamp;

    try {
      const started = monotonicNow();
      const result = landmarker.detectForVideo(source, timestamp);
      const inferenceMs = monotonicNow() - started;
      return convertPoseLandmarkerResult(result, {
        inferenceMs,
        maxPoses,
        scoreThreshold,
      });
    } catch (error) {
      if (error instanceof MultiPoseBrowserError) throw error;
      throw new MultiPoseBrowserError("MediaPipe multi-pose browser inference failed", {
        cause: error,
      });
    }
  }

  return Object.freeze({
    details,
    infer(source, timestamp) {
      if (closed) {
        return Promise.reject(new MultiPoseBrowserError("multi-pose estimator is disposed"));
      }
      const inference = inferenceQueue.then(() => inferOne(source, timestamp));
      inferenceQueue = inference.catch(() => undefined);
      return inference;
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      disposal = inferenceQueue.then(() => {
        try {
          landmarker.close();
        } catch (error) {
          throw new MultiPoseBrowserError("failed to dispose the multi-pose estimator", {
            cause: error,
          });
        }
      });
      return disposal;
    },
  });
}
