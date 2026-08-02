import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFeedState,
  keypointsToSkeleton,
  reduceAEvent,
  reduceBEvent,
} from "./viewerFeed.js";

const SCHEMA = "reme-runtime-event/v0-experiment";
const SESSION = "live-camera-viewer-test";

function envelope(overrides = {}) {
  return {
    schema_version: SCHEMA,
    session_id: SESSION,
    sequence: 1,
    event_type: "posture_observation",
    payload: { posture: "standing" },
    ...overrides,
  };
}

test("reduceAEvent 只放行本会话的三类感知事件", () => {
  const feed = createFeedState();
  assert.equal(reduceAEvent(feed, envelope({ session_id: "other" }), SESSION), null);
  assert.equal(reduceAEvent(feed, envelope({ schema_version: "bad" }), SESSION), null);
  assert.equal(
    reduceAEvent(feed, envelope({ event_type: "care_decision", sequence: 2 }), SESSION),
    null,
  );
  const result = reduceAEvent(feed, envelope({ sequence: 3 }), SESSION);
  assert.equal(result.kind, "posture_observation");
  assert.equal(result.payload.posture, "standing");
});

test("reduceAEvent 按 sequence 水位丢弃迟到与同类型重复事件", () => {
  const feed = createFeedState();
  assert.ok(reduceAEvent(feed, envelope({ sequence: 5 }), SESSION));
  assert.equal(reduceAEvent(feed, envelope({ sequence: 5 }), SESSION), null, "同 seq 同类型拒收");
  assert.equal(reduceAEvent(feed, envelope({ sequence: 4 }), SESSION), null, "低 seq 拒收");
  assert.ok(reduceAEvent(feed, envelope({ sequence: 6 }), SESSION));
});

test("reduceAEvent 放行复用同帧 sequence 的派生事件（A 的实际发布形态）", () => {
  const feed = createFeedState();
  const frame = envelope({ event_type: "frame_landmarks", sequence: 8, payload: { keypoints: [] } });
  assert.equal(reduceAEvent(feed, frame, SESSION).kind, "frame_landmarks");
  const posture = reduceAEvent(feed, envelope({ sequence: 8 }), SESSION);
  assert.equal(posture?.kind, "posture_observation", "同 seq 姿态必须放行");
  const transition = reduceAEvent(
    feed,
    envelope({ event_type: "transition_event", sequence: 8, payload: { transition: "x" } }),
    SESSION,
  );
  assert.equal(transition?.kind, "transition_event", "同 seq 转变必须放行");
  assert.equal(reduceAEvent(feed, frame, SESSION), null, "同 seq 帧重复仍拒收");
  assert.ok(reduceAEvent(feed, envelope({ sequence: 9 }), SESSION), "水位推进后正常");
  assert.equal(reduceAEvent(feed, envelope({ sequence: 8 }), SESSION), null, "推进后旧 seq 拒收");
});

test("reduceAEvent 被过滤的事件不推进水位", () => {
  const feed = createFeedState();
  assert.equal(
    reduceAEvent(feed, envelope({ event_type: "care_decision", sequence: 9 }), SESSION),
    null,
  );
  assert.ok(reduceAEvent(feed, envelope({ sequence: 7 }), SESSION), "水位不应被 9 污染");
});

test("keypointsToSkeleton 转换 17 点并拒绝残缺载荷", () => {
  const keypoints = Array.from({ length: 17 }, (_, index) => ({
    name: `kp-${index}`,
    x_norm: 0.5,
    y_norm: 0.4,
    score: 0.9,
  }));
  const points = keypointsToSkeleton({ person_detected: true, keypoints });
  assert.equal(points.length, 17);
  assert.deepEqual(points[0], { x: 0.5, y: 0.4, score: 0.9 });
  assert.equal(keypointsToSkeleton({ person_detected: false, keypoints }), null);
  assert.equal(keypointsToSkeleton({ keypoints: keypoints.slice(0, 5) }), null);
  const broken = [...keypoints];
  broken[3] = { x_norm: "nan?", y_norm: 0.2, score: 0.5 };
  assert.equal(keypointsToSkeleton({ keypoints: broken }), null);
});

test("reduceBEvent 按 decision_id 去重并过滤他会话", () => {
  const seen = new Set();
  const frame = envelope({
    event_type: "care_decision",
    payload: { decision_id: "decision-0001", state: "check_in_required" },
  });
  const first = reduceBEvent(seen, frame, SESSION);
  assert.equal(first.state, "check_in_required");
  assert.equal(reduceBEvent(seen, frame, SESSION), null, "同 id 重播必须去重");
  assert.equal(reduceBEvent(seen, { ...frame, session_id: "other" }, SESSION), null);
  assert.equal(reduceBEvent(seen, envelope(), SESSION), null, "非 care_decision 不放行");
});
