export function deriveFamilyTruth(snapshot, relay) {
  const authoritative = Boolean(
    snapshot
      && !relay?.unavailableReason
      && relay?.monitorOnline,
  );
  const sceneId = authoritative ? snapshot.state?.scene_id || null : null;
  return Object.freeze({
    authoritative,
    sceneId,
    quietStateReady: Boolean(
      authoritative
        && sceneId
        && snapshot.state?.runtime?.status === "ready"
        && snapshot.state?.capture?.status === "active",
    ),
  });
}
