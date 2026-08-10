export const ROOM_NAME = "shared-live-demo";
export const DEMO_STATE_SCHEMA_VERSION = "reme-demo-state/v1";
export const CONTROL_COMMAND_SCHEMA_VERSION = "reme-control-command/v1";
export const POSE_FRAME_SCHEMA_VERSION = "reme-pose-frame-17/v1";
export const MEDIA_SIGNAL_SCHEMA_VERSION = "reme-media-signal/v1";
export const FAMILY_EVENT_SCHEMA_VERSION = "reme-family-event/v1";
export const MEDIA_AUTHORIZATION_SCHEMA_VERSION = "reme-media-authorization/v1";
export const REME_DATE_INDEX_SCHEMA_VERSION = "reme-date-index/v1";
export const REME_TIMELINE_DAY_SCHEMA_VERSION = "reme-timeline-day-state/v1";
export const REME_DIARY_SUMMARY_SCHEMA_VERSION = "reme-diary-summary-state/v1";
export const REME_DAY_REVISION_TYPE = "reme_day_revision";
export const REME_DEMO_DATASET_ID = "reme-aug-2026-demo-v1";
export const REME_DEMO_MODE = "mock_fixture";
export const REME_DEMO_TIMEZONE = "Asia/Shanghai";

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
    decision_id: string | null;
    consent: "none" | "pending" | "granted" | "denied";
    alarm_authoritative: boolean;
    message: string | null;
  };
  media_grant: ActiveMediaGrant | null;
}

export interface FamilyEvent {
  schema_version: typeof FAMILY_EVENT_SCHEMA_VERSION;
  runtime_session_id: string;
  revision: number;
  decision_timestamp_ms: number;
  published_at_ms: number;
  care: {
    decision_id: string;
    state:
      | "normal"
      | "observe"
      | "check_in_required"
      | "consent_required"
      | "family_notification_required"
      | "urgent_attention"
      | "resolved"
      | "degraded";
    action:
      | "none"
      | "observe"
      | "ask_elder"
      | "notify_family"
      | "show_urgent_attention"
      | "mark_resolved";
    risk_level: number;
    family_notification: string | null;
    privacy_mode: "visible" | "blurred" | "skeleton_only" | "hidden";
    alarm: null | {
      channels: Array<"vibrate" | "ring" | "flash">;
      trigger:
        | "elder_report"
        | "voice_intent"
        | "visual_confirm"
        | "check_in_timeout"
        | "unclear_response"
        | "family_unresponsive";
    };
    action_card: null | {
      event: string;
      system_judgment: string;
      suggested_action: string;
      time_window: string;
      status: "pending" | "confirmed" | "done";
      elder_quote?: string;
    };
    media_authorization: null | {
      schema_version: typeof MEDIA_AUTHORIZATION_SCHEMA_VERSION;
      authorization_id: string;
      decision_id: string;
      scene_id: string;
      scope: MediaGrantScope;
      status: "active";
      issued_at_ms: number;
      expires_at_ms: number;
      event_id: string | null;
    };
  };
}

export interface FamilyEventWire extends FamilyEvent {
  type: "family_event";
  room_session_id: string;
}

export interface RemeTimelineDayState {
  schema_version: typeof REME_TIMELINE_DAY_SCHEMA_VERSION;
  dataset_id: typeof REME_DEMO_DATASET_ID;
  mode: typeof REME_DEMO_MODE;
  date: string;
  timezone: typeof REME_DEMO_TIMEZONE;
  revision: number;
  updated_at_ms: number;
  status: "ready" | "partial" | "unavailable";
  coverage: {
    status: "complete" | "partial" | "unavailable";
    start_at_ms: number;
    end_at_ms: number;
    observed_hours: number;
    missing_intervals: Array<{ start_at_ms: number; end_at_ms: number }>;
  };
  counts: { total: number; activity: number; device: number; care: number };
  items: Array<Record<string, unknown>>;
}

