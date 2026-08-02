export const DEMO_EVENT_SCHEMA_VERSION = "reme-demo-event/v1";
export const MEDIA_SIGNAL_SCHEMA_VERSION = "reme-media-signal/v1";

export const DEMO_EVENT_TYPES = [
  "scene_state",
  "activity_state",
  "care_card",
  "alarm_state",
  "media_grant",
] as const;

export const MEDIA_GRANT_SCOPES = ["kitchen_moment", "fall_emergency"] as const;

export type DemoEventType = (typeof DEMO_EVENT_TYPES)[number];
export type MediaGrantScope = (typeof MEDIA_GRANT_SCOPES)[number];

export interface SceneStatePayload {
  scene_id: "living" | "kitchen" | "bathroom" | "fall";
  visual_mode: "abstract_environment" | "skeleton_only";
}

export interface ActivityStatePayload {
  activity: "cooking";
  phase: "sampling" | "candidate" | "confirmed" | "unavailable";
  source: "mimo_visual" | "manual_debug";
  confidence: number | null;
  reason: string;
}

export interface CareCardPayload {
  card_id: string;
  event_id: string;
  kind: "family_heartbeat";
  title: string;
  body: string;
  occurred_at_ms: number;
  share_state: "local_only" | "consent_pending" | "consented" | "denied" | "expired";
}

export interface AlarmStatePayload {
  event_id: string;
  phase: "checking" | "escalated" | "resolved";
  trigger:
    | "fall_transition"
    | "elder_need_help"
    | "voice_intent"
    | "check_in_timeout"
    | "visual_confirm"
    | "manual_debug";
  message: string;
  response_deadline_ms: number | null;
  media_scope: "none" | "fall_emergency";
}

export interface MediaGrantPayload {
  grant_id: string;
  event_id: string;
  scope: MediaGrantScope;
  expires_at_ms: number;
  status: "active" | "revoked" | "expired";
}

export type DemoEventPayload =
  | SceneStatePayload
  | ActivityStatePayload
  | CareCardPayload
  | AlarmStatePayload
  | MediaGrantPayload;

interface DemoEventBase<T extends DemoEventType, P extends DemoEventPayload> {
  schema_version: typeof DEMO_EVENT_SCHEMA_VERSION;
  session_id: string;
  event_sequence: number;
  timestamp_ms: number;
  event_type: T;
  payload: P;
}

export type DemoEvent =
  | DemoEventBase<"scene_state", SceneStatePayload>
  | DemoEventBase<"activity_state", ActivityStatePayload>
  | DemoEventBase<"care_card", CareCardPayload>
  | DemoEventBase<"alarm_state", AlarmStatePayload>
  | DemoEventBase<"media_grant", MediaGrantPayload>;

export interface MediaSignal {
  schema_version: typeof MEDIA_SIGNAL_SCHEMA_VERSION;
  grant_id: string;
  target_id: string;
  signal_type: "offer" | "answer" | "ice_candidate";
  signal: { sdp: string } | {
    candidate: string;
    sdp_mid: string | null;
    sdp_mline_index: number | null;
  };
}

export interface ForwardedMediaSignal extends MediaSignal {
  from_id: string;
}

export interface MediaGrantRequest {
  type: "media_grant_request";
  event_id: string;
  scope: MediaGrantScope;
  expires_in_ms: number;
}

export interface MediaGrantRevoke {
  type: "media_grant_revoke";
  grant_id: string;
}

