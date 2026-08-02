import { RUNTIME_EVENT_SCHEMA } from "../adapters/perception.js";

// 旁观页的纯归约层：会话过滤、sequence 防乱序、事件拆解。
// 不持有连接与副作用，便于 node --test 直接回归。

export function createFeedState() {
  // A 的 RuntimeEvent.sequence 在整个 session 内单调递增（abc-interface §4），
  // 但派生事件（posture_observation/transition_event）复用其源帧的 sequence
  // 且帧先发布——水位必须按事件类型放行同 seq，否则派生事件被全部拦下
  // （B 侧 ingest 与驱动页 adapter 均按此语义实现）。
  return { lastSequence: -1, typesAtSequence: new Set() };
}

export function reduceAEvent(feed, envelope, sessionId) {
  if (!envelope || envelope.schema_version !== RUNTIME_EVENT_SCHEMA) return null;
  if (envelope.session_id !== sessionId) return null;
  const sequence = envelope.sequence;
  if (!Number.isFinite(sequence) || sequence < feed.lastSequence) return null;
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") return null;
  if (!["frame_landmarks", "posture_observation", "transition_event"].includes(envelope.event_type)) {
    return null;
  }
  if (sequence === feed.lastSequence) {
    if (feed.typesAtSequence.has(envelope.event_type)) return null;
  } else {
    feed.lastSequence = sequence;
    feed.typesAtSequence.clear();
  }
  feed.typesAtSequence.add(envelope.event_type);
  return { kind: envelope.event_type, payload };
}

// A 的 frame_landmarks（MoveNet-17 顺序）→ drawSkeleton 需要的 {x,y,score}×17。
export function keypointsToSkeleton(payload) {
  if (payload?.person_detected === false) return null;
  const keypoints = payload?.keypoints;
  if (!Array.isArray(keypoints) || keypoints.length !== 17) return null;
  const points = keypoints.map((keypoint) => ({
    x: Number(keypoint?.x_norm),
    y: Number(keypoint?.y_norm),
    score: Number(keypoint?.score),
  }));
  const usable = points.every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.score),
  );
  return usable ? points : null;
}

// B 决策流：按 decision_id 去重（B 自身广播在 CAS 竞态下允许重复，
// C 端去重是文档化的消费者义务）。
export function reduceBEvent(seenDecisionIds, frame, sessionId) {
  if (!frame || frame.schema_version !== RUNTIME_EVENT_SCHEMA) return null;
  if (frame.session_id !== sessionId || frame.event_type !== "care_decision") return null;
  const payload = frame.payload;
  const decisionId = payload?.decision_id;
  if (!decisionId || seenDecisionIds.has(decisionId)) return null;
  seenDecisionIds.add(decisionId);
  return payload;
}