export interface RemeDiarySummaryState {
  schema_version: typeof REME_DIARY_SUMMARY_SCHEMA_VERSION;
  dataset_id: typeof REME_DEMO_DATASET_ID;
  mode: typeof REME_DEMO_MODE;
  date: string;
  revision: number;
  input_timeline_revision: number;
  status: "generating" | "ready" | "unavailable";
  updated_at_ms: number;
  error_code:
    | null
    | "mimo_not_configured"
    | "mimo_timeout"
    | "mimo_upstream_error"
    | "mimo_invalid_output"
    | "timeline_not_ready";
  summary: null | {
    headline: string;
    summary: string;
    highlights: Array<{ time: string; text: string }>;
    care_note: string;
    uncertainty: "low" | "medium" | "high" | "unknown";
    source: "mimo";
    model: string;
    generated_at_ms: number;
    input_event_count: number;
    latency_ms: number;
    attempts: number;
  };
}

export interface RemeDateIndex {
  schema_version: typeof REME_DATE_INDEX_SCHEMA_VERSION;
  dataset_id: typeof REME_DEMO_DATASET_ID;
  mode: typeof REME_DEMO_MODE;
  timezone: typeof REME_DEMO_TIMEZONE;
  revision: number;
  dates: Array<{
    date: string;
    status: "ready" | "partial" | "unavailable";
    timeline_revision: number;
    summary_revision: number;
  }>;
}

export interface RemeDayRevision {
  type: typeof REME_DAY_REVISION_TYPE;
  dataset_id: typeof REME_DEMO_DATASET_ID;
  date: string;
  timeline_revision: number;
  summary_revision: number;
  summary_status: "generating" | "ready" | "unavailable";
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
  | { name: "acknowledge_alarm"; decision_id: string }
  | { name: "confirm_action_card"; decision_id: string }
  | { name: "confirm_alarm"; decision_id: string }
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
const CARE_KEYS = ["alarm_authoritative", "consent", "decision_id", "message", "phase"] as const;
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
  "mimo_completion",
  "mimo_prompt",
  "payload_bytes",
  "raw_audio",
  "raw_frame",
  "raw_video",
  "skeleton_history",
  "video_bytes",
  "camera_frame",
  "landmarks",
  "device_key",
  "device_secret",
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

export function validateFamilyEvent(value: unknown): value is FamilyEvent {
  if (!isExactObject(value, [
    "care",
    "decision_timestamp_ms",
    "published_at_ms",
    "revision",
    "runtime_session_id",
    "schema_version",
  ])) return false;
  if (value.schema_version !== FAMILY_EVENT_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.runtime_session_id)) return false;
  if (!isNonNegativeSafeInteger(value.revision) || value.revision === 0) return false;
  if (!isFiniteNonNegativeNumber(value.decision_timestamp_ms)) return false;
  if (!isFiniteNonNegativeNumber(value.published_at_ms)) return false;
  return validateFamilyCare(value.care) && !containsForbiddenRawMedia(value);
}

export function createFamilyEventWire(
  event: FamilyEvent,
  roomSessionId: string,
): FamilyEventWire {
  return {
    ...event,
    type: "family_event",
    room_session_id: roomSessionId,
  };
}

export function validateRemeTimelineDayState(value: unknown): value is RemeTimelineDayState {
  if (!isExactObject(value, [
    "counts",
    "coverage",
    "dataset_id",
    "date",
    "items",
    "mode",
    "revision",
    "schema_version",
    "status",
    "timezone",
    "updated_at_ms",
  ])) return false;
  if (value.schema_version !== REME_TIMELINE_DAY_SCHEMA_VERSION) return false;
  if (value.dataset_id !== REME_DEMO_DATASET_ID || value.mode !== REME_DEMO_MODE) return false;
  if (value.timezone !== REME_DEMO_TIMEZONE || !isIsoDate(value.date)) return false;
  if (!isPositiveSafeInteger(value.revision) || !isFiniteNonNegativeNumber(value.updated_at_ms)) {
    return false;
  }
  if (value.status !== "ready" && value.status !== "partial" && value.status !== "unavailable") {
    return false;
  }
  if (!validateRemeCoverage(value.coverage) || !validateRemeCounts(value.counts)) return false;
  if (!Array.isArray(value.items) || value.items.length > 512) return false;
  let activity = 0;
  let device = 0;
  let care = 0;
  for (const item of value.items) {
    if (!validateRemeTimelineItem(item)) return false;
    if (item.kind === "activity") activity += 1;
    else if (item.kind === "device") device += 1;
    else care += 1;
  }
  if (
    value.counts.activity !== activity
    || value.counts.device !== device
    || value.counts.care !== care
    || value.counts.total !== activity + device + care
  ) return false;
  return !containsForbiddenRawMedia(value);
}

