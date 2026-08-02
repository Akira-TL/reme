import assert from "node:assert/strict";
import test from "node:test";

import {
  emitRealInferenceLandmarks,
  resolvePrivacySafeViewMode,
} from "./useLiveDemoCamera.js";

test("真实推理的空 landmarks 仍上送，保留消失式跌倒证据", () => {
  const received = [];

  emitRealInferenceLandmarks((landmarks, timestamp) => {
    received.push({ landmarks, timestamp });
  }, [], 1234);

  assert.deepEqual(received, [{ landmarks: [], timestamp: 1234 }]);
});

test("没有订阅者时忽略真实推理结果", () => {
  assert.doesNotThrow(() => emitRealInferenceLandmarks(null, [], 1234));
});

test("浴室隐私模式在画布渲染层禁止所有视频模式", () => {
  assert.equal(resolvePrivacySafeViewMode("video", true), "skeleton");
  assert.equal(resolvePrivacySafeViewMode("video_skeleton", true), "skeleton");
  assert.equal(resolvePrivacySafeViewMode("video_skeleton", false), "video_skeleton");
});
