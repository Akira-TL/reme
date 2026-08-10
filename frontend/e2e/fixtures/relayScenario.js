const ROOM_SESSION_ID = "room-e2e";
const RUNTIME_SESSION_ID = "runtime-e2e";
const VIEWER_ID = "viewer-e2e";

const KEYPOINT_NAMES = Object.freeze([
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
]);

function createGrant(sceneId, nowMs) {
  return {
    grant_id: `grant-${sceneId}`,
    event_id: `decision-${sceneId}`,
    scope: sceneId === "kitchen" ? "kitchen_moment" : "fall_emergency",
    expires_at_ms: nowMs + 25_000,
    status: "active",
  };
}

function createAuthorization(sceneId, nowMs) {
  return {
    schema_version: "reme-media-authorization/v1",
    authorization_id: `authorization-${sceneId}`,
    decision_id: `decision-${sceneId}`,
    event_id: `transition-${sceneId}`,
    scene_id: sceneId,
    scope: sceneId === "kitchen" ? "kitchen_moment" : "fall_emergency",
    status: "active",
    issued_at_ms: nowMs,
    expires_at_ms: nowMs + 25_000,
  };
}

function createCare({ sceneId, variant, privacyMode, withGrant, nowMs }) {
  const base = {
    decision_id: `decision-${sceneId}`,
    state: "observe",
    risk_level: 1,
    privacy_mode: privacyMode,
    family_notification: null,
    action: "observe",
    action_card: null,
    alarm: null,
    media_authorization: withGrant ? createAuthorization(sceneId, nowMs) : null,
  };
  if (variant === "alarm") {
    return {
      ...base,
      state: "urgent_attention",
      risk_level: 4,
      privacy_mode: "skeleton_only",
      family_notification: "检测到需要立即关注的安全事件。",
      action: "show_urgent_attention",
      alarm: { channels: ["flash"], trigger: "visual_confirm" },
      media_authorization: null,
    };
  }
  if (variant === "action_card") {
    return {
      ...base,
      state: "family_notification_required",
      risk_level: 2,
      family_notification: "今天需要家属协助。",
      action: "notify_family",
      action_card: {
        event: "需要协助安排复诊",
        elder_quote: "今天牙齿有些不舒服。",
        system_judgment: "本人表达了明确的生活协助需求",
        suggested_action: "今天联系本人并协助预约",
        time_window: "今天",
        status: "pending",
      },
    };
  }
  if (withGrant) {
    return {
      ...base,
      state: "resolved",
      risk_level: 0,
      family_notification: "本人已授权当前事件的短时画面。",
      action: "notify_family",
    };
  }
  return base;
}

function createDemoState({ sceneId, variant, grant, nowMs }) {
  const emergency = variant === "alarm";
  return {
    schema_version: "reme-demo-state/v1",
    room_session_id: ROOM_SESSION_ID,
    runtime_session_id: RUNTIME_SESSION_ID,
    state_revision: 1,
    timestamp_ms: nowMs,
    state: {
      scene_id: sceneId,
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
        phase: emergency ? "emergency" : "idle",
        decision_id: emergency ? `decision-${sceneId}` : null,
        consent: "none",
        alarm_authoritative: emergency,
        message: emergency ? "权威规则已升级告警。" : null,
      },
      media_grant: grant,
    },
  };
}

function createFamilyEvent(options) {
  return {
    type: "family_event",
    schema_version: "reme-family-event/v1",
    room_session_id: ROOM_SESSION_ID,
    runtime_session_id: RUNTIME_SESSION_ID,
    revision: 1,
    decision_timestamp_ms: options.nowMs,
    published_at_ms: options.nowMs + 1,
    care: createCare(options),
  };
}

function createPoseFrame(nowMs) {
  return {
    schema_version: "reme-pose-frame-17/v1",
    room_session_id: ROOM_SESSION_ID,
    runtime_session_id: RUNTIME_SESSION_ID,
    frame_sequence: 1,
    timestamp_ms: nowMs + 2,
    source_width: 640,
    source_height: 360,
    person_detected: true,
    landmark_quality: "usable",
    keypoints: KEYPOINT_NAMES.map((name, index) => ({
      name,
      x: 0.35 + ((index % 5) * 0.075),
      y: 0.14 + (Math.floor(index / 3) * 0.105),
      score: 0.95,
    })),
  };
}

/**
 * Installs a strict in-process Relay peer. Media bytes never enter this mock;
 * only the same JSON envelopes accepted from the public Relay are emitted.
 */
export async function installRelayScenario(page, {
  sceneId = "living",
  variant = "observe",
  privacyMode = "blurred",
  withGrant = false,
} = {}) {
  const sentMessages = [];
  await page.route(/\/api\/rtc-config(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      iceServers: [],
      mode: "local_network_only",
      credential_expires_at_ms: null,
    }),
  }));

  await page.routeWebSocket(/\/ws\/viewer(?:\?.*)?$/, (socket) => {
    const nowMs = Date.now();
    const grant = withGrant ? createGrant(sceneId, nowMs) : null;
    const initialMessages = [
      {
        type: "viewer_ready",
        room_name: "shared-live-demo",
        viewer_id: VIEWER_ID,
        room_session_id: ROOM_SESSION_ID,
        monitor_online: true,
        viewer_count: 1,
        max_viewers: 5,
        controller: null,
        server_time_ms: nowMs,
      },
      createDemoState({ sceneId, variant, grant, nowMs }),
      createFamilyEvent({ sceneId, variant, privacyMode, withGrant, nowMs }),
      createPoseFrame(nowMs),
    ];

    socket.onMessage((raw) => {
      const value = JSON.parse(String(raw));
      sentMessages.push(value);
      if (value.type === "control_claim") {
        socket.send(JSON.stringify({
          type: "control_claim_result",
          status: "granted",
          room_session_id: ROOM_SESSION_ID,
          lease: { lease_id: "lease-e2e", expires_at_ms: Date.now() + 30_000 },
        }));
      } else if (value.type === "control_heartbeat") {
        socket.send(JSON.stringify({
          type: "control_heartbeat_ack",
          room_session_id: ROOM_SESSION_ID,
          lease_id: "lease-e2e",
          expires_at_ms: Date.now() + 30_000,
        }));
      } else if (value.schema_version === "reme-control-command/v1") {
        socket.send(JSON.stringify({
          type: "control_ack",
          room_session_id: ROOM_SESSION_ID,
          command_id: value.command_id,
          phase: "received",
          timestamp_ms: Date.now(),
          state_revision: null,
          reason: null,
        }));
        setTimeout(() => socket.send(JSON.stringify({
          type: "control_ack",
          room_session_id: ROOM_SESSION_ID,
          command_id: value.command_id,
          phase: "applied",
          timestamp_ms: Date.now(),
          state_revision: 2,
          reason: null,
        })), 0);
      }
    });

    setTimeout(() => {
      for (const message of initialMessages) socket.send(JSON.stringify(message));
    }, 0);
  });

  return { sentMessages };
}
