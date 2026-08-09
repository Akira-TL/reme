export const ROOM_NAME = "shared-live-demo";
export const DEMO_STATE_SCHEMA_VERSION = "reme-demo-state/v3";
export const CONTROL_COMMAND_SCHEMA_VERSION = "reme-control-command/v1";
export const POSE_FRAME_SCHEMA_VERSION = "reme-pose-frame-17/v1";
export const MEDIA_SIGNAL_SCHEMA_VERSION = "reme-media-signal/v1";

export const SCENE_IDS = ["living", "kitchen", "bathroom", "fall"] as const;
export const MEDIA_GRANT_SCOPES = ["kitchen_moment", "fall_emergency"] as const;
export const CONTROL_ACK_PHASES = [
  "received",
  "awaiting_local_confirmation",
  "applied",
  "rejected",
  "failed",
] as const;

export const MOVENET_KEYPOINT_NAMES = [
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
] as const;

export type SceneId = (typeof SCENE_IDS)[number];
export type MediaGrantScope = (typeof MEDIA_GRANT_SCOPES)[number];
export type ControlAckPhase = (typeof CONTROL_ACK_PHASES)[number];
export type KeypointName = (typeof MOVENET_KEYPOINT_NAMES)[number];

export interface ActiveMediaGrant {
  grant_id: string;
  event_id: string;
  scope: MediaGrantScope;
  expires_at_ms: number;
  status: "active";
}

export interface CareDecision {
  schema_version: "reme-care-decision/v0-experiment";
  scene_id: SceneId;
  decision_id: string;
  timestamp_ms: number;
  state:
    | "normal"
    | "observe"
    | "check_in_required"
    | "consent_required"
    | "family_notification_required"
    | "urgent_attention"
    | "resolved"
    | "degraded";
  risk_level: number;
  privacy_mode: "visible" | "blurred" | "skeleton_only" | "hidden";
  need_dialogue: boolean;
  dialogue_goal: string | null;
  elder_message: string | null;
  family_notification: string | null;
  action:
    | "none"
    | "observe"
    | "ask_elder"
    | "notify_family"
    | "show_urgent_attention"
    | "mark_resolved";
  reason_summary: string;
  uncertainty: "low" | "medium" | "high" | "unknown";
  source: "rule" | "mimo" | "mock" | "record" | "degraded";
  fallback_used: boolean;
  demo_mode: "live" | "mock" | "record";
  consent_required: boolean;
  response_timeout_ms: number | null;
  response_deadline_ms: number | null;
  action_card: {
    event: string;
    elder_quote: string;
    system_judgment: string;
    suggested_action: string;
    time_window: string;
    status: "pending" | "confirmed" | "done";
  } | null;
  visual_context: {
    sent_to_mimo: boolean;
    type: "keyframes" | "clip" | null;
    start_ms: number | null;
    end_ms: number | null;
    sample_count: number | null;
  } | null;
  alarm: {
    channels: Array<"vibrate" | "ring" | "flash">;
    trigger:
      | "elder_report"
      | "voice_intent"
      | "visual_confirm"
      | "check_in_timeout"
      | "unclear_response"
      | "family_unresponsive";
  } | null;
  voice_asset: string | null;
  confirm_channels: Array<"frame" | "voice"> | null;
}

export interface DemoState {
  scene_id: SceneId;
  source_generation: number;
  capture: {
    status:
      | "idle"
      | "awaiting_local_confirmation"
      | "starting"
      | "active"
      | "stopping"
      | "error";
    source_id: string | null;
    source_kind: "camera" | "display" | "file" | null;
    remote_video: "available" | "local_only" | "unavailable";
    error: string | null;
  };
  runtime: {
    status: "offline" | "connecting" | "ready" | "degraded" | "error";
    capability: "live" | "scripted" | "unavailable";
    detail: string | null;
  };
  care: {
    phase: "idle" | "checking" | "emergency" | "resolved";
    consent: "none" | "pending" | "granted" | "denied";
    decision: CareDecision | null;
  };
  media_grant: ActiveMediaGrant | null;
}

