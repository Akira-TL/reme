import assert from "node:assert/strict";
import test from "node:test";
import {
  canRevealAuthorizedVideo,
  createViewerState,
  ownsControllerLease,
  reduceViewerState,
  selectActiveMediaGrant,
} from "./viewerState.js";

function message(state, kind, value) {
  return reduceViewerState(state, { type: "message", message: { kind, value } });
}

function ready(state, room = "room-1") {
  return message(state, "viewer_ready", {
    type: "viewer_ready",
    room_name: "shared-live-demo",
    viewer_id: "viewer-1",
    room_session_id: room,
    monitor_online: true,
    viewer_count: 2,
    max_viewers: 5,
    controller: null,
    server_time_ms: 1000,
  });
}

function snapshot({ scene = "kitchen", revision = 1, runtime = "runtime-1" } = {}) {
  return {
    schema_version: "reme-demo-state/v1",
    room_session_id: "room-1",
    runtime_session_id: runtime,
    state_revision: revision,
    timestamp_ms: 1000 + revision,
    state: {
      scene_id: scene,
      source_generation: 1,
      capture: {
        status: "active",
        source_id: "camera-user",
        source_kind: "camera",
        remote_video: "available",
        error: null,
      },
      runtime: { status: "ready", capability: "live", detail: null },
      care: {
        phase: "idle",
        decision_id: "decision-1",
        consent: scene === "kitchen" ? "granted" : "none",
        alarm_authoritative: false,
        message: null,
      },
      media_grant: null,
    },
  };
}

test("room session change clears stale state, grant and controller", () => {
  let state = ready(createViewerState());
  state = { ...state, state: snapshot(), mediaGrant: { grant_id: "grant-1" }, lease: { lease_id: "lease-1" } };
  state = ready(state, "room-2");
  assert.equal(state.roomSessionId, "room-2");
  assert.equal(state.state, null);
  assert.equal(state.mediaGrant, null);
  assert.equal(state.lease, null);
});

test("state revisions and runtime sessions are monotonic", () => {
  let state = ready(createViewerState());
  state = message(state, "demo_state", snapshot({ revision: 3 }));
  state = message(state, "pose_frame", {
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 5,
  });
  state = message(state, "demo_state", snapshot({ revision: 2 }));
  assert.equal(state.state.state_revision, 3);
  assert.equal(state.pose.frame_sequence, 5);
  state = message(state, "demo_state", snapshot({ revision: 4, runtime: "runtime-2" }));
  assert.equal(state.pose, null);
});

test("controller ownership requires matching unexpired viewer lease", () => {
  let state = ready(createViewerState());
  state = message(state, "control_claim_result", {
    type: "control_claim_result",
    status: "granted",
    room_session_id: "room-1",
    lease: { lease_id: "lease-1", expires_at_ms: 5000 },
  });
  assert.equal(ownsControllerLease(state, 4000), true);
  assert.equal(ownsControllerLease(state, 5000), false);
});

test("authorized video fails closed for bathroom and high privacy", () => {
  let state = ready(createViewerState());
  state = message(state, "demo_state", snapshot());
  state = message(state, "media_grant", {
    type: "media_grant",
    room_session_id: "room-1",
    grant: {
      grant_id: "grant-1",
      event_id: "event-1",
      scope: "kitchen_moment",
      expires_at_ms: 5000,
      status: "active",
    },
    audience: "all_viewers",
    reason: null,
  });
  assert.equal(selectActiveMediaGrant(state, 4000)?.grant_id, "grant-1");
  assert.equal(canRevealAuthorizedVideo(state, true, 4000), false);
  assert.equal(canRevealAuthorizedVideo(state, false, 4000), true);
  state = { ...state, state: snapshot({ scene: "bathroom", revision: 2 }) };
  assert.equal(selectActiveMediaGrant(state, 4000), null);
});

test("fall media stays closed until the current care state is authoritative emergency", () => {
  let state = ready(createViewerState());
  const fallState = snapshot({ scene: "fall" });
  fallState.state.care = {
    phase: "checking",
    decision_id: "decision-1",
    consent: "none",
    alarm_authoritative: false,
    message: "正在询问本人",
  };
  state = message(state, "demo_state", fallState);
  state = message(state, "media_grant", {
    type: "media_grant",
    room_session_id: "room-1",
    grant: {
      grant_id: "grant-fall",
      event_id: "event-fall",
      scope: "fall_emergency",
      expires_at_ms: 5000,
      status: "active",
    },
    audience: "all_viewers",
    reason: null,
  });
  assert.equal(selectActiveMediaGrant(state, 4000), null);
  state = {
    ...state,
    state: {
      ...fallState,
      state: {
        ...fallState.state,
        care: {
          ...fallState.state.care,
          phase: "emergency",
          alarm_authoritative: true,
        },
      },
    },
  };
  assert.equal(selectActiveMediaGrant(state, 4000)?.grant_id, "grant-fall");
});

test("disconnect revokes media and control authority", () => {
  let state = ready(createViewerState());
  state = { ...state, mediaGrant: { grant_id: "grant-1" }, controller: { viewer_id: "viewer-1" }, lease: { lease_id: "lease-1" } };
  state = reduceViewerState(state, { type: "disconnected" });
  assert.equal(state.mediaGrant, null);
  assert.equal(state.controller, null);
  assert.equal(state.lease, null);
});
