// @ts-check

export const POSE_DISPLAY_MAX_AGE_MS = 5_000;

/**
 * @typedef {object} PosePresentationState
 * @property {string | null} runtimeSessionId
 * @property {any | null} lastGoodPose
 */

/** @returns {PosePresentationState} */
export function createPosePresentationState() {
  return Object.freeze({ runtimeSessionId: null, lastGoodPose: null });
}

/**
 * Freshness is based on local receipt time, never the producer's wall clock.
 *
 * @param {any} pose
 * @param {number} [localNowMs]
 * @param {number} [maxAgeMs]
 */
export function isPoseFresh(
  pose,
  localNowMs = Date.now(),
  maxAgeMs = POSE_DISPLAY_MAX_AGE_MS,
) {
  if (!pose
    || !Number.isFinite(pose.receivedAtMs)
    || !Number.isFinite(localNowMs)
    || !Number.isFinite(maxAgeMs)
    || maxAgeMs < 0) return false;
  const ageMs = Math.max(0, localNowMs - pose.receivedAtMs);
  return ageMs <= maxAgeMs;
}

/**
 * Selects a presentation frame without mutating or replacing Relay truth.
 * A `person_detected:false` frame may briefly display the previous good frame,
 * but the returned state still carries that frame's original sequence and
 * receipt time. It is never presented as a new Backend result.
 *
 * @param {object} parameters
 * @param {PosePresentationState} parameters.previous
 * @param {any | null} parameters.pose
 * @param {string | null} parameters.runtimeSessionId
 * @param {number} parameters.localNowMs
 * @param {boolean} [parameters.authorityAvailable]
 * @param {number} [parameters.maxAgeMs]
 */
export function advancePosePresentation({
  previous,
  pose,
  runtimeSessionId,
  localNowMs,
  authorityAvailable = true,
  maxAgeMs = POSE_DISPLAY_MAX_AGE_MS,
}) {
  if (!authorityAvailable || !runtimeSessionId) {
    return Object.freeze({
      state: createPosePresentationState(),
      visiblePose: null,
      mode: "unavailable",
    });
  }

  const sameRuntime = previous.runtimeSessionId === runtimeSessionId;
  const lastGoodPose = sameRuntime ? previous.lastGoodPose : null;
  if (pose?.runtime_session_id !== runtimeSessionId) {
    return Object.freeze({
      state: Object.freeze({ runtimeSessionId, lastGoodPose: null }),
      visiblePose: null,
      mode: "waiting",
    });
  }

  if (pose.person_detected === true && isPoseFresh(pose, localNowMs, maxAgeMs)) {
    return Object.freeze({
      state: Object.freeze({ runtimeSessionId, lastGoodPose: pose }),
      visiblePose: pose,
      mode: pose.landmark_quality === "degraded" ? "degraded" : "live",
    });
  }

  if (
    pose.person_detected === false
    && lastGoodPose
    && isPoseFresh(lastGoodPose, localNowMs, maxAgeMs)
  ) {
    return Object.freeze({
      state: Object.freeze({ runtimeSessionId, lastGoodPose }),
      visiblePose: lastGoodPose,
      mode: "held",
    });
  }

  return Object.freeze({
    state: Object.freeze({ runtimeSessionId, lastGoodPose }),
    visiblePose: null,
    mode: "stale",
  });
}