export interface DemoStateEnvelope {
  schema_version: typeof DEMO_STATE_SCHEMA_VERSION;
  room_session_id: string;
  runtime_session_id: string;
  state_revision: number;
  timestamp_ms: number;
  state: DemoState;
}

export interface PoseFrame {
  schema_version: typeof POSE_FRAME_SCHEMA_VERSION;
  room_session_id: string;
  runtime_session_id: string;
  frame_sequence: number;
  timestamp_ms: number;
  source_width: number;
  source_height: number;
  person_detected: boolean;
  landmark_quality: "usable" | "degraded" | "unavailable";
  keypoints: Array<{
    name: KeypointName;
    x: number;
    y: number;
    score: number;
  }>;
}

export type ControlCommandBody =
  | { name: "select_scene"; scene_id: SceneId }
  | { name: "select_source"; source_id: string }
  | { name: "start_capture" }
  | { name: "stop_capture" }
  | { name: "run_demo_scenario"; scenario: "normal" | "fall" }
  | { name: "reset_demo" }
  | {
    name: "start_conversation";
    scenario: "proactive_check_in" | "kitchen_share";
  }
  | {
    name: "submit_response";
    decision_id: string;
    response: "safe" | "need_help" | "consent_granted" | "consent_denied";
  }
  | { name: "confirm_alarm"; decision_id: string }
  | { name: "confirm_action_card"; decision_id: string }
  | { name: "confirm_family_notification"; decision_id: string }
  | { name: "replay_voice"; decision_id: string };

export interface ControlCommand {
  schema_version: typeof CONTROL_COMMAND_SCHEMA_VERSION;
  room_session_id: string;
  command_id: string;
  command_sequence: number;
  issued_at_ms: number;
  expires_at_ms: number;
  expected_state_revision: number;
  command: ControlCommandBody;
}

export interface ControlAck {
  type: "control_ack";
  room_session_id: string;
  command_id: string;
  phase: ControlAckPhase;
  timestamp_ms: number;
  state_revision: number | null;
  reason: string | null;
}

export interface MediaGrantRequest {
  type: "media_grant_request";
  room_session_id: string;
  runtime_session_id: string;
  event_id: string;
  scope: MediaGrantScope;
  expires_in_ms: number;
}

export interface MediaGrantRevoke {
  type: "media_grant_revoke";
  room_session_id: string;
  grant_id: string;
}

export interface MediaSignal {
  schema_version: typeof MEDIA_SIGNAL_SCHEMA_VERSION;
  room_session_id: string;
  grant_id: string;
  target_id: string;
  signal_type: "offer" | "answer" | "ice_candidate";
  signal:
    | { type: "offer" | "answer"; sdp: string }
    | {
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
      usernameFragment: string | null;
    };
}

export interface ForwardedMediaSignal extends MediaSignal {
  from_id: string;
}

