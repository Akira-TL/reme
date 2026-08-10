export const POSE_DISPLAY_INTERPOLATION_MS = 90;

function clamp01(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 1);
}

function lerp(left, right, progress) {
  return left + (right - left) * progress;
}

export function canInterpolatePoseFrames(previous, next) {
  return Boolean(
    previous?.person_detected
      && next?.person_detected
      && previous.runtime_session_id === next.runtime_session_id
      && previous.room_session_id === next.room_session_id
      && Number.isSafeInteger(previous.frame_sequence)
      && Number.isSafeInteger(next.frame_sequence)
      && next.frame_sequence > previous.frame_sequence
      && Array.isArray(previous.keypoints)
      && previous.keypoints.length === 17
      && Array.isArray(next.keypoints)
      && next.keypoints.length === 17,
  );
}

export function interpolatePoseFrame(previous, next, progress) {
  if (!canInterpolatePoseFrames(previous, next)) return next;
  const amount = clamp01(progress);
  if (amount >= 1) return next;
  if (amount <= 0) return previous;
  return {
    ...next,
    keypoints: next.keypoints.map((point, index) => {
      const prior = previous.keypoints[index];
      if (!prior || prior.name !== point.name) return point;
      return {
        ...point,
        x: lerp(prior.x, point.x, amount),
        y: lerp(prior.y, point.y, amount),
        score: lerp(prior.score, point.score, amount),
      };
    }),
  };
}
