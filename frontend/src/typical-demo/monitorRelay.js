const MONITOR_PROTOCOL = "reme-monitor-v1";
const TOKEN_PROTOCOL_PREFIX = "reme-token-";
const DEMO_STATE_SCHEMA = "reme-demo-state/v2";
const POSE_FRAME_SCHEMA = "reme-pose-frame-17/v1";
const CONTROL_COMMAND_SCHEMA = "reme-control-command/v1";
const MEDIA_SIGNAL_SCHEMA = "reme-media-signal/v1";

const HEARTBEAT_INTERVAL_MS = 10_000;
const MAX_RELAY_JSON_BYTES = 16_384;
const MAX_SOCKET_BUFFER_BYTES = 64 * 1024;
const CLAIM_STORAGE_KEY = "reme-monitor-claim/v1";
const CONTROL_ACK_PHASES = new Set([
  "received",
  "awaiting_local_confirmation",
  "applied",
  "rejected",
  "failed",
]);
const SCENE_IDS = new Set(["living", "kitchen", "bathroom", "fall"]);
const SOURCE_KINDS = new Set(["camera", "display", "file"]);
const CAPTURE_STATES = new Set([
  "idle",
  "awaiting_local_confirmation",
  "starting",
  "active",
  "stopping",
  "error",
]);
const REMOTE_VIDEO_STATES = new Set(["available", "local_only", "unavailable"]);
const RUNTIME_STATES = new Set(["offline", "connecting", "ready", "degraded", "error"]);
const RUNTIME_CAPABILITIES = new Set(["live", "scripted", "unavailable"]);
const CARE_PHASES = new Set(["idle", "checking", "emergency", "resolved"]);
const CONSENT_STATES = new Set(["none", "pending", "granted", "denied"]);
const ASSESSMENT_UNCERTAINTIES = new Set(["low", "medium", "high", "unknown"]);
const ASSESSMENT_SOURCES = new Set(["rule", "mimo", "mock", "record", "degraded"]);
const ASSESSMENT_ACTIONS = new Set([
  "none",
  "observe",
  "ask_elder",
  "notify_family",
  "show_urgent_attention",
  "mark_resolved",
]);
const ASSESSMENT_STATUSES = new Set([
  "observing",
  "awaiting_response",
  "family_notified",
  "resolved",
  "degraded",
]);
const KEYPOINT_NAMES = [
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
];
const FORBIDDEN_MEDIA_KEYS = new Set([
  "audio",
  "base64",
  "binary",
  "blob",
  "clip",
  "clip_data",
  "data_url",
  "frame_data",
  "image",
  "image_data",
  "image_url",
  "jpeg",
  "media_bytes",
  "payload_bytes",
  "raw_frame",
  "raw_video",
  "video_bytes",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function isNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isBoundedString(value, maximum, allowEmpty = false) {
  return typeof value === "string"
    && value.length <= maximum
    && (allowEmpty || value.length > 0);
}

function isUnitNumber(value) {
  return isFiniteNonNegative(value) && value <= 1;
}

function validController(value) {
  return value === null || (
    exactKeys(value, ["viewer_id", "lease_id", "expires_at_ms"])
    && isId(value.viewer_id)
    && isId(value.lease_id)
    && isFiniteNonNegative(value.expires_at_ms)
  );
}

export function containsForbiddenRawMedia(value) {
  if (typeof value === "string") return /^data:(?:image|video|audio)\//i.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenRawMedia);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_MEDIA_KEYS.has(key.toLowerCase()) || containsForbiddenRawMedia(child)
  ));
}

export function resolveMonitorRelayEndpoints(relayUrl) {
  const url = new URL(relayUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("Relay URL 必须使用 http 或 https");
  }
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  const claimUrl = new URL("api/monitor/claim", url);
  const monitorWsUrl = new URL("ws/monitor", url);
  monitorWsUrl.protocol = monitorWsUrl.protocol === "https:" ? "wss:" : "ws:";
  return Object.freeze({ claimUrl: claimUrl.href, monitorWsUrl: monitorWsUrl.href });
}

function validateClaim(value) {
  return exactKeys(value, [
    "room_name",
    "room_session_id",
    "producer_token",
    "expires_at_ms",
  ])
    && value.room_name === "shared-live-demo"
    && isId(value.room_session_id)
    && typeof value.producer_token === "string"
    && /^[a-f0-9]{64}$/.test(value.producer_token)
    && isFiniteNonNegative(value.expires_at_ms);
}

