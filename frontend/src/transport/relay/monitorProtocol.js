// @ts-check

/**
 * Exact Monitor <-> Relay wire protocol.
 *
 * This module is deliberately React-free and transport-lifecycle-free. It is
 * the runtime validation boundary for messages crossing the public Relay.
 */

export const MONITOR_PROTOCOL = "reme-monitor-v1";
export const TOKEN_PROTOCOL_PREFIX = "reme-token-";
export const DEMO_STATE_SCHEMA = "reme-demo-state/v1";
export const POSE_FRAME_SCHEMA = "reme-pose-frame-17/v1";
export const CONTROL_COMMAND_SCHEMA = "reme-control-command/v1";
export const MEDIA_SIGNAL_SCHEMA = "reme-media-signal/v1";
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const MAX_RELAY_JSON_BYTES = 16_384;

const CONTROL_ACK_PHASES = new Set([
  "received",
  "awaiting_local_confirmation",
  "applied",
  "rejected",
  "failed",
]);
const SCENE_IDS = new Set(["living", "kitchen", "bathroom", "fall"]);
const SOURCE_KINDS = new Set(["camera", "display", "file"]);
const CAPTURE_STATES = new Set([
  "idle",
  "awaiting_local_confirmation",
  "starting",
  "active",
  "stopping",
  "error",
]);
const REMOTE_VIDEO_STATES = new Set(["available", "local_only", "unavailable"]);
const RUNTIME_STATES = new Set(["offline", "connecting", "ready", "degraded", "error"]);
const RUNTIME_CAPABILITIES = new Set(["live", "scripted", "unavailable"]);
const KEYPOINT_NAMES = [
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
];
const FORBIDDEN_MEDIA_KEYS = new Set([
  "audio",
  "base64",
  "binary",
  "blob",
  "clip",
  "clip_data",
  "data_url",
  "frame_data",
  "image",
  "image_data",
  "image_url",
  "jpeg",
  "media_bytes",
  "payload_bytes",
  "raw_frame",
  "raw_video",
  "video_bytes",
]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} keys
 */
export function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

/** @param {unknown} value */
export function isId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

/** @param {unknown} value */
export function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/** @param {unknown} value */
export function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * @param {unknown} value
 * @param {number} maximum
 * @param {boolean} [allowEmpty]
 */
export function isBoundedString(value, maximum, allowEmpty = false) {
  return typeof value === "string"
    && value.length <= maximum
    && (allowEmpty || value.length > 0);
}

/** @param {unknown} value */
function isUnitNumber(value) {
  return typeof value === "number" && isFiniteNonNegative(value) && value <= 1;
}

/** @param {any} value */
export function validController(value) {
  return value === null || (
    exactKeys(value, ["viewer_id", "lease_id", "expires_at_ms"])
    && isId(value.viewer_id)
    && isId(value.lease_id)
    && isFiniteNonNegative(value.expires_at_ms)
  );
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function containsForbiddenRawMedia(value) {
  if (typeof value === "string") return /^data:(?:image|video|audio)\//i.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenRawMedia);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_MEDIA_KEYS.has(key.toLowerCase()) || containsForbiddenRawMedia(child)
  ));
}

