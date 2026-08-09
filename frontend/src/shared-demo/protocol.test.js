import assert from "node:assert/strict";
import test from "node:test";
import {
  createControlCommand,
  createMediaSignal,
  isControlCommand,
  isDemoState,
  isPoseFrame,
  parseViewerMessage,
} from "./protocol.js";

function validState() {
  return {
    schema_version: "reme-demo-state/v4",
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    state_revision: 4,
    timestamp_ms: 1000,
    state: {
      scene_id: "living",
      source_generation: 2,
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
        consent: "none",
        decision: null,
      },
      media_grant: null,
    },
  };
}

test("state parser accepts exact v4 shape and rejects extra keys", () => {
  const state = validState();
  assert.equal(isDemoState(state), true);
  assert.equal(parseViewerMessage(JSON.stringify(state))?.kind, "demo_state");
  assert.equal(isDemoState({ ...state, extra: true }), false);
  assert.equal(isDemoState({
    ...state,
    state: { ...state.state, care: { ...state.state.care, made_up: true } },
  }), false);
});

test("v4 carries the exact CareDecision and rejects invented fields", () => {
  const state = validState();
  state.state.care.decision = {
    schema_version: "reme-care-decision/v1-experiment",
    scene_id: "living",
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
    reason_summary: "姿态与房间内活动节奏综合判断。",
    uncertainty: "medium",
    source: "mimo",
    fallback_used: false,
    demo_mode: "live",
    consent_required: false,
    response_timeout_ms: null,
    response_deadline_ms: null,
    action_card: null,
    visual_context: {
      sent_to_mimo: true,
      type: "keyframes",
      start_ms: 900,
      end_ms: 1_000,
      sample_count: 3,
    },
    alarm: null,
    voice_asset: null,
    confirm_channels: null,
  };

  assert.equal(isDemoState(state), true);

  const mismatchedPhase = structuredClone(state);
  mismatchedPhase.state.care.phase = "checking";
  assert.equal(isDemoState(mismatchedPhase), false);

  const inventedSource = structuredClone(state);
  inventedSource.state.care.decision.source = "guessed";
  assert.equal(isDemoState(inventedSource), false);

  const rawVisualPayload = structuredClone(state);
  rawVisualPayload.state.care.decision.visual_context.image_url = "data:image/jpeg;base64,no";
  assert.equal(isDemoState(rawVisualPayload), false);
});

test("viewer ready and presence reject out-of-contract audience sizes", () => {
  const ready = {
    type: "viewer_ready",
    room_name: "shared-live-demo",
    viewer_id: "viewer-1",
    room_session_id: "room-1",
    monitor_online: true,
    viewer_count: 1,
    max_viewers: 5,
    controller: null,
    server_time_ms: 1000,
  };
  assert.equal(parseViewerMessage(JSON.stringify(ready))?.kind, "viewer_ready");
  assert.equal(parseViewerMessage(JSON.stringify({ ...ready, viewer_count: 6 })), null);
  assert.equal(parseViewerMessage(JSON.stringify({ ...ready, password: "no" })), null);
});

test("pose parser requires ordered MoveNet 17 keypoints", () => {
  const names = [
    "nose", "left_eye", "right_eye", "left_ear", "right_ear",
    "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
    "left_wrist", "right_wrist", "left_hip", "right_hip", "left_knee",
    "right_knee", "left_ankle", "right_ankle",
  ];
  const frame = {
    schema_version: "reme-pose-frame-17/v1",
    room_session_id: "room-1",
    runtime_session_id: "runtime-1",
    frame_sequence: 7,
    timestamp_ms: 1200,
    source_width: 1280,
    source_height: 720,
    person_detected: true,
    landmark_quality: "usable",
    keypoints: names.map((name) => ({ name, x: 0.5, y: 0.5, score: 0.9 })),
  };
  assert.equal(isPoseFrame(frame), true);
  const swapped = structuredClone(frame);
  [swapped.keypoints[0], swapped.keypoints[1]] = [swapped.keypoints[1], swapped.keypoints[0]];
  assert.equal(isPoseFrame(swapped), false);
  assert.equal(isPoseFrame({ ...frame, person_detected: false, landmark_quality: "unavailable", keypoints: [] }), true);
});

test("control command factory accepts only the strict command union", () => {
  const command = createControlCommand({
    roomSessionId: "room-1",
    commandId: "cmd-1",
    commandSequence: 0,
    issuedAtMs: 1000,
    expiresAtMs: 9000,
    expectedStateRevision: 4,
    command: { name: "select_scene", scene_id: "kitchen" },
  });
  assert.equal(isControlCommand(command), true);
  const notificationAck = createControlCommand({
    roomSessionId: "room-1",
    commandId: "cmd-notification",
    commandSequence: 1,
    issuedAtMs: 1000,
    expiresAtMs: 9000,
    expectedStateRevision: 4,
    command: { name: "confirm_family_notification", decision_id: "decision-1" },
  });
  assert.equal(isControlCommand(notificationAck), true);
  assert.throws(() => createControlCommand({
    ...command,
    roomSessionId: "room-1",
    commandId: "cmd-2",
    commandSequence: 1,
    issuedAtMs: 1000,
    expiresAtMs: 9000,
    expectedStateRevision: 4,
    command: { name: "confirm_alarm", decision_id: "decision-1", cancel: true },
  }), /invalid control command/);
});

test("media signal factory emits exact viewer-to-monitor shape", () => {
  const message = createMediaSignal({
    roomSessionId: "room-1",
    grantId: "grant-1",
    targetId: "monitor",
    signalType: "answer",
    signal: { type: "answer", sdp: "v=0" },
  });
  assert.deepEqual(Object.keys(message).sort(), [
    "grant_id", "room_session_id", "schema_version", "signal", "signal_type", "target_id",
  ]);
  const forwardedIce = {
    schema_version: "reme-media-signal/v1",
    room_session_id: "room-1",
    grant_id: "grant-1",
    target_id: "viewer-1",
    from_id: "monitor",
    signal_type: "ice_candidate",
    signal: {
      candidate: "candidate:1",
      sdpMid: null,
      sdpMLineIndex: 0,
      usernameFragment: null,
    },
  };
  assert.equal(parseViewerMessage(JSON.stringify(forwardedIce))?.kind, "media_signal");
  assert.equal(parseViewerMessage(JSON.stringify({
    ...forwardedIce,
    signal: { ...forwardedIce.signal, address: "not-allowed" },
  })), null);
});
