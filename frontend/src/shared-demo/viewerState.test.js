import assert from "node:assert/strict";
import test from "node:test";

import { createMediaSignal } from "./protocol.js";
import {
  createViewerState,
  reduceViewerState,
  selectActiveMediaGrant,
  selectViewerScene,
} from "./state.js";
import {
  canStartViewerSocketConnection,
  createForwardedMediaSignalBuffer,
  isCurrentViewerSocket,
  parseViewerReady,
  sendViewerSignal,
  suspendViewerRelayConnection,
} from "./useViewerRelay.js";

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

  state = applyEvent(state, event(3, "activity_state", {
    activity: "cooking",
    confidence: 0.51,
    phase: "candidate",
    reason: "等待更多证据",
    source: "mimo_visual",
  }));
  assert.equal(state.activityEventSequence, 3);

  state = applyEvent(state, event(0, "scene_state", {
    scene_id: "bathroom",
    visual_mode: "skeleton_only",
  }, "session-b"));
  assert.equal(state.sessionId, "session-b");
  assert.equal(state.activity, null);
  assert.equal(state.activityEventSequence, null);
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

  state = applyEvent(state, event(5, "scene_state", {
    scene_id: "living",
    visual_mode: "abstract_environment",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);

  state = reduceViewerState(state, { type: "disconnected" });
  assert.equal(selectActiveMediaGrant(state, 2_000), null);
});