const STATE_ENVELOPE_KEYS = [
  "room_session_id",
  "runtime_session_id",
  "schema_version",
  "state",
  "state_revision",
  "timestamp_ms",
] as const;
const STATE_KEYS = [
  "capture",
  "care",
  "media_grant",
  "runtime",
  "scene_id",
  "source_generation",
] as const;
const CAPTURE_KEYS = ["error", "remote_video", "source_id", "source_kind", "status"] as const;
const RUNTIME_KEYS = ["capability", "detail", "status"] as const;
const CARE_KEYS = ["consent", "decision", "phase"] as const;
const CARE_DECISION_KEYS = [
  "action",
  "action_card",
  "alarm",
  "confirm_channels",
  "consent_required",
  "decision_id",
  "demo_mode",
  "dialogue_goal",
  "elder_message",
  "fallback_used",
  "family_notification",
  "need_dialogue",
  "privacy_mode",
  "reason_summary",
  "response_timeout_ms",
  "response_deadline_ms",
  "risk_level",
  "scene_id",
  "schema_version",
  "source",
  "state",
  "timestamp_ms",
  "uncertainty",
  "visual_context",
  "voice_asset",
] as const;
const ACTION_CARD_KEYS = [
  "elder_quote",
  "event",
  "status",
  "suggested_action",
  "system_judgment",
  "time_window",
] as const;
const CARE_VISUAL_CONTEXT_KEYS = [
  "end_ms",
  "sample_count",
  "sent_to_mimo",
  "start_ms",
  "type",
] as const;
const ALARM_KEYS = [
  "channels",
  "trigger",
] as const;
const ACTIVE_GRANT_KEYS = ["event_id", "expires_at_ms", "grant_id", "scope", "status"] as const;
const POSE_FRAME_KEYS = [
  "frame_sequence",
  "keypoints",
  "landmark_quality",
  "person_detected",
  "room_session_id",
  "runtime_session_id",
  "schema_version",
  "source_height",
  "source_width",
  "timestamp_ms",
] as const;
const KEYPOINT_KEYS = ["name", "score", "x", "y"] as const;
const CONTROL_COMMAND_KEYS = [
  "command",
  "command_id",
  "command_sequence",
  "expected_state_revision",
  "expires_at_ms",
  "issued_at_ms",
  "room_session_id",
  "schema_version",
] as const;
const CONTROL_ACK_KEYS = [
  "command_id",
  "phase",
  "reason",
  "room_session_id",
  "state_revision",
  "timestamp_ms",
  "type",
] as const;
const MEDIA_SIGNAL_KEYS = [
  "grant_id",
  "room_session_id",
  "schema_version",
  "signal",
  "signal_type",
  "target_id",
] as const;

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
  "video_bytes",
]);

export function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export function isOpaqueId(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[a-z0-9_-]+$/i.test(value);
}

export function containsForbiddenRawMedia(value: unknown): boolean {
  if (typeof value === "string") {
    return /^data:(?:image|video|audio)\//i.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsForbiddenRawMedia(item));
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => (
    FORBIDDEN_RAW_MEDIA_KEYS.has(key.toLowerCase()) || containsForbiddenRawMedia(item)
  ));
}

export function validateDemoState(
  value: unknown,
  roomSessionId: string,
  requireRelayOwnedGrant = true,
): value is DemoStateEnvelope {
  if (!isExactObject(value, STATE_ENVELOPE_KEYS)) return false;
  if (value.schema_version !== DEMO_STATE_SCHEMA_VERSION) return false;
  if (value.room_session_id !== roomSessionId || !isOpaqueId(value.room_session_id)) return false;
  if (!isOpaqueId(value.runtime_session_id)) return false;
  if (!isNonNegativeSafeInteger(value.state_revision)) return false;
  if (!isFiniteNonNegativeNumber(value.timestamp_ms)) return false;
  if (!validateStateBody(value.state, requireRelayOwnedGrant)) return false;
  return !containsForbiddenRawMedia(value);
}

export function validatePoseFrame(
  value: unknown,
  roomSessionId: string,
  runtimeSessionId: string,
): value is PoseFrame {
  if (!isExactObject(value, POSE_FRAME_KEYS)) return false;
  if (value.schema_version !== POSE_FRAME_SCHEMA_VERSION) return false;
  if (value.room_session_id !== roomSessionId || value.runtime_session_id !== runtimeSessionId) {
    return false;
  }
  if (!isNonNegativeSafeInteger(value.frame_sequence)) return false;
  if (!isFiniteNonNegativeNumber(value.timestamp_ms)) return false;
  if (!isPositiveDimension(value.source_width) || !isPositiveDimension(value.source_height)) {
    return false;
  }
  if (typeof value.person_detected !== "boolean" || !Array.isArray(value.keypoints)) return false;
  if (!value.person_detected) {
    return value.landmark_quality === "unavailable" && value.keypoints.length === 0;
  }
  if (value.landmark_quality !== "usable" && value.landmark_quality !== "degraded") return false;
  if (value.keypoints.length !== MOVENET_KEYPOINT_NAMES.length) return false;
  return value.keypoints.every((point, index) => (
    isExactObject(point, KEYPOINT_KEYS)
    && point.name === MOVENET_KEYPOINT_NAMES[index]
    && isUnitNumber(point.x)
    && isUnitNumber(point.y)
    && isUnitNumber(point.score)
  )) && !containsForbiddenRawMedia(value);
}