export async function claimMonitor(relayUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch 不可用");
  const endpoints = resolveMonitorRelayEndpoints(relayUrl);
  const response = await fetchImpl(endpoints.claimUrl, {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A stable local error is safer than exposing an arbitrary proxy response.
  }
  if (!response.ok) {
    const error = new Error(payload?.error === "monitor_busy" ? "Monitor 正被另一设备占用" : "Relay claim 失败");
    error.code = payload?.error || `http_${response.status}`;
    error.retryAtMs = isFiniteNonNegative(payload?.retry_at_ms) ? payload.retry_at_ms : null;
    error.serverTimeMs = isFiniteNonNegative(payload?.server_time_ms)
      ? payload.server_time_ms
      : null;
    error.retryAfterMs = isFiniteNonNegative(payload?.retry_after_ms)
      ? payload.retry_after_ms
      : error.retryAtMs !== null && error.serverTimeMs !== null
        ? Math.max(0, error.retryAtMs - error.serverTimeMs)
        : null;
    throw error;
  }
  if (!validateClaim(payload)) {
    const error = new Error("Relay 返回了无效的 producer claim");
    error.code = "invalid_claim_response";
    throw error;
  }
  return Object.freeze({ ...payload, relay_url: relayUrl });
}

export function createSessionClaimStore(storage = globalThis.sessionStorage) {
  return Object.freeze({
    load(relayUrl, nowMs = Date.now()) {
      if (!storage?.getItem) return null;
      try {
        const value = JSON.parse(storage.getItem(CLAIM_STORAGE_KEY));
        if (!exactKeys(value, [
          "relay_url",
          "room_name",
          "room_session_id",
          "producer_token",
          "expires_at_ms",
        ])) return null;
        if (value.relay_url !== relayUrl || !validateClaim({
          room_name: value.room_name,
          room_session_id: value.room_session_id,
          producer_token: value.producer_token,
          expires_at_ms: value.expires_at_ms,
        })) return null;
        return value.expires_at_ms > nowMs ? Object.freeze(value) : null;
      } catch {
        return null;
      }
    },
    save(claim) {
      const claimPayload = {
        room_name: claim?.room_name,
        room_session_id: claim?.room_session_id,
        producer_token: claim?.producer_token,
        expires_at_ms: claim?.expires_at_ms,
      };
      if (!storage?.setItem || !validateClaim(claimPayload) || typeof claim.relay_url !== "string") {
        return;
      }
      try {
        storage.setItem(CLAIM_STORAGE_KEY, JSON.stringify({
          relay_url: claim.relay_url,
          room_name: claim.room_name,
          room_session_id: claim.room_session_id,
          producer_token: claim.producer_token,
          expires_at_ms: claim.expires_at_ms,
        }));
      } catch {
        // Memory-only operation remains valid when sessionStorage is unavailable.
      }
    },
    clear() {
      try {
        storage?.removeItem?.(CLAIM_STORAGE_KEY);
      } catch {
        // An unavailable sessionStorage must never block local cleanup.
      }
    },
  });
}

function validateCapture(value) {
  if (!exactKeys(value, ["status", "source_id", "source_kind", "remote_video", "error"])) {
    return false;
  }
  if (!CAPTURE_STATES.has(value.status)) return false;
  if (value.source_id !== null && !isId(value.source_id)) return false;
  if (value.source_kind !== null && !SOURCE_KINDS.has(value.source_kind)) return false;
  if (!REMOTE_VIDEO_STATES.has(value.remote_video)) return false;
  if (value.error !== null && !isBoundedString(value.error, 240)) return false;
  return value.status !== "active" || (value.source_id !== null && value.source_kind !== null);
}

function validateRuntime(value) {
  return exactKeys(value, ["status", "capability", "detail"])
    && RUNTIME_STATES.has(value.status)
    && RUNTIME_CAPABILITIES.has(value.capability)
    && (value.detail === null || isBoundedString(value.detail, 240));
}

function validateCare(value) {
  if (!exactKeys(value, [
    "phase",
    "decision_id",
    "consent",
    "alarm_authoritative",
    "message",
    "assessment",
  ])) return false;
  if (!CARE_PHASES.has(value.phase) || !CONSENT_STATES.has(value.consent)) return false;
  if (value.decision_id !== null && !isId(value.decision_id)) return false;
  if (typeof value.alarm_authoritative !== "boolean") return false;
  if (value.message !== null && !isBoundedString(value.message, 240)) return false;
  if (value.assessment !== null && !validateCareAssessment(value.assessment)) return false;
  if (value.assessment !== null && value.decision_id === null) return false;
  return value.phase === "emergency"
    ? value.alarm_authoritative && value.decision_id !== null
    : !value.alarm_authoritative;
}

function validateCareAssessment(value) {
  if (!exactKeys(value, [
    "verdict",
    "basis",
    "uncertainty",
    "source",
    "action",
    "suggested_action",
    "status",
    "visual_context",
  ])) return false;
  if (!isBoundedString(value.verdict, 240) || !isBoundedString(value.basis, 240)) return false;
  if (!isBoundedString(value.suggested_action, 240)) return false;
  if (!ASSESSMENT_UNCERTAINTIES.has(value.uncertainty)) return false;
  if (!ASSESSMENT_SOURCES.has(value.source)) return false;
  if (!ASSESSMENT_ACTIONS.has(value.action)) return false;
  if (!ASSESSMENT_STATUSES.has(value.status)) return false;
  return validateCareVisualContext(value.visual_context);
}

function validateCareVisualContext(value) {
  if (!exactKeys(value, ["sent_to_mimo", "type", "sample_count"])) return false;
  if (typeof value.sent_to_mimo !== "boolean") return false;
  if (!value.sent_to_mimo) return value.type === null && value.sample_count === null;
  return ["keyframes", "clip"].includes(value.type)
    && (value.sample_count === null
      || (Number.isSafeInteger(value.sample_count) && value.sample_count > 0));
}

export function validateDemoStateEnvelope(value, roomSessionId = value?.room_session_id) {
  if (!exactKeys(value, [
    "schema_version",
    "room_session_id",
    "runtime_session_id",
    "state_revision",
    "timestamp_ms",
    "state",
  ])) return false;
  if (
    value.schema_version !== DEMO_STATE_SCHEMA
    || value.room_session_id !== roomSessionId
    || !isId(value.room_session_id)
    || !isId(value.runtime_session_id)
    || !isNonNegativeInteger(value.state_revision)
    || !isFiniteNonNegative(value.timestamp_ms)
  ) return false;
  const state = value.state;
  return exactKeys(state, [
    "scene_id",
    "source_generation",
    "capture",
    "runtime",
    "care",
    "media_grant",
  ])
    && SCENE_IDS.has(state.scene_id)
    && isNonNegativeInteger(state.source_generation)
    && validateCapture(state.capture)
    && validateRuntime(state.runtime)
    && validateCare(state.care)
    && state.media_grant === null
    && !containsForbiddenRawMedia(value);
}

export function createDemoStateEnvelope({
  roomSessionId,
  runtimeSessionId,
  stateRevision,
  state,
  timestampMs = Date.now(),
}) {
  const value = {
    schema_version: DEMO_STATE_SCHEMA,
    room_session_id: roomSessionId,
    runtime_session_id: runtimeSessionId,
    state_revision: stateRevision,
    timestamp_ms: timestampMs,
    state: { ...state, media_grant: null },
  };
  if (!validateDemoStateEnvelope(value, roomSessionId)) {
    throw new TypeError("无效的 Monitor demo state");
  }
  return value;
}

export function createPoseFrame({
  roomSessionId,
  runtimeSessionId,
  frameSequence,
  timestampMs = Date.now(),
  sourceWidth,
  sourceHeight,
  landmarks,
  landmarkQuality = "usable",
}) {
  const personDetected = Array.isArray(landmarks) && landmarks.length === KEYPOINT_NAMES.length;
  const value = {
    schema_version: POSE_FRAME_SCHEMA,
    room_session_id: roomSessionId,
    runtime_session_id: runtimeSessionId,
    frame_sequence: frameSequence,
    timestamp_ms: timestampMs,
    source_width: sourceWidth,
    source_height: sourceHeight,
    person_detected: personDetected,
    landmark_quality: personDetected && (landmarkQuality === "usable" || landmarkQuality === "degraded")
      ? landmarkQuality
      : "unavailable",
    keypoints: personDetected ? KEYPOINT_NAMES.map((name, index) => ({
      name,
      x: Number(landmarks[index]?.x),
      y: Number(landmarks[index]?.y),
      score: Number(landmarks[index]?.score),
    })) : [],
  };
  if (!validatePoseFrame(value, roomSessionId, runtimeSessionId)) {
    throw new TypeError("无效的 17 点 pose frame");
  }
  return value;
}

export function validatePoseFrame(value, roomSessionId, runtimeSessionId) {
  if (!exactKeys(value, [
    "schema_version",
    "room_session_id",
    "runtime_session_id",
    "frame_sequence",
    "timestamp_ms",
    "source_width",
    "source_height",
    "person_detected",
    "landmark_quality",
    "keypoints",
  ])) return false;
  if (
    value.schema_version !== POSE_FRAME_SCHEMA
    || value.room_session_id !== roomSessionId
    || value.runtime_session_id !== runtimeSessionId
    || !isNonNegativeInteger(value.frame_sequence)
    || !isFiniteNonNegative(value.timestamp_ms)
    || !Number.isSafeInteger(value.source_width)
    || value.source_width <= 0
    || value.source_width > 16_384
    || !Number.isSafeInteger(value.source_height)
    || value.source_height <= 0
    || value.source_height > 16_384
    || typeof value.person_detected !== "boolean"
    || !Array.isArray(value.keypoints)
  ) return false;
  if (!value.person_detected) {
    return value.landmark_quality === "unavailable" && value.keypoints.length === 0;
  }
  return (value.landmark_quality === "usable" || value.landmark_quality === "degraded")
    && value.keypoints.length === KEYPOINT_NAMES.length
    && value.keypoints.every((point, index) => (
      exactKeys(point, ["name", "x", "y", "score"])
      && point.name === KEYPOINT_NAMES[index]
      && isUnitNumber(point.x)
      && isUnitNumber(point.y)
      && isUnitNumber(point.score)
    ))
    && !containsForbiddenRawMedia(value);
}

function validateCommandBody(value) {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.name === "select_scene") {
    return exactKeys(value, ["name", "scene_id"]) && SCENE_IDS.has(value.scene_id);
  }
  if (value.name === "select_source") {
    return exactKeys(value, ["name", "source_id"]) && isId(value.source_id);
  }
  if (["start_capture", "stop_capture", "reset_demo"].includes(value.name)) {
    return exactKeys(value, ["name"]);
  }
  if (value.name === "run_demo_scenario") {
    return exactKeys(value, ["name", "scenario"])
      && (value.scenario === "normal" || value.scenario === "fall");
  }
  if (value.name === "start_conversation") {
    return exactKeys(value, ["name", "scenario"])
      && (value.scenario === "proactive_check_in" || value.scenario === "kitchen_share");
  }
  if (value.name === "submit_response") {
    return exactKeys(value, ["name", "decision_id", "response"])
      && isId(value.decision_id)
      && ["safe", "need_help", "consent_granted", "consent_denied"].includes(value.response);
  }
  if (value.name === "confirm_alarm" || value.name === "replay_voice") {
    return exactKeys(value, ["name", "decision_id"]) && isId(value.decision_id);
  }
  return false;
}

