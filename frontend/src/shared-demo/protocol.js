export const FRAME_SCHEMA_VERSION = "movenet-17/v1-demo";
export const VIEWER_PROTOCOL = "reme-viewer-v1";
export const CONTROLLER_PROTOCOL = "reme-controller-v1";
export const KEYPOINT_SCORE_THRESHOLD = 0.2;
export const LANDMARK_QUALITIES = Object.freeze(["usable", "degraded", "unavailable"]);

export const KEYPOINT_NAMES = Object.freeze([
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
]);

const FRAME_KEYS = [
  "keypoints",
  "landmark_quality",
  "person_detected",
  "schema_version",
  "sequence",
  "session_id",
  "source_height",
  "source_width",
  "timestamp_ms",
];
const KEYPOINT_KEYS = ["name", "score", "x", "y"];
const TORSO_SHOULDER_INDICES = Object.freeze([5, 6]);
const TORSO_HIP_INDICES = Object.freeze([11, 12]);
const CORE_KEYPOINT_INDICES = Object.freeze([5, 6, 11, 12, 13, 14, 15, 16]);

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isUnitNumber(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPositiveDimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 16_384;
}

export function isPoseFrame(value) {
  if (!hasExactKeys(value, FRAME_KEYS)) return false;
  if (value.schema_version !== FRAME_SCHEMA_VERSION) return false;
  if (typeof value.session_id !== "string" || value.session_id.length < 1) return false;
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) return false;
  if (!Number.isFinite(value.timestamp_ms) || value.timestamp_ms < 0) return false;
  if (!isPositiveDimension(value.source_width) || !isPositiveDimension(value.source_height)) {
    return false;
  }
  if (typeof value.person_detected !== "boolean") return false;
  if (!LANDMARK_QUALITIES.includes(value.landmark_quality)) return false;
  if (value.person_detected && value.landmark_quality === "unavailable") return false;
  if (!value.person_detected && value.landmark_quality !== "unavailable") return false;
  if (!Array.isArray(value.keypoints) || value.keypoints.length !== KEYPOINT_NAMES.length) {
    return false;
  }
  const hasValidKeypoints = value.keypoints.every((point, index) =>
    hasExactKeys(point, KEYPOINT_KEYS)
      && point.name === KEYPOINT_NAMES[index]
      && isUnitNumber(point.x)
      && isUnitNumber(point.y)
      && isUnitNumber(point.score),
  );
  if (!hasValidKeypoints) return false;

  const torsoDetected = TORSO_SHOULDER_INDICES.some(
    (index) => value.keypoints[index].score >= KEYPOINT_SCORE_THRESHOLD,
  ) && TORSO_HIP_INDICES.some(
    (index) => value.keypoints[index].score >= KEYPOINT_SCORE_THRESHOLD,
  );
  if (value.person_detected !== torsoDetected) return false;
  const expectedQuality = !torsoDetected
    ? "unavailable"
    : CORE_KEYPOINT_INDICES.every(
      (index) => value.keypoints[index].score >= KEYPOINT_SCORE_THRESHOLD,
    )
      ? "usable"
      : "degraded";
  return value.landmark_quality === expectedQuality;
}

export function parsePoseFrame(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return isPoseFrame(value) ? value : null;
  } catch {
    return null;
  }
}

export function createPoseFrame({
  sessionId,
  sequence,
  timestampMs,
  sourceWidth,
  sourceHeight,
  personDetected,
  landmarkQuality,
  keypoints,
}) {
  if (
    !Array.isArray(keypoints)
    || keypoints.length !== KEYPOINT_NAMES.length
    || !keypoints.every((point, index) => point?.name === KEYPOINT_NAMES[index])
  ) {
    return null;
  }
  const frame = {
    schema_version: FRAME_SCHEMA_VERSION,
    session_id: sessionId,
    sequence,
    timestamp_ms: timestampMs,
    source_width: sourceWidth,
    source_height: sourceHeight,
    person_detected: personDetected,
    landmark_quality: landmarkQuality,
    keypoints: keypoints.map((point) => ({
      name: point.name,
      x: Number(point.x_norm),
      y: Number(point.y_norm),
      score: Number(point.score),
    })),
  };
  return isPoseFrame(frame) ? frame : null;
}

export function controllerProtocols(token) {
  if (typeof token !== "string" || !/^[a-f0-9]+$/i.test(token)) {
    throw new TypeError("controller token must be hexadecimal");
  }
  return [CONTROLLER_PROTOCOL, `reme-token-${token}`];
}