export function validateControlCommand(value: unknown): value is ControlCommand {
  if (!isExactObject(value, CONTROL_COMMAND_KEYS)) return false;
  if (value.schema_version !== CONTROL_COMMAND_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.room_session_id) || !isOpaqueId(value.command_id)) return false;
  if (!isNonNegativeSafeInteger(value.command_sequence) || value.command_sequence === 0) return false;
  if (!isFiniteNonNegativeNumber(value.issued_at_ms)) return false;
  if (!isFiniteNonNegativeNumber(value.expires_at_ms)) return false;
  if (!isNonNegativeSafeInteger(value.expected_state_revision)) return false;
  return validateCommandBody(value.command) && !containsForbiddenRawMedia(value);
}

export function validateControlAck(value: unknown): value is ControlAck {
  return isExactObject(value, CONTROL_ACK_KEYS)
    && value.type === "control_ack"
    && isOpaqueId(value.room_session_id)
    && isOpaqueId(value.command_id)
    && isControlAckPhase(value.phase)
    && isFiniteNonNegativeNumber(value.timestamp_ms)
    && (value.state_revision === null || isNonNegativeSafeInteger(value.state_revision))
    && (value.reason === null || isBoundedString(value.reason, 240));
}

export function validateMediaGrantRequest(value: unknown): value is MediaGrantRequest {
  if (!isExactObject(value, [
    "event_id",
    "expires_in_ms",
    "room_session_id",
    "runtime_session_id",
    "scope",
    "type",
  ])) return false;
  if (value.type !== "media_grant_request") return false;
  if (!isOpaqueId(value.room_session_id) || !isOpaqueId(value.runtime_session_id)) return false;
  if (!isOpaqueId(value.event_id) || !isMediaGrantScope(value.scope)) return false;
  if (!isNonNegativeSafeInteger(value.expires_in_ms) || value.expires_in_ms < 1_000) return false;
  return value.scope === "kitchen_moment"
    ? value.expires_in_ms <= 60_000
    : value.expires_in_ms <= 30_000;
}

export function validateMediaGrantRevoke(value: unknown): value is MediaGrantRevoke {
  return isExactObject(value, ["grant_id", "room_session_id", "type"])
    && value.type === "media_grant_revoke"
    && isOpaqueId(value.room_session_id)
    && isOpaqueId(value.grant_id);
}

export function validateMediaSignal(value: unknown): value is MediaSignal {
  if (!isExactObject(value, MEDIA_SIGNAL_KEYS)) return false;
  if (value.schema_version !== MEDIA_SIGNAL_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.room_session_id) || !isOpaqueId(value.grant_id)) return false;
  if (!(value.target_id === "monitor" || isOpaqueId(value.target_id))) return false;
  if (
    value.signal_type !== "offer"
    && value.signal_type !== "answer"
    && value.signal_type !== "ice_candidate"
  ) return false;
  if (value.signal_type === "ice_candidate") {
    return validateIceCandidate(value.signal);
  }
  return validateSessionDescription(value.signal, value.signal_type);
}

export function withMediaGrant(
  envelope: DemoStateEnvelope,
  grant: ActiveMediaGrant | null,
): DemoStateEnvelope {
  return {
    ...envelope,
    state: {
      ...envelope.state,
      media_grant: grant,
    },
  };
}

