import { FRAME_SCHEMA_VERSION, POSE_BATCH_SCHEMA_VERSION } from "./protocol.js";

export const POSE_MODE_SINGLE = "single";
export const POSE_MODE_MULTI = "multi";
export const POSE_MODES = Object.freeze([POSE_MODE_SINGLE, POSE_MODE_MULTI]);
export const SOURCE_FRAME_STALE_AFTER_MS = 3_000;

export class PoseEstimatorPoolClosedError extends Error {
  constructor() {
    super("pose estimator pool is closed");
    this.name = "PoseEstimatorPoolClosedError";
  }
}

export class PoseInferenceTimeoutError extends Error {
  constructor() {
    super("pose inference exceeded the source freshness deadline");
    this.name = "PoseInferenceTimeoutError";
  }
}

export function isPoseMode(value) {
  return POSE_MODES.includes(value);
}

export function isFallAuthorityPoseFrame(mode, frame) {
  return mode === POSE_MODE_SINGLE
    && frame?.schema_version === FRAME_SCHEMA_VERSION;
}

export function shouldArmManualFallDetection(sceneId, mode) {
  return sceneId === "fall" && mode === POSE_MODE_SINGLE;
}

export function canArmManualFallDetection({
  sceneId,
  mode,
  captureActive,
  estimatorReady,
  inferenceUnavailable = false,
}) {
  return shouldArmManualFallDetection(sceneId, mode)
    && (!captureActive || (estimatorReady && !inferenceUnavailable));
}

export function canPublishPoseFrame(mode, poseProjectionCapability) {
  return mode === POSE_MODE_SINGLE
    || (mode === POSE_MODE_MULTI && poseProjectionCapability === "supported");
}

export function canPublishPoseProjectionReset(poseProjectionCapability) {
  return poseProjectionCapability === "supported";
}

export function isFallArmOperationContextCurrent(expected, current) {
  return expected?.operationGeneration === current?.operationGeneration
    && expected?.captureGeneration === current?.captureGeneration
    && expected?.inferenceGeneration === current?.inferenceGeneration
    && expected?.estimatorPool === current?.estimatorPool
    && expected?.stream === current?.stream
    && expected?.controllerConnection === current?.controllerConnection
    && current?.captureActive === true
    && current?.visibilityState === "visible"
    && current?.poseMode === POSE_MODE_SINGLE
    && current?.sceneId === "fall";
}

export function posePublishingLabel({
  captureLive,
  mode,
  frame,
  modelState,
  poseProjectionCapability,
  publishedFrame,
}) {
  if (!captureLive) return "LOCAL / PAUSED";
  if (modelState === "unavailable") return "POSE UNAVAILABLE";
  const hasCurrentFrame = mode === POSE_MODE_MULTI
    ? frame?.schema_version === POSE_BATCH_SCHEMA_VERSION
    : frame?.schema_version === FRAME_SCHEMA_VERSION;
  const currentFramePublished = hasCurrentFrame
    && publishedFrame?.schemaVersion === frame.schema_version
    && publishedFrame?.sessionId === frame.session_id
    && publishedFrame?.sequence === frame.sequence;
  if (
    !canPublishPoseFrame(mode, poseProjectionCapability)
    || !currentFramePublished
  ) return "LOCAL / WAITING";
  return mode === POSE_MODE_MULTI ? "MULTI PUBLISHING" : "SINGLE PUBLISHING";
}

export function poseCandidateLabel({ mode, frame, modelState }) {
  if (modelState === "unavailable") return "人物层不可用";
  if (mode === POSE_MODE_MULTI) {
    return frame?.schema_version === POSE_BATCH_SCHEMA_VERSION
      ? `本帧 ${frame.poses.length} 个匿名姿态`
      : "等待多人首帧";
  }
  return frame?.schema_version === FRAME_SCHEMA_VERSION && frame.person_detected
    ? "单人姿态可见"
    : "等待单人姿态";
}

export function readSourceFrameMarker(video) {
  if (!video || typeof video !== "object") return null;
  try {
    const totalFrames = video.getVideoPlaybackQuality?.().totalVideoFrames;
    if (Number.isFinite(totalFrames) && totalFrames > 0) {
      return { kind: "decoded_frames", value: totalFrames };
    }
  } catch {
    // Fall through to the other browser counters.
  }
  if (Number.isFinite(video.webkitDecodedFrameCount) && video.webkitDecodedFrameCount > 0) {
    return { kind: "webkit_decoded_frames", value: video.webkitDecodedFrameCount };
  }
  return null;
}

export function sourceFrameAdvanced(previous, next) {
  if (!next) return false;
  if (!previous) return true;
  // Pin the first reliable browser counter for this freshness generation.
  // Alternating APIs cannot prove that two values share one monotonic domain.
  if (previous.kind !== next.kind) return false;
  return next.value > previous.value;
}

export function isSourceInferenceResultFresh({
  startedMarker,
  currentMarker,
  elapsedMs,
  staleAfterMs = SOURCE_FRAME_STALE_AFTER_MS,
}) {
  return Number.isFinite(elapsedMs)
    && elapsedMs >= 0
    && elapsedMs < staleAfterMs
    && startedMarker !== null
    && currentMarker !== null
    && startedMarker.kind === currentMarker.kind
    && currentMarker.value >= startedMarker.value;
}

