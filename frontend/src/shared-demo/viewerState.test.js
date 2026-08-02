import assert from "node:assert/strict";
import test from "node:test";

import {
  createViewerState,
  reduceViewerState,
  selectActiveMediaGrant,
  selectViewerScene,
} from "./state.js";
import { parseViewerReady } from "./useViewerRelay.js";

function event(eventSequence, eventType, payload, sessionId = "session-a") {
  return {
    schema_version: "reme-demo-event/v1",
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: 1_000 + eventSequence,
    event_type: eventType,
    payload,
  };
}

function applyEvent(state, value) {
  return reduceViewerState(state, {
    type: "demo_event",
    event: value,
    receivedAtMs: value.timestamp_ms,
  });
}

test("viewer_ready is exact and does not need to enter the rejected-frame path", () => {
  assert.deepEqual(
    parseViewerReady('{"type":"viewer_ready","viewer_id":"viewer-1"}'),
    { type: "viewer_ready", viewer_id: "viewer-1" },
  );
  assert.equal(parseViewerReady('{"type":"viewer_ready","viewer_id":"bad id"}'), null);
  assert.equal(
    parseViewerReady('{"type":"viewer_ready","viewer_id":"viewer-1","extra":true}'),
    null,
  );

  const ready = reduceViewerState(createViewerState(), {
    type: "viewer_ready",
    viewerId: "viewer-1",
  });
  assert.equal(ready.viewerId, "viewer-1");
  assert.equal(ready.rejectedFrames, 0);
});

test("demo events are monotonic and a new session clears stale scene state", () => {
  let state = createViewerState();
  state = applyEvent(state, event(2, "scene_state", {
    scene_id: "kitchen",
    visual_mode: "abstract_environment",
  }));
  const duplicate = applyEvent(state, event(2, "scene_state", {
    scene_id: "fall",
    visual_mode: "abstract_environment",
  }));
  assert.equal(duplicate, state);
  assert.equal(selectViewerScene(state).scene_id, "kitchen");

  state = applyEvent(state, event(0, "scene_state", {
    scene_id: "bathroom",
    visual_mode: "skeleton_only",
  }, "session-b"));
  assert.equal(state.sessionId, "session-b");
  assert.equal(state.activity, null);
  assert.equal(selectViewerScene(state).scene_id, "bathroom");
});

test("fall media stays closed during checking and opens only for matching escalation", () => {
  let state = createViewerState();
  state = reduceViewerState(state, { type: "viewer_ready", viewerId: "viewer-1" });
  state = reduceViewerState(state, { type: "connected" });
  state = applyEvent(state, event(1, "scene_state", {
    scene_id: "fall",
    visual_mode: "abstract_environment",
  }));
  state = applyEvent(state, event(2, "alarm_state", {
    event_id: "fall-1",
    phase: "checking",
    trigger: "fall_transition",
    message: "正在确认安全",
    response_deadline_ms: 9_000,
    media_scope: "none",
  }));
  state = applyEvent(state, event(3, "media_grant", {
    grant_id: "grant-1",
    event_id: "fall-1",
    scope: "fall_emergency",
    expires_at_ms: 30_000,
    status: "active",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);

  state = applyEvent(state, event(4, "alarm_state", {
    event_id: "fall-1",
    phase: "escalated",
    trigger: "check_in_timeout",
    message: "已通知家属关注",
    response_deadline_ms: null,
    media_scope: "fall_emergency",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000)?.grant_id, "grant-1");
  assert.equal(selectActiveMediaGrant(state, 31_000), null);

  state = reduceViewerState(state, { type: "disconnected" });
  assert.equal(selectActiveMediaGrant(state, 2_000), null);
});

test("bathroom fails closed and kitchen grants require a consented heartbeat", () => {
  let state = createViewerState();
  state = reduceViewerState(state, { type: "viewer_ready", viewerId: "viewer-1" });
  state = reduceViewerState(state, { type: "connected" });
  state = applyEvent(state, event(1, "scene_state", {
    scene_id: "kitchen",
    visual_mode: "abstract_environment",
  }));
  state = applyEvent(state, event(2, "care_card", {
    card_id: "card-1",
    event_id: "cook-1",
    kind: "family_heartbeat",
    title: "今天也在认真生活",
    body: "记录到一段做饭时光。",
    occurred_at_ms: 1_000,
    share_state: "consent_pending",
  }));
  state = applyEvent(state, event(3, "media_grant", {
    grant_id: "grant-1",
    event_id: "cook-1",
    scope: "kitchen_moment",
    expires_at_ms: 30_000,
    status: "active",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);

  state = applyEvent(state, event(4, "care_card", {
    ...state.careCard,
    share_state: "consented",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000)?.grant_id, "grant-1");

  state = applyEvent(state, event(5, "scene_state", {
    scene_id: "bathroom",
    visual_mode: "skeleton_only",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);
});
