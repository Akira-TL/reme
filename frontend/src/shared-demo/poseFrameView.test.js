import assert from "node:assert/strict";
import test from "node:test";

import {
  expandAnonymousPoses,
  selectPoseFrameView,
} from "./poseFrameView.js";

const KEYPOINT_NAMES = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
];

function keypoints(score = 0.9) {
  return KEYPOINT_NAMES.map((name, index) => ({
    name,
    score,
    x: (index + 1) / 20,
    y: (index + 2) / 21,
  }));
}

function singleFrame(overrides = {}) {
  return {
    schema_version: "movenet-17/v1-demo",
    person_detected: true,
    landmark_quality: "usable",
    keypoints: keypoints(),
    ...overrides,
  };
}

function batchFrame(poses) {
  return {
    schema_version: "reme-pose-batch-17/v1-demo",
    poses,
  };
}

test("legacy MoveNet frames expand to one anonymous single-mode pose", () => {
  const frame = singleFrame({ person_id: "must-not-pass-through" });
  const view = selectPoseFrameView(frame);

  assert.equal(view.mode, "single");
  assert.equal(view.modeCopy, "单人模式");
  assert.equal(view.poseCount, 1);
  assert.equal(view.quality, "usable");
  assert.deepEqual(Object.keys(view.poses[0]).sort(), ["keypoints", "landmark_quality"]);
  assert.equal("person_id" in view.poses[0], false);
});

test("batch frames expand every candidate without identity or tracking metadata", () => {
  const view = selectPoseFrameView(batchFrame([
    {
      landmark_quality: "usable",
      keypoints: keypoints(),
      person_id: "person-1",
      tracking_id: "track-1",
      color: "red",
    },
    {
      landmark_quality: "degraded",
      keypoints: keypoints(0.4),
      pose_index: 1,
    },
  ]));

  assert.equal(view.mode, "multi");
  assert.equal(view.poseCount, 2);
  assert.equal(view.quality, "degraded");
  assert.equal(view.modeCopy, "多人模式 · 本帧 2 个匿名姿态候选 · 不追踪身份");
  for (const pose of view.poses) {
    assert.deepEqual(Object.keys(pose).sort(), ["keypoints", "landmark_quality"]);
    assert.deepEqual(Object.keys(pose.keypoints[0]).sort(), ["name", "score", "x", "y"]);
    assert.equal("person_id" in pose, false);
    assert.equal("tracking_id" in pose, false);
    assert.equal("pose_index" in pose, false);
    assert.equal("color" in pose, false);
  }
});

test("the accepted batch boundary is four anonymous poses", () => {
  const pose = { landmark_quality: "usable", keypoints: keypoints() };
  const view = selectPoseFrameView(batchFrame(Array.from({ length: 4 }, () => pose)));

  assert.equal(view.poseCount, 4);
  assert.equal(view.modeCopy, "多人模式 · 本帧 4 个匿名姿态候选 · 不追踪身份");
});

test("an empty batch stays explicitly unavailable without inventing a person count", () => {
  const view = selectPoseFrameView(batchFrame([]));

  assert.equal(view.mode, "multi");
  assert.equal(view.poseCount, 0);
  assert.equal(view.quality, "unavailable");
  assert.equal(view.modeCopy, "多人模式 · 本帧 0 个匿名姿态候选 · 不追踪身份");
  assert.deepEqual(view.poses, []);
});

test("an oversized or malformed batch fails closed instead of truncating or drawing", () => {
  const pose = { landmark_quality: "usable", keypoints: keypoints() };
  assert.deepEqual(expandAnonymousPoses(batchFrame(Array.from({ length: 5 }, () => pose))), []);
  assert.deepEqual(expandAnonymousPoses(batchFrame([{ ...pose, landmark_quality: "unavailable" }])), []);
  assert.deepEqual(expandAnonymousPoses(batchFrame([{ ...pose, keypoints: keypoints().slice(1) }])), []);
  assert.deepEqual(expandAnonymousPoses(batchFrame([{
    ...pose,
    keypoints: keypoints().map((point, index) => (
      index === 0 ? { ...point, name: "right_eye" } : point
    )),
  }])), []);
  const sparsePoses = [];
  sparsePoses.length = 1;
  assert.deepEqual(expandAnonymousPoses(batchFrame(sparsePoses)), []);
  const sparseKeypoints = [];
  sparseKeypoints.length = 17;
  assert.deepEqual(expandAnonymousPoses(batchFrame([{ ...pose, keypoints: sparseKeypoints }])), []);
});

test("no frame does not claim a controller mode before synchronization", () => {
  assert.deepEqual(selectPoseFrameView(null), {
    isReset: false,
    mode: null,
    modeCopy: "等待模式同步",
    poseCount: 0,
    poses: [],
    quality: "unavailable",
  });
});

test("controller-loss fallback mode keeps identity-free copy while the frame is cleared", () => {
  assert.deepEqual(selectPoseFrameView(null, "multi"), {
    isReset: false,
    mode: "multi",
    modeCopy: "多人 · 实验模式 · 人物层已清除",
    poseCount: 0,
    poses: [],
    quality: "unavailable",
  });
});

test("projection reset keeps only the target mode and clears candidate claims", () => {
  assert.deepEqual(selectPoseFrameView({
    schema_version: "reme-pose-reset/v1-demo",
    pose_mode: "multi",
  }), {
    isReset: true,
    mode: "multi",
    modeCopy: "多人 · 实验模式切换中 · 人物层已清除",
    poseCount: 0,
    poses: [],
    quality: "unavailable",
  });
});
