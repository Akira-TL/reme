import assert from "node:assert/strict";
import test from "node:test";
import {
  MOVENET_KEYPOINT_NAMES,
  createCropPixelPlan,
  decodeMoveNetOutput,
  deriveLandmarkQuality,
  determineNextCropRegion,
  initialCropRegion,
  roundHalfToEven,
  torsoDetected,
  validateMoveNetModelIO,
} from "./movenet.js";

function makeKeypoints({ score = 0.9 } = {}) {
  return MOVENET_KEYPOINT_NAMES.map((name) => ({
    name,
    x_norm: 0.5,
    y_norm: 0.5,
    score,
  }));
}

function setPoint(keypoints, name, x, y, score = 0.9) {
  const index = MOVENET_KEYPOINT_NAMES.indexOf(name);
  keypoints[index] = { name, x_norm: x, y_norm: y, score };
}

test("initial crop mirrors Python landscape and portrait padding", () => {
  assert.deepEqual(initialCropRegion(720, 1280), {
    y_min: -0.3888888888888889,
    x_min: 0,
    y_max: 1.3888888888888888,
    x_max: 1,
  });
  assert.deepEqual(initialCropRegion(1280, 720), {
    y_min: 0,
    x_min: -0.3888888888888889,
    y_max: 1,
    x_max: 1.3888888888888888,
  });
  assert.throws(() => initialCropRegion(0, 720), /positive integer/);
});

test("crop pixel plan preserves black padding and Python tie rounding", () => {
  const plan = createCropPixelPlan(initialCropRegion(720, 1280), 720, 1280);
  assert.deepEqual(plan, {
    y_min_px: -280,
    x_min_px: 0,
    y_max_px: 1000,
    x_max_px: 1280,
    crop_height: 1280,
    crop_width: 1280,
    src_y: 0,
    src_x: 0,
    src_height: 720,
    src_width: 1280,
    dst_y: 280,
    dst_x: 0,
  });
  assert.equal(roundHalfToEven(2.5), 2);
  assert.equal(roundHalfToEven(3.5), 4);
  assert.equal(roundHalfToEven(-2.5), -2);
});

test("tracking crop uses torso and visible body ranges", () => {
  const points = makeKeypoints();
  setPoint(points, "left_shoulder", 0.45, 0.4);
  setPoint(points, "right_shoulder", 0.55, 0.4);
  setPoint(points, "left_hip", 0.45, 0.6);
  setPoint(points, "right_hip", 0.55, 0.6);
  setPoint(points, "left_ankle", 0.4, 0.9);
  setPoint(points, "right_ankle", 0.6, 0.9);

  assert.deepEqual(determineNextCropRegion(points, 1000, 1000, 0.2), {
    y_min: 0.22,
    x_min: 0.12,
    y_max: 0.98,
    x_max: 0.88,
  });

  for (const name of ["left_shoulder", "right_shoulder", "left_hip", "right_hip"]) {
    const point = points[MOVENET_KEYPOINT_NAMES.indexOf(name)];
    setPoint(points, name, point.x_norm, point.y_norm, 0.1);
  }
  assert.deepEqual(determineNextCropRegion(points, 1000, 1000, 0.2), {
    y_min: 0,
    x_min: 0,
    y_max: 1,
    x_max: 1,
  });
});

test("decode maps y/x/score from crop coordinates into full-frame coordinates", () => {
  const raw = new Float32Array(MOVENET_KEYPOINT_NAMES.length * 3);
  for (let index = 0; index < MOVENET_KEYPOINT_NAMES.length; index += 1) {
    raw[index * 3] = 0.25;
    raw[index * 3 + 1] = 0.75;
    raw[index * 3 + 2] = 0.9;
  }
  raw[0] = 0;
  raw[1] = 1;

  const decoded = decodeMoveNetOutput(raw, {
    y_min: -0.5,
    x_min: 0.25,
    y_max: 1.5,
    x_max: 0.75,
  });
  assert.deepEqual(decoded[0], {
    name: "nose",
    x_norm: 0.75,
    y_norm: 0,
    score: raw[2],
  });
  assert.equal(decoded[1].x_norm, 0.625);
  assert.equal(decoded[1].y_norm, 0);
  assert.throws(
    () => decodeMoveNetOutput(new Float32Array(50), initialCropRegion(100, 100)),
    /expected 51/,
  );
});

test("torso visibility and landmark quality match the Python adapter", () => {
  const points = makeKeypoints();
  assert.equal(torsoDetected(points, 0.2), true);
  assert.equal(deriveLandmarkQuality(points, true, 0.2), "usable");

  setPoint(points, "left_ankle", 0.5, 0.9, 0.1);
  assert.equal(deriveLandmarkQuality(points, true, 0.2), "degraded");

  setPoint(points, "left_hip", 0.5, 0.6, 0.1);
  setPoint(points, "right_hip", 0.5, 0.6, 0.1);
  assert.equal(torsoDetected(points, 0.2), false);
  assert.equal(deriveLandmarkQuality(points, false, 0.2), "unavailable");
});

test("model validation accepts only measured uint8-to-float32 tensor shapes", () => {
  const details = validateMoveNetModelIO(
    [{ name: "serving_default_input:0", dtype: "uint8", shape: new Int32Array([1, 192, 192, 3]) }],
    [{ name: "StatefulPartitionedCall:0", dtype: "float32", shape: new Int32Array([1, 1, 17, 3]) }],
  );
  assert.deepEqual(details.input.shape, [1, 192, 192, 3]);
  assert.deepEqual(details.output.shape, [1, 1, 17, 3]);

  assert.throws(
    () => validateMoveNetModelIO(
      [{ dtype: "float32", shape: [1, 192, 192, 3] }],
      [{ dtype: "float32", shape: [1, 1, 17, 3] }],
    ),
    /unexpected MoveNet input tensor/,
  );
  assert.throws(
    () => validateMoveNetModelIO(
      [{ dtype: "uint8", shape: [1, 192, 192, 3] }],
      [{ dtype: "float32", shape: [1, 17, 3] }],
    ),
    /unexpected MoveNet output tensor/,
  );
  assert.throws(
    () => validateMoveNetModelIO([], []),
    /exactly one input/,
  );
});
