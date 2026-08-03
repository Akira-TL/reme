import {
  FRAME_SCHEMA_VERSION,
  KEYPOINT_NAMES,
  MAX_POSES_PER_BATCH,
  POSE_BATCH_SCHEMA_VERSION,
  POSE_PROJECTION_RESET_SCHEMA_VERSION,
} from "./protocol.js";

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  return Object.keys(value).length === value.length
    && Object.keys(value).every((key, index) => key === String(index));
}

function isDrawableKeypoint(point, index) {
  return point
    && point.name === KEYPOINT_NAMES[index]
    && Number.isFinite(point.x)
    && Number.isFinite(point.y)
    && Number.isFinite(point.score);
}

function copyKeypoint(point) {
  return {
    name: point?.name,
    x: point?.x,
    y: point?.y,
    score: point?.score,
  };
}

function copyAnonymousPose(pose) {
  if (
    !pose
    || !["usable", "degraded"].includes(pose.landmark_quality)
    || !isDenseArray(pose.keypoints)
    || pose.keypoints.length !== KEYPOINT_NAMES.length
    || !pose.keypoints.every(isDrawableKeypoint)
  ) {
    return null;
  }
  return {
    landmark_quality: pose.landmark_quality,
    keypoints: pose.keypoints.map(copyKeypoint),
  };
}

/**
 * Expands either accepted wire-frame schema into anonymous, per-frame poses.
 * Identity-like metadata is deliberately not copied into the view model.
 */
export function expandAnonymousPoses(frame) {
  if (!frame || typeof frame !== "object") return [];

  if (frame.schema_version === POSE_BATCH_SCHEMA_VERSION) {
    if (
      !isDenseArray(frame.poses)
      || frame.poses.length > MAX_POSES_PER_BATCH
    ) {
      return [];
    }
    const poses = frame.poses.map(copyAnonymousPose);
    return poses.every(Boolean) ? poses : [];
  }

  if (
    frame.schema_version !== FRAME_SCHEMA_VERSION
    || frame.person_detected !== true
    || frame.landmark_quality === "unavailable"
  ) {
    return [];
  }
  const pose = copyAnonymousPose(frame);
  return pose ? [pose] : [];
}

export function selectPoseFrameView(frame, fallbackMode = null) {
  const reset = frame?.schema_version === POSE_PROJECTION_RESET_SCHEMA_VERSION;
  const mode = reset
    ? frame.pose_mode
    : frame?.schema_version === POSE_BATCH_SCHEMA_VERSION
      ? "multi"
      : frame?.schema_version === FRAME_SCHEMA_VERSION
        ? "single"
        : fallbackMode;
  const poses = expandAnonymousPoses(frame);
  const poseCount = poses.length;
  const quality = poseCount === 0
    ? "unavailable"
    : poses.some((pose) => pose.landmark_quality === "degraded")
      ? "degraded"
      : "usable";

  return {
    isReset: reset,
    mode,
    modeCopy: reset
      ? `${mode === "multi" ? "多人 · 实验" : "单人"}模式切换中 · 人物层已清除`
      : !frame && mode
        ? `${mode === "multi" ? "多人 · 实验" : "单人"}模式 · 人物层已清除`
      : mode === "multi"
        ? `多人模式 · 本帧 ${poseCount} 个匿名姿态候选 · 不追踪身份`
        : mode === "single" ? "单人模式" : "等待模式同步",
    poseCount,
    poses,
    quality,
  };
}