/** @param {string | URL} relayUrl */
export function resolveMonitorRelayEndpoints(relayUrl) {
  const url = new URL(relayUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Relay URL 必须使用 http 或 https");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const claimUrl = new URL("api/monitor/claim", url);
  const monitorWsUrl = new URL("ws/monitor", url);
  monitorWsUrl.protocol = monitorWsUrl.protocol === "https:" ? "wss:" : "ws:";
  return Object.freeze({ claimUrl: claimUrl.href, monitorWsUrl: monitorWsUrl.href });
}

/** @param {any} value */
export function validateClaim(value) {
  return exactKeys(value, [
    "room_name",
    "room_session_id",
    "producer_token",
    "expires_at_ms",
  ])
    && value.room_name === "shared-live-demo"
    && isId(value.room_session_id)
    && typeof value.producer_token === "string"
    && /^[a-f0-9]{64}$/.test(value.producer_token)
    && isFiniteNonNegative(value.expires_at_ms);
}

/** @param {any} value */
function validateCapture(value) {
  if (!exactKeys(value, ["status", "source_id", "source_kind", "remote_video", "error"])) {
    return false;
  }
  if (!CAPTURE_STATES.has(value.status)) return false;
  if (value.source_id !== null && !isId(value.source_id)) return false;
  if (value.source_kind !== null && !SOURCE_KINDS.has(value.source_kind)) return false;
  if (!REMOTE_VIDEO_STATES.has(value.remote_video)) return false;
  if (value.error !== null && !isBoundedString(value.error, 240)) return false;
  return value.status !== "active" || (value.source_id !== null && value.source_kind !== null);
}

/** @param {any} value */
function validateRuntime(value) {
  return exactKeys(value, ["status", "capability", "detail"])
    && RUNTIME_STATES.has(value.status)
    && RUNTIME_CAPABILITIES.has(value.capability)
    && (value.detail === null || isBoundedString(value.detail, 240));
}

/** @param {any} value */
function validateCare(value) {
  if (!exactKeys(value, [
    "phase",
    "decision_id",
    "consent",
    "alarm_authoritative",
    "message",
  ])) return false;
  if (!["idle", "checking", "emergency", "resolved"].includes(value.phase)
    || (value.decision_id !== null && !isId(value.decision_id))
    || !["none", "pending", "granted", "denied"].includes(value.consent)
    || typeof value.alarm_authoritative !== "boolean"
    || (value.message !== null && !isBoundedString(value.message, 240))) return false;
  return value.phase === "emergency"
    ? value.alarm_authoritative && value.decision_id !== null
    : !value.alarm_authoritative;
}

/**
 * @param {any} value
 * @param {unknown} [roomSessionId]
 */
export function validateDemoStateEnvelope(value, roomSessionId = value?.room_session_id) {
  if (!exactKeys(value, [
    "schema_version",
    "room_session_id",
    "runtime_session_id",
    "state_revision",
    "timestamp_ms",
    "state",
  ])) return false;
  if (
    value.schema_version !== DEMO_STATE_SCHEMA
    || value.room_session_id !== roomSessionId
    || !isId(value.room_session_id)
    || !isId(value.runtime_session_id)
    || !isNonNegativeInteger(value.state_revision)
    || !isFiniteNonNegative(value.timestamp_ms)
  ) return false;
  const state = value.state;
  return exactKeys(state, [
    "scene_id",
    "source_generation",
    "capture",
    "runtime",
    "care",
    "media_grant",
  ])
    && SCENE_IDS.has(state.scene_id)
    && isNonNegativeInteger(state.source_generation)
    && validateCapture(state.capture)
    && validateRuntime(state.runtime)
    && validateCare(state.care)
    && state.media_grant === null
    && !containsForbiddenRawMedia(value);
}

/** @param {any} parameters */
export function createDemoStateEnvelope({
  roomSessionId,
  runtimeSessionId,
  stateRevision,
  state,
  timestampMs = Date.now(),
}) {
  const value = {
    schema_version: DEMO_STATE_SCHEMA,
    room_session_id: roomSessionId,
    runtime_session_id: runtimeSessionId,
    state_revision: stateRevision,
    timestamp_ms: timestampMs,
    state: { ...state, media_grant: null },
  };
  if (!validateDemoStateEnvelope(value, roomSessionId)) {
    throw new TypeError("无效的 Monitor demo state");
  }
  return value;
}

/** @param {any} parameters */
export function createPoseFrame({
  roomSessionId,
  runtimeSessionId,
  frameSequence,
  timestampMs = Date.now(),
  sourceWidth,
  sourceHeight,
  landmarks,
  landmarkQuality = "usable",
}) {
  const personDetected = Array.isArray(landmarks) && landmarks.length === KEYPOINT_NAMES.length;
  const value = {
    schema_version: POSE_FRAME_SCHEMA,
    room_session_id: roomSessionId,
    runtime_session_id: runtimeSessionId,
    frame_sequence: frameSequence,
    timestamp_ms: timestampMs,
    source_width: sourceWidth,
    source_height: sourceHeight,
    person_detected: personDetected,
    landmark_quality: personDetected && (landmarkQuality === "usable" || landmarkQuality === "degraded")
      ? landmarkQuality
      : "unavailable",
    keypoints: personDetected ? KEYPOINT_NAMES.map((name, index) => ({
      name,
      x: Number(landmarks[index]?.x),
      y: Number(landmarks[index]?.y),
      score: Number(landmarks[index]?.score),
    })) : [],
  };
  if (!validatePoseFrame(value, roomSessionId, runtimeSessionId)) {
    throw new TypeError("无效的 17 点 pose frame");
  }
  return value;
}

/**
 * @param {any} value
 * @param {unknown} roomSessionId
 * @param {unknown} runtimeSessionId
 */
export function validatePoseFrame(value, roomSessionId, runtimeSessionId) {
  if (!exactKeys(value, [
    "schema_version",
    "room_session_id",
    "runtime_session_id",
    "frame_sequence",
    "timestamp_ms",
    "source_width",
    "source_height",
    "person_detected",
    "landmark_quality",
    "keypoints",
  ])) return false;
  if (
    value.schema_version !== POSE_FRAME_SCHEMA
    || value.room_session_id !== roomSessionId
    || value.runtime_session_id !== runtimeSessionId
    || !isNonNegativeInteger(value.frame_sequence)
    || !isFiniteNonNegative(value.timestamp_ms)
    || !Number.isSafeInteger(value.source_width)
    || value.source_width <= 0
    || value.source_width > 16_384
    || !Number.isSafeInteger(value.source_height)
    || value.source_height <= 0
    || value.source_height > 16_384
    || typeof value.person_detected !== "boolean"
    || !Array.isArray(value.keypoints)
  ) return false;
  if (!value.person_detected) {
    return value.landmark_quality === "unavailable" && value.keypoints.length === 0;
  }
  return (value.landmark_quality === "usable" || value.landmark_quality === "degraded")
    && value.keypoints.length === KEYPOINT_NAMES.length
    && value.keypoints.every((
      /** @type {any} */ point,
      /** @type {number} */ index,
    ) => (
      exactKeys(point, ["name", "x", "y", "score"])
      && point.name === KEYPOINT_NAMES[index]
      && isUnitNumber(point.x)
      && isUnitNumber(point.y)
      && isUnitNumber(point.score)
    ))
    && !containsForbiddenRawMedia(value);
}

/** @param {any} value */
function validateCommandBody(value) {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.name === "select_scene") {
    return exactKeys(value, ["name", "scene_id"])
      && typeof value.scene_id === "string"
      && SCENE_IDS.has(value.scene_id);
  }
  if (value.name === "select_source") {
    return exactKeys(value, ["name", "source_id"]) && isId(value.source_id);
  }
  if (["start_capture", "stop_capture", "reset_demo"].includes(value.name)) {
    return exactKeys(value, ["name"]);
  }
  if (value.name === "run_demo_scenario") {
    return exactKeys(value, ["name", "scenario"])
      && (value.scenario === "normal" || value.scenario === "fall");
  }
  if (value.name === "start_conversation") {
    return exactKeys(value, ["name", "scenario"])
      && (value.scenario === "proactive_check_in" || value.scenario === "kitchen_share");
  }
  if (value.name === "submit_response") {
    return exactKeys(value, ["name", "decision_id", "response"])
      && isId(value.decision_id)
      && typeof value.response === "string"
      && ["safe", "need_help", "consent_granted", "consent_denied"].includes(value.response);
  }
  if ([
    "acknowledge_alarm",
    "confirm_alarm",
    "confirm_action_card",
    "replay_voice",
  ].includes(value.name)) {
    return exactKeys(value, ["name", "decision_id"]) && isId(value.decision_id);
  }
  return false;
}

