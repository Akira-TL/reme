const COMMAND_SCHEMA = "reme-control-command/v1";
const ACK_TYPE = "control_ack";

const SCENE_IDS = new Set(["living", "kitchen", "bathroom", "fall"]);
const CONVERSATION_SCENARIOS = new Set(["proactive_check_in", "kitchen_share"]);
const DEMO_SCENARIOS = new Set(["normal", "fall"]);
const RESPONSES = new Set(["safe", "need_help", "consent_granted", "consent_denied"]);
const TERMINAL_PHASES = new Set(["applied", "rejected", "failed"]);

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function validId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function validInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function parseControlCommand(value) {
  const topKeys = [
    "schema_version",
    "room_session_id",
    "command_id",
    "command_sequence",
    "issued_at_ms",
    "expires_at_ms",
    "expected_state_revision",
    "command",
  ];
  if (!exactKeys(value, topKeys)) return null;
  if (
    value.schema_version !== COMMAND_SCHEMA
    || !validId(value.room_session_id)
    || !validId(value.command_id)
    || !validInteger(value.command_sequence)
    || value.command_sequence === 0
    || !validInteger(value.issued_at_ms)
    || !validInteger(value.expires_at_ms)
    || value.expires_at_ms <= value.issued_at_ms
    || !validInteger(value.expected_state_revision)
  ) return null;

  const command = value.command;
  if (!isRecord(command) || typeof command.name !== "string") return null;
  switch (command.name) {
    case "select_scene":
      return exactKeys(command, ["name", "scene_id"]) && SCENE_IDS.has(command.scene_id)
        ? value : null;
    case "select_source":
      return exactKeys(command, ["name", "source_id"]) && validId(command.source_id)
        ? value : null;
    case "start_capture":
    case "stop_capture":
    case "reset_demo":
      return exactKeys(command, ["name"]) ? value : null;
    case "run_demo_scenario":
      return exactKeys(command, ["name", "scenario"]) && DEMO_SCENARIOS.has(command.scenario)
        ? value : null;
    case "start_conversation":
      return exactKeys(command, ["name", "scenario"])
        && CONVERSATION_SCENARIOS.has(command.scenario) ? value : null;
    case "submit_response":
      return exactKeys(command, ["name", "decision_id", "response"])
        && validId(command.decision_id)
        && RESPONSES.has(command.response) ? value : null;
    case "acknowledge_alarm":
    case "confirm_alarm":
    case "confirm_action_card":
    case "replay_voice":
      return exactKeys(command, ["name", "decision_id"]) && validId(command.decision_id)
        ? value : null;
    default:
      return null;
  }
}

export function classifyControlCommand(commandEnvelope, context, now = Date.now()) {
  const envelope = parseControlCommand(commandEnvelope);
  if (!envelope) return { disposition: "rejected", code: "invalid_command" };
  if (envelope.room_session_id !== context.roomSessionId) {
    return { disposition: "rejected", code: "stale_room_session" };
  }
  if (envelope.expires_at_ms <= now) {
    return { disposition: "rejected", code: "command_expired" };
  }
  if (envelope.expected_state_revision !== context.stateRevision) {
    return { disposition: "rejected", code: "stale_state_revision" };
  }

  const command = envelope.command;
  const activeSafetyEvent = Boolean(context.activeSafetyEvent);
  if (
    activeSafetyEvent
    && (
      command.name === "reset_demo"
      || command.name === "stop_capture"
      || (command.name === "select_scene" && command.scene_id !== context.sceneId)
    )
  ) {
    return { disposition: "rejected", code: "safety_event_active" };
  }

  if ([
    "submit_response",
    "acknowledge_alarm",
    "confirm_alarm",
    "confirm_action_card",
    "replay_voice",
  ].includes(command.name)) {
    if (!context.decisionId || command.decision_id !== context.decisionId) {
      return { disposition: "rejected", code: "stale_decision" };
    }
  }

  if (command.name === "select_source") {
    const source = context.sources?.find((item) => item.id === command.source_id);
    if (!source || source.disabled_reason) {
      return { disposition: "rejected", code: "source_unavailable" };
    }
    return {
      disposition: "awaiting_local_confirmation",
      code: "local_confirmation_required",
    };
  }
  if (command.name === "start_capture") {
    return {
      disposition: "awaiting_local_confirmation",
      code: "local_confirmation_required",
    };
  }

  return { disposition: "ready", code: "command_ready" };
}

