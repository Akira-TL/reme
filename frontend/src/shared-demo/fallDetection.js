import { KEYPOINT_SCORE_THRESHOLD } from "./protocol.js";

const INDEX = Object.freeze({
  leftShoulder: 5,
  rightShoulder: 6,
  leftHip: 11,
  rightHip: 12,
  leftKnee: 13,
  rightKnee: 14,
  leftAnkle: 15,
  rightAnkle: 16,
});

export const DEFAULT_FALL_DETECTOR_CONFIG = Object.freeze({
  anchorMaxAgeMs: 3_000,
  transitionMinMs: 180,
  transitionMaxMs: 2_600,
  hipDropThreshold: 0.11,
  uprightTorsoAngleDeg: 54,
  lyingTorsoAngleDeg: 38,
  uprightBodyAspect: 1.2,
  lyingBodyAspect: 1.02,
  cooldownMs: 8_000,
});

function averagePoint(points) {
  if (!points.length) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  };
}

function visible(frame, indices) {
  return indices
    .map((index) => frame.keypoints[index])
    .filter((point) => point && point.score >= KEYPOINT_SCORE_THRESHOLD);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

export function measureFallGeometry(frame) {
  if (!frame?.person_detected || !Array.isArray(frame.keypoints)) return null;
  const shoulders = visible(frame, [INDEX.leftShoulder, INDEX.rightShoulder]);
  const hips = visible(frame, [INDEX.leftHip, INDEX.rightHip]);
  const body = visible(frame, [
    INDEX.leftShoulder,
    INDEX.rightShoulder,
    INDEX.leftHip,
    INDEX.rightHip,
    INDEX.leftKnee,
    INDEX.rightKnee,
    INDEX.leftAnkle,
    INDEX.rightAnkle,
  ]);
  if (!shoulders.length || !hips.length || body.length < 5) return null;

  const shoulder = averagePoint(shoulders);
  const hip = averagePoint(hips);
  const torsoDx = Math.abs(hip.x - shoulder.x);
  const torsoDy = Math.abs(hip.y - shoulder.y);
  const torsoAngleDeg = Math.atan2(torsoDy, Math.max(torsoDx, 1e-6)) * (180 / Math.PI);
  const xs = body.map((point) => point.x);
  const ys = body.map((point) => point.y);
  const bodyWidth = Math.max(...xs) - Math.min(...xs);
  const bodyHeight = Math.max(...ys) - Math.min(...ys);
  const bodyAspect = bodyHeight / Math.max(bodyWidth, 0.03);
  const meanScore = body.reduce((sum, point) => sum + point.score, 0) / body.length;

  return {
    hipY: hip.y,
    torsoAngleDeg,
    bodyAspect,
    meanScore,
  };
}

function classifyGeometry(metrics, config) {
  if (!metrics) return "unavailable";
  const upright = metrics.torsoAngleDeg >= config.uprightTorsoAngleDeg
    && metrics.bodyAspect >= config.uprightBodyAspect;
  if (upright) return "upright";
  const lying = metrics.torsoAngleDeg <= config.lyingTorsoAngleDeg
    && metrics.bodyAspect <= config.lyingBodyAspect;
  return lying ? "lying" : "transitioning";
}

export function createFallTransitionDetector(overrides = {}) {
  const config = { ...DEFAULT_FALL_DETECTOR_CONFIG, ...overrides };
  let uprightAnchor = null;
  let lastTimestampMs = -1;
  let cooldownUntilMs = -1;

  return {
    push(frame) {
      const timestampMs = frame?.timestamp_ms;
      if (!Number.isFinite(timestampMs) || timestampMs <= lastTimestampMs) {
        return { phase: "ignored", metrics: null, event: null };
      }
      lastTimestampMs = timestampMs;
      const metrics = measureFallGeometry(frame);
      const posture = classifyGeometry(metrics, config);

      if (posture === "upright") {
        uprightAnchor = { timestampMs, hipY: metrics.hipY };
        return { phase: "upright", metrics, event: null };
      }
      if (
        uprightAnchor
        && timestampMs - uprightAnchor.timestampMs > config.anchorMaxAgeMs
      ) {
        uprightAnchor = null;
      }
      if (
        posture !== "lying"
        || uprightAnchor === null
        || timestampMs < cooldownUntilMs
      ) {
        return { phase: posture, metrics, event: null };
      }

      const transitionMs = timestampMs - uprightAnchor.timestampMs;
      const hipDrop = metrics.hipY - uprightAnchor.hipY;
      if (
        transitionMs < config.transitionMinMs
        || transitionMs > config.transitionMaxMs
        || hipDrop < config.hipDropThreshold
      ) {
        return { phase: "lying", metrics: { ...metrics, hipDrop, transitionMs }, event: null };
      }

      const dropEvidence = clamp01(
        (hipDrop - config.hipDropThreshold) / Math.max(config.hipDropThreshold, 0.01),
      );
      const horizontalEvidence = clamp01(
        (config.lyingTorsoAngleDeg - metrics.torsoAngleDeg) / config.lyingTorsoAngleDeg,
      );
      const evidenceScore = clamp01(
        (0.45 * dropEvidence) + (0.35 * horizontalEvidence) + (0.2 * metrics.meanScore),
      );
      const event = {
        transition: "fall_like_transition",
        timestamp_ms: timestampMs,
        transition_ms: transitionMs,
        hip_drop: hipDrop,
        torso_angle_deg: metrics.torsoAngleDeg,
        body_aspect: metrics.bodyAspect,
        evidence_score: evidenceScore,
      };
      uprightAnchor = null;
      cooldownUntilMs = timestampMs + config.cooldownMs;
      return { phase: "candidate", metrics: { ...metrics, hipDrop, transitionMs }, event };
    },
    reset() {
      uprightAnchor = null;
      lastTimestampMs = -1;
      cooldownUntilMs = -1;
    },
  };
}
