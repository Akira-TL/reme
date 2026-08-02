export const SESSION_REQUEST_SCHEMA = "reme-runtime-session-request/v0-experiment";
export const SESSION_STATUS_SCHEMA = "reme-runtime-session-status/v0-experiment";
export const RUNTIME_EVENT_SCHEMA = "reme-runtime-event/v0-experiment";
export const LANDMARKS_SCHEMA = "movenet-17/v0-experiment";
export const POSTURE_SCHEMA = "reme-posture/v0-experiment";
export const TRANSITION_SCHEMA = "reme-transition/v0-experiment";

const KEYPOINT_NAMES = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
];
const EVENT_TYPES = new Set(["frame_landmarks", "posture_observation", "transition_event"]);

export function createSceneSignal(sessionId, sceneId, signal, timestampMs) {
  if (!["activate", "switch", "reuse"].includes(signal)) throw new Error(`无效场景信号: ${signal}`);
  return {
    type: "scene_signal",
    session_id: sessionId,
    scene_id: sceneId,
    timestamp_ms: timestampMs,
    signal,
  };
}

export function createFrameMeta(sessionId, sceneId, frameIndex, timestampMs) {
  return {
    type: "frame_meta",
    session_id: sessionId,
    scene_id: sceneId,
    frame_index: frameIndex,
    timestamp_ms: timestampMs,
  };
}

export function createSessionRequest(sessionId, sceneId) {
  return {
    schema_version: SESSION_REQUEST_SCHEMA,
    session_id: sessionId,
    profile: "live_camera",
    scene_id: sceneId,
    input_source: "camera",
    perception_mode: "live",
    decision_mode: "live",
    camera_id: "c-primary-camera",
    manifest_path: null,
  };
}

export function parseRuntimeStatus(payload, sessionId) {
  if (!payload || payload.schema_version !== SESSION_STATUS_SCHEMA) return null;
  if (payload.session_id !== sessionId || payload.component !== "perception") return null;
  if (!["starting", "running", "degraded", "stopped"].includes(payload.state)) return null;
  return payload;
}

export function createEventParser(sessionId) {
  let lastSequence = -1;
  let typesAtSequence = new Set();

  return (raw) => {
    const event = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!event || event.schema_version !== RUNTIME_EVENT_SCHEMA) return null;
    if (event.session_id !== sessionId || !Number.isInteger(event.sequence) || event.sequence < 0) return null;
    if (!EVENT_TYPES.has(event.event_type) || !event.payload || typeof event.payload !== "object") return null;
    if (event.sequence < lastSequence) return null;
    if (event.sequence > lastSequence) {
      lastSequence = event.sequence;
      typesAtSequence = new Set();
    }
    if (typesAtSequence.has(event.event_type)) return null;
    typesAtSequence.add(event.event_type);
    return event;
  };
}

export function mapFrameLandmarks(payload) {
  if (!payload || payload.schema_version !== LANDMARKS_SCHEMA) return null;
  if (!payload.person_detected) return [];
  if (!Array.isArray(payload.keypoints)) return null;
  const byName = new Map(payload.keypoints.map((point) => [point.name, point]));
  const points = KEYPOINT_NAMES.map((name) => byName.get(name));
  if (points.some((point) => !point)) return null;
  const mapped = points.map((point) => ({
    x: Number(point.x_norm),
    y: Number(point.y_norm),
    score: Number(point.score),
  }));
  if (mapped.some((point) => (
    !Number.isFinite(point.x) || !Number.isFinite(point.y) || !Number.isFinite(point.score)
    || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1 || point.score < 0 || point.score > 1
  ))) return null;
  return mapped;
}

export function describePosture(posture) {
  return ({
    standing: "站立",
    sitting: "坐姿",
    lying: "躺卧",
    bending_or_crouching: "弯腰/蹲伏",
    unknown: "姿态未知",
  })[posture] || "姿态未知";
}