export function validateRemeDiarySummaryState(value: unknown): value is RemeDiarySummaryState {
  if (!isExactObject(value, [
    "dataset_id",
    "date",
    "error_code",
    "input_timeline_revision",
    "mode",
    "revision",
    "schema_version",
    "status",
    "summary",
    "updated_at_ms",
  ])) return false;
  if (value.schema_version !== REME_DIARY_SUMMARY_SCHEMA_VERSION) return false;
  if (value.dataset_id !== REME_DEMO_DATASET_ID || value.mode !== REME_DEMO_MODE) return false;
  if (!isIsoDate(value.date) || !isPositiveSafeInteger(value.revision)) return false;
  if (!isPositiveSafeInteger(value.input_timeline_revision)) return false;
  if (!isFiniteNonNegativeNumber(value.updated_at_ms)) return false;
  if (value.status !== "generating" && value.status !== "ready" && value.status !== "unavailable") {
    return false;
  }
  const errors = [
    "mimo_not_configured",
    "mimo_timeout",
    "mimo_upstream_error",
    "mimo_invalid_output",
    "timeline_not_ready",
  ];
  if (value.error_code !== null && !errors.includes(String(value.error_code))) return false;
  if (value.status === "ready") {
    if (value.error_code !== null || !validateRemeSummary(value.summary)) return false;
  } else if (value.summary !== null) return false;
  return !containsForbiddenRawMedia(value);
}

function validateRemeCoverage(value: unknown): value is RemeTimelineDayState["coverage"] {
  if (!isExactObject(value, [
    "end_at_ms",
    "missing_intervals",
    "observed_hours",
    "start_at_ms",
    "status",
  ])) return false;
  if (value.status !== "complete" && value.status !== "partial" && value.status !== "unavailable") {
    return false;
  }
  if (!isFiniteNonNegativeNumber(value.start_at_ms)
    || !isFiniteNonNegativeNumber(value.end_at_ms)
    || value.end_at_ms < value.start_at_ms) return false;
  if (!isFiniteNonNegativeNumber(value.observed_hours) || value.observed_hours > 24) return false;
  if (!Array.isArray(value.missing_intervals) || value.missing_intervals.length > 96) return false;
  for (const interval of value.missing_intervals) {
    if (!isExactObject(interval, ["end_at_ms", "start_at_ms"])) return false;
    if (!isFiniteNonNegativeNumber(interval.start_at_ms)
      || !isFiniteNonNegativeNumber(interval.end_at_ms)
      || interval.end_at_ms < interval.start_at_ms) return false;
  }
  if (value.status === "complete") {
    return value.observed_hours === 24 && value.missing_intervals.length === 0;
  }
  return true;
}

function validateRemeCounts(value: unknown): value is RemeTimelineDayState["counts"] {
  if (!isExactObject(value, ["activity", "care", "device", "total"])) return false;
  return isNonNegativeSafeInteger(value.activity)
    && isNonNegativeSafeInteger(value.device)
    && isNonNegativeSafeInteger(value.care)
    && isNonNegativeSafeInteger(value.total);
}

