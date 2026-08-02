import assert from "node:assert/strict";
import test from "node:test";
import {
  createEventParser,
  createFrameMeta,
  createSceneSignal,
  createSessionRequest,
  mapFrameLandmarks,
} from "./perception.js";

const SESSION_ID = "live-camera-contract-test";
const KEYPOINT_NAMES = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
];

function keypoints(overrides = {}) {
  return KEYPOINT_NAMES.map((name, index) => ({
    name,
    x_norm: 0.2 + index * 0.02,
    y_norm: 0.3 + index * 0.02,
    score: 0.9,
    ...overrides,
  }));
}

function event(sequence, eventType = "frame_landmarks", payload = {}) {
  return {
    schema_version: "reme-runtime-event/v0-experiment",
    session_id: SESSION_ID,
    sequence,
    event_type: eventType,
    payload,
  };
}

test("构造 A live_camera 会话合同", () => {
  assert.deepEqual(createSessionRequest(SESSION_ID, "normal"), {
    schema_version: "reme-runtime-session-request/v0-experiment",
    session_id: SESSION_ID,
    profile: "live_camera",
    scene_id: "normal",
    input_source: "camera",
    perception_mode: "live",
    decision_mode: "live",
    camera_id: "c-primary-camera",
    manifest_path: null,
  });
});

test("构造场景信号与二进制帧元数据", () => {
  assert.equal(createSceneSignal(SESSION_ID, "privacy", "switch", 120).signal, "switch");
  assert.equal(createFrameMeta(SESSION_ID, "privacy", 12, 400).frame_index, 12);
  assert.throws(() => createSceneSignal(SESSION_ID, "privacy", "invalid", 0), /无效场景信号/);
});

test("事件解析器拒绝旧会话、倒序与重复事件", () => {
  const parse = createEventParser(SESSION_ID);
  assert.ok(parse(event(3)));
  assert.ok(parse(event(3, "posture_observation")));
  assert.equal(parse(event(3)), null);
  assert.equal(parse(event(2)), null);
  assert.equal(parse({ ...event(4), session_id: "stale-session" }), null);
  assert.equal(parse(event(4, "unknown_event")), null);
});

test("MoveNet 17 节点按名称映射并拒绝非法坐标", () => {
  const payload = {
    schema_version: "movenet-17/v0-experiment",
    person_detected: true,
    keypoints: keypoints().reverse(),
  };
  const mapped = mapFrameLandmarks(payload);
  assert.equal(mapped.length, 17);
  assert.equal(mapped[0].x, 0.2);
  assert.deepEqual(mapFrameLandmarks({ ...payload, person_detected: false }), []);
  assert.equal(mapFrameLandmarks({ ...payload, keypoints: keypoints({ x_norm: 2 }) }), null);
  assert.equal(mapFrameLandmarks({ ...payload, keypoints: keypoints().slice(0, 16) }), null);
});
