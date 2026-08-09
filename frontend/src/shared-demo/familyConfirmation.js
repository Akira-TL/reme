export function resolveFamilyConfirmationError({
  failure,
  decisionId,
  ackError = "",
}) {
  const localError = failure?.decisionId === decisionId
    ? failure?.message || ""
    : "";
  return localError || ackError;
}

const TERMINAL_PHASES = new Set(["applied", "rejected", "failed"]);

export function selectFamilyAcknowledgementCommand(decision) {
  if (decision?.alarm) return "confirm_alarm";
  if (decision?.action_card?.status === "pending") return "confirm_action_card";
  if (
    !decision?.action_card
    && decision?.family_notification
    && ["family_notification_required", "urgent_attention"].includes(decision.state)
  ) return "confirm_family_notification";
  return null;
}

export function isFamilyConfirmationTimedOut({
  sent,
  ack,
  nowMs,
  timeoutMs = 10_000,
}) {
  if (!sent || TERMINAL_PHASES.has(ack?.phase)) return false;
  if (!Number.isFinite(sent.sentAtMs) || !Number.isFinite(nowMs)) return false;
  return nowMs - sent.sentAtMs >= timeoutMs;
}