test("bathroom fails closed and kitchen grants bind to the latest confirmed activity", () => {
  let state = createViewerState();
  state = reduceViewerState(state, { type: "viewer_ready", viewerId: "viewer-1" });
  state = reduceViewerState(state, { type: "connected" });
  state = applyEvent(state, event(1, "scene_state", {
    scene_id: "kitchen",
    visual_mode: "abstract_environment",
  }));
  state = applyEvent(state, event(2, "activity_state", {
    activity: "cooking",
    confidence: 0.54,
    phase: "candidate",
    reason: "仅有一次证据",
    source: "mimo_visual",
  }));
  state = applyEvent(state, event(3, "media_grant", {
    grant_id: "grant-1",
    event_id: "activity-2",
    scope: "kitchen_moment",
    expires_at_ms: 30_000,
    status: "active",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);

  state = applyEvent(state, event(4, "activity_state", {
    ...state.activity,
    confidence: 0.88,
    phase: "confirmed",
    reason: "连续证据确认",
    source: "manual_debug",
  }));
  assert.equal(state.activityEventSequence, 4);
  assert.equal(selectActiveMediaGrant(state, 2_000), null);

  state = applyEvent(state, event(5, "media_grant", {
    grant_id: "grant-2",
    event_id: "activity-4",
    scope: "kitchen_moment",
    expires_at_ms: 30_000,
    status: "active",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);

  state = applyEvent(state, event(6, "activity_state", {
    ...state.activity,
    confidence: 0.91,
    phase: "confirmed",
    reason: "真实 MiMo 连续证据确认",
    source: "mimo_visual",
  }));
  state = applyEvent(state, event(7, "care_card", {
    card_id: "heartbeat-1",
    event_id: "activity-6",
    kind: "family_heartbeat",
    title: "厨房里的家庭心跳",
    body: "真实做饭确认已记录；本地短片与实景授权相互独立。",
    occurred_at_ms: 1_000,
    share_state: "local_only",
  }));
  state = applyEvent(state, event(8, "media_grant", {
    grant_id: "grant-3",
    event_id: "activity-6",
    scope: "kitchen_moment",
    expires_at_ms: 30_000,
    status: "active",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000)?.grant_id, "grant-3");

  state = applyEvent(state, event(9, "care_card", {
    ...state.careCard,
    share_state: "expired",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000)?.grant_id, "grant-3");

  state = applyEvent(state, event(10, "scene_state", {
    scene_id: "bathroom",
    visual_mode: "skeleton_only",
  }));
  assert.equal(selectActiveMediaGrant(state, 2_000), null);
});

test("viewer grant fallback expires by server-issued duration despite a slow absolute clock", () => {
  let state = createViewerState();
  state = reduceViewerState(state, { type: "viewer_ready", viewerId: "viewer-1" });
  state = reduceViewerState(state, { type: "connected" });
  state = applyEvent(state, event(1, "scene_state", {
    scene_id: "fall",
    visual_mode: "abstract_environment",
  }));
  state = applyEvent(state, event(2, "alarm_state", {
    event_id: "fall-1",
    phase: "escalated",
    trigger: "check_in_timeout",
    message: "已升级",
    response_deadline_ms: null,
    media_scope: "fall_emergency",
  }));
  const grantEvent = {
    ...event(3, "media_grant", {
      grant_id: "grant-clock",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_at_ms: 160_000,
      status: "active",
    }),
    timestamp_ms: 100_000,
  };
  state = reduceViewerState(state, {
    type: "demo_event",
    event: grantEvent,
    receivedAtMs: 10_000,
  });
  assert.equal(selectActiveMediaGrant(state, 69_999)?.grant_id, "grant-clock");
  assert.equal(selectActiveMediaGrant(state, 70_000), null);
});

test("forwarded media signal buffer is bounded and drains only matching signals", () => {
  const buffer = createForwardedMediaSignalBuffer(3);
  buffer.push({ grant_id: "grant-old", signal_type: "offer" });
  buffer.push({ grant_id: "grant-other", signal_type: "offer" });
  buffer.push({ grant_id: "grant-1", signal_type: "offer" });
  buffer.push({ grant_id: "grant-1", signal_type: "ice_candidate" });

  assert.equal(buffer.size(), 3);
  assert.deepEqual(
    buffer.drain((signal) => signal.grant_id === "grant-1"),
    [
      { grant_id: "grant-1", signal_type: "offer" },
      { grant_id: "grant-1", signal_type: "ice_candidate" },
    ],
  );
  assert.equal(buffer.size(), 1);
  assert.deepEqual(buffer.drain(), [{ grant_id: "grant-other", signal_type: "offer" }]);
  assert.throws(() => createForwardedMediaSignalBuffer(0), /positive integer/);
});

test("forwarded signal buffer preserves the only offer when ICE reaches capacity", () => {
  const buffer = createForwardedMediaSignalBuffer(64);
  const offer = {
    grant_id: "grant-1",
    target_id: "viewer-1",
    from_id: "controller-1",
    signal_type: "offer",
  };
  buffer.push(offer);
  for (let index = 0; index < 64; index += 1) {
    buffer.push({
      grant_id: "grant-1",
      target_id: "viewer-1",
      from_id: "controller-1",
      signal_type: "ice_candidate",
      signal: { candidate: `candidate:${index}` },
    });
  }

  const signals = buffer.drain();
  assert.equal(signals.length, 64);
  assert.equal(signals[0], offer);
  assert.equal(signals.filter((signal) => signal.signal_type === "offer").length, 1);
  assert.equal(signals.filter((signal) => signal.signal_type === "ice_candidate").length, 63);
});

test("pagehide synchronously clears viewer signaling authority before closing the socket", () => {
  const buffer = createForwardedMediaSignalBuffer(3);
  buffer.push({ grant_id: "grant-1", signal_type: "offer" });
  const calls = [];
  const socket = {
    close(code, reason) {
      calls.push({ code, reason, buffered: buffer.size() });
    },
  };
  let capability = { grant_id: "grant-1" };
  let exposedSocket = socket;

  suspendViewerRelayConnection({
    signalBuffer: buffer,
    socket,
    clearCapability: () => { capability = null; },
    clearSocket: () => { exposedSocket = null; },
    reason: "viewer_pagehide",
  });

  assert.equal(buffer.size(), 0);
  assert.equal(capability, null);
  assert.equal(exposedSocket, null);
  assert.deepEqual(calls, [{ code: 1000, reason: "viewer_pagehide", buffered: 0 }]);
});

test("stale viewer socket events cannot affect a replacement connection", () => {
  const oldSocket = { readyState: 3 };
  const newSocket = { readyState: 0 };
  assert.equal(isCurrentViewerSocket(newSocket, oldSocket), false);
  assert.equal(isCurrentViewerSocket(newSocket, newSocket), true);
  assert.equal(canStartViewerSocketConnection({
    active: true,
    pageSuspended: false,
    visibilityState: "visible",
    currentSocket: newSocket,
  }), false, "pageshow must not open an orphan while the replacement is connecting");
  newSocket.readyState = 1;
  assert.equal(canStartViewerSocketConnection({
    active: true,
    pageSuspended: false,
    visibilityState: "visible",
    currentSocket: newSocket,
  }), false, "an open replacement also blocks retry connect");
  assert.equal(canStartViewerSocketConnection({
    active: true,
    pageSuspended: false,
    visibilityState: "visible",
    currentSocket: null,
  }), true);
});

test("viewer signaling returns false when an OPEN socket send throws", () => {
  const signal = createMediaSignal({
    grantId: "grant-1",
    targetId: "controller-1",
    signalType: "ice_candidate",
    signal: { candidate: "candidate:1", sdp_mid: "0", sdp_mline_index: 0 },
  });
  const socket = {
    readyState: 1,
    send() {
      throw new Error("socket closed between readyState and send");
    },
  };
  assert.equal(sendViewerSignal(socket, signal), false);
});