export function createSourceFrameFreshnessTracker(
  staleAfterMs = SOURCE_FRAME_STALE_AFTER_MS,
) {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs <= 0) {
    throw new TypeError("source frame stale threshold must be positive");
  }
  let lastMarker = null;
  let waitingSinceMs = null;

  return Object.freeze({
    rebase(marker, nowMs) {
      if (!Number.isFinite(nowMs) || nowMs < 0) {
        throw new TypeError("source frame observation time must be non-negative");
      }
      lastMarker = marker;
      waitingSinceMs = nowMs;
    },
    observe(marker, nowMs) {
      if (!Number.isFinite(nowMs) || nowMs < 0) {
        throw new TypeError("source frame observation time must be non-negative");
      }
      if (waitingSinceMs === null) waitingSinceMs = nowMs;
      if (sourceFrameAdvanced(lastMarker, marker)) {
        lastMarker = marker;
        waitingSinceMs = nowMs;
        return { advanced: true, reliable: true, stale: false };
      }
      return {
        advanced: false,
        reliable: marker !== null,
        stale: nowMs - waitingSinceMs >= staleAfterMs,
      };
    },
  });
}

export function isPoseInferenceContextCurrent(expected, current) {
  return expected?.captureGeneration === current?.captureGeneration
    && expected?.inferenceGeneration === current?.inferenceGeneration
    && expected?.poseMode === current?.poseMode
    && expected?.estimatorPool === current?.estimatorPool
    && expected?.stream === current?.stream;
}

export async function releaseOwnedPoseCapture({
  stream,
  estimatorPool,
  video,
  streamRef,
  estimatorPoolRef,
}) {
  if (video?.srcObject === stream) video.srcObject = null;
  if (streamRef?.current === stream) streamRef.current = null;
  stream?.getTracks?.().forEach((track) => track.stop());
  if (estimatorPoolRef?.current === estimatorPool) estimatorPoolRef.current = null;
  await estimatorPool?.dispose?.();
}

export function runPoseInferenceWithDeadline(
  infer,
  timeoutMs = SOURCE_FRAME_STALE_AFTER_MS,
) {
  if (typeof infer !== "function") {
    return Promise.reject(new TypeError("pose inference must be a function"));
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new TypeError("pose inference deadline must be positive"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      callback(value);
    };
    const timer = globalThis.setTimeout(
      () => finish(reject, new PoseInferenceTimeoutError()),
      timeoutMs,
    );
    Promise.resolve()
      .then(infer)
      .then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
  });
}

export function describePoseFrame(mode, frame) {
  if (mode === POSE_MODE_MULTI) {
    const count = frame?.schema_version === POSE_BATCH_SCHEMA_VERSION
      && Array.isArray(frame.poses)
      ? frame.poses.length
      : 0;
    const degraded = count > 0
      && frame.poses.some((pose) => pose.landmark_quality === "degraded");
    return {
      count,
      quality: count === 0
        ? "未检测到匿名姿态"
        : `${count} 个匿名姿态${degraded ? " · 降级" : " · 可用"}`,
    };
  }

  return {
    count: frame?.schema_version === FRAME_SCHEMA_VERSION && frame.person_detected ? 1 : 0,
    quality: frame?.landmark_quality ?? "准备首帧",
  };
}

async function disposeEstimator(estimator) {
  if (!estimator || typeof estimator.dispose !== "function") return;
  await estimator.dispose();
}

/**
 * Owns the two browser estimators for one camera capture generation. Loading is
 * lazy, deduplicated per mode, and a late load after close is disposed instead
 * of becoming reachable by a restarted capture.
 */
export function createPoseEstimatorPool(loaders) {
  if (!loaders || POSE_MODES.some((mode) => typeof loaders[mode] !== "function")) {
    throw new TypeError("pose estimator pool requires single and multi loaders");
  }

  const estimators = new Map();
  const pending = new Map();
  let closed = false;
  let disposal = null;

  const load = (mode) => {
    if (!isPoseMode(mode)) return Promise.reject(new TypeError("unknown pose mode"));
    if (closed) return Promise.reject(new PoseEstimatorPoolClosedError());
    if (estimators.has(mode)) return Promise.resolve(estimators.get(mode));
    if (pending.has(mode)) return pending.get(mode);

    const request = Promise.resolve()
      .then(() => loaders[mode]())
      .then(async (estimator) => {
        if (!estimator || typeof estimator.infer !== "function") {
          throw new TypeError(`${mode} pose loader returned an invalid estimator`);
        }
        if (closed) {
          await disposeEstimator(estimator);
          throw new PoseEstimatorPoolClosedError();
        }
        estimators.set(mode, estimator);
        return estimator;
      })
      .finally(() => {
        pending.delete(mode);
      });
    pending.set(mode, request);
    return request;
  };

  return Object.freeze({
    load,
    peek(mode) {
      return estimators.get(mode) ?? null;
    },
    isClosed() {
      return closed;
    },
    invalidate(mode) {
      if (!isPoseMode(mode)) return false;
      const estimator = estimators.get(mode);
      if (!estimator) return false;
      estimators.delete(mode);
      void disposeEstimator(estimator).catch(() => undefined);
      return true;
    },
    dispose() {
      if (disposal) return disposal;
      closed = true;
      disposal = Promise.resolve().then(() => {
        const active = [...estimators.values()];
        estimators.clear();
        // A loader that never settles must not hold control release or page
        // teardown hostage. A late successful load still observes `closed`
        // above and disposes the newly-created estimator immediately.
        pending.clear();
        for (const estimator of active) {
          void disposeEstimator(estimator).catch(() => undefined);
        }
      });
      return disposal;
    },
  });
}
