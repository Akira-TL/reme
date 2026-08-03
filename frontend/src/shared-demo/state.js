import {
  FRAME_SCHEMA_VERSION,
  POSE_BATCH_SCHEMA_VERSION,
  POSE_PROJECTION_RESET_SCHEMA_VERSION,
} from "./protocol.js";

export function createViewerState() {
  return {
    connection: "connecting",
    viewerId: null,
    sessionId: null,
    frame: null,
    poseMode: null,
    lastFrameSequence: null,
    receivedAtMs: null,
    eventSequence: null,
    eventReceivedAtMs: null,
    scene: null,
    activity: null,
    activityEventSequence: null,
    careCard: null,
    alarm: null,
    mediaGrant: null,
    rejectedFrames: 0,
  };
}

export const VIEWER_STALE_AFTER_MS = 2500;
export const DEFAULT_VIEWER_SCENE = Object.freeze({
  scene_id: "living",
  visual_mode: "abstract_environment",
});

function resetViewerSession(state, sessionId) {
  return {
    ...state,
    sessionId,
    frame: null,
    poseMode: null,
    lastFrameSequence: null,
    receivedAtMs: null,
    eventSequence: null,
    eventReceivedAtMs: null,
    scene: null,
    activity: null,
    activityEventSequence: null,
    careCard: null,
    alarm: null,
    mediaGrant: null,
  };
}

export function selectViewerScene(state) {
  return state.scene || DEFAULT_VIEWER_SCENE;
}

export function selectActiveMediaGrant(state, nowMs) {
  const grant = state.mediaGrant;
  if (
    state.connection !== "connected"
    || !state.viewerId
    || !grant
    || grant.status !== "active"
    || grant.expires_at_ms <= nowMs
    || (
      Number.isFinite(grant.received_at_ms)
      && Number.isFinite(grant.server_ttl_ms)
      && grant.received_at_ms + grant.server_ttl_ms <= nowMs
    )
  ) {
    return null;
  }

  const scene = selectViewerScene(state);
  if (scene.scene_id === "bathroom" || scene.visual_mode === "skeleton_only") return null;

  if (grant.scope === "fall_emergency") {
    const alarm = state.alarm;
    return scene.scene_id === "fall"
      && alarm
      && alarm.event_id === grant.event_id
      && alarm.phase === "escalated"
      && alarm.media_scope === "fall_emergency"
      ? grant
      : null;
  }

  if (grant.scope === "kitchen_moment") {
    const activity = state.activity;
    return scene.scene_id === "kitchen"
      && activity
      && activity.phase === "confirmed"
      && activity.source === "mimo_visual"
      && Number.isSafeInteger(state.activityEventSequence)
      && grant.event_id === `activity-${state.activityEventSequence}`
      ? grant
      : null;
  }

  return null;
}

export function selectViewerPresentation(
  state,
  nowMs,
  staleAfterMs = VIEWER_STALE_AFTER_MS,
) {
  if (!state.frame || state.receivedAtMs == null) {
    return { kind: "waiting", ageMs: null };
  }
  const ageMs = Math.max(0, nowMs - state.receivedAtMs);
  if (ageMs > staleAfterMs) return { kind: "stale", ageMs };
  if (state.frame.schema_version === POSE_PROJECTION_RESET_SCHEMA_VERSION) {
    return { kind: "waiting", ageMs };
  }
  if (Array.isArray(state.frame.poses)) {
    if (state.frame.poses.length === 0) return { kind: "unavailable", ageMs };
    if (state.frame.poses.some((pose) => pose.landmark_quality === "degraded")) {
      return { kind: "degraded", ageMs };
    }
    return { kind: "live", ageMs };
  }
  if (!state.frame.person_detected || state.frame.landmark_quality === "unavailable") {
    return { kind: "unavailable", ageMs };
  }
  if (state.frame.landmark_quality === "degraded") {
    return { kind: "degraded", ageMs };
  }
  return { kind: "live", ageMs };
}