export function validateControlCommand(value) {
  return exactKeys(value, [
    "schema_version",
    "room_session_id",
    "command_id",
    "command_sequence",
    "issued_at_ms",
    "expires_at_ms",
    "expected_state_revision",
    "command",
  ])
    && value.schema_version === CONTROL_COMMAND_SCHEMA
    && isId(value.room_session_id)
    && isId(value.command_id)
    && isNonNegativeInteger(value.command_sequence)
    && value.command_sequence > 0
    && isFiniteNonNegative(value.issued_at_ms)
    && isFiniteNonNegative(value.expires_at_ms)
    && value.expires_at_ms > value.issued_at_ms
    && isNonNegativeInteger(value.expected_state_revision)
    && validateCommandBody(value.command)
    && !containsForbiddenRawMedia(value);
}

export function createExactControlAck({
  roomSessionId,
  commandId,
  phase,
  timestampMs = Date.now(),
  stateRevision = null,
  reason = null,
}) {
  const value = {
    type: "control_ack",
    room_session_id: roomSessionId,
    command_id: commandId,
    phase,
    timestamp_ms: timestampMs,
    state_revision: stateRevision,
    reason,
  };
  if (
    !isId(roomSessionId)
    || !isId(commandId)
    || !CONTROL_ACK_PHASES.has(phase)
    || !isFiniteNonNegative(timestampMs)
    || (stateRevision !== null && !isNonNegativeInteger(stateRevision))
    || (reason !== null && !isBoundedString(reason, 240))
  ) throw new TypeError("无效的 control_ack");
  if (phase === "applied" && stateRevision === null) {
    throw new TypeError("applied ACK 必须包含 state revision");
  }
  return value;
}

