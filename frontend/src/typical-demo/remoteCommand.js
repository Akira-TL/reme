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
    case "confirm_alarm":
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

  if (["submit_response", "confirm_alarm", "replay_voice"].includes(command.name)) {
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
  code,
  stateRevision,
  runtimeSessionId = null,
  timestampMs = Date.now(),
  detail = null,
}) {
  if (!["received", "awaiting_local_confirmation", ...TERMINAL_PHASES].includes(phase)) {
    throw new TypeError(`unsupported ACK phase: ${phase}`);
  }
  return {
    type: ACK_TYPE,
    room_session_id: roomSessionId,
    command_id: commandId,
    phase,
    code,
    state_revision: stateRevision,
    runtime_session_id: runtimeSessionId,
    timestamp_ms: timestampMs,
    ...(detail ? { detail } : {}),
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
  care,
  mediaGrant,
  timestampMs = Date.now(),
}) {
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
        status: capture?.status || (capture?.active ? "active" : "stopped"),
        source_id: source?.id || null,
        source_kind: source?.kind || null,
        remote_video: source?.remote_video || "unavailable",
        error: capture?.error || "",
      },
      runtime: {
        status: runtime?.state || "offline",
        capability: runtime?.inputMode === "jpeg"
          ? "backend_jpeg_movenet"
          : "unavailable",
        detail: runtime?.reason || "",
      },
      care: {
        phase: care?.phase || "idle",
        decision_id: care?.decisionId || null,
        consent: care?.consent || "none",
        alarm_authoritative: Boolean(care?.alarmAuthoritative),
        message: care?.message || "",
      },
      media_grant: mediaGrant ? {
        grant_id: mediaGrant.grant_id,
        scope: mediaGrant.scope,
        expires_at_ms: mediaGrant.expires_at_ms,
      } : null,
    },
  };
}

export function mediaGrantEligibility({ sceneId, careDecision, now = Date.now() }) {
  if (sceneId === "bathroom") return { allowed: false, code: "bathroom_video_forbidden" };
  if (sceneId === "kitchen") {
    const consented = careDecision?.scene_id === "kitchen"
      && (
        careDecision?.response === "consent_granted"
        || (careDecision?.action === "notify_family" && Boolean(careDecision?.family_notification))
      );
    return consented
      ? { allowed: true, scope: "kitchen_consent", durationMs: 60_000, now }
      : { allowed: false, code: "current_consent_required" };
  }
  if (sceneId === "fall") {
    const escalated = careDecision?.scene_id === "fall"
      && ["family_notification_required", "urgent_attention"].includes(careDecision?.state);
    return escalated
      ? { allowed: true, scope: "fall_escalation", durationMs: 30_000, now }
      : { allowed: false, code: "authoritative_escalation_required" };
  }
  return { allowed: false, code: "event_video_not_available" };
}
