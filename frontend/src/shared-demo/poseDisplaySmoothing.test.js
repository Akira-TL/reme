import assert from "node:assert/strict";
import test from "node:test";

import {
  canInterpolatePoseFrames,
  interpolatePoseFrame,
  POSE_DISPLAY_INTERPOLATION_MS,
} from "./poseDisplaySmoothing.js";

function frame(sequence, x, options = {}) {
  return {
    schema_version: "reme-pose-frame-17/v1",
    room_session_id: options.room ?? "room-1",
    runtime_session_id: options.runtime ?? "runtime-1",
    frame_sequence: sequence,
    timestamp_ms: sequence * 100,
    person_detected: options.person ?? true,
    landmark_quality: "usable",
    coordinate_space: "normalized_image_top_left",
    keypoints: Array.from({ length: 17 }, (_, index) => ({
      name: `point-${index}`,
      x,
      y: 0.2 + index * 0.01,
      score: options.score ?? 0.9,
    })),
  };
}

test("display pose interpolation smooths coordinates without changing authority identity", () => {
  const previous = frame(10, 0.2, { score: 0.8 });
  const next = frame(11, 0.6, { score: 1 });
  const halfway = interpolatePoseFrame(previous, next, 0.5);

  assert.equal(POSE_DISPLAY_INTERPOLATION_MS, 90);
  assert.equal(halfway.frame_sequence, 11);
  assert.equal(halfway.runtime_session_id, "runtime-1");
  assert.equal(halfway.person_detected, true);
  assert.equal(halfway.keypoints[0].x, 0.4);
  assert.equal(halfway.keypoints[0].score, 0.9);
  assert.deepEqual(interpolatePoseFrame(previous, next, 1), next);
});

test("display pose interpolation never blends across sessions, stale sequences, or missing people", () => {
  const previous = frame(10, 0.2);
  const differentSession = frame(11, 0.8, { runtime: "runtime-2" });
  const stale = frame(10, 0.8);
  const missing = frame(11, 0.8, { person: false });

  assert.equal(canInterpolatePoseFrames(previous, differentSession), false);
  assert.equal(canInterpolatePoseFrames(previous, stale), false);
  assert.equal(canInterpolatePoseFrames(previous, missing), false);
  assert.equal(interpolatePoseFrame(previous, differentSession, 0.5), differentSession);
  assert.equal(interpolatePoseFrame(previous, missing, 0.5), missing);
});
