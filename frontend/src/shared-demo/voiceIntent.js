const VOICE_INTENTS = Object.freeze(["safe", "need_help", "unclear"]);
const MAX_VOICE_AUDIO_BYTES = 44 + 10 * 16_000 * 2;
const MAX_VOICE_BASE64_CHARS = Math.ceil(MAX_VOICE_AUDIO_BYTES / 3) * 4;
const SUCCESS_KEYS = Object.freeze([
  "intent",
  "latency_ms",
  "model",
  "ok",
  "transcript",
]);

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value, maxLength, { allowEmpty = false } = {}) {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function isVoiceIntentSuccess(value) {
  return hasExactKeys(value, SUCCESS_KEYS)
    && value.ok === true
    && VOICE_INTENTS.includes(value.intent)
    && (value.transcript === null || isBoundedString(value.transcript, 240, { allowEmpty: true }))
    && isBoundedString(value.model, 128)
    && Number.isSafeInteger(value.latency_ms)
    && value.latency_ms >= 0;
}

export function estimatePromptLeadMs(durationSeconds, fallbackMs = 7_000) {
  if (!Number.isFinite(fallbackMs) || fallbackMs < 0) {
    throw new TypeError("fallbackMs must be a finite non-negative number");
  }
  return Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.ceil(durationSeconds * 1_000)
    : fallbackMs;
}

export function selectVoiceIntentAction({ eventId, fall, intent, nowMs = Date.now() }) {
  if (
    !eventId
    || !fall
    || fall.eventId !== eventId
    || fall.phase !== "checking"
  ) return "ignore";
  if (Number.isFinite(fall.deadlineMs) && fall.deadlineMs <= nowMs) return "expire";
  if (intent === "safe") return "resolve";
  if (intent === "need_help") return "escalate";
  if (intent === "unclear") return "continue_timeout";
  return "ignore";
}

export function selectFailClosedFallEvent(fall) {
  return fall?.phase === "checking"
    && typeof fall.eventId === "string"
    && fall.eventId.length > 0
    ? fall.eventId
    : null;
}

export function selectFallInterruptionAction({
  kind,
  fall,
  nowMs = Date.now(),
  visibilityState,
} = {}) {
  if (!selectFailClosedFallEvent(fall)) return "none";
  if (kind === "pagehide") return "escalate";
  if (
    kind !== "visibility"
    || !["hidden", "visible", "prerender"].includes(visibilityState)
  ) return "none";
  return !Number.isFinite(fall.deadlineMs) || fall.deadlineMs <= nowMs
    ? "escalate"
    : "preserve";
}

export function selectFallCheckInStartAction(visibilityState) {
  return visibilityState === "hidden" ? "escalate" : "prompt";
}

export function prepareFallRecoveryForNewSession(fall, nowMs = Date.now()) {
  if (
    !fall
    || typeof fall.eventId !== "string"
    || fall.eventId.length === 0
    || fall.phase === "idle"
  ) return null;
  if (
    fall.phase === "checking"
    && (!Number.isFinite(fall.deadlineMs) || fall.deadlineMs <= nowMs)
  ) {
    return {
      ...fall,
      phase: "escalated",
      deadlineMs: null,
      trigger: "check_in_timeout",
      message: "完整问询窗口没有收到回应，规则已进入告警状态。",
      delivery: "pending",
    };
  }
  return { ...fall, delivery: "pending" };
}

export function reconcileFallWithAuthoritativeAlarm(fall, alarm) {
  if (
    !alarm
    || typeof alarm.event_id !== "string"
    || !["checking", "escalated", "resolved"].includes(alarm.phase)
  ) return { action: "ignore", fall };

  const authoritative = {
    phase: alarm.phase,
    eventId: alarm.event_id,
    deadlineMs: alarm.response_deadline_ms,
    trigger: alarm.trigger,
    message: alarm.message,
    delivery: "accepted",
  };
  const sameEvent = fall?.eventId === alarm.event_id;

  if (alarm.phase === "checking" && sameEvent) {
    if (["escalated", "resolved"].includes(fall.phase)) {
      return { action: "republish", fall };
    }
    if (
      fall.phase === "checking"
      && Number.isFinite(fall.deadlineMs)
      && fall.deadlineMs < alarm.response_deadline_ms
    ) {
      return {
        action: "republish",
        fall: fall.delivery === "pending" ? fall : { ...fall, delivery: "pending" },
      };
    }
  }

  if (alarm.phase === "resolved") {
    if (fall?.phase === "idle") return { action: "ignore", fall };
    if (!sameEvent) return { action: "republish", fall };
  }

  const unchanged = fall
    && Object.keys(authoritative).every((key) => fall[key] === authoritative[key]);
  return { action: "adopt", fall: unchanged ? fall : authoritative };
}

export function selectFallReconnectAction(fall, nowMs = Date.now()) {
  if (
    !fall
    || typeof fall.eventId !== "string"
    || fall.eventId.length === 0
  ) return "none";
  if (fall.phase === "checking") {
    return Number.isFinite(fall.deadlineMs) && fall.deadlineMs > nowMs
      ? "republish_checking"
      : "escalate";
  }
  if (fall.phase === "escalated") return "republish_escalated";
  if (fall.phase === "resolved") return "republish_resolved";
  return "none";
}

export function selectFallResolutionAction(fall, requestedEventId = null, nowMs = Date.now()) {
  const eventId = typeof requestedEventId === "string" ? requestedEventId : fall?.eventId;
  if (
    !fall
    || !eventId
    || fall.eventId !== eventId
    || fall.phase === "idle"
    || fall.phase === "resolved"
  ) return "ignore";
  if (fall.phase === "checking") {
    return Number.isFinite(fall.deadlineMs) && fall.deadlineMs > nowMs
      ? "resolve"
      : "escalate";
  }
  if (fall.phase === "escalated") {
    return fall.delivery === "accepted" ? "resolve" : "block";
  }
  return "ignore";
}

export function selectFallExitAction(fall, { persistenceHealthy = true } = {}) {
  if (!persistenceHealthy) return "block";
  if (!fall || !fall.eventId || fall.phase === "idle") return "allow";
  if (fall.phase === "checking") return "escalate";
  if (fall.phase === "resolved" && fall.delivery === "accepted") return "allow";
  return "block";
}

export function selectControlReleaseAction(status) {
  return status === 401 || (Number.isInteger(status) && status >= 200 && status < 300)
    ? "complete"
    : "retry";
}

export function applyAlarmDeliveryAck({ fall, pending, eventSequence }) {
  if (
    !fall
    || !pending
    || pending.eventSequence !== eventSequence
    || pending.eventId !== fall.eventId
    || pending.phase !== fall.phase
  ) return null;
  return fall.delivery === "accepted"
    ? fall
    : { ...fall, delivery: "accepted" };
}

export async function recognizeDangerVoice(
  httpUrl,
  token,
  { eventId, audioB64, audioFormat = "wav", signal } = {},
  fetchImpl = fetch,
) {
  if (!isBoundedString(httpUrl, 2_048) || !isBoundedString(token, 512)) {
    throw new Error("缺少语音识别服务地址或控制授权");
  }
  if (!isBoundedString(eventId, 128) || !/^[a-z0-9_-]+$/i.test(eventId)) {
    throw new Error("语音回应缺少有效事件标识");
  }
  if (!isBoundedString(audioB64, MAX_VOICE_BASE64_CHARS) || audioFormat !== "wav") {
    throw new Error("语音回应必须是有效 WAV 数据");
  }

  const response = await fetchImpl(`${httpUrl.replace(/\/+$/, "")}/api/danger/voice`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_id: eventId,
      audio_b64: audioB64,
      audio_format: audioFormat,
    }),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = typeof payload?.error === "string" ? payload.error : "voice_intent_failed";
    const error = new Error(
      typeof payload?.message === "string" && payload.message
        ? payload.message
        : `语音意图识别失败 (${response.status})`,
    );
    error.code = code;
    throw error;
  }
  if (!isVoiceIntentSuccess(payload)) {
    const error = new Error("语音意图响应不符合合同");
    error.code = "invalid_voice_intent_response";
    throw error;
  }
  return {
    intent: payload.intent,
    transcript: payload.transcript,
    model: payload.model,
    latencyMs: payload.latency_ms,
  };
}