const EVENT_KEYS = [
  "event_sequence",
  "event_type",
  "payload",
  "schema_version",
  "session_id",
  "timestamp_ms",
] as const;
const SCENE_STATE_KEYS = ["scene_id", "visual_mode"] as const;
const ACTIVITY_STATE_KEYS = ["activity", "confidence", "phase", "reason", "source"] as const;
const CARE_CARD_KEYS = [
  "body",
  "card_id",
  "event_id",
  "kind",
  "occurred_at_ms",
  "share_state",
  "title",
] as const;
const ALARM_STATE_KEYS = [
  "event_id",
  "media_scope",
  "message",
  "phase",
  "response_deadline_ms",
  "trigger",
] as const;
const MEDIA_GRANT_KEYS = ["event_id", "expires_at_ms", "grant_id", "scope", "status"] as const;
const MEDIA_SIGNAL_KEYS = ["grant_id", "schema_version", "signal", "signal_type", "target_id"] as const;
const DESCRIPTION_SIGNAL_KEYS = ["sdp"] as const;
const ICE_SIGNAL_KEYS = ["candidate", "sdp_mid", "sdp_mline_index"] as const;

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

export function validateDemoEvent(value: unknown, sessionId: string): value is DemoEvent {
  if (!isExactObject(value, EVENT_KEYS)) return false;
  if (value.schema_version !== DEMO_EVENT_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.session_id) || value.session_id !== sessionId) return false;
  if (!Number.isSafeInteger(value.event_sequence) || (value.event_sequence as number) < 0) {
    return false;
  }
  if (!isFiniteNonNegativeNumber(value.timestamp_ms)) return false;
  if (!isDemoEventType(value.event_type)) return false;
  return validateEventPayload(value.event_type, value.payload, value.timestamp_ms);
}

export function validateMediaSignal(value: unknown): value is MediaSignal {
  if (!isExactObject(value, MEDIA_SIGNAL_KEYS)) return false;
  if (value.schema_version !== MEDIA_SIGNAL_SCHEMA_VERSION) return false;
  if (!isOpaqueId(value.grant_id) || !isOpaqueId(value.target_id)) return false;
  if (
    value.signal_type !== "offer"
    && value.signal_type !== "answer"
    && value.signal_type !== "ice_candidate"
  ) return false;
  return value.signal_type === "ice_candidate"
    ? validateIceSignal(value.signal)
    : validateDescriptionSignal(value.signal);
}

export function validateMediaGrantRequest(value: unknown): value is MediaGrantRequest {
  return isExactObject(value, ["type", "event_id", "scope", "expires_in_ms"])
    && value.type === "media_grant_request"
    && isOpaqueId(value.event_id)
    && isMediaGrantScope(value.scope)
    && Number.isSafeInteger(value.expires_in_ms)
    && (value.expires_in_ms as number) >= 5_000
    && (value.expires_in_ms as number) <= 60_000;
}

export function validateMediaGrantRevoke(value: unknown): value is MediaGrantRevoke {
  return isExactObject(value, ["type", "grant_id"])
    && value.type === "media_grant_revoke"
    && isOpaqueId(value.grant_id);
}

export function createForwardedMediaSignal(
  value: MediaSignal,
  fromId: string,
): ForwardedMediaSignal {
  return {
    ...value,
    from_id: fromId,
  };
}

function validateEventPayload(
  eventType: DemoEventType,
  payload: unknown,
  timestampMs: number,
): payload is DemoEventPayload {
  if (eventType === "scene_state") return validateSceneState(payload);
  if (eventType === "activity_state") return validateActivityState(payload);
  if (eventType === "care_card") return validateCareCard(payload);
  if (eventType === "alarm_state") return validateAlarmState(payload);
  return validateMediaGrant(payload, timestampMs);
}

function validateSceneState(value: unknown): value is SceneStatePayload {
  if (!isExactObject(value, SCENE_STATE_KEYS)) return false;
  if (
    value.scene_id !== "living"
    && value.scene_id !== "kitchen"
    && value.scene_id !== "bathroom"
    && value.scene_id !== "fall"
  ) return false;
  if (value.visual_mode !== "abstract_environment" && value.visual_mode !== "skeleton_only") {
    return false;
  }
  return value.scene_id === "bathroom"
    ? value.visual_mode === "skeleton_only"
    : value.visual_mode === "abstract_environment";
}

