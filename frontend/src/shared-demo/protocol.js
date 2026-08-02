export const FRAME_SCHEMA_VERSION = "movenet-17/v1-demo";
export const DEMO_EVENT_SCHEMA_VERSION = "reme-demo-event/v1";
export const MEDIA_SIGNAL_SCHEMA_VERSION = "reme-media-signal/v1";
export const CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE = 1024;
export const VIEWER_PROTOCOL = "reme-viewer-v1";
export const CONTROLLER_PROTOCOL = "reme-controller-v1";
export const KEYPOINT_SCORE_THRESHOLD = 0.2;
export const LANDMARK_QUALITIES = Object.freeze(["usable", "degraded", "unavailable"]);
export const DEMO_SCENE_IDS = Object.freeze(["living", "kitchen", "bathroom", "fall"]);
export const DEMO_EVENT_TYPES = Object.freeze([
  "scene_state",
  "activity_state",
  "care_card",
  "alarm_state",
  "media_grant",
]);
export const MEDIA_GRANT_SCOPES = Object.freeze(["kitchen_moment", "fall_emergency"]);

/**
 * Controller events reserve a sequence block for Relay-generated grant and
 * revoke events. This keeps an immediate user action from colliding with a
 * server event whose acknowledgement is still in flight.
 */
export function advanceControllerEventSequence(current, observedSequence = current) {
  if (
    !Number.isSafeInteger(current)
    || current < 0
    || !Number.isSafeInteger(observedSequence)
    || observedSequence < 0
  ) {
    throw new TypeError("event sequences must be non-negative safe integers");
  }
  const minimum = Math.max(current, observedSequence + 1);
  const next = Math.ceil(minimum / CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE)
    * CONTROLLER_EVENT_SEQUENCE_BLOCK_SIZE;
  if (!Number.isSafeInteger(next)) {
    throw new RangeError("event sequence reservation exceeded the safe integer range");
  }
  return next;
}

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
const EVENT_KEYS = [
  "event_sequence",
  "event_type",
  "payload",
  "schema_version",
  "session_id",
  "timestamp_ms",
];
const SCENE_STATE_KEYS = ["scene_id", "visual_mode"];
const ACTIVITY_STATE_KEYS = ["activity", "confidence", "phase", "reason", "source"];
const CARE_CARD_KEYS = [
  "body",
  "card_id",
  "event_id",
  "kind",
  "occurred_at_ms",
  "share_state",
  "title",
];
const ALARM_STATE_KEYS = [
  "event_id",
  "media_scope",
  "message",
  "phase",
  "response_deadline_ms",
  "trigger",
];
const MEDIA_GRANT_KEYS = ["event_id", "expires_at_ms", "grant_id", "scope", "status"];
const MEDIA_SIGNAL_KEYS = ["grant_id", "schema_version", "signal", "signal_type", "target_id"];
const FORWARDED_MEDIA_SIGNAL_KEYS = [
  "from_id",
  "grant_id",
  "schema_version",
  "signal",
  "signal_type",
  "target_id",
];
const CONTROLLER_READY_KEYS = [
  "current_alarm",
  "last_event_sequence",
  "last_frame_sequence",
  "lease_expires_at_ms",
  "session_id",
  "type",
];
const LEGACY_CONTROLLER_READY_KEYS = CONTROLLER_READY_KEYS.filter(
  (key) => key !== "current_alarm",
);
const PRE_CURSOR_CONTROLLER_READY_KEYS = ["lease_expires_at_ms", "session_id", "type"];
const HEARTBEAT_ACK_KEYS = ["lease_expires_at_ms", "type"];
const SOCKET_ERROR_KEYS = ["error", "type"];
const MEDIA_GRANT_ERROR_CODES = Object.freeze([
  "media_grant_already_active",
  "media_grant_not_eligible",
  "no_connected_viewers",
]);
const DESCRIPTION_SIGNAL_KEYS = ["sdp"];
const ICE_SIGNAL_KEYS = ["candidate", "sdp_mid", "sdp_mline_index"];
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

