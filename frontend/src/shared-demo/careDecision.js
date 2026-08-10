import { isMediaAuthorization } from "./protocol.js";

export const CARE_DECISION_SCHEMA = "reme-care-decision/v0-experiment";
const LEGACY_CARE_DECISION_SCHEMA = "reme-care-decision/v1-experiment";

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
const FAMILY_DELIVERIES = new Set(["none", "notification", "action_card", "alarm"]);
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
  "family_delivery",
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
const BACKEND_DECISION_KEYS = [
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
  "action_card",
  "media_authorization",
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
const FAMILY_ACTION_CARD_KEYS = [
  "event",
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
const FAMILY_CARE_KEYS = [
  "schema_version",
  "scene_id",
  "decision_id",
  "timestamp_ms",
  "state",
  "risk_level",
  "privacy_mode",
  "family_notification",
  "action",
  "family_delivery",
  "reason_summary",
  "uncertainty",
  "fallback_used",
  "source",
  "demo_mode",
  "action_card",
  "visual_context",
  "alarm",
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

function isFamilyActionCard(value) {
  return hasExactKeys(value, FAMILY_ACTION_CARD_KEYS)
    && isText(value.event)
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

function isFamilyDeliveryConsistent(value) {
  const hasCard = value.action_card !== null;
  const hasAlarm = value.alarm !== null;
  if (hasCard && hasAlarm) return false;

  if (value.family_delivery === "action_card") {
    if (!hasCard || hasAlarm) return false;
    if (value.action_card.status === "pending") {
      return value.state === "family_notification_required"
        && value.action === "notify_family"
        && value.family_notification !== null
        && value.risk_level === 2;
    }
    return value.state === "resolved"
      && value.action === "mark_resolved"
      && value.risk_level === 0;
  }
  if (hasCard) return false;

  if (value.family_delivery === "alarm") {
    return hasAlarm
      && value.risk_level >= 3
      && value.family_notification !== null
      && ["notify_family", "show_urgent_attention"].includes(value.action);
  }
  if (hasAlarm) return false;

  if (value.family_delivery === "notification") {
    return value.family_notification !== null
      && ["notify_family", "show_urgent_attention"].includes(value.action)
      && ["family_notification_required", "urgent_attention", "resolved"].includes(value.state);
  }
  return value.family_notification === null
    && !["notify_family", "show_urgent_attention"].includes(value.action)
    && !["family_notification_required", "urgent_attention"].includes(value.state);
}

export function isCareDecision(value) {
  const backendContract = hasExactKeys(value, BACKEND_DECISION_KEYS)
    && value.schema_version === CARE_DECISION_SCHEMA;
  const legacyContract = hasExactKeys(value, DECISION_KEYS)
    && value.schema_version === LEGACY_CARE_DECISION_SCHEMA;
  if (!backendContract && !legacyContract) return false;
  if (containsEncodedMedia(value)) return false;
  if (!SCENE_IDS.has(value.scene_id)
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
  if (legacyContract && value.response_deadline_ms !== null) {
    if (!isTimestamp(value.response_deadline_ms) || value.response_timeout_ms === null) {
      return false;
    }
  }
  if (value.action_card !== null && !isActionCard(value.action_card)) return false;
  if (backendContract && value.media_authorization !== null) {
    if (!isMediaAuthorization(value.media_authorization, value.decision_id)
      || value.media_authorization.scene_id !== value.scene_id
      || ["hidden", "skeleton_only"].includes(value.privacy_mode)) return false;
  }
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
  return backendContract || (
    FAMILY_DELIVERIES.has(value.family_delivery)
    && isFamilyDeliveryConsistent(value)
  );
}

export function isFamilyCare(value) {
  if (!hasExactKeys(value, FAMILY_CARE_KEYS) || containsEncodedMedia(value)) return false;
  if (value.schema_version !== LEGACY_CARE_DECISION_SCHEMA
    || !SCENE_IDS.has(value.scene_id)
    || !isOpaqueId(value.decision_id)
    || !isTimestamp(value.timestamp_ms)
    || !DECISION_STATES.has(value.state)
    || !Number.isSafeInteger(value.risk_level)
    || value.risk_level < 0
    || value.risk_level > 4
    || !PRIVACY_MODES.has(value.privacy_mode)
    || !isText(value.family_notification, { nullable: true })
    || !DECISION_ACTIONS.has(value.action)
    || !FAMILY_DELIVERIES.has(value.family_delivery)
    || !isText(value.reason_summary)
    || !UNCERTAINTIES.has(value.uncertainty)
    || typeof value.fallback_used !== "boolean"
    || !DECISION_SOURCES.has(value.source)
    || !DEMO_MODES.has(value.demo_mode)) return false;
  if (value.action === "notify_family" && value.family_notification === null) return false;
  if (value.state === "degraded" && !value.fallback_used) return false;
  if (value.source === "degraded" && value.state !== "degraded") return false;
  if (value.action_card !== null && !isFamilyActionCard(value.action_card)) return false;
  if (value.visual_context !== null && !isVisualContext(value.visual_context)) return false;
  if (value.alarm !== null && (!isAlarm(value.alarm)
    || !["family_notification_required", "urgent_attention"].includes(value.state))) {
    return false;
  }
  return isFamilyDeliveryConsistent(value);
}

function freezeNullableRecord(value) {
  return value === null ? null : Object.freeze({ ...value });
}

export function projectCareDecision(value) {
  if (!isCareDecision(value)) return null;
  const projected = {
    ...value,
    action_card: freezeNullableRecord(value.action_card),
    visual_context: freezeNullableRecord(value.visual_context),
    alarm: value.alarm === null
      ? null
      : Object.freeze({
          channels: Object.freeze([...value.alarm.channels]),
          trigger: value.alarm.trigger,
        }),
    confirm_channels: value.confirm_channels === null
      ? null
      : Object.freeze([...value.confirm_channels]),
  };
  if (Object.hasOwn(value, "media_authorization")) {
    projected.media_authorization = freezeNullableRecord(value.media_authorization);
  }
  return Object.freeze(projected);
}

export function mapCareDecisionToPhase(decision) {
  if (!decision) return "idle";
  if (["check_in_required", "consent_required"].includes(decision.state)) return "checking";
  if (decision.state === "resolved") return "resolved";
  if (decision.alarm || decision.family_delivery === "alarm") return "emergency";
  if (decision.action_card
    || decision.family_notification
    || ["notification", "action_card"].includes(decision.family_delivery)) return "attention";
  return "idle";
}

export function careDecisionMessage(decision) {
  return decision?.family_notification
    || decision?.elder_message
    || decision?.reason_summary
    || null;
}

export function hasCurrentAlarm(decision) {
  return Boolean(
    decision?.alarm
      && isCareDecision(decision),
  );
}