export function reduceViewerState(state, action) {
  switch (action.type) {
    case "connecting":
      return { ...state, connection: "connecting" };
    case "connected":
      return { ...state, connection: "connected" };
    case "disconnected":
      return {
        ...state,
        connection: "disconnected",
        frame: null,
        receivedAtMs: null,
        mediaGrant: null,
      };
    case "viewer_ready":
      return { ...state, viewerId: action.viewerId };
    case "invalid_frame":
      return { ...state, rejectedFrames: state.rejectedFrames + 1 };
    case "frame": {
      const base = state.sessionId && state.sessionId !== action.frame.session_id
        ? resetViewerSession(state, action.frame.session_id)
        : { ...state, sessionId: action.frame.session_id };
      if (
        base.lastFrameSequence !== null
        && action.frame.sequence <= base.lastFrameSequence
      ) {
        return state;
      }
      return {
        ...base,
        connection: "connected",
        frame: action.frame,
        lastFrameSequence: action.frame.sequence,
        poseMode: action.frame.schema_version === POSE_BATCH_SCHEMA_VERSION
          ? "multi"
          : action.frame.schema_version === FRAME_SCHEMA_VERSION
            ? "single"
            : action.frame.pose_mode,
        receivedAtMs: action.receivedAtMs,
      };
    }
    case "pose_projection_unavailable": {
      const message = action.message;
      if (state.sessionId && state.sessionId !== message.session_id) return state;
      const base = { ...state, sessionId: message.session_id };
      if (
        base.frame
        && base.frame.session_id === message.session_id
        && base.frame.sequence > message.through_sequence
      ) {
        return state;
      }
      return {
        ...base,
        connection: "connected",
        frame: null,
        poseMode: message.pose_mode,
        receivedAtMs: null,
      };
    }
    case "demo_event": {
      const event = action.event;
      const base = state.sessionId && state.sessionId !== event.session_id
        ? resetViewerSession(state, event.session_id)
        : { ...state, sessionId: event.session_id };
      if (base.eventSequence !== null && event.event_sequence <= base.eventSequence) {
        return state;
      }

      const next = {
        ...base,
        connection: "connected",
        eventSequence: event.event_sequence,
        eventReceivedAtMs: action.receivedAtMs,
      };
      if (event.event_type === "scene_state") next.scene = event.payload;
      if (event.event_type === "activity_state") {
        next.activity = event.payload;
        next.activityEventSequence = event.event_sequence;
      }
      if (event.event_type === "care_card") next.careCard = event.payload;
      if (event.event_type === "alarm_state") next.alarm = event.payload;
      if (event.event_type === "media_grant") {
        if (event.payload.status === "active") {
          next.mediaGrant = {
            ...event.payload,
            received_at_ms: action.receivedAtMs,
            server_ttl_ms: Math.max(0, event.payload.expires_at_ms - event.timestamp_ms),
          };
        } else if (next.mediaGrant?.grant_id === event.payload.grant_id) {
          next.mediaGrant = event.payload;
        }
      }
      return next;
    }
    default:
      return state;
  }
}

export function createMonitorState() {
  return {
    phase: "locked",
    connection: "idle",
    sessionId: null,
    captureActive: false,
    error: null,
  };
}

export function reduceMonitorState(state, action) {
  switch (action.type) {
    case "unlocking":
      return { ...state, phase: "unlocking", error: null };
    case "unlocked":
      return {
        ...state,
        phase: "ready",
        connection: "connecting",
        sessionId: action.sessionId,
        error: null,
      };
    case "controller_connecting":
      return { ...state, connection: "connecting" };
    case "controller_connected":
      return {
        ...state,
        phase: state.captureActive ? "live" : "ready",
        connection: "connected",
        error: null,
      };
    case "starting":
      return { ...state, phase: "starting", error: null };
    case "live":
      return { ...state, phase: "live", captureActive: true, error: null };
    case "capture_stopped":
      return {
        ...state,
        phase: state.connection === "connected" ? "ready" : "degraded",
        captureActive: false,
        error: state.connection === "connected" ? null : state.error,
      };
    case "degraded":
      return {
        ...state,
        phase: state.phase === "locked" ? "locked" : "degraded",
        connection: action.connection ?? state.connection,
        captureActive: action.captureActive ?? state.captureActive,
        error: action.error || "同步链路不可用",
      };
    case "released":
      return createMonitorState();
    case "session_expired":
      return {
        ...createMonitorState(),
        error: action.error || "短期控制会话已失效",
      };
    default:
      return state;
  }
}