function validateRemeTimelineItem(
  value: unknown,
): value is RemeTimelineDayState["items"][number] & { kind: "activity" | "device" | "care_thread" } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.kind !== "activity" && item.kind !== "device" && item.kind !== "care_thread") return false;
  if (!isOpaqueId(item.event_id)) return false;
  if (!isFiniteNonNegativeNumber(item.occurred_at_ms)
    || !isFiniteNonNegativeNumber(item.recorded_at_ms)
    || item.recorded_at_ms < item.occurred_at_ms) return false;
  if (item.kind === "activity") {
    if (!isExactObject(item, [
      "detail",
      "event_id",
      "fact",
      "fact_type",
      "kind",
      "occurred_at_ms",
      "occurrence_count",
      "recorded_at_ms",
      "related",
      "room",
      "source",
    ])) return false;
    return isBoundedString(item.room, 80)
      && isBoundedString(item.fact_type, 80)
      && isBoundedString(item.fact, 500)
      && isBoundedString(item.detail, 1_000)
      && isPositiveSafeInteger(item.occurrence_count)
      && validateActivitySource(item.source)
      && Array.isArray(item.related)
      && item.related.length <= 32
      && item.related.every((related) => (
        isExactObject(related, ["fact", "occurred_at_ms"])
        && isFiniteNonNegativeNumber(related.occurred_at_ms)
        && isBoundedString(related.fact, 500)
      ));
  }
  if (item.kind === "device") {
    if (!isExactObject(item, [
      "action",
      "device",
      "event_id",
      "fact",
      "kind",
      "occurred_at_ms",
      "occurrence_count",
      "recorded_at_ms",
      "room",
      "source",
      "value",
    ])) return false;
    return isBoundedString(item.room, 80)
      && isBoundedString(item.action, 80)
      && isBoundedString(item.fact, 500)
      && isPositiveSafeInteger(item.occurrence_count)
      && validateDeviceDescriptor(item.device)
      && validateDeviceSource(item.source)
      && item.value !== null
      && typeof item.value === "object"
      && !Array.isArray(item.value);
  }
  if (!isExactObject(item, [
    "assessment",
    "check_in",
    "delivery",
    "event_id",
    "kind",
    "material",
    "occurred_at_ms",
    "recorded_at_ms",
    "response",
    "source",
    "status",
    "thread_id",
  ])) return false;
  if (!isOpaqueId(item.thread_id) || !isBoundedString(item.status, 64)) return false;
  return validateCareSource(item.source)
    && validateCareAssessment(item.assessment)
    && validateCareCheckIn(item.check_in)
    && validateCareResponse(item.response)
    && validateCareMaterial(item.material)
    && validateCareDelivery(item.delivery);
}

function validateActivitySource(value: unknown): boolean {
  return isExactObject(value, ["confidence", "mode", "type"])
    && value.type === "pose_observation"
    && value.mode === REME_DEMO_MODE
    && (value.confidence === null || isFiniteNonNegativeNumber(value.confidence));
}

function validateDeviceSource(value: unknown): boolean {
  return isExactObject(value, ["adapter", "mode", "type"])
    && value.type === "smart_home_event"
    && value.mode === REME_DEMO_MODE
    && value.adapter === "demo_fixture";
}

function validateCareSource(value: unknown): boolean {
  return isExactObject(value, ["mode"]) && value.mode === REME_DEMO_MODE;
}

function validateDeviceDescriptor(value: unknown): boolean {
  return isExactObject(value, ["capability", "device_id", "device_type"])
    && isOpaqueId(value.device_id)
    && isBoundedString(value.device_type, 80)
    && isBoundedString(value.capability, 80);
}

function validateCareAssessment(value: unknown): boolean {
  if (!isExactObject(value, [
    "baseline",
    "basis",
    "source",
    "suggested_action",
    "title",
    "uncertainty",
    "visual_context",
  ])) return false;
  if (!isBoundedString(value.title, 300)
    || !isBoundedString(value.basis, 1_000)
    || !isBoundedString(value.suggested_action, 500)
    || value.source !== "mimo"
    || !["low", "medium", "high", "unknown"].includes(String(value.uncertainty))) return false;
  if (!isExactObject(value.baseline, ["comparison_period", "sample_count", "version"])) {
    return false;
  }
  if (!isBoundedString(value.baseline.version, 128)
    || !isBoundedString(value.baseline.comparison_period, 128)
    || !isNonNegativeSafeInteger(value.baseline.sample_count)) return false;
  if (!isExactObject(value.visual_context, ["sample_count", "sent_to_mimo", "type"])) return false;
  if (typeof value.visual_context.sent_to_mimo !== "boolean") return false;
  if (value.visual_context.type !== null
    && value.visual_context.type !== "keyframes"
    && value.visual_context.type !== "clip") return false;
  return value.visual_context.sample_count === null
    || isNonNegativeSafeInteger(value.visual_context.sample_count);
}

