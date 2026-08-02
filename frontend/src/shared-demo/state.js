export function createViewerState() {
  return {
    connection: "connecting",
    frame: null,
    receivedAtMs: null,
    rejectedFrames: 0,
  };
}

export const VIEWER_STALE_AFTER_MS = 2500;

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
      return { ...state, connection: "disconnected" };
    case "invalid_frame":
      return { ...state, rejectedFrames: state.rejectedFrames + 1 };
    case "frame": {
      const previous = state.frame;
      if (
        previous
        && previous.session_id === action.frame.session_id
        && action.frame.sequence <= previous.sequence
      ) {
        return state;
      }
      return {
        ...state,
        connection: "connected",
        frame: action.frame,
        receivedAtMs: action.receivedAtMs,
      };
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
    default:
      return state;
  }
}
