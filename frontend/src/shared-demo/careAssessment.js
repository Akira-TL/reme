const ASSESSMENT_SOURCES = new Set(["rule", "mimo", "mock", "record", "degraded"]);
const ASSESSMENT_UNCERTAINTIES = new Set(["low", "medium", "high", "unknown"]);
const ASSESSMENT_ACTIONS = new Set([
  "none",
  "observe",
  "ask_elder",
  "notify_family",
  "show_urgent_attention",
  "mark_resolved",
]);
const FAMILY_DELIVERIES = new Set(["none", "notification", "action_card", "alarm"]);

const STATUS_BY_STATE = Object.freeze({
  normal: "observing",
  observe: "observing",
  check_in_required: "awaiting_response",
  consent_required: "awaiting_response",
  family_notification_required: "family_notified",
  urgent_attention: "family_notified",
  resolved: "resolved",
  degraded: "degraded",
});

const ACTION_COPY = Object.freeze({
  none: "暂无需额外操作",
  observe: "继续安静观察，有可靠变化时再提醒",
  ask_elder: "已发起轻量问候，等待本人回应",
  notify_family: "请家人尽快联系确认情况",
  show_urgent_attention: "请立即联系本人或前往查看",
  mark_resolved: "本次关怀已完成，无需继续操作",
});

function boundedText(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return normalized.slice(0, 240);
}

function projectVisualContext(value) {
  if (!value || value.sent_to_mimo !== true) {
    return Object.freeze({
      sent_to_mimo: false,
      type: null,
      sample_count: null,
    });
  }
  if (!["keyframes", "clip"].includes(value.type)) return null;
  const sampleCount = Number.isSafeInteger(value.sample_count) && value.sample_count > 0
    ? value.sample_count
    : null;
  return Object.freeze({
    sent_to_mimo: true,
    type: value.type,
    sample_count: sampleCount,
  });
}

export function projectCareAssessment(decision) {
  if (!decision || typeof decision !== "object" || !decision.decision_id) return null;
  const basis = boundedText(decision.reason_summary);
  const source = ASSESSMENT_SOURCES.has(decision.source) ? decision.source : null;
  const uncertainty = ASSESSMENT_UNCERTAINTIES.has(decision.uncertainty)
    ? decision.uncertainty
    : "unknown";
  const action = ASSESSMENT_ACTIONS.has(decision.action) ? decision.action : null;
  const familyDelivery = FAMILY_DELIVERIES.has(decision.family_delivery)
    ? decision.family_delivery
    : decision.alarm
      ? "alarm"
      : decision.action_card
        ? "action_card"
        : decision.family_notification
          ? "notification"
          : "none";
  const status = STATUS_BY_STATE[decision.state] || null;
  const visualContext = projectVisualContext(decision.visual_context);
  if (!basis || !source || !action || !familyDelivery || !status || !visualContext) return null;

  const actionCard = familyDelivery === "action_card" && decision.action_card
    ? Object.freeze({
        event: boundedText(decision.action_card.event),
        system_judgment: boundedText(decision.action_card.system_judgment),
        suggested_action: boundedText(decision.action_card.suggested_action),
        time_window: boundedText(decision.action_card.time_window),
        status: decision.action_card.status,
      })
    : null;
  if (familyDelivery === "action_card" && (
    !actionCard
    || !actionCard.event
    || !actionCard.system_judgment
    || !actionCard.suggested_action
    || !actionCard.time_window
  )) return null;
  const alarm = familyDelivery === "alarm" && decision.alarm
    ? Object.freeze({
        channels: Object.freeze([...(decision.alarm.channels || [])]),
        trigger: decision.alarm.trigger,
      })
    : null;
  if (familyDelivery === "alarm" && !alarm) return null;

  const presentationKind = familyDelivery === "none" ? "judgment" : familyDelivery;
  const familyNotification = boundedText(decision.family_notification);
  const verdict = actionCard?.event
    || ((familyDelivery === "notification" || familyDelivery === "alarm")
      ? familyNotification
      : null)
    || basis;
  const presentationBasis = actionCard?.system_judgment || basis;
  return Object.freeze({
    presentation_kind: presentationKind,
    verdict,
    basis: presentationBasis,
    uncertainty,
    source,
    action,
    suggested_action: actionCard?.suggested_action || ACTION_COPY[action],
    status,
    action_card: actionCard,
    alarm,
    visual_context: visualContext,
  });
}