function validMediaSignal(value, forwarded = false) {
  const keys = [
    "schema_version",
    "room_session_id",
    "grant_id",
    "target_id",
    "signal_type",
    "signal",
  ];
  if (forwarded) keys.push("from_id");
  if (!exactKeys(value, keys)) return false;
  if (
    value.schema_version !== MEDIA_SIGNAL_SCHEMA
    || !isId(value.room_session_id)
    || !isId(value.grant_id)
    || !(value.target_id === "monitor" || isId(value.target_id))
    || (forwarded && !isId(value.from_id))
  ) return false;
  if (value.signal_type === "offer" || value.signal_type === "answer") {
    return exactKeys(value.signal, ["type", "sdp"])
      && value.signal.type === value.signal_type
      && isBoundedString(value.signal.sdp, 12_000)
      && !containsForbiddenRawMedia(value);
  }
  return value.signal_type === "ice_candidate"
    && exactKeys(value.signal, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
    && isBoundedString(value.signal.candidate, 4_096, true)
    && (value.signal.sdpMid === null || isBoundedString(value.signal.sdpMid, 128, true))
    && (value.signal.sdpMLineIndex === null || isNonNegativeInteger(value.signal.sdpMLineIndex))
    && (value.signal.usernameFragment === null
      || isBoundedString(value.signal.usernameFragment, 256, true))
    && !containsForbiddenRawMedia(value);
}

export function validateForwardedMediaSignal(value) {
  return validMediaSignal(value, true);
}

function validateMediaGrant(value) {
  if (!exactKeys(value, ["type", "room_session_id", "grant", "audience", "reason"])) return false;
  if (
    value.type !== "media_grant"
    || !isId(value.room_session_id)
    || value.audience !== "all_viewers"
    || (value.reason !== null && !isBoundedString(value.reason, 240))
    || (value.reason !== null && !isBoundedString(value.reason, 240))
    || !exactKeys(value.grant, ["grant_id", "event_id", "scope", "expires_at_ms", "status"])
  ) return false;
  return isId(value.grant.grant_id)
    && isId(value.grant.event_id)
    && (value.grant.scope === "kitchen_moment" || value.grant.scope === "fall_emergency")
    && isFiniteNonNegative(value.grant.expires_at_ms)
    && ["active", "revoked", "expired"].includes(value.grant.status);
}

function validViewerCounts(viewerCount, maxViewers) {
  return isNonNegativeInteger(viewerCount)
    && maxViewers === 5
    && viewerCount <= maxViewers;
}

function parseRelayMessage(data) {
  if (typeof data !== "string") return { type: "protocol_error", code: "binary_message_rejected" };
  if (new TextEncoder().encode(data).byteLength > MAX_RELAY_JSON_BYTES) {
    return { type: "protocol_error", code: "message_too_large" };
  }
  try {
    const value = JSON.parse(data);
    return containsForbiddenRawMedia(value)
      ? { type: "protocol_error", code: "raw_media_rejected" }
      : value;
  } catch {
    return { type: "protocol_error", code: "invalid_json" };
  }
}

function serializeRelayMessage(value) {
  if (containsForbiddenRawMedia(value)) throw new TypeError("Relay 禁止发送原始媒体数据");
  const message = JSON.stringify(value);
  if (new TextEncoder().encode(message).byteLength > MAX_RELAY_JSON_BYTES) {
    throw new RangeError("Relay 消息超过 16 KiB");
  }
  return message;
}

export function createLatestPublicationQueue(send, canSend = () => true) {
  let roomSessionId = null;
  let runtimeSessionId = null;
  let latestState = null;
  let latestPose = null;
  let stateInFlight = null;
  let poseInFlight = null;
  let acceptedStateRevision = -1;
  let acceptedPoseSequence = -1;

  function drain() {
    if (!canSend()) return;
    if (
      latestState
      && stateInFlight === null
      && latestState.state_revision > acceptedStateRevision
    ) {
      stateInFlight = latestState.state_revision;
      send(latestState);
      return;
    }
    if (
      latestPose
      && poseInFlight === null
      && acceptedStateRevision >= 0
      && latestPose.frame_sequence > acceptedPoseSequence
    ) {
      poseInFlight = latestPose.frame_sequence;
      send(latestPose);
    }
  }

  return Object.freeze({
    reset(nextRoomSessionId, nextRuntimeSessionId) {
      roomSessionId = nextRoomSessionId;
      runtimeSessionId = nextRuntimeSessionId;
      latestState = null;
      latestPose = null;
      stateInFlight = null;
      poseInFlight = null;
      acceptedStateRevision = -1;
      acceptedPoseSequence = -1;
    },
    transportInterrupted() {
      // An ACK may have been lost. Keep the last accepted cursors unchanged and
      // retry the exact in-flight value after reconnect; Relay treats exact
      // duplicate state/pose publications idempotently.
      stateInFlight = null;
      poseInFlight = null;
    },
    offerState(value) {
      if (!validateDemoStateEnvelope(value, roomSessionId)) return false;
      const runtimeChanged = runtimeSessionId !== null
        && value.runtime_session_id !== runtimeSessionId;
      if (runtimeChanged) {
        latestState = null;
        stateInFlight = null;
        acceptedStateRevision = -1;
        latestPose = null;
        poseInFlight = null;
        acceptedPoseSequence = -1;
      }
      runtimeSessionId = value.runtime_session_id;
      if (latestState === null || value.state_revision > latestState.state_revision) {
        latestState = value;
      }
      drain();
      return true;
    },
    offerPose(value) {
      if (!validatePoseFrame(value, roomSessionId, runtimeSessionId)) return false;
      if (latestPose === null || value.frame_sequence > latestPose.frame_sequence) {
        latestPose = value;
      }
      drain();
      return true;
    },
    acceptState(revision) {
      if (!isNonNegativeInteger(revision)) return;
      acceptedStateRevision = Math.max(acceptedStateRevision, revision);
      if (stateInFlight !== null && revision >= stateInFlight) stateInFlight = null;
      drain();
    },
    acceptPose(sequence) {
      if (!isNonNegativeInteger(sequence)) return;
      acceptedPoseSequence = Math.max(acceptedPoseSequence, sequence);
      if (poseInFlight !== null && sequence >= poseInFlight) poseInFlight = null;
      drain();
    },
    drain,
    snapshot() {
      return {
        roomSessionId,
        runtimeSessionId,
        latestStateRevision: latestState?.state_revision ?? null,
        latestPoseSequence: latestPose?.frame_sequence ?? null,
        stateInFlight,
        poseInFlight,
        acceptedStateRevision,
        acceptedPoseSequence,
      };
    },
  });
}

function initialSnapshot(relayUrl) {
  return Object.freeze({
    relayUrl,
    status: relayUrl ? "idle" : "unconfigured",
    roomName: "shared-live-demo",
    roomSessionId: null,
    producerLeaseExpiresAtMs: null,
    viewerCount: 0,
    maxViewers: 5,
    controller: null,
    connectionGeneration: 0,
    error: relayUrl ? null : "Relay URL 未配置",
    lastProtocolError: null,
    acceptedStateRevision: -1,
    serverTimeOffsetMs: 0,
  });
}

function defaultTimerApi() {
  return {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

export function createMonitorRelayClient({
  relayUrl,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  claimStore = createSessionClaimStore(),
  timerApi = defaultTimerApi(),
  now = () => Date.now(),
  onCommand = null,
  onMediaGrant = null,
  onMediaSignal = null,
  onEvent = null,
} = {}) {
  let snapshot = initialSnapshot(relayUrl || "");
  let desiredActive = false;
  let claim = null;
  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let generation = 0;
  let controlGeneration = 0;
  let controlRevocationPending = false;
  let commandChain = Promise.resolve();
  let callbacks = { onCommand, onMediaGrant, onMediaSignal, onEvent };
  const listeners = new Set();
  const handledCommands = new Map();
  const appliedAcks = new Map();
  const endpoints = relayUrl ? resolveMonitorRelayEndpoints(relayUrl) : null;

  function emitEvent(event) {
    callbacks.onEvent?.(event);
  }

  function update(values) {
    snapshot = Object.freeze({ ...snapshot, ...values });
    for (const listener of listeners) listener(snapshot);
  }

  function socketOpen() {
    return socket?.readyState === 1;
  }

  function relayNow() {
    return now() + (snapshot.serverTimeOffsetMs || 0);
  }

  function canPublish() {
    return snapshot.status === "connected"
      && socketOpen()
      && (socket.bufferedAmount || 0) <= MAX_SOCKET_BUFFER_BYTES;
  }

  function send(value) {
    if (!socketOpen()) return false;
    try {
      socket.send(serializeRelayMessage(value));
      return true;
    } catch {
      return false;
    }
  }

  const publications = createLatestPublicationQueue(send, canPublish);

  function flushAppliedAcks() {
    if (!canPublish()) return;
    const acceptedRevision = publications.snapshot().acceptedStateRevision;
    for (const entry of appliedAcks.values()) {
      if (
        entry.ack.state_revision <= acceptedRevision
        && entry.sentGeneration !== generation
        && send(entry.ack)
      ) entry.sentGeneration = generation;
    }
  }

  function clearTimers() {
    if (heartbeatTimer !== null) timerApi.clearInterval(heartbeatTimer);
    if (reconnectTimer !== null) timerApi.clearTimeout(reconnectTimer);
    heartbeatTimer = null;
    reconnectTimer = null;
  }

  function closeSocket(code = 1000, reason = "monitor_stopped") {
    const previous = socket;
    socket = null;
    publications.transportInterrupted();
    if (previous && previous.readyState < 2) previous.close(code, reason);
  }

  function heartbeat() {
    if (!claim || !socketOpen()) return;
    send({ type: "monitor_heartbeat", room_session_id: claim.room_session_id });
    publications.drain();
    flushAppliedAcks();
  }

  function beginHeartbeat() {
    if (heartbeatTimer !== null) timerApi.clearInterval(heartbeatTimer);
    heartbeatTimer = timerApi.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleReconnect(delayMs = 500) {
    if (!desiredActive || reconnectTimer !== null) return;
    reconnectTimer = timerApi.setTimeout(() => {
      reconnectTimer = null;
      if (!desiredActive) return;
      if (claim?.expires_at_ms > relayNow()) void connect(claim, true);
      else void start(true);
    }, delayMs);
  }

  function rememberHandledCommand(commandId, phase = "received") {
    handledCommands.set(commandId, phase);
    if (handledCommands.size > 64) handledCommands.delete(handledCommands.keys().next().value);
  }

  function sendControlAck(parameters) {
    if (!claim) return false;
    const ack = createExactControlAck({
      roomSessionId: claim.room_session_id,
      timestampMs: parameters.timestampMs ?? relayNow(),
      ...parameters,
    });
    rememberHandledCommand(ack.command_id, ack.phase);
    if (ack.phase === "applied") {
      appliedAcks.set(ack.command_id, { ack, sentGeneration: -1 });
      if (appliedAcks.size > 64) appliedAcks.delete(appliedAcks.keys().next().value);
      flushAppliedAcks();
      return true;
    }
    return send(ack);
  }

  async function dispatchCommand(command, expectedControlGeneration) {
    if (!claim || command.room_session_id !== claim.room_session_id) return;
    if (expectedControlGeneration !== controlGeneration) return;
    if (handledCommands.has(command.command_id)) return;
    rememberHandledCommand(command.command_id);
    if (command.expires_at_ms <= relayNow()) {
      sendControlAck({
        commandId: command.command_id,
        phase: "rejected",
        stateRevision: null,
        reason: "command_expired",
      });
      return;
    }
    try {
      const result = await callbacks.onCommand?.(command);
      if (expectedControlGeneration !== controlGeneration) return;
      if (result?.phase) {
        sendControlAck({
          commandId: command.command_id,
          phase: result.phase,
          stateRevision: result.stateRevision ?? null,
          reason: result.reason ?? result.code ?? null,
        });
      }
    } catch (error) {
      if (expectedControlGeneration !== controlGeneration) return;
      sendControlAck({
        commandId: command.command_id,
        phase: "failed",
        stateRevision: null,
        reason: isBoundedString(error?.code, 240) ? error.code : "monitor_command_failed",
      });
    }
  }

  function handleMessage(event, connectionGeneration) {
    if (generation !== connectionGeneration || event.currentTarget !== socket) return;
    const value = parseRelayMessage(event.data);
    if (value.type === "monitor_ready") {
      if (!exactKeys(value, [
        "type",
        "room_name",
        "room_session_id",
        "expires_at_ms",
        "viewer_count",
        "max_viewers",
        "controller",
        "heartbeat_interval_ms",
        "server_time_ms",
      ]) || value.room_name !== "shared-live-demo" || value.room_session_id !== claim?.room_session_id
        || !isFiniteNonNegative(value.expires_at_ms)
        || !validViewerCounts(value.viewer_count, value.max_viewers)
        || value.heartbeat_interval_ms !== HEARTBEAT_INTERVAL_MS
        || !isFiniteNonNegative(value.server_time_ms)
        || !validController(value.controller)) {
        update({
          status: "reconnecting",
          lastProtocolError: "invalid_monitor_ready",
          error: "Relay monitor_ready 协议不匹配",
        });
        closeSocket(1008, "invalid_monitor_ready");
        scheduleReconnect();
        return;
      }
      claim = Object.freeze({ ...claim, expires_at_ms: value.expires_at_ms });
      claimStore.save(claim);
      update({
        status: "connected",
        roomName: value.room_name,
        roomSessionId: value.room_session_id,
        producerLeaseExpiresAtMs: value.expires_at_ms,
        viewerCount: value.viewer_count,
        maxViewers: value.max_viewers,
        controller: value.controller,
        serverTimeOffsetMs: value.server_time_ms - now(),
        error: null,
      });
      beginHeartbeat();
      emitEvent({ type: "needs_state", roomSessionId: value.room_session_id, connectionGeneration });
      publications.drain();
      flushAppliedAcks();
      return;
    }
    if (value.type === "viewer_presence") {
      if (exactKeys(value, [
        "type", "room_session_id", "viewer_count", "max_viewers", "monitor_online", "server_time_ms",
      ])
        && value.room_session_id === claim?.room_session_id
        && validViewerCounts(value.viewer_count, value.max_viewers)
        && typeof value.monitor_online === "boolean"
        && isFiniteNonNegative(value.server_time_ms)) {
        update({ viewerCount: value.viewer_count, maxViewers: value.max_viewers });
      }
      return;
    }
    if (value.type === "controller_status") {
      if (exactKeys(value, ["type", "room_session_id", "controller", "server_time_ms"])
        && value.room_session_id === claim?.room_session_id
        && validController(value.controller)
        && isFiniteNonNegative(value.server_time_ms)) {
        if (controlRevocationPending && value.controller === null) {
          controlRevocationPending = false;
        }
        update({ controller: value.controller });
      }
      return;
    }
    if (value.type === "monitor_heartbeat_ack") {
      if (exactKeys(value, ["type", "room_session_id", "expires_at_ms"])
        && value.room_session_id === claim?.room_session_id
        && isFiniteNonNegative(value.expires_at_ms)) {
        claim = Object.freeze({ ...claim, expires_at_ms: value.expires_at_ms });
        claimStore.save(claim);
        update({ producerLeaseExpiresAtMs: value.expires_at_ms });
      }
      return;
    }
    if (value.type === "state_accepted") {
      if (exactKeys(value, ["type", "room_session_id", "state_revision"])
        && value.room_session_id === claim?.room_session_id
        && isNonNegativeInteger(value.state_revision)) {
        publications.acceptState(value.state_revision);
        update({
          acceptedStateRevision: Math.max(
            snapshot.acceptedStateRevision,
            value.state_revision,
          ),
        });
        flushAppliedAcks();
      }
      return;
    }
    if (value.type === "pose_accepted") {
      if (exactKeys(value, ["type", "room_session_id", "frame_sequence"])
        && value.room_session_id === claim?.room_session_id
        && isNonNegativeInteger(value.frame_sequence)) {
        publications.acceptPose(value.frame_sequence);
      }
      return;
    }
    if (validateControlCommand(value)) {
      if (value.room_session_id === claim?.room_session_id && !controlRevocationPending) {
        const commandGeneration = generation;
        const commandControlGeneration = controlGeneration;
        commandChain = commandChain.catch(() => undefined).then(() => {
          if (commandGeneration !== generation
            || commandControlGeneration !== controlGeneration) return undefined;
          return dispatchCommand(value, commandControlGeneration);
        });
      }
      return;
    }
    if (validateMediaGrant(value)) {
      if (value.room_session_id === claim?.room_session_id) callbacks.onMediaGrant?.(value);
      return;
    }
    if (validateForwardedMediaSignal(value)) {
      if (value.room_session_id === claim?.room_session_id && value.target_id === "monitor") {
        callbacks.onMediaSignal?.(value);
      }
      return;
    }
    if (value.type === "protocol_error" && exactKeys(value, ["type", "code"])
      && isBoundedString(value.code, 240)) {
      update({ lastProtocolError: value.code });
      emitEvent(value);
      return;
    }
    emitEvent({ type: "ignored_relay_message" });
  }

  function connect(nextClaim, reconnecting = false) {
    if (typeof WebSocketImpl !== "function") {
      update({ status: "error", error: "WebSocket 不可用" });
      return Promise.resolve(false);
    }
    generation += 1;
    const connectionGeneration = generation;
    clearTimers();
    closeSocket(1000, "connection_replaced");
    claim = nextClaim;
    controlRevocationPending = false;
    const roomChanged = snapshot.roomSessionId !== claim.room_session_id;
    if (roomChanged) {
      publications.reset(claim.room_session_id, null);
      handledCommands.clear();
      appliedAcks.clear();
    }
    update({
      status: reconnecting ? "reconnecting" : "connecting",
      roomSessionId: claim.room_session_id,
      producerLeaseExpiresAtMs: claim.expires_at_ms,
      connectionGeneration,
      ...(roomChanged ? { acceptedStateRevision: -1 } : {}),
      error: null,
    });
    return new Promise((resolve) => {
      let settled = false;
      const nextSocket = new WebSocketImpl(endpoints.monitorWsUrl, [
        MONITOR_PROTOCOL,
        `${TOKEN_PROTOCOL_PREFIX}${claim.producer_token}`,
      ]);
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };
      nextSocket.onmessage = (event) => handleMessage(event, connectionGeneration);
      nextSocket.onerror = () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        update({ error: "Relay WebSocket 连接失败" });
      };
      nextSocket.onclose = () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        socket = null;
        publications.transportInterrupted();
        claimStore.clear();
        claim = null;
        if (heartbeatTimer !== null) timerApi.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        callbacks.onMediaGrant?.(null);
        update({ status: desiredActive ? "reconnecting" : "idle", controller: null });
        emitEvent({ type: "relay_disconnected", connectionGeneration });
        if (!settled) {
          settled = true;
          resolve(false);
        }
        scheduleReconnect();
      };
    });
  }

  async function start(reconnecting = false) {
    if (!relayUrl || !endpoints) {
      update({ status: "unconfigured", error: "Relay URL 未配置" });
      return false;
    }
    if (
      !reconnecting
      && desiredActive
      && ["claiming", "connecting", "connected", "reconnecting"].includes(snapshot.status)
    ) return true;
    desiredActive = true;
    update({ status: reconnecting ? "reconnecting" : "claiming", error: null });
    try {
      // Reloading the page also resets its monotonic state cursor. Reusing a
      // stored token could reconnect to an older room revision and permanently
      // conflict, so every explicit start obtains a fresh room session.
      claim = await claimMonitor(relayUrl, fetchImpl);
      claimStore.save(claim);
      return connect(claim, reconnecting);
    } catch (error) {
      update({
        status: error?.code === "monitor_busy" ? "busy" : "error",
        error: error?.message || "Relay claim 失败",
      });
      if (desiredActive && isFiniteNonNegative(error?.retryAfterMs)) {
        scheduleReconnect(Math.max(250, error.retryAfterMs + 50));
      }
      return false;
    }
  }

  function stop({ release = true } = {}) {
    desiredActive = false;
    clearTimers();
    if (release && claim && socketOpen()) {
      send({ type: "monitor_release", room_session_id: claim.room_session_id });
    }
    generation += 1;
    closeSocket(1000, "monitor_stopped");
    claimStore.clear();
    claim = null;
    publications.reset(null, null);
    handledCommands.clear();
    appliedAcks.clear();
    update({
      ...initialSnapshot(relayUrl || ""),
      connectionGeneration: generation,
    });
  }

  function publishState(value) {
    if (!claim) return false;
    const previousRuntimeSessionId = publications.snapshot().runtimeSessionId;
    const offered = publications.offerState({ ...value, timestamp_ms: relayNow() });
    if (
      offered
      && previousRuntimeSessionId !== null
      && previousRuntimeSessionId !== value.runtime_session_id
    ) update({ acceptedStateRevision: -1 });
    return offered;
  }

  function publishPose(value) {
    return claim ? publications.offerPose({ ...value, timestamp_ms: relayNow() }) : false;
  }

  function requestMediaGrant({ runtimeSessionId, eventId, scope, expiresInMs }) {
    if (!claim || !isId(runtimeSessionId) || !isId(eventId)) return false;
    const maximum = scope === "kitchen_moment" ? 60_000 : scope === "fall_emergency" ? 30_000 : 0;
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > maximum) {
      return false;
    }
    return send({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: runtimeSessionId,
      event_id: eventId,
      scope,
      expires_in_ms: expiresInMs,
    });
  }

  function revokeMediaGrant(grantId) {
    return Boolean(claim && isId(grantId) && send({
      type: "media_grant_revoke",
      room_session_id: claim.room_session_id,
      grant_id: grantId,
    }));
  }

  function revokeControl() {
    const sent = Boolean(claim && send({
      type: "control_revoke",
      room_session_id: claim.room_session_id,
    }));
    if (sent) {
      controlGeneration += 1;
      controlRevocationPending = true;
    }
    return sent;
  }

  function sendMediaSignal(value) {
    if (!claim || !validMediaSignal(value, false)) return false;
    if (value.room_session_id !== claim.room_session_id || value.target_id === "monitor") return false;
    return send(value);
  }

  return Object.freeze({
    start,
    stop,
    publishState,
    publishPose,
    sendControlAck,
    requestMediaGrant,
    revokeMediaGrant,
    revokeControl,
    sendMediaSignal,
    setCallbacks(next = {}) {
      callbacks = {
        onCommand: next.onCommand ?? null,
        onMediaGrant: next.onMediaGrant ?? null,
        onMediaSignal: next.onMediaSignal ?? null,
        onEvent: next.onEvent ?? null,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getPublicationSnapshot: () => publications.snapshot(),
  });
}

export const monitorRelayProtocol = Object.freeze({
  monitorProtocol: MONITOR_PROTOCOL,
  demoStateSchema: DEMO_STATE_SCHEMA,
  poseFrameSchema: POSE_FRAME_SCHEMA,
  controlCommandSchema: CONTROL_COMMAND_SCHEMA,
  mediaSignalSchema: MEDIA_SIGNAL_SCHEMA,
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  maxJsonBytes: MAX_RELAY_JSON_BYTES,
});
