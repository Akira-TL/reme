export function familyCarePresentationKind(care) {
  if (care?.alarm) return "alarm";
  if (care?.action_card) return "action_card";
  if (care?.family_notification) return "notification";
  return "none";
}

export function isFamilyAlarm(care) {
  return familyCarePresentationKind(care) === "alarm";
}

export function isPendingFamilyActionCard(care) {
  return familyCarePresentationKind(care) === "action_card"
    && care.action_card.status === "pending";
}

export function familyCareMessage(care) {
  if (!care) return null;
  return care.family_notification
    || care.action_card?.system_judgment
    || care.action_card?.event
    || null;
}

export function familyMediaAuthorization(familyEvent) {
  return familyEvent?.care?.media_authorization || null;
}
