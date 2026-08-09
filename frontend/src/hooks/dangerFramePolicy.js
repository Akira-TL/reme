export function shouldSubmitDangerFrame(decision, {
  promptPlaybackCompleted,
  alreadySubmitted = false,
} = {}) {
  return Boolean(
    promptPlaybackCompleted
      && !alreadySubmitted
      && decision?.decision_id
      && Array.isArray(decision.confirm_channels)
      && decision.confirm_channels.includes("frame"),
  );
}