function isBoundedString(value, maxLength, { allowEmpty = false } = {}) {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function isOpaqueId(value) {
  return isBoundedString(value, 128) && /^[a-z0-9_-]+$/i.test(value);
}

function isNullableDeadline(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function isSequenceCursor(value) {
  return Number.isSafeInteger(value) && value >= -1;
}

export function isControllerReady(value) {
  const hasCurrentAlarm = hasExactKeys(value, CONTROLLER_READY_KEYS);
  const isLegacyTransition = hasExactKeys(value, LEGACY_CONTROLLER_READY_KEYS);
  const isPreCursorTransition = hasExactKeys(value, PRE_CURSOR_CONTROLLER_READY_KEYS);
  return (hasCurrentAlarm || isLegacyTransition || isPreCursorTransition)
    && value.type === "controller_ready"
    && isOpaqueId(value.session_id)
    && Number.isFinite(value.lease_expires_at_ms)
    && value.lease_expires_at_ms >= 0
    && (isPreCursorTransition || (
      isSequenceCursor(value.last_event_sequence)
      && isSequenceCursor(value.last_frame_sequence)
    ))
    && (!hasCurrentAlarm || (
      value.current_alarm === null
      || (
        isDemoEvent(value.current_alarm, { sessionId: value.session_id })
        && value.current_alarm.event_type === "alarm_state"
        && value.current_alarm.event_sequence <= value.last_event_sequence
      )
    ));
}

export function isHeartbeatAck(value) {
  return hasExactKeys(value, HEARTBEAT_ACK_KEYS)
    && value.type === "heartbeat_ack"
    && Number.isFinite(value.lease_expires_at_ms)
    && value.lease_expires_at_ms >= 0;
}

export function isMediaGrantError(value) {
  return hasExactKeys(value, SOCKET_ERROR_KEYS)
    && value.type === "error"
    && MEDIA_GRANT_ERROR_CODES.includes(value.error);
}

function isSceneStatePayload(value) {
  if (!hasExactKeys(value, SCENE_STATE_KEYS)) return false;
  if (!DEMO_SCENE_IDS.includes(value.scene_id)) return false;
  if (!["abstract_environment", "skeleton_only"].includes(value.visual_mode)) return false;
  return value.scene_id === "bathroom"
    ? value.visual_mode === "skeleton_only"
    : value.visual_mode === "abstract_environment";
}

function isActivityStatePayload(value) {
  return hasExactKeys(value, ACTIVITY_STATE_KEYS)
    && value.activity === "cooking"
    && ["sampling", "candidate", "confirmed", "unavailable"].includes(value.phase)
    && ["mimo_visual", "manual_debug"].includes(value.source)
    && (value.confidence === null || isUnitNumber(value.confidence))
    && isBoundedString(value.reason, 240, { allowEmpty: true })
    && (value.phase !== "confirmed" || value.confidence !== null);
}

function isCareCardPayload(value) {
  return hasExactKeys(value, CARE_CARD_KEYS)
    && isOpaqueId(value.card_id)
    && isOpaqueId(value.event_id)
    && value.kind === "family_heartbeat"
    && isBoundedString(value.title, 80)
    && isBoundedString(value.body, 240)
    && Number.isFinite(value.occurred_at_ms)
    && value.occurred_at_ms >= 0
    && ["local_only", "consent_pending", "consented", "denied", "expired"].includes(
      value.share_state,
    );
}

function isAlarmStatePayload(value) {
  if (!hasExactKeys(value, ALARM_STATE_KEYS)) return false;
  if (!isOpaqueId(value.event_id)) return false;
  if (!["checking", "escalated", "resolved"].includes(value.phase)) return false;
  if (!["none", "fall_emergency"].includes(value.media_scope)) return false;
  if (!isBoundedString(value.message, 240)) return false;
  if (!isNullableDeadline(value.response_deadline_ms)) return false;
  if (![
    "fall_transition",
    "elder_need_help",
    "voice_intent",
    "check_in_timeout",
    "visual_confirm",
    "manual_debug",
  ].includes(value.trigger)) return false;
  if (value.phase === "checking") {
    return value.media_scope === "none" && value.response_deadline_ms !== null;
  }
  if (value.phase === "escalated") {
    return value.media_scope === "fall_emergency" && value.response_deadline_ms === null;
  }
  return value.media_scope === "none" && value.response_deadline_ms === null;
}

function isMediaGrantPayload(value, timestampMs) {
  if (!hasExactKeys(value, MEDIA_GRANT_KEYS)) return false;
  if (!isOpaqueId(value.event_id) || !isOpaqueId(value.grant_id)) return false;
  if (!MEDIA_GRANT_SCOPES.includes(value.scope)) return false;
  if (!["active", "revoked", "expired"].includes(value.status)) return false;
  if (!Number.isFinite(value.expires_at_ms) || value.expires_at_ms < 0) return false;
  return value.status !== "active" || value.expires_at_ms > timestampMs;
}

function isEventPayload(eventType, payload, timestampMs) {
  if (eventType === "scene_state") return isSceneStatePayload(payload);
  if (eventType === "activity_state") return isActivityStatePayload(payload);
  if (eventType === "care_card") return isCareCardPayload(payload);
  if (eventType === "alarm_state") return isAlarmStatePayload(payload);
  if (eventType === "media_grant") return isMediaGrantPayload(payload, timestampMs);
  return false;
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

export function isDemoEvent(value, { sessionId = null } = {}) {
  if (!hasExactKeys(value, EVENT_KEYS)) return false;
  if (value.schema_version !== DEMO_EVENT_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.session_id)) return false;
  if (sessionId !== null && value.session_id !== sessionId) return false;
  if (!Number.isSafeInteger(value.event_sequence) || value.event_sequence < 0) return false;
  if (!Number.isFinite(value.timestamp_ms) || value.timestamp_ms < 0) return false;
  if (!DEMO_EVENT_TYPES.includes(value.event_type)) return false;
  return isEventPayload(value.event_type, value.payload, value.timestamp_ms);
}

export function parseDemoEvent(raw, options) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return isDemoEvent(value, options) ? value : null;
  } catch {
    return null;
  }
}

