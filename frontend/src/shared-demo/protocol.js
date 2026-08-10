export const VIEWER_PROTOCOL = "reme-viewer-v2";
export const DEMO_STATE_SCHEMA = "reme-demo-state/v1";
export const CONTROL_COMMAND_SCHEMA = "reme-control-command/v1";
export const POSE_FRAME_SCHEMA = "reme-pose-frame-17/v1";
export const MEDIA_SIGNAL_SCHEMA = "reme-media-signal/v1";
export const FAMILY_EVENT_SCHEMA = "reme-family-event/v1";
export const MEDIA_AUTHORIZATION_SCHEMA = "reme-media-authorization/v1";

export const SCENE_IDS = Object.freeze(["living", "kitchen", "bathroom", "fall"]);
export const SOURCE_IDS = Object.freeze([
  "camera-user",
  "camera-environment",
  "display",
  "file",
]);
export const ACK_PHASES = Object.freeze([
  "received",
  "awaiting_local_confirmation",
  "applied",
  "rejected",
  "failed",
]);

const KEYPOINT_NAMES = Object.freeze([
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

const FORBIDDEN_RAW_MEDIA_KEYS = new Set([
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
  "video",
  "video_bytes",
]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isOpaqueId(value, { nullable = false } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[a-z0-9_-]+$/i.test(value);
}

function isNullableString(value, maxLength = 240) {
  return value === null
    || (typeof value === "string" && value.length > 0 && value.length <= maxLength);
}

function isBoundedString(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function containsForbiddenRawMedia(value) {
  if (typeof value === "string") return /^data:(?:image|video|audio)\//i.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenRawMedia);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_RAW_MEDIA_KEYS.has(key.toLowerCase()) || containsForbiddenRawMedia(child)
  ));
}

function isTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isUnitNumber(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isController(value) {
  return value === null || (
    hasExactKeys(value, ["viewer_id", "lease_id", "expires_at_ms"])
    && isOpaqueId(value.viewer_id)
    && isOpaqueId(value.lease_id)
    && isTimestamp(value.expires_at_ms)
  );
}

function isLease(value) {
  return value === null || (
    hasExactKeys(value, ["lease_id", "expires_at_ms"])
    && isOpaqueId(value.lease_id)
    && isTimestamp(value.expires_at_ms)
  );
}

function isMediaGrant(value, { allowInactive = false } = {}) {
  if (!hasExactKeys(value, ["grant_id", "event_id", "scope", "expires_at_ms", "status"])) {
    return false;
  }
  return isOpaqueId(value.grant_id)
    && isOpaqueId(value.event_id)
    && ["kitchen_moment", "fall_emergency"].includes(value.scope)
    && isTimestamp(value.expires_at_ms)
    && (allowInactive
      ? ["active", "revoked", "expired"].includes(value.status)
      : value.status === "active");
}

export function isMediaAuthorization(value, decisionId) {
  if (!hasExactKeys(value, [
    "schema_version",
    "authorization_id",
    "decision_id",
    "event_id",
    "scene_id",
    "scope",
    "status",
    "issued_at_ms",
    "expires_at_ms",
  ])) return false;
  if (value.schema_version !== MEDIA_AUTHORIZATION_SCHEMA
    || !isOpaqueId(value.authorization_id)
    || !isOpaqueId(value.decision_id)
    || value.decision_id !== decisionId
    || (value.event_id !== null && !isOpaqueId(value.event_id))
    || !isOpaqueId(value.scene_id)
    || !["kitchen_moment", "fall_emergency"].includes(value.scope)
    || value.status !== "active"
    || !isTimestamp(value.issued_at_ms)
    || !isTimestamp(value.expires_at_ms)
    || value.expires_at_ms <= value.issued_at_ms) return false;
  const maximumTtlMs = value.scope === "kitchen_moment" ? 60_000 : 30_000;
  return value.expires_at_ms - value.issued_at_ms <= maximumTtlMs;
}

function isFamilyAlarm(value) {
  if (value === null) return true;
  if (!hasExactKeys(value, ["channels", "trigger"])
    || !Array.isArray(value.channels)
    || value.channels.length === 0
    || !value.channels.every((channel) => ["vibrate", "ring", "flash"].includes(channel))
    || new Set(value.channels).size !== value.channels.length) return false;
  return [
    "elder_report",
    "voice_intent",
    "visual_confirm",
    "check_in_timeout",
    "unclear_response",
    "family_unresponsive",
  ].includes(value.trigger);
}

function isFamilyActionCard(value) {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const baseKeys = ["event", "status", "suggested_action", "system_judgment", "time_window"].sort();
  const quotedKeys = [...baseKeys, "elder_quote"].sort();
  if (!(
    (keys.length === baseKeys.length && keys.every((key, index) => key === baseKeys[index]))
    || (keys.length === quotedKeys.length && keys.every((key, index) => key === quotedKeys[index]))
  )) return false;
  return isBoundedString(value.event, 500)
    && isBoundedString(value.system_judgment, 500)
    && isBoundedString(value.suggested_action, 500)
    && isBoundedString(value.time_window, 240)
    && ["pending", "confirmed", "done"].includes(value.status)
    && (value.elder_quote === undefined || isBoundedString(value.elder_quote, 500));
}

export function isFamilyCareProjection(value) {
  if (!hasExactKeys(value, [
    "action",
    "action_card",
    "alarm",
    "decision_id",
    "family_notification",
    "media_authorization",
    "privacy_mode",
    "risk_level",
    "state",
  ])) return false;
  return isOpaqueId(value.decision_id)
    && [
      "normal",
      "observe",
      "check_in_required",
      "consent_required",
      "family_notification_required",
      "urgent_attention",
      "resolved",
      "degraded",
    ].includes(value.state)
    && [
      "none",
      "observe",
      "ask_elder",
      "notify_family",
      "show_urgent_attention",
      "mark_resolved",
    ].includes(value.action)
    && Number.isSafeInteger(value.risk_level)
    && value.risk_level >= 0
    && value.risk_level <= 4
    && (value.family_notification === null || isBoundedString(value.family_notification, 500))
    && ["visible", "blurred", "skeleton_only", "hidden"].includes(value.privacy_mode)
    && isFamilyAlarm(value.alarm)
    && isFamilyActionCard(value.action_card)
    && (value.media_authorization === null
      || isMediaAuthorization(value.media_authorization, value.decision_id));
}

export function isFamilyEvent(value) {
  if (!hasExactKeys(value, [
    "type",
    "schema_version",
    "room_session_id",
    "runtime_session_id",
    "revision",
    "decision_timestamp_ms",
    "published_at_ms",
    "care",
  ])) return false;
  return value.type === "family_event"
    && value.schema_version === FAMILY_EVENT_SCHEMA
    && isOpaqueId(value.room_session_id)
    && isOpaqueId(value.runtime_session_id)
    && isRevision(value.revision)
    && value.revision > 0
    && isTimestamp(value.decision_timestamp_ms)
    && isTimestamp(value.published_at_ms)
    && isFamilyCareProjection(value.care)
    && !containsForbiddenRawMedia(value);
}

function isCaptureState(value) {
  if (!hasExactKeys(value, [
    "status",
    "source_id",
    "source_kind",
    "remote_video",
    "error",
  ])) return false;
  const valid = ["idle", "awaiting_local_confirmation", "starting", "active", "stopping", "error"]
    .includes(value.status)
    && isOpaqueId(value.source_id, { nullable: true })
    && (value.source_kind === null || ["camera", "display", "file"].includes(value.source_kind))
    && ["available", "local_only", "unavailable"].includes(value.remote_video)
    && isNullableString(value.error);
  return valid && (value.status !== "active"
    || (value.source_id !== null && value.source_kind !== null));
}

function isRuntimeState(value) {
  return hasExactKeys(value, ["status", "capability", "detail"])
    && ["offline", "connecting", "ready", "degraded", "error"].includes(value.status)
    && ["live", "scripted", "unavailable"].includes(value.capability)
    && isNullableString(value.detail);
}

function isCareState(value) {
  if (!hasExactKeys(value, [
    "phase",
    "decision_id",
    "consent",
    "alarm_authoritative",
    "message",
  ])) return false;
  if (!["idle", "checking", "emergency", "resolved"].includes(value.phase)
    || !isOpaqueId(value.decision_id, { nullable: true })
    || !["none", "pending", "granted", "denied"].includes(value.consent)
    || typeof value.alarm_authoritative !== "boolean"
    || !isNullableString(value.message)) return false;
  return value.phase === "emergency"
    ? value.alarm_authoritative && value.decision_id !== null
    : !value.alarm_authoritative;
}

export function isDemoState(value) {
  if (!hasExactKeys(value, [
    "schema_version",
    "room_session_id",
    "runtime_session_id",
    "state_revision",
    "timestamp_ms",
    "state",
  ])) return false;
  if (value.schema_version !== DEMO_STATE_SCHEMA
    || !isOpaqueId(value.room_session_id)
    || !isOpaqueId(value.runtime_session_id)
    || !isRevision(value.state_revision)
    || !isTimestamp(value.timestamp_ms)
    || !hasExactKeys(value.state, [
      "scene_id",
      "source_generation",
      "capture",
      "runtime",
      "care",
      "media_grant",
    ])) return false;
  return SCENE_IDS.includes(value.state.scene_id)
    && isRevision(value.state.source_generation)
    && isCaptureState(value.state.capture)
    && isRuntimeState(value.state.runtime)
    && isCareState(value.state.care)
    && (value.state.media_grant === null || isMediaGrant(value.state.media_grant))
    && !containsForbiddenRawMedia(value);
}

export function isPoseFrame(value) {
  if (!hasExactKeys(value, [
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
  if (value.schema_version !== POSE_FRAME_SCHEMA
    || !isOpaqueId(value.room_session_id)
    || !isOpaqueId(value.runtime_session_id)
    || !isRevision(value.frame_sequence)
    || !isTimestamp(value.timestamp_ms)
    || !Number.isSafeInteger(value.source_width)
    || value.source_width < 1
    || value.source_width > 16_384
    || !Number.isSafeInteger(value.source_height)
    || value.source_height < 1
    || value.source_height > 16_384
    || typeof value.person_detected !== "boolean"
    || !["usable", "degraded", "unavailable"].includes(value.landmark_quality)
    || !Array.isArray(value.keypoints)) return false;
  if (!value.person_detected) {
    return value.landmark_quality === "unavailable" && value.keypoints.length === 0;
  }
  return value.landmark_quality !== "unavailable"
    && value.keypoints.length === KEYPOINT_NAMES.length
    && value.keypoints.every((point, index) => (
      hasExactKeys(point, ["name", "x", "y", "score"])
      && point.name === KEYPOINT_NAMES[index]
      && isUnitNumber(point.x)
      && isUnitNumber(point.y)
      && isUnitNumber(point.score)
    ));
}

function isMediaDescription(signal) {
  return hasExactKeys(signal, ["type", "sdp"])
    && ["offer", "answer"].includes(signal.type)
    && typeof signal.sdp === "string"
    && signal.sdp.length <= 64_000;
}

function isIceCandidate(signal) {
  return hasExactKeys(signal, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
    && typeof signal.candidate === "string"
    && signal.candidate.length <= 4096
    && (signal.sdpMid === null || (typeof signal.sdpMid === "string" && signal.sdpMid.length <= 128))
    && (signal.sdpMLineIndex === null
      || (Number.isSafeInteger(signal.sdpMLineIndex) && signal.sdpMLineIndex >= 0))
    && (signal.usernameFragment === null
      || (typeof signal.usernameFragment === "string" && signal.usernameFragment.length <= 256));
}

export function isForwardedMediaSignal(value) {
  if (!hasExactKeys(value, [
    "schema_version",
    "room_session_id",
    "grant_id",
    "target_id",
    "from_id",
    "signal_type",
    "signal",
  ])) return false;
  if (value.schema_version !== MEDIA_SIGNAL_SCHEMA
    || !isOpaqueId(value.room_session_id)
    || !isOpaqueId(value.grant_id)
    || !isOpaqueId(value.target_id)
    || !(value.from_id === "monitor" || isOpaqueId(value.from_id))
    || !["offer", "answer", "ice_candidate"].includes(value.signal_type)) return false;
  return value.signal_type === "ice_candidate"
    ? isIceCandidate(value.signal)
    : isMediaDescription(value.signal) && value.signal.type === value.signal_type;
}

export function createMediaSignal({
  roomSessionId,
  grantId,
  targetId,
  signalType,
  signal,
}) {
  const value = {
    schema_version: MEDIA_SIGNAL_SCHEMA,
    room_session_id: roomSessionId,
    grant_id: grantId,
    target_id: targetId,
    signal_type: signalType,
    signal,
  };
  const forwarded = { ...value, from_id: "monitor" };
  if (!isForwardedMediaSignal(forwarded)) {
    throw new TypeError("invalid media signal");
  }
  return value;
}

function parseTypedMessage(value) {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  if (value.type === "viewer_ready") {
    return hasExactKeys(value, [
      "type", "room_name", "viewer_id", "room_session_id", "monitor_online",
      "viewer_count", "max_viewers", "controller", "server_time_ms",
    ])
      && value.room_name === "shared-live-demo"
      && isOpaqueId(value.viewer_id)
      && isOpaqueId(value.room_session_id, { nullable: true })
      && typeof value.monitor_online === "boolean"
      && Number.isSafeInteger(value.viewer_count)
      && value.viewer_count >= 1
      && value.viewer_count <= 5
      && value.max_viewers === 5
      && isController(value.controller)
      && isTimestamp(value.server_time_ms)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "viewer_presence") {
    return hasExactKeys(value, [
      "type", "room_session_id", "viewer_count", "max_viewers", "monitor_online", "server_time_ms",
    ])
      && isOpaqueId(value.room_session_id, { nullable: true })
      && Number.isSafeInteger(value.viewer_count)
      && value.viewer_count >= 0
      && value.viewer_count <= 5
      && value.max_viewers === 5
      && typeof value.monitor_online === "boolean"
      && isTimestamp(value.server_time_ms)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "controller_status") {
    return hasExactKeys(value, ["type", "room_session_id", "controller", "server_time_ms"])
      && isOpaqueId(value.room_session_id, { nullable: true })
      && isController(value.controller)
      && isTimestamp(value.server_time_ms)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "control_claim_result") {
    return hasExactKeys(value, ["type", "status", "room_session_id", "lease"])
      && ["granted", "busy", "unavailable"].includes(value.status)
      && isOpaqueId(value.room_session_id, { nullable: true })
      && isLease(value.lease)
      && (value.status === "granted") === Boolean(value.lease)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "control_heartbeat_ack") {
    return hasExactKeys(value, ["type", "room_session_id", "lease_id", "expires_at_ms"])
      && isOpaqueId(value.room_session_id)
      && isOpaqueId(value.lease_id)
      && isTimestamp(value.expires_at_ms)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "control_ack") {
    return hasExactKeys(value, [
      "type", "room_session_id", "command_id", "phase", "timestamp_ms", "state_revision", "reason",
    ])
      && isOpaqueId(value.room_session_id)
      && isOpaqueId(value.command_id)
      && ACK_PHASES.includes(value.phase)
      && isTimestamp(value.timestamp_ms)
      && (value.state_revision === null || isRevision(value.state_revision))
      && isNullableString(value.reason)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "media_grant") {
    return hasExactKeys(value, ["type", "room_session_id", "grant", "audience", "reason"])
      && isOpaqueId(value.room_session_id)
      && isMediaGrant(value.grant, { allowInactive: true })
      && value.audience === "all_viewers"
      && isNullableString(value.reason)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "protocol_error") {
    return hasExactKeys(value, ["type", "code"])
      && isOpaqueId(value.code)
      ? { kind: value.type, value }
      : null;
  }
  if (value.type === "state_unavailable") {
    return hasExactKeys(value, ["type", "reason"])
      && ["monitor_offline", "stale", "not_published"].includes(value.reason)
      ? { kind: value.type, value }
      : null;
  }
  return null;
}

export function parseViewerMessage(raw) {
  if (typeof raw !== "string" || raw.length > 16_384) return null;
  try {
    const value = JSON.parse(raw);
    if (isFamilyEvent(value)) return { kind: "family_event", value };
    if (isDemoState(value)) return { kind: "demo_state", value };
    if (isPoseFrame(value)) return { kind: "pose_frame", value };
    if (isForwardedMediaSignal(value)) return { kind: "media_signal", value };
    return parseTypedMessage(value);
  } catch {
    return null;
  }
}

function isCommandPayload(value) {
  if (!isRecord(value) || !isOpaqueId(value.name)) return false;
  if (value.name === "select_scene") {
    return hasExactKeys(value, ["name", "scene_id"]) && SCENE_IDS.includes(value.scene_id);
  }
  if (value.name === "select_source") {
    return hasExactKeys(value, ["name", "source_id"]) && isOpaqueId(value.source_id);
  }
  if (["start_capture", "stop_capture", "reset_demo"].includes(value.name)) {
    return hasExactKeys(value, ["name"]);
  }
  if (value.name === "run_demo_scenario") {
    return hasExactKeys(value, ["name", "scenario"])
      && ["normal", "fall"].includes(value.scenario);
  }
  if (value.name === "start_conversation") {
    return hasExactKeys(value, ["name", "scenario"])
      && ["proactive_check_in", "kitchen_share"].includes(value.scenario);
  }
  if (value.name === "submit_response") {
    return hasExactKeys(value, ["name", "decision_id", "response"])
      && isOpaqueId(value.decision_id)
      && ["safe", "need_help", "consent_granted", "consent_denied"].includes(value.response);
  }
  if ([
    "acknowledge_alarm",
    "confirm_alarm",
    "confirm_action_card",
    "replay_voice",
  ].includes(value.name)) {
    return hasExactKeys(value, ["name", "decision_id"])
      && isOpaqueId(value.decision_id);
  }
  return false;
}

export function isControlCommand(value) {
  return hasExactKeys(value, [
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
    && isOpaqueId(value.room_session_id)
    && isOpaqueId(value.command_id)
    && isRevision(value.command_sequence)
    && value.command_sequence > 0
    && isTimestamp(value.issued_at_ms)
    && isTimestamp(value.expires_at_ms)
    && value.expires_at_ms > value.issued_at_ms
    && isRevision(value.expected_state_revision)
    && isCommandPayload(value.command)
    && !containsForbiddenRawMedia(value);
}

export function createControlCommand({
  roomSessionId,
  commandId,
  commandSequence,
  issuedAtMs,
  expiresAtMs,
  expectedStateRevision,
  command,
}) {
  const value = {
    schema_version: CONTROL_COMMAND_SCHEMA,
    room_session_id: roomSessionId,
    command_id: commandId,
    command_sequence: commandSequence,
    issued_at_ms: issuedAtMs,
    expires_at_ms: expiresAtMs,
    expected_state_revision: expectedStateRevision,
    command,
  };
  if (!isControlCommand(value)) throw new TypeError("invalid control command");
  return value;
}

export function createOpaqueId(prefix = "id") {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random}`.slice(0, 128);
}