export function createControlAck({
  roomSessionId,
  commandId,
  phase,
  stateRevision = null,
  timestampMs = Date.now(),
  reason = null,
  code = null,
}) {
  if (!["received", "awaiting_local_confirmation", ...TERMINAL_PHASES].includes(phase)) {
    throw new TypeError(`unsupported ACK phase: ${phase}`);
  }
  if (phase === "applied" && !Number.isSafeInteger(stateRevision)) {
    throw new TypeError("applied ACK requires a state revision");
  }
  return {
    type: ACK_TYPE,
    room_session_id: roomSessionId,
    command_id: commandId,
    phase,
    timestamp_ms: timestampMs,
    state_revision: Number.isSafeInteger(stateRevision) ? stateRevision : null,
    reason: reason || code || null,
  };
}

export function buildDemoState({
  roomSessionId,
  runtimeSessionId,
  stateRevision,
  sceneId,
  sourceGeneration = 0,
  source,
  capture,
  runtime,
  decision = null,
  timestampMs = Date.now(),
}) {
  const captureStatus = capture?.status === "ready" || capture?.active
    ? "active"
    : capture?.status === "requesting"
      ? "starting"
      : capture?.status === "error" || capture?.status === "unsupported"
        ? "error"
        : "idle";
  const runtimeStatus = runtime?.state === "running"
    ? "ready"
    : runtime?.state === "starting"
      ? "connecting"
      : ["degraded", "input_unavailable"].includes(runtime?.state)
        ? "degraded"
        : runtime?.state === "error"
          ? "error"
          : "offline";
  const alarmAuthoritative = Boolean(decision?.alarm);
  const carePhase = alarmAuthoritative
    ? "emergency"
    : ["check_in_required", "consent_required"].includes(decision?.state)
      ? "checking"
      : decision?.state === "resolved"
        ? "resolved"
        : "idle";
  const careConsent = decision?.state === "consent_required"
    ? "pending"
    : decision?.state === "resolved"
      && decision?.action === "notify_family"
      && sceneId === "kitchen"
      ? "granted"
      : "none";
  return {
    schema_version: "reme-demo-state/v1",
    room_session_id: roomSessionId,
    runtime_session_id: runtimeSessionId,
    state_revision: stateRevision,
    timestamp_ms: timestampMs,
    state: {
      scene_id: sceneId,
      source_generation: sourceGeneration,
      capture: {
        status: captureStatus,
        source_id: source?.id || null,
        source_kind: source?.kind || null,
        remote_video: source?.remote_video || "unavailable",
        error: capture?.error || null,
      },
      runtime: {
        status: runtimeStatus,
        capability: runtime?.inputMode === "jpeg"
          ? "live"
          : "unavailable",
        detail: runtime?.reason || null,
      },
      care: {
        phase: carePhase,
        decision_id: decision?.decision_id || null,
        consent: careConsent,
        alarm_authoritative: alarmAuthoritative,
        message: decision?.family_notification || null,
      },
      media_grant: null,
    },
  };
}

export function mediaGrantEligibility({
  sceneId,
  runtimeSessionId,
  authorization = null,
  authorizationRuntimeSessionId = null,
  privacyMode = "hidden",
  now = Date.now(),
}) {
  if (sceneId === "bathroom") return { allowed: false, code: "bathroom_video_forbidden" };
  if (!["visible", "blurred"].includes(privacyMode)) {
    return { allowed: false, code: "privacy_mode_forbids_video" };
  }
  if (!authorization || authorization.status !== "active") {
    return { allowed: false, code: "backend_authorization_required" };
  }
  if (authorization.scene_id !== sceneId
    || authorizationRuntimeSessionId !== runtimeSessionId) {
    return { allowed: false, code: "stale_backend_authorization" };
  }
  const remainingMs = authorization.expires_at_ms - now;
  if (remainingMs < 1_000) return { allowed: false, code: "backend_authorization_expired" };
  const expectedScope = sceneId === "kitchen"
    ? "kitchen_moment"
    : sceneId === "fall" ? "fall_emergency" : null;
  if (expectedScope === null || authorization.scope !== expectedScope) {
    return { allowed: false, code: "event_video_not_available" };
  }
  return {
    allowed: true,
    scope: authorization.scope,
    eventId: authorization.decision_id,
    durationMs: Math.min(
      authorization.scope === "kitchen_moment" ? 60_000 : 30_000,
      Math.floor(remainingMs),
    ),
    now,
  };
}