export function createDemoEvent({
  sessionId,
  eventSequence,
  timestampMs,
  eventType,
  payload,
}) {
  const event = {
    schema_version: DEMO_EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: timestampMs,
    event_type: eventType,
    payload,
  };
  return isDemoEvent(event) ? event : null;
}

function isDescriptionSignal(value) {
  return hasExactKeys(value, DESCRIPTION_SIGNAL_KEYS) && isBoundedString(value.sdp, 12_000);
}

function isIceSignal(value) {
  return hasExactKeys(value, ICE_SIGNAL_KEYS)
    && isBoundedString(value.candidate, 4_096)
    && (value.sdp_mid === null || isBoundedString(value.sdp_mid, 128, { allowEmpty: true }))
    && (
      value.sdp_mline_index === null
      || (Number.isSafeInteger(value.sdp_mline_index) && value.sdp_mline_index >= 0)
    );
}

function isMediaSignalShape(value, { forwarded }) {
  if (!hasExactKeys(value, forwarded ? FORWARDED_MEDIA_SIGNAL_KEYS : MEDIA_SIGNAL_KEYS)) {
    return false;
  }
  if (value.schema_version !== MEDIA_SIGNAL_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.grant_id) || !isOpaqueId(value.target_id)) return false;
  if (forwarded && !isOpaqueId(value.from_id)) return false;
  if (!["offer", "answer", "ice_candidate"].includes(value.signal_type)) return false;
  return value.signal_type === "ice_candidate"
    ? isIceSignal(value.signal)
    : isDescriptionSignal(value.signal);
}

export function isMediaSignal(value) {
  return isMediaSignalShape(value, { forwarded: false });
}

export function isForwardedMediaSignal(value) {
  return isMediaSignalShape(value, { forwarded: true });
}

export function parseForwardedMediaSignal(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return isForwardedMediaSignal(value) ? value : null;
  } catch {
    return null;
  }
}

export function createMediaSignal({ grantId, targetId, signalType, signal }) {
  const message = {
    schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
    grant_id: grantId,
    target_id: targetId,
    signal_type: signalType,
    signal,
  };
  return isMediaSignal(message) ? message : null;
}

export function createMediaGrantRequest({ eventId, scope, expiresInMs }) {
  if (
    !isOpaqueId(eventId)
    || !MEDIA_GRANT_SCOPES.includes(scope)
    || !Number.isSafeInteger(expiresInMs)
    || expiresInMs < 5_000
    || expiresInMs > 60_000
  ) return null;
  return {
    type: "media_grant_request",
    event_id: eventId,
    scope,
    expires_in_ms: expiresInMs,
  };
}

export function createMediaGrantRevoke(grantId) {
  return isOpaqueId(grantId) ? { type: "media_grant_revoke", grant_id: grantId } : null;
}

export function controllerProtocols(token) {
  if (typeof token !== "string" || !/^[a-f0-9]+$/i.test(token)) {
    throw new TypeError("controller token must be hexadecimal");
  }
  return [CONTROLLER_PROTOCOL, `reme-token-${token}`];
}
