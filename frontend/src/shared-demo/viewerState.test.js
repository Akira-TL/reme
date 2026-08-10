import assert from "node:assert/strict";
import test from "node:test";
import {
  canRevealAuthorizedVideo,
  createViewerState,
  failPendingAcks,
  hasPendingCommand,
  isPoseFresh,
  ownsControllerLease,
  reduceViewerState,
  selectActiveMediaGrant,
} from "./viewerState.js";

function message(state, kind, value, receivedAtMs = 1000) {
  return reduceViewerState(state, {
    type: "message",
    message: { kind, value },
    receivedAtMs,
  });
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

function familyCare(scene, overrides = {}) {
  return {
    decision_id: `decision-${scene}`,
    state: "observe",
    risk_level: 1,
    privacy_mode: "blurred",
    family_notification: null,
    action: "observe",
    action_card: null,
    alarm: null,
    media_authorization: null,
    ...overrides,
  };
}

function mediaAuthorization(scene, overrides = {}) {
  const decisionId = overrides.decision_id || `decision-${scene}`;
  return {
    schema_version: "reme-media-authorization/v1",
    authorization_id: `authorization-${scene}`,
    decision_id: decisionId,
    event_id: `transition-${scene}`,
    scene_id: scene,
    scope: scene === "fall" ? "fall_emergency" : "kitchen_moment",
    status: "active",
    issued_at_ms: 1_000,
    expires_at_ms: 5_000,
    ...overrides,
  };
}

function familyEvent(scene, { revision = 1, care = {}, authorization } = {}) {
  const authorizedCare = authorization === undefined
    ? scene === "kitchen"
      ? {
          state: "resolved",
          risk_level: 0,
          action: "notify_family",
          family_notification: "已确认厨房时刻，可查看短时画面。",
        }
      : {
          state: "urgent_attention",
          risk_level: 4,
          action: "show_urgent_attention",
          family_notification: "请立即关注",
          alarm: { channels: ["flash"], trigger: "visual_confirm" },
        }
    : {};
  return {
    type: "family_event",
    schema_version: "reme-family-event/v1",
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    revision,
    decision_timestamp_ms: 1_000 + revision,
    published_at_ms: 1_100 + revision,
    care: familyCare(scene, {
      ...authorizedCare,
      ...care,
      media_authorization: authorization === undefined
        ? mediaAuthorization(scene)
        : authorization,
    }),
  };
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
        decision_id: null,
        consent: "none",
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

test("authorized video fails closed for local privacy, contract privacy and bathroom", () => {
  let state = ready(createViewerState());
  state = message(state, "demo_state", snapshot());
  state = message(state, "family_event", familyEvent("kitchen", {
    care: {
      state: "resolved",
      risk_level: 0,
      action: "notify_family",
      family_notification: "已确认厨房时刻，可查看短时画面。",
    },
  }));
  state = message(state, "media_grant", {
    type: "media_grant",
    room_session_id: "room-1",
    grant: {
      grant_id: "grant-1",
      event_id: "decision-kitchen",
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
  state = message(state, "family_event", familyEvent("kitchen", {
    revision: 2,
    care: { privacy_mode: "skeleton_only" },
  }));
  assert.equal(selectActiveMediaGrant(state, 4000), null);
  state = message(state, "family_event", familyEvent("kitchen", {
    revision: 3,
    care: { privacy_mode: "hidden" },
  }));
  assert.equal(selectActiveMediaGrant(state, 4000), null);
  state = { ...state, state: snapshot({ scene: "bathroom", revision: 2 }) };
  assert.equal(selectActiveMediaGrant(state, 4000), null);
});

test("reconnect accepts the Relay latest FamilyEvent snapshot at the same revision", () => {
  let state = ready(createViewerState());
  const latest = familyEvent("fall", { revision: 7 });
  state = message(state, "family_event", latest);
  const first = state.familyEvent;
  state = reduceViewerState(state, { type: "disconnected", timestampMs: 2_000 });
  assert.equal(state.familyEventStale, true);
  state = ready(state);
  state = message(state, "family_event", structuredClone(latest), 2_100);
  assert.equal(state.familyEventStale, false);
  assert.notEqual(state.familyEvent, first);
  assert.equal(state.familyEvent.revision, 7);
});

test("keepalive state revisions preserve the active grant identity", () => {
  let state = ready(createViewerState());
  const first = snapshot({ revision: 1 });
  first.state.media_grant = {
    grant_id: "grant-stable",
    event_id: "decision-1",
    scope: "kitchen_moment",
    expires_at_ms: 5_000,
    status: "active",
  };
  state = message(state, "demo_state", first);
  const grant = state.mediaGrant;
  state = message(state, "media_grant", {
    type: "media_grant",
    room_session_id: "room-1",
    grant: { ...first.state.media_grant },
    audience: "all_viewers",
    reason: null,
  });
  assert.equal(state.mediaGrant, grant);
  const keepalive = snapshot({ revision: 2 });
  keepalive.state.media_grant = { ...first.state.media_grant };
  state = message(state, "demo_state", keepalive);
  assert.equal(state.mediaGrant, grant);
});

test("fall media stays closed until the backend publishes an active authorization", () => {
  let state = ready(createViewerState());
  const fallState = snapshot({ scene: "fall" });
  state = message(state, "demo_state", fallState);
  state = message(state, "family_event", familyEvent("fall", {
    authorization: null,
    care: {
      state: "check_in_required",
      action: "ask_elder",
    },
  }));
  state = message(state, "media_grant", {
    type: "media_grant",
    room_session_id: "room-1",
    grant: {
      grant_id: "grant-fall",
      event_id: "decision-fall",
      scope: "fall_emergency",
      expires_at_ms: 5000,
      status: "active",
    },
    audience: "all_viewers",
    reason: null,
  });
  assert.equal(selectActiveMediaGrant(state, 4000), null);
  state = message(state, "family_event", familyEvent("fall", {
    revision: 2,
    care: {
      state: "urgent_attention",
      risk_level: 4,
      action: "show_urgent_attention",
      family_notification: "请立即关注",
      alarm: { channels: ["flash"], trigger: "visual_confirm" },
    },
  }));
  assert.equal(selectActiveMediaGrant(state, 4000)?.grant_id, "grant-fall");
});

test("disconnect revokes media and control authority", () => {
  let state = ready(createViewerState());
  state = {
    ...state,
    mediaGrant: { grant_id: "grant-1" },
    controller: { viewer_id: "viewer-1" },
    lease: { lease_id: "lease-1" },
    acks: [{ command_id: "cmd-pending", phase: "received", timestamp_ms: 100 }],
  };
  state = reduceViewerState(state, { type: "disconnected", timestampMs: 500 });
  assert.equal(state.mediaGrant, null);
  assert.equal(state.controller, null);
  assert.equal(state.lease, null);
  assert.equal(state.acks[0].phase, "failed");
  assert.equal(state.acks[0].reason, "relay_disconnected");
});

test("state unavailable clears old normal state and accepts a fresh same-revision replay", () => {
  let state = ready(createViewerState());
  const normal = snapshot({ revision: 3 });
  state = message(state, "demo_state", normal);
  state = message(state, "pose_frame", {
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 1,
  }, 1_100);
  state = message(state, "state_unavailable", {
    type: "state_unavailable",
    reason: "stale",
  });
  assert.equal(state.state, null);
  assert.equal(state.stateStale, false);
  assert.equal(state.pose, null);
  assert.equal(state.unavailableReason, "stale");
  assert.equal(state.lastStateRevision, 3);

  state = message(state, "demo_state", normal, 1_200);
  assert.equal(state.state, normal);
  assert.equal(state.unavailableReason, null);
});

test("an unavailable alarm snapshot is retained only as stale history", () => {
  let state = ready(createViewerState());
  const emergency = snapshot({ scene: "fall", revision: 4 });
  state = message(state, "demo_state", emergency);
  state = message(state, "family_event", familyEvent("fall", {
    revision: 4,
    care: {
      family_notification: "上次收到权威紧急告警",
      alarm: { channels: ["ring"], trigger: "visual_confirm" },
    },
  }));
  state = message(state, "state_unavailable", {
    type: "state_unavailable",
    reason: "not_published",
  });
  assert.equal(state.state, emergency);
  assert.equal(state.stateStale, true);
  assert.equal(state.unavailableReason, "not_published");
  assert.notEqual(state.familyEvent.care.alarm, null);
  assert.equal(state.familyEvent.care.alarm.trigger, "visual_confirm");
  assert.equal(selectActiveMediaGrant(state, 4_000), null);
});

test("disconnect and invalid protocol terminalize only local nonterminal ACKs", () => {
  const pending = [
    { command_id: "cmd-sent", phase: "sent", timestamp_ms: 100, state_revision: null, reason: null },
    { command_id: "cmd-received", phase: "received", timestamp_ms: 110, state_revision: null, reason: null },
    { command_id: "cmd-applied", phase: "applied", timestamp_ms: 120, state_revision: 2, reason: null },
  ];
  const failed = failPendingAcks(pending, "relay_disconnected", 500);
  assert.deepEqual(failed.map((ack) => ack.phase), ["failed", "failed", "applied"]);
  assert.equal(failed[0].reason, "relay_disconnected");
  assert.equal(failed[2], pending[2]);

  let state = ready(createViewerState());
  state = { ...state, acks: pending };
  state = reduceViewerState(state, { type: "protocol_invalid", reason: "invalid_server_message", timestampMs: 600 });
  assert.deepEqual(state.acks.map((ack) => ack.phase), ["failed", "failed", "applied"]);
  assert.equal(state.acks[0].reason, "invalid_server_message");
  assert.equal(hasPendingCommand(state), false);

  state = ready(state, "room-1");
  state = message(state, "demo_state", snapshot({ revision: 1 }));
  assert.deepEqual(state.acks.map((ack) => ack.phase), ["failed", "failed", "applied"]);
  state = reduceViewerState(state, {
    type: "outgoing_command",
    command: {
      command_id: "cmd-after-reconnect",
      issued_at_ms: 700,
      command: { name: "reset_demo" },
    },
  });
  assert.equal(hasPendingCommand(state), true);
  assert.equal(state.acks[0].command_id, "cmd-after-reconnect");
});

test("a late ACK cannot overwrite a locally terminalized command", () => {
  let state = ready(createViewerState());
  state = {
    ...state,
    acks: [{
      command_id: "cmd-failed",
      command_name: "reset_demo",
      phase: "failed",
      timestamp_ms: 500,
      state_revision: null,
      reason: "relay_disconnected",
    }],
  };
  const next = message(state, "control_ack", {
    type: "control_ack",
    room_session_id: "room-1",
    command_id: "cmd-failed",
    phase: "applied",
    timestamp_ms: 600,
    state_revision: 3,
    reason: null,
  });
  assert.equal(next, state);
});

test("server clock offset and local pose receive time isolate device clock skew", () => {
  let state = message(createViewerState(), "viewer_ready", {
    type: "viewer_ready",
    room_name: "shared-live-demo",
    viewer_id: "viewer-1",
    room_session_id: "room-1",
    monitor_online: true,
    viewer_count: 1,
    max_viewers: 5,
    controller: null,
    server_time_ms: 2_000,
  }, 10_000);
  assert.equal(state.serverTimeOffsetMs, -8_000);
  state = message(state, "demo_state", snapshot(), 10_050);
  state = message(state, "pose_frame", {
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 1,
    timestamp_ms: 2_100,
  }, 10_100);
  assert.equal(state.pose.receivedAtMs, 10_100);
  assert.equal(isPoseFresh(state.pose, 10_050), true);
  assert.equal(isPoseFresh(state.pose, 15_100), true);
  assert.equal(isPoseFresh(state.pose, 15_101), false);
  assert.equal(isPoseFresh({ ...state.pose, timestamp_ms: 999_999 }, 15_101), false);
});

test("one short MoveNet miss holds the last detected pose without accepting stale sequence", () => {
  let state = message(createViewerState(), "viewer_ready", {
    type: "viewer_ready",
    room_name: "shared-live-demo",
    viewer_id: "viewer-1",
    room_session_id: "room-1",
    monitor_online: true,
    viewer_count: 1,
    max_viewers: 5,
    controller: null,
    server_time_ms: 1_000,
  }, 1_000);
  state = message(state, "demo_state", snapshot(), 1_010);
  state = message(state, "pose_frame", {
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 10,
    timestamp_ms: 1_020,
    person_detected: true,
    keypoints: [{ name: "nose", x: 0.5, y: 0.5, score: 0.9 }],
  }, 1_020);
  const detected = state.pose;
  state = message(state, "pose_frame", {
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 11,
    timestamp_ms: 3_020,
    person_detected: false,
    keypoints: [],
  }, 3_020);
  assert.equal(state.pose, detected);
  assert.equal(state.lastPoseSequence, 11);

  const duplicate = message(state, "pose_frame", {
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 11,
    timestamp_ms: 3_030,
    person_detected: true,
    keypoints: [{ name: "nose", x: 0.6, y: 0.6, score: 0.9 }],
  }, 3_030);
  assert.equal(duplicate, state);
});
