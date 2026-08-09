export const CARE_DECISION_SCHEMA = "reme-care-decision/v0-experiment";

const SCENE_IDS = new Set(["living", "kitchen", "bathroom", "fall"]);
const DECISION_STATES = new Set([
  "normal",
  "observe",
  "check_in_required",
  "consent_required",
  "family_notification_required",
  "urgent_attention",
  "resolved",
  "degraded",
]);
const PRIVACY_MODES = new Set(["visible", "blurred", "skeleton_only", "hidden"]);
const DECISION_ACTIONS = new Set([
  "none",
  "observe",
  "ask_elder",
  "notify_family",
  "show_urgent_attention",
  "mark_resolved",
]);
const DECISION_SOURCES = new Set(["rule", "mimo", "mock", "record", "degraded"]);
const DEMO_MODES = new Set(["live", "mock", "record"]);
const UNCERTAINTIES = new Set(["low", "medium", "high", "unknown"]);
const CARD_STATUSES = new Set(["pending", "confirmed", "done"]);
const ALARM_CHANNELS = new Set(["vibrate", "ring", "flash"]);
const ALARM_TRIGGERS = new Set([
  "elder_report",
  "voice_intent",
  "visual_confirm",
  "check_in_timeout",
  "unclear_response",
  "family_unresponsive",
]);
const CONFIRM_CHANNELS = new Set(["frame", "voice"]);

const DECISION_KEYS = [
  "schema_version",
  "scene_id",
  "decision_id",
  "timestamp_ms",
  "state",
  "risk_level",
  "privacy_mode",
  "need_dialogue",
  "dialogue_goal",
  "elder_message",
  "family_notification",
  "action",
  "reason_summary",
  "uncertainty",
  "fallback_used",
  "source",
  "demo_mode",
  "consent_required",
  "response_timeout_ms",
  "response_deadline_ms",
  "action_card",
  "visual_context",
  "alarm",
  "voice_asset",
  "confirm_channels",
];
const ACTION_CARD_KEYS = [
  "event",
  "elder_quote",
  "system_judgment",
  "suggested_action",
  "time_window",
  "status",
];
const VISUAL_CONTEXT_KEYS = [
  "sent_to_mimo",
  "type",
  "start_ms",
  "end_ms",
  "sample_count",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isOpaqueId(value) {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 128
    && /^[a-z0-9_-]+$/i.test(value);
}

function isText(value, { nullable = false, maxLength = 2_000 } = {}) {
  if (nullable && value === null) return true;
  return typeof value === "string"
    && value.trim().length > 0
    && value.length <= maxLength;
}

function isTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUniqueClosedList(value, allowed) {
  return Array.isArray(value)
    && value.length > 0
    && new Set(value).size === value.length
    && value.every((item) => typeof item === "string" && allowed.has(item));
}

function containsEncodedMedia(value) {
  if (typeof value === "string") return /^data:(?:image|video|audio)\//i.test(value);
  if (Array.isArray(value)) return value.some(containsEncodedMedia);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsEncodedMedia);
}

function isActionCard(value) {
  return hasExactKeys(value, ACTION_CARD_KEYS)
    && isText(value.event)
    && isText(value.elder_quote)
    && isText(value.system_judgment)
    && isText(value.suggested_action)
    && isText(value.time_window)
    && CARD_STATUSES.has(value.status);
}

function isVisualContext(value) {
  if (!hasExactKeys(value, VISUAL_CONTEXT_KEYS)
    || typeof value.sent_to_mimo !== "boolean") return false;
  if (!value.sent_to_mimo) {
    return value.type === null
      && value.start_ms === null
      && value.end_ms === null
      && value.sample_count === null;
  }
  if (!["keyframes", "clip"].includes(value.type)) return false;
  if (value.start_ms !== null && !isTimestamp(value.start_ms)) return false;
  if (value.end_ms !== null && !isTimestamp(value.end_ms)) return false;
  if (value.start_ms !== null && value.end_ms !== null && value.end_ms < value.start_ms) {
    return false;
  }
  return value.sample_count === null
    || (Number.isSafeInteger(value.sample_count) && value.sample_count > 0);
}

function isAlarm(value) {
  return hasExactKeys(value, ["channels", "trigger"])
    && isUniqueClosedList(value.channels, ALARM_CHANNELS)
    && ALARM_TRIGGERS.has(value.trigger);
}