/** @param {any} value */
export function validateControlCommand(value) {
  return exactKeys(value, [
    "schema_version",
    "room_session_id",
    "command_id",
    "command_sequence",
    "issued_at_ms",
    "expires_at_ms",
    "expected_state_revision",
    "command",
  ])
    && value.schema_version === CONTROL_COMMAND_SCHEMA
    && isId(value.room_session_id)
    && isId(value.command_id)
    && isNonNegativeInteger(value.command_sequence)
    && value.command_sequence > 0
    && isFiniteNonNegative(value.issued_at_ms)
    && isFiniteNonNegative(value.expires_at_ms)
    && value.expires_at_ms > value.issued_at_ms
    && isNonNegativeInteger(value.expected_state_revision)
    && validateCommandBody(value.command)
    && !containsForbiddenRawMedia(value);
}

/** @param {any} parameters */
export function createExactControlAck({
  roomSessionId,
  commandId,
  phase,
  timestampMs = Date.now(),
  stateRevision = null,
  reason = null,
}) {
  const value = {
    type: "control_ack",
    room_session_id: roomSessionId,
    command_id: commandId,
    phase,
    timestamp_ms: timestampMs,
    state_revision: stateRevision,
    reason,
  };
  if (
    !isId(roomSessionId)
    || !isId(commandId)
    || !CONTROL_ACK_PHASES.has(phase)
    || !isFiniteNonNegative(timestampMs)
    || (stateRevision !== null && !isNonNegativeInteger(stateRevision))
    || (reason !== null && !isBoundedString(reason, 240))
  ) throw new TypeError("无效的 control_ack");
  if (phase === "applied" && stateRevision === null) {
    throw new TypeError("applied ACK 必须包含 state revision");
  }
  return value;
}

