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

function careDecision(scene, overrides = {}) {
  return {
    schema_version: "reme-care-decision/v1-experiment",
    scene_id: scene,
    decision_id: "decision-1",
    timestamp_ms: 1_000,
    state: "observe",
    risk_level: 1,
    privacy_mode: "skeleton_only",
    need_dialogue: false,
    dialogue_goal: null,
    elder_message: null,
    family_notification: null,
    action: "observe",
    family_delivery: "none",
    reason_summary: "当前关怀状态。",
    uncertainty: "low",
    fallback_used: false,
    source: "rule",
    demo_mode: "live",
    consent_required: false,
    response_timeout_ms: null,
    response_deadline_ms: null,
    action_card: null,
    visual_context: null,
    alarm: null,
    voice_asset: null,
    confirm_channels: null,
    ...overrides,
  };
}

function snapshot({ scene = "kitchen", revision = 1, runtime = "runtime-1" } = {}) {
  return {
    schema_version: "reme-demo-state/v4",
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
        consent: scene === "kitchen" ? "granted" : "none",
        decision: careDecision(scene),
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
      event_id: "decision-1",
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

test("fall media stays closed until the current decision carries an alarm", () => {
  let state = ready(createViewerState());
  const fallState = snapshot({ scene: "fall" });
  fallState.state.care = {
    phase: "checking",
    consent: "none",
    decision: careDecision("fall", {
      state: "check_in_required",
      need_dialogue: true,
      elder_message: "正在询问本人",
      action: "ask_elder",
    }),
  };
  state = message(state, "demo_state", fallState);
  state = message(state, "media_grant", {
    type: "media_grant",
    room_session_id: "room-1",
    grant: {
      grant_id: "grant-fall",
      event_id: "decision-1",
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
          decision: careDecision("fall", {
            state: "urgent_attention",
            risk_level: 4,
            action: "show_urgent_attention",
            family_notification: "请立即关注",
            family_delivery: "alarm",
            alarm: { channels: ["flash"], trigger: "visual_confirm" },
          }),
        },
      },
    },
  };
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
  emergency.state.care = {
    phase: "emergency",
    consent: "none",
    decision: careDecision("fall", {
      state: "urgent_attention",
      risk_level: 4,
      action: "show_urgent_attention",
      family_notification: "上次收到权威紧急告警",
      family_delivery: "alarm",
      alarm: { channels: ["ring"], trigger: "visual_confirm" },
    }),
  };
  state = message(state, "demo_state", emergency);
  state = message(state, "state_unavailable", {
    type: "state_unavailable",
    reason: "not_published",
  });
  assert.equal(state.state, emergency);
  assert.equal(state.stateStale, true);
  assert.equal(state.unavailableReason, "not_published");
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
  assert.equal(isPoseFresh(state.pose, 12_500), true);
  assert.equal(isPoseFresh(state.pose, 12_601), false);
  assert.equal(isPoseFresh({ ...state.pose, timestamp_ms: 999_999 }, 12_601), false);
});
