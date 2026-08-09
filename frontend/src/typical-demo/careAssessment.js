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
  const status = STATUS_BY_STATE[decision.state] || null;
  const visualContext = projectVisualContext(decision.visual_context);
  if (!basis || !source || !action || !status || !visualContext) return null;

  const verdict = boundedText(decision.family_notification) || basis;
  const cardAction = boundedText(decision.action_card?.suggested_action);
  return Object.freeze({
    verdict,
    basis,
    uncertainty,
    source,
    action,
    suggested_action: cardAction || ACTION_COPY[action],
    status,
    visual_context: visualContext,
  });
}
