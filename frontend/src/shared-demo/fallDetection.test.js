import assert from "node:assert/strict";
import test from "node:test";
import { KEYPOINT_NAMES } from "./protocol.js";
import { createFallTransitionDetector, measureFallGeometry } from "./fallDetection.js";

function point(name, x, y, score = 0.95) {
  return { name, x, y, score };
}

function frame(timestampMs, posture = "upright") {
  const points = KEYPOINT_NAMES.map((name) => point(name, 0.5, 0.5));
  const set = (index, x, y) => {
    points[index] = point(KEYPOINT_NAMES[index], x, y);
  };
  if (posture === "upright") {
    set(5, 0.45, 0.26);
    set(6, 0.55, 0.26);
    set(11, 0.46, 0.51);
    set(12, 0.54, 0.51);
    set(13, 0.46, 0.68);
    set(14, 0.54, 0.68);
    set(15, 0.45, 0.9);
    set(16, 0.55, 0.9);
  } else if (posture === "lying") {
    set(5, 0.2, 0.72);
    set(6, 0.25, 0.78);
    set(11, 0.48, 0.75);
    set(12, 0.53, 0.8);
    set(13, 0.68, 0.77);
    set(14, 0.72, 0.82);
    set(15, 0.86, 0.78);
    set(16, 0.9, 0.84);
  } else if (posture === "bending") {
    set(5, 0.38, 0.38);
    set(6, 0.48, 0.39);
    set(11, 0.5, 0.57);
    set(12, 0.58, 0.58);
    set(13, 0.48, 0.71);
    set(14, 0.58, 0.72);
    set(15, 0.46, 0.9);
    set(16, 0.6, 0.9);
  }
  return {
    schema_version: "movenet-17/v1-demo",
    session_id: "session-a",
    sequence: timestampMs,
    timestamp_ms: timestampMs,
    source_width: 1280,
    source_height: 720,
    person_detected: true,
    landmark_quality: "usable",
    keypoints: points,
  };
}

test("fall geometry separates an upright body from a horizontal body", () => {
  const upright = measureFallGeometry(frame(0, "upright"));
  const lying = measureFallGeometry(frame(1, "lying"));
  assert.ok(upright.torsoAngleDeg > 70);
  assert.ok(upright.bodyAspect > 2);
  assert.ok(lying.torsoAngleDeg < 25);
  assert.ok(lying.bodyAspect < 0.5);
});

test("a recent upright-to-horizontal downward transition emits one real candidate", () => {
  const detector = createFallTransitionDetector();
  assert.equal(detector.push(frame(1_000, "upright")).event, null);
  const candidate = detector.push(frame(1_900, "lying"));
  assert.equal(candidate.phase, "candidate");
  assert.equal(candidate.event.transition, "fall_like_transition");
  assert.ok(candidate.event.hip_drop >= 0.11);
  assert.ok(candidate.event.evidence_score >= 0 && candidate.event.evidence_score <= 1);
  assert.equal(detector.push(frame(2_000, "lying")).event, null);
});

test("lying without a recent upright anchor and ordinary bending do not trigger", () => {
  const noAnchor = createFallTransitionDetector();
  assert.equal(noAnchor.push(frame(1_000, "lying")).event, null);

  const bend = createFallTransitionDetector();
  bend.push(frame(1_000, "upright"));
  assert.equal(bend.push(frame(1_700, "bending")).event, null);

  const stale = createFallTransitionDetector();
  stale.push(frame(1_000, "upright"));
  assert.equal(stale.push(frame(5_000, "lying")).event, null);
});

test("duplicate and out-of-order timestamps are ignored", () => {
  const detector = createFallTransitionDetector();
  detector.push(frame(1_000, "upright"));
  assert.equal(detector.push(frame(1_000, "lying")).phase, "ignored");
  assert.equal(detector.push(frame(900, "lying")).phase, "ignored");
});