function validateCareCheckIn(value: unknown): boolean {
  return isExactObject(value, ["asked_at_ms", "prompt"])
    && isFiniteNonNegativeNumber(value.asked_at_ms)
    && isBoundedString(value.prompt, 500);
}

function validateCareResponse(value: unknown): boolean {
  if (!isExactObject(value, ["consent_scope", "received_at_ms", "status", "summary"])) {
    return false;
  }
  return isFiniteNonNegativeNumber(value.received_at_ms)
    && value.status === "received"
    && isBoundedString(value.summary, 500)
    && (value.consent_scope === null || isBoundedString(value.consent_scope, 128));
}

function validateCareMaterial(value: unknown): boolean {
  if (value === null) return true;
  if (!isExactObject(value, [
    "attachment",
    "facts",
    "generated_by",
    "label",
    "material_id",
    "status",
    "summary",
  ])) return false;
  if (!isOpaqueId(value.material_id)
    || value.status !== "ready"
    || !isBoundedString(value.label, 240)
    || !isBoundedString(value.summary, 800)
    || value.generated_by !== "mimo") return false;
  if (!Array.isArray(value.facts) || value.facts.length > 32) return false;
  if (!value.facts.every((fact) => (
    isExactObject(fact, ["event_id", "text"])
    && isOpaqueId(fact.event_id)
    && isBoundedString(fact.text, 500)
  ))) return false;
  return isExactObject(value.attachment, [
    "asset_id",
    "duration_seconds",
    "privacy_mode",
    "status",
    "type",
  ])
    && value.attachment.type === "skeleton_clip"
    && value.attachment.status === "metadata_only"
    && isFiniteNonNegativeNumber(value.attachment.duration_seconds)
    && value.attachment.privacy_mode === "skeleton"
    && value.attachment.asset_id === null;
}

function validateCareDelivery(value: unknown): boolean {
  if (value === null) return true;
  return isExactObject(value, [
    "delivered_at_ms",
    "recipient_label",
    "status",
    "transport_receipt_id",
  ])
    && isBoundedString(value.recipient_label, 120)
    && value.status === "mock_delivered"
    && isFiniteNonNegativeNumber(value.delivered_at_ms)
    && value.transport_receipt_id === null;
}

function validateRemeSummary(value: unknown): value is NonNullable<RemeDiarySummaryState["summary"]> {
  if (!isExactObject(value, [
    "attempts",
    "care_note",
    "generated_at_ms",
    "headline",
    "highlights",
    "input_event_count",
    "latency_ms",
    "model",
    "source",
    "summary",
    "uncertainty",
  ])) return false;
  if (!isBoundedString(value.headline, 40) || !isBoundedString(value.summary, 240)) return false;
  if (!isBoundedString(value.care_note, 160) || !isBoundedString(value.model, 128)) return false;
  if (value.source !== "mimo") return false;
  if (!["low", "medium", "high", "unknown"].includes(String(value.uncertainty))) return false;
  if (!isFiniteNonNegativeNumber(value.generated_at_ms)
    || !isNonNegativeSafeInteger(value.input_event_count)
    || !isFiniteNonNegativeNumber(value.latency_ms)
    || !isPositiveSafeInteger(value.attempts)) return false;
  if (!Array.isArray(value.highlights) || value.highlights.length > 4) return false;
  return value.highlights.every((item) => (
    isExactObject(item, ["text", "time"])
    && typeof item.time === "string"
    && /^\d{2}:\d{2}$/.test(item.time)
    && isBoundedString(item.text, 120)
  ));
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
  if (requireRelayOwnedGrant) return value.media_grant === null;
  return value.media_grant === null || validateActiveGrant(value.media_grant);
}