export function isCareDecision(value) {
  if (!hasExactKeys(value, DECISION_KEYS)) return false;
  if (containsEncodedMedia(value)) return false;
  if (value.schema_version !== CARE_DECISION_SCHEMA
    || !SCENE_IDS.has(value.scene_id)
    || !isOpaqueId(value.decision_id)
    || !isTimestamp(value.timestamp_ms)
    || !DECISION_STATES.has(value.state)
    || !Number.isSafeInteger(value.risk_level)
    || value.risk_level < 0
    || value.risk_level > 4
    || !PRIVACY_MODES.has(value.privacy_mode)
    || typeof value.need_dialogue !== "boolean"
    || !isText(value.dialogue_goal, { nullable: true })
    || !isText(value.elder_message, { nullable: true })
    || !isText(value.family_notification, { nullable: true })
    || !DECISION_ACTIONS.has(value.action)
    || !isText(value.reason_summary)
    || !UNCERTAINTIES.has(value.uncertainty)
    || typeof value.fallback_used !== "boolean"
    || !DECISION_SOURCES.has(value.source)
    || !DEMO_MODES.has(value.demo_mode)
    || typeof value.consent_required !== "boolean"
    || !isText(value.voice_asset, { nullable: true, maxLength: 512 })) return false;

  if (!value.need_dialogue && value.elder_message !== null) return false;
  if (value.action === "notify_family" && value.family_notification === null) return false;
  if (value.consent_required && value.action === "notify_family") return false;
  if (value.state === "consent_required"
    && (value.risk_level !== 2 || value.consent_required !== true)) return false;
  if (value.state === "degraded" && !value.fallback_used) return false;
  if (value.source === "degraded" && value.state !== "degraded") return false;
  if (value.response_timeout_ms !== null
    && (!Number.isSafeInteger(value.response_timeout_ms) || value.response_timeout_ms <= 0)) {
    return false;
  }
  if (value.response_deadline_ms !== null) {
    if (!isTimestamp(value.response_deadline_ms) || value.response_timeout_ms === null) {
      return false;
    }
  }
  if (value.action_card !== null && !isActionCard(value.action_card)) return false;
  if (value.visual_context !== null && !isVisualContext(value.visual_context)) return false;
  if (value.alarm !== null) {
    if (!isAlarm(value.alarm)
      || !["family_notification_required", "urgent_attention"].includes(value.state)) {
      return false;
    }
  }
  if (value.voice_asset !== null && value.elder_message === null) return false;
  if (value.confirm_channels !== null) {
    if (!isUniqueClosedList(value.confirm_channels, CONFIRM_CHANNELS)
      || value.action !== "ask_elder") return false;
  }
  return true;
}

function freezeNullableRecord(value) {
  return value === null ? null : Object.freeze({ ...value });
}

export function projectCareDecision(value) {
  if (!isCareDecision(value)) return null;
  return Object.freeze({
    schema_version: value.schema_version,
    scene_id: value.scene_id,
    decision_id: value.decision_id,
    timestamp_ms: value.timestamp_ms,
    state: value.state,
    risk_level: value.risk_level,
    privacy_mode: value.privacy_mode,
    need_dialogue: value.need_dialogue,
    dialogue_goal: value.dialogue_goal,
    elder_message: value.elder_message,
    family_notification: value.family_notification,
    action: value.action,
    reason_summary: value.reason_summary,
    uncertainty: value.uncertainty,
    fallback_used: value.fallback_used,
    source: value.source,
    demo_mode: value.demo_mode,
    consent_required: value.consent_required,
    response_timeout_ms: value.response_timeout_ms,
    response_deadline_ms: value.response_deadline_ms,
    action_card: freezeNullableRecord(value.action_card),
    visual_context: freezeNullableRecord(value.visual_context),
    alarm: value.alarm === null
      ? null
      : Object.freeze({
          channels: Object.freeze([...value.alarm.channels]),
          trigger: value.alarm.trigger,
        }),
    voice_asset: value.voice_asset,
    confirm_channels: value.confirm_channels === null
      ? null
      : Object.freeze([...value.confirm_channels]),
  });
}

export function mapDecisionStateToPhase(state) {
  if (["check_in_required", "consent_required"].includes(state)) return "checking";
  if (["family_notification_required", "urgent_attention"].includes(state)) return "emergency";
  if (state === "resolved") return "resolved";
  return "idle";
}

export function careDecisionMessage(decision) {
  return decision?.family_notification
    || decision?.elder_message
    || decision?.reason_summary
    || null;
}

export function hasCurrentAlarm(decision) {
  return Boolean(decision?.alarm && isCareDecision(decision));
}