export function createForwardedMediaSignal(
  signal: MediaSignal,
  fromId: string,
): ForwardedMediaSignal {
  return { ...signal, from_id: fromId };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateStateBody(value: unknown, requireRelayOwnedGrant: boolean): value is DemoState {
  if (!isExactObject(value, STATE_KEYS)) return false;
  if (!isSceneId(value.scene_id) || !isNonNegativeSafeInteger(value.source_generation)) return false;
  if (!validateCapture(value.capture) || !validateRuntime(value.runtime) || !validateCare(value.care)) {
    return false;
  }
  if (value.care.decision !== null && value.care.decision.scene_id !== value.scene_id) return false;
  if (requireRelayOwnedGrant) return value.media_grant === null;
  return value.media_grant === null || validateActiveGrant(value.media_grant);
}

function validateCapture(value: unknown): value is DemoState["capture"] {
  if (!isExactObject(value, CAPTURE_KEYS)) return false;
  if (
    value.status !== "idle"
    && value.status !== "awaiting_local_confirmation"
    && value.status !== "starting"
    && value.status !== "active"
    && value.status !== "stopping"
    && value.status !== "error"
  ) return false;
  if (value.source_id !== null && !isOpaqueId(value.source_id)) return false;
  if (
    value.source_kind !== null
    && value.source_kind !== "camera"
    && value.source_kind !== "display"
    && value.source_kind !== "file"
  ) return false;
  if (
    value.remote_video !== "available"
    && value.remote_video !== "local_only"
    && value.remote_video !== "unavailable"
  ) return false;
  if (value.error !== null && !isBoundedString(value.error, 240)) return false;
  if (value.status === "active") return value.source_id !== null && value.source_kind !== null;
  return true;
}

function validateRuntime(value: unknown): value is DemoState["runtime"] {
  if (!isExactObject(value, RUNTIME_KEYS)) return false;
  if (
    value.status !== "offline"
    && value.status !== "connecting"
    && value.status !== "ready"
    && value.status !== "degraded"
    && value.status !== "error"
  ) return false;
  if (
    value.capability !== "live"
    && value.capability !== "scripted"
    && value.capability !== "unavailable"
  ) return false;
  return value.detail === null || isBoundedString(value.detail, 240);
}

function validateCare(value: unknown): value is DemoState["care"] {
  if (!isExactObject(value, CARE_KEYS)) return false;
  if (
    value.phase !== "idle"
    && value.phase !== "checking"
    && value.phase !== "emergency"
    && value.phase !== "resolved"
  ) return false;
  if (
    value.consent !== "none"
    && value.consent !== "pending"
    && value.consent !== "granted"
    && value.consent !== "denied"
  ) return false;
  if (value.decision !== null && !validateCareDecision(value.decision)) return false;
  const expectedPhase = value.decision === null
    ? "idle"
    : value.decision.state === "check_in_required" || value.decision.state === "consent_required"
      ? "checking"
      : value.decision.state === "family_notification_required"
          || value.decision.state === "urgent_attention"
        ? "emergency"
        : value.decision.state === "resolved"
          ? "resolved"
          : "idle";
  return value.phase === expectedPhase;
}

export function validateCareDecision(value: unknown): value is CareDecision {
  if (!isExactObject(value, CARE_DECISION_KEYS)) return false;
  if (value.schema_version !== "reme-care-decision/v0-experiment") return false;
  if (!isSceneId(value.scene_id) || !isOpaqueId(value.decision_id)) return false;
  if (!isFiniteNonNegativeNumber(value.timestamp_ms)) return false;
  if (
    value.state !== "normal"
    && value.state !== "observe"
    && value.state !== "check_in_required"
    && value.state !== "consent_required"
    && value.state !== "family_notification_required"
    && value.state !== "urgent_attention"
    && value.state !== "resolved"
    && value.state !== "degraded"
  ) return false;
  if (!isNonNegativeSafeInteger(value.risk_level) || value.risk_level > 4) return false;
  if (
    value.privacy_mode !== "visible"
    && value.privacy_mode !== "blurred"
    && value.privacy_mode !== "skeleton_only"
    && value.privacy_mode !== "hidden"
  ) return false;
  if (typeof value.need_dialogue !== "boolean") return false;
  if (!isNullableText(value.dialogue_goal) || !isNullableText(value.elder_message)) return false;
  if (!isNullableText(value.family_notification)) return false;
  if (
    value.action !== "none"
    && value.action !== "observe"
    && value.action !== "ask_elder"
    && value.action !== "notify_family"
    && value.action !== "show_urgent_attention"
    && value.action !== "mark_resolved"
  ) return false;
  if (!isBoundedString(value.reason_summary, 2_000)) return false;
  if (value.uncertainty !== "low"
    && value.uncertainty !== "medium"
    && value.uncertainty !== "high"
    && value.uncertainty !== "unknown") return false;
  if (typeof value.fallback_used !== "boolean") return false;
  if (value.source !== "rule"
    && value.source !== "mimo"
    && value.source !== "mock"
    && value.source !== "record"
    && value.source !== "degraded") return false;
  if (value.demo_mode !== "live" && value.demo_mode !== "mock" && value.demo_mode !== "record") {
    return false;
  }
  if (typeof value.consent_required !== "boolean") return false;
  if (value.response_timeout_ms !== null
    && (!isNonNegativeSafeInteger(value.response_timeout_ms) || value.response_timeout_ms === 0)) {
    return false;
  }
  if (value.response_deadline_ms !== null
    && (!isFiniteNonNegativeNumber(value.response_deadline_ms)
      || value.response_timeout_ms === null)) return false;
  if (value.action_card !== null && !validateActionCard(value.action_card)) return false;
  if (value.visual_context !== null && !validateCareVisualContext(value.visual_context)) return false;
  if (value.alarm !== null && !validateAlarm(value.alarm)) return false;
  if (!isNullableText(value.voice_asset, 512)) return false;
  if (value.confirm_channels !== null
    && !isUniqueClosedList(value.confirm_channels, ["frame", "voice"])) return false;

  if (!value.need_dialogue && value.elder_message !== null) return false;
  if (value.action === "notify_family" && value.family_notification === null) return false;
  if (value.consent_required && value.action === "notify_family") return false;
  if (value.state === "consent_required"
    && (value.risk_level !== 2 || value.consent_required !== true)) return false;
  if (value.state === "degraded" && !value.fallback_used) return false;
  if (value.source === "degraded" && value.state !== "degraded") return false;
  if (value.alarm !== null
    && value.state !== "family_notification_required"
    && value.state !== "urgent_attention") return false;
  if (value.voice_asset !== null && value.elder_message === null) return false;
  if (value.confirm_channels !== null && value.action !== "ask_elder") return false;
  return !containsForbiddenRawMedia(value);
}

function validateActionCard(value: unknown): value is NonNullable<CareDecision["action_card"]> {
  if (!isExactObject(value, ACTION_CARD_KEYS)) return false;
  return isBoundedString(value.event, 2_000)
    && isBoundedString(value.elder_quote, 2_000)
    && isBoundedString(value.system_judgment, 2_000)
    && isBoundedString(value.suggested_action, 2_000)
    && isBoundedString(value.time_window, 2_000)
    && (value.status === "pending" || value.status === "confirmed" || value.status === "done");
}

function validateCareVisualContext(
  value: unknown,
): value is NonNullable<CareDecision["visual_context"]> {
  if (!isExactObject(value, CARE_VISUAL_CONTEXT_KEYS)) return false;
  if (typeof value.sent_to_mimo !== "boolean") return false;
  if (!value.sent_to_mimo) {
    return value.type === null
      && value.start_ms === null
      && value.end_ms === null
      && value.sample_count === null;
  }
  if (value.type !== "keyframes" && value.type !== "clip") return false;
  if (value.start_ms !== null && !isFiniteNonNegativeNumber(value.start_ms)) return false;
  if (value.end_ms !== null && !isFiniteNonNegativeNumber(value.end_ms)) return false;
  if (typeof value.start_ms === "number"
    && typeof value.end_ms === "number"
    && value.end_ms < value.start_ms) return false;
  return value.sample_count === null
    || (isNonNegativeSafeInteger(value.sample_count) && value.sample_count > 0);
}

function validateAlarm(value: unknown): value is NonNullable<CareDecision["alarm"]> {
  if (!isExactObject(value, ALARM_KEYS)) return false;
  if (!isUniqueClosedList(value.channels, ["vibrate", "ring", "flash"])) return false;
  return value.trigger === "elder_report"
    || value.trigger === "voice_intent"
    || value.trigger === "visual_confirm"
    || value.trigger === "check_in_timeout"
    || value.trigger === "unclear_response"
    || value.trigger === "family_unresponsive";
}

function validateActiveGrant(value: unknown): value is ActiveMediaGrant {
  return isExactObject(value, ACTIVE_GRANT_KEYS)
    && isOpaqueId(value.grant_id)
    && isOpaqueId(value.event_id)
    && isMediaGrantScope(value.scope)
    && isFiniteNonNegativeNumber(value.expires_at_ms)
    && value.status === "active";
}

function validateCommandBody(value: unknown): value is ControlCommandBody {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("name" in value) || typeof value.name !== "string") return false;
  const record = value as Record<string, unknown>;
  if (record.name === "select_scene") {
    if (!isExactObject(record, ["name", "scene_id"])) return false;
    return isSceneId(record.scene_id);
  }
  if (record.name === "select_source") {
    if (!isExactObject(record, ["name", "source_id"])) return false;
    return isOpaqueId(record.source_id);
  }
  if (
    record.name === "start_capture"
    || record.name === "stop_capture"
    || record.name === "reset_demo"
  ) return isExactObject(record, ["name"]);
  if (record.name === "run_demo_scenario") {
    if (!isExactObject(record, ["name", "scenario"])) return false;
    return record.scenario === "normal" || record.scenario === "fall";
  }
  if (record.name === "start_conversation") {
    if (!isExactObject(record, ["name", "scenario"])) return false;
    return record.scenario === "proactive_check_in" || record.scenario === "kitchen_share";
  }
  if (record.name === "submit_response") {
    if (!isExactObject(record, ["decision_id", "name", "response"])) return false;
    return isOpaqueId(record.decision_id)
      && (record.response === "safe"
        || record.response === "need_help"
        || record.response === "consent_granted"
        || record.response === "consent_denied");
  }
  if (record.name === "confirm_alarm"
    || record.name === "confirm_action_card"
    || record.name === "confirm_family_notification"
    || record.name === "replay_voice") {
    if (!isExactObject(record, ["decision_id", "name"])) return false;
    return isOpaqueId(record.decision_id);
  }
  return false;
}