function validateActivityState(value: unknown): value is ActivityStatePayload {
  return isExactObject(value, ACTIVITY_STATE_KEYS)
    && value.activity === "cooking"
    && (
      value.phase === "sampling"
      || value.phase === "candidate"
      || value.phase === "confirmed"
      || value.phase === "unavailable"
    )
    && (value.source === "mimo_visual" || value.source === "manual_debug")
    && (value.confidence === null || isUnitNumber(value.confidence))
    && isBoundedString(value.reason, 240, true)
    && (value.phase !== "confirmed" || value.confidence !== null);
}

function validateCareCard(value: unknown): value is CareCardPayload {
  return isExactObject(value, CARE_CARD_KEYS)
    && isOpaqueId(value.card_id)
    && isOpaqueId(value.event_id)
    && value.kind === "family_heartbeat"
    && isBoundedString(value.title, 80)
    && isBoundedString(value.body, 240)
    && isFiniteNonNegativeNumber(value.occurred_at_ms)
    && (
      value.share_state === "local_only"
      || value.share_state === "consent_pending"
      || value.share_state === "consented"
      || value.share_state === "denied"
      || value.share_state === "expired"
    );
}

function validateAlarmState(value: unknown): value is AlarmStatePayload {
  if (!isExactObject(value, ALARM_STATE_KEYS)) return false;
  if (!isOpaqueId(value.event_id)) return false;
  if (value.phase !== "checking" && value.phase !== "escalated" && value.phase !== "resolved") {
    return false;
  }
  if (value.media_scope !== "none" && value.media_scope !== "fall_emergency") return false;
  if (!isBoundedString(value.message, 240)) return false;
  if (value.response_deadline_ms !== null && !isFiniteNonNegativeNumber(value.response_deadline_ms)) {
    return false;
  }
  if (
    value.trigger !== "fall_transition"
    && value.trigger !== "elder_need_help"
    && value.trigger !== "voice_intent"
    && value.trigger !== "check_in_timeout"
    && value.trigger !== "visual_confirm"
    && value.trigger !== "manual_debug"
  ) return false;
  if (value.phase === "checking") {
    return value.media_scope === "none" && value.response_deadline_ms !== null;
  }
  if (value.phase === "escalated") {
    return value.media_scope === "fall_emergency" && value.response_deadline_ms === null;
  }
  return value.media_scope === "none" && value.response_deadline_ms === null;
}

function validateMediaGrant(value: unknown, timestampMs: number): value is MediaGrantPayload {
  return isExactObject(value, MEDIA_GRANT_KEYS)
    && isOpaqueId(value.grant_id)
    && isOpaqueId(value.event_id)
    && isMediaGrantScope(value.scope)
    && (
      value.status === "active"
      || value.status === "revoked"
      || value.status === "expired"
    )
    && isFiniteNonNegativeNumber(value.expires_at_ms)
    && (value.status !== "active" || value.expires_at_ms > timestampMs);
}

function validateDescriptionSignal(value: unknown): value is { sdp: string } {
  return isExactObject(value, DESCRIPTION_SIGNAL_KEYS)
    && isBoundedString(value.sdp, 12_000);
}

function validateIceSignal(value: unknown): value is {
  candidate: string;
  sdp_mid: string | null;
  sdp_mline_index: number | null;
} {
  return isExactObject(value, ICE_SIGNAL_KEYS)
    && isBoundedString(value.candidate, 4_096)
    && (value.sdp_mid === null || isBoundedString(value.sdp_mid, 128, true))
    && (
      value.sdp_mline_index === null
      || (
        typeof value.sdp_mline_index === "number"
        && Number.isSafeInteger(value.sdp_mline_index)
        && value.sdp_mline_index >= 0
      )
    );
}

function isDemoEventType(value: unknown): value is DemoEventType {
  return typeof value === "string" && (DEMO_EVENT_TYPES as readonly string[]).includes(value);
}

function isMediaGrantScope(value: unknown): value is MediaGrantScope {
  return typeof value === "string" && (MEDIA_GRANT_SCOPES as readonly string[]).includes(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 1;
}

function isBoundedString(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}