function validateFamilyCare(value: unknown): value is FamilyEvent["care"] {
  if (!isExactObject(value, [
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
  if (!isOpaqueId(value.decision_id)) return false;
  if (!["normal", "observe", "check_in_required", "consent_required", "family_notification_required", "urgent_attention", "resolved", "degraded"].includes(String(value.state))) return false;
  if (!["none", "observe", "ask_elder", "notify_family", "show_urgent_attention", "mark_resolved"].includes(String(value.action))) return false;
  if (!Number.isSafeInteger(value.risk_level) || (value.risk_level as number) < 0 || (value.risk_level as number) > 4) return false;
  if (value.family_notification !== null && !isBoundedString(value.family_notification, 500)) return false;
  if (!["visible", "blurred", "skeleton_only", "hidden"].includes(String(value.privacy_mode))) return false;
  if (!validateFamilyAlarm(value.alarm)) return false;
  if (!validateFamilyActionCard(value.action_card)) return false;
  if (!validateMediaAuthorization(value.media_authorization, value.decision_id)) return false;
  return true;
}

function validateFamilyAlarm(value: unknown): value is FamilyEvent["care"]["alarm"] {
  if (value === null) return true;
  if (!isExactObject(value, ["channels", "trigger"])) return false;
  if (!Array.isArray(value.channels) || value.channels.length === 0) return false;
  if (!value.channels.every((channel) => (
    channel === "vibrate" || channel === "ring" || channel === "flash"
  ))) return false;
  if (new Set(value.channels).size !== value.channels.length) return false;
  return [
    "elder_report",
    "voice_intent",
    "visual_confirm",
    "check_in_timeout",
    "unclear_response",
    "family_unresponsive",
  ].includes(String(value.trigger));
}

function validateFamilyActionCard(value: unknown): value is FamilyEvent["care"]["action_card"] {
  if (value === null) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const base = ["event", "status", "suggested_action", "system_judgment", "time_window"].sort();
  const withQuote = [...base, "elder_quote"].sort();
  if (!(
    (keys.length === base.length && keys.every((key, index) => key === base[index]))
    || (keys.length === withQuote.length && keys.every((key, index) => key === withQuote[index]))
  )) return false;
  const record = value as Record<string, unknown>;
  if (!isBoundedString(record.event, 500)) return false;
  if (!isBoundedString(record.system_judgment, 500)) return false;
  if (!isBoundedString(record.suggested_action, 500)) return false;
  if (!isBoundedString(record.time_window, 240)) return false;
  if (record.status !== "pending" && record.status !== "confirmed" && record.status !== "done") return false;
  return record.elder_quote === undefined || isBoundedString(record.elder_quote, 500);
}

function validateMediaAuthorization(
  value: unknown,
  decisionId: string,
): value is FamilyEvent["care"]["media_authorization"] {
  if (value === null) return true;
  if (!isExactObject(value, [
    "authorization_id",
    "decision_id",
    "event_id",
    "expires_at_ms",
    "issued_at_ms",
    "scene_id",
    "schema_version",
    "scope",
    "status",
  ])) return false;
  if (value.schema_version !== MEDIA_AUTHORIZATION_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.authorization_id) || value.decision_id !== decisionId) return false;
  if (!isOpaqueId(value.decision_id) || !isOpaqueId(value.scene_id)) return false;
  if (!isMediaGrantScope(value.scope) || value.status !== "active") return false;
  if (!isFiniteNonNegativeNumber(value.issued_at_ms) || !isFiniteNonNegativeNumber(value.expires_at_ms)) return false;
  if (value.expires_at_ms <= value.issued_at_ms) return false;
  if (value.event_id !== null && !isOpaqueId(value.event_id)) return false;
  return value.scope === "kitchen_moment"
    ? value.expires_at_ms - value.issued_at_ms <= 60_000
    : value.expires_at_ms - value.issued_at_ms <= 30_000;
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
  if (value.decision_id !== null && !isOpaqueId(value.decision_id)) return false;
  if (
    value.consent !== "none"
    && value.consent !== "pending"
    && value.consent !== "granted"
    && value.consent !== "denied"
  ) return false;
  if (typeof value.alarm_authoritative !== "boolean") return false;
  if (value.message !== null && !isBoundedString(value.message, 240)) return false;
  if (value.phase === "emergency") {
    return value.alarm_authoritative && value.decision_id !== null;
  }
  return !value.alarm_authoritative;
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
  if (
    record.name === "acknowledge_alarm"
    || record.name === "confirm_action_card"
    || record.name === "confirm_alarm"
    || record.name === "replay_voice"
  ) {
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

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parts = value.split("-");
  const year = Number(parts[0]!);
  const month = Number(parts[1]!);
  const day = Number(parts[2]!);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isPositiveDimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 16_384;
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 1;
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}