function validateSessionDescription(
  value: unknown,
  expectedType: "offer" | "answer",
): value is { type: "offer" | "answer"; sdp: string } {
  return isExactObject(value, ["sdp", "type"])
    && value.type === expectedType
    && isBoundedString(value.sdp, 12_000);
}

function validateIceCandidate(value: unknown): value is {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment: string | null;
} {
  return isExactObject(value, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
    && isBoundedString(value.candidate, 4_096, true)
    && (value.sdpMid === null || isBoundedString(value.sdpMid, 128, true))
    && (value.sdpMLineIndex === null || isNonNegativeSafeInteger(value.sdpMLineIndex))
    && (value.usernameFragment === null || isBoundedString(value.usernameFragment, 256, true));
}

function isSceneId(value: unknown): value is SceneId {
  return typeof value === "string" && (SCENE_IDS as readonly string[]).includes(value);
}

function isMediaGrantScope(value: unknown): value is MediaGrantScope {
  return typeof value === "string" && (MEDIA_GRANT_SCOPES as readonly string[]).includes(value);
}

function isControlAckPhase(value: unknown): value is ControlAckPhase {
  return typeof value === "string" && (CONTROL_ACK_PHASES as readonly string[]).includes(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 16_384;
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 1;
}

function isNullableText(value: unknown, maxLength = 2_000): value is string | null {
  return value === null || isBoundedString(value, maxLength);
}

function isUniqueClosedList<const T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T[] {
  return Array.isArray(value)
    && value.length > 0
    && new Set(value).size === value.length
    && value.every((item) => (
      typeof item === "string" && (allowed as readonly string[]).includes(item)
    ));
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.trim().length > 0);
}
