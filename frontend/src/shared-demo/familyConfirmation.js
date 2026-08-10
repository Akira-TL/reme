import { isFamilyAlarm, isPendingFamilyActionCard } from "./familyAuthority.js";

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
  if (isFamilyAlarm(decision)) return "acknowledge_alarm";
  if (isPendingFamilyActionCard(decision)) return "confirm_action_card";
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