/**
 * @param {any} value
 * @param {boolean} [forwarded]
 */
export function validMediaSignal(value, forwarded = false) {
  const keys = [
    "schema_version",
    "room_session_id",
    "grant_id",
    "target_id",
    "signal_type",
    "signal",
  ];
  if (forwarded) keys.push("from_id");
  if (!exactKeys(value, keys)) return false;
  if (
    value.schema_version !== MEDIA_SIGNAL_SCHEMA
    || !isId(value.room_session_id)
    || !isId(value.grant_id)
    || !(value.target_id === "monitor" || isId(value.target_id))
    || (forwarded && !isId(value.from_id))
  ) return false;
  if (value.signal_type === "offer" || value.signal_type === "answer") {
    return exactKeys(value.signal, ["type", "sdp"])
      && value.signal.type === value.signal_type
      && isBoundedString(value.signal.sdp, 12_000)
      && !containsForbiddenRawMedia(value);
  }
  return value.signal_type === "ice_candidate"
    && exactKeys(value.signal, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
    && isBoundedString(value.signal.candidate, 4_096, true)
    && (value.signal.sdpMid === null || isBoundedString(value.signal.sdpMid, 128, true))
    && (value.signal.sdpMLineIndex === null || isNonNegativeInteger(value.signal.sdpMLineIndex))
    && (value.signal.usernameFragment === null
      || isBoundedString(value.signal.usernameFragment, 256, true))
    && !containsForbiddenRawMedia(value);
}

/** @param {any} value */
export function validateForwardedMediaSignal(value) {
  return validMediaSignal(value, true);
}

/** @param {any} value */
export function validateMediaGrant(value) {
  if (!exactKeys(value, ["type", "room_session_id", "grant", "audience", "reason"])) return false;
  if (
    value.type !== "media_grant"
    || !isId(value.room_session_id)
    || value.audience !== "all_viewers"
    || (value.reason !== null && !isBoundedString(value.reason, 240))
    || !exactKeys(value.grant, ["grant_id", "event_id", "scope", "expires_at_ms", "status"])
  ) return false;
  return isId(value.grant.grant_id)
    && isId(value.grant.event_id)
    && (value.grant.scope === "kitchen_moment" || value.grant.scope === "fall_emergency")
    && isFiniteNonNegative(value.grant.expires_at_ms)
    && ["active", "revoked", "expired"].includes(value.grant.status);
}

/**
 * @param {unknown} viewerCount
 * @param {unknown} maxViewers
 */
export function validViewerCounts(viewerCount, maxViewers) {
  return isNonNegativeInteger(viewerCount)
    && maxViewers === 5
    && Number(viewerCount) <= maxViewers;
}

/** @param {unknown} data */
export function parseRelayMessage(data) {
  if (typeof data !== "string") return { type: "protocol_error", code: "binary_message_rejected" };
  if (new TextEncoder().encode(data).byteLength > MAX_RELAY_JSON_BYTES) {
    return { type: "protocol_error", code: "message_too_large" };
  }
  try {
    const value = JSON.parse(data);
    return containsForbiddenRawMedia(value)
      ? { type: "protocol_error", code: "raw_media_rejected" }
      : value;
  } catch {
    return { type: "protocol_error", code: "invalid_json" };
  }
}

/** @param {unknown} value */
export function serializeRelayMessage(value) {
  if (containsForbiddenRawMedia(value)) throw new TypeError("Relay 禁止发送原始媒体数据");
  const message = JSON.stringify(value);
  if (new TextEncoder().encode(message).byteLength > MAX_RELAY_JSON_BYTES) {
    throw new RangeError("Relay 消息超过 16 KiB");
  }
  return message;
}

export const monitorRelayProtocol = Object.freeze({
  monitorProtocol: MONITOR_PROTOCOL,
  demoStateSchema: DEMO_STATE_SCHEMA,
  poseFrameSchema: POSE_FRAME_SCHEMA,
  controlCommandSchema: CONTROL_COMMAND_SCHEMA,
  mediaSignalSchema: MEDIA_SIGNAL_SCHEMA,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  maxJsonBytes: MAX_RELAY_JSON_BYTES,
});
