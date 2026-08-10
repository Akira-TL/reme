import { classifyControlCommand, parseControlCommand } from "./remoteCommand.js";

const REJECT_CODES = new Set([
  "invalid_command",
  "stale_room_session",
  "command_expired",
  "stale_state_revision",
  "controller_lease_ended",
  "stale_decision",
  "safety_event_active",
  "bathroom_video_forbidden",
  "source_unavailable",
]);

function resolveNow(now) {
  return typeof now === "function" ? now() : now;
}

function resolveContext(options) {
  return typeof options.getContext === "function"
    ? options.getContext()
    : options.context;
}

function validateCommandAuthority(envelope, options, expectedDisposition) {
  const context = resolveContext(options);
  if (!context) return null;
  const classification = classifyControlCommand(envelope, context, resolveNow(options.now));
  if (classification.disposition === "rejected") {
    return { phase: "rejected", code: classification.code };
  }
  if (
    Number.isSafeInteger(options.expectedControlGeneration)
    && typeof options.getControlGeneration === "function"
    && options.getControlGeneration() !== options.expectedControlGeneration
  ) {
    return { phase: "rejected", code: "controller_lease_ended" };
  }
  if (classification.disposition !== expectedDisposition) {
    return { phase: "rejected", code: "command_authority_changed" };
  }
  return null;
}

function createExecutionGuard(envelope, options, expectedDisposition) {
  return Object.freeze({
    revalidate() {
      const rejection = validateCommandAuthority(envelope, options, expectedDisposition);
      return rejection
        ? { ok: false, ...rejection }
        : { ok: true, phase: expectedDisposition, code: "command_authority_current" };
    },
  });
}

function normalizeFailure(result, fallbackCode) {
  if (result && typeof result === "object" && result.ok === false) {
    return {
      phase: REJECT_CODES.has(result.code) ? "rejected" : "failed",
      code: result.code || fallbackCode,
      ...(result.authoritativeStateCommitted === true
        ? { authoritativeStateCommitted: true }
        : {}),
    };
  }
  if (result === false || result === null) {
    return { phase: "failed", code: fallbackCode };
  }
  return null;
}

async function runAction(action, args, successCode, failureCode, execution = null) {
  if (typeof action !== "function") {
    return { phase: "failed", code: "command_not_supported" };
  }
  const authority = execution?.revalidate();
  if (authority && !authority.ok) {
    return { phase: authority.phase, code: authority.code };
  }
  try {
    const result = await action(...args, execution);
    const failure = normalizeFailure(result, failureCode);
    return failure || {
      phase: "applied",
      code: result?.code || successCode,
      ...(result?.authoritativeStateCommitted === true
        ? { authoritativeStateCommitted: true }
        : {}),
    };
  } catch (error) {
    return {
      phase: "failed",
      code: error?.code || failureCode,
      detail: error?.message || "命令执行失败",
    };
  }
}

export async function executeMonitorCommand(envelope, options) {
  const {
    actions,
    getActions,
    now = Date.now,
  } = options;
  const context = resolveContext(options) || {};
  const classification = classifyControlCommand(envelope, context, resolveNow(now));
  if (classification.disposition === "rejected") {
    return { phase: "rejected", code: classification.code };
  }
  if (
    Number.isSafeInteger(options.expectedControlGeneration)
    && typeof options.getControlGeneration === "function"
    && options.getControlGeneration() !== options.expectedControlGeneration
  ) {
    return { phase: "rejected", code: "controller_lease_ended" };
  }
  if (classification.disposition === "awaiting_local_confirmation") {
    return {
      phase: "awaiting_local_confirmation",
      code: classification.code,
      pendingCommand: envelope,
    };
  }

  const currentActions = typeof getActions === "function" ? getActions() : actions;
  const execution = createExecutionGuard(envelope, { ...options, now }, "ready");
  const command = envelope.command;
  switch (command.name) {
    case "select_scene":
      return runAction(
        currentActions.selectScene,
        [command.scene_id],
        "scene_selected",
        "scene_switch_failed",
        execution,
      );
    case "stop_capture":
      return runAction(currentActions.stopCapture, [], "capture_stopped", "capture_stop_failed", execution);
    case "run_demo_scenario":
      return runAction(
        currentActions.runDemoScenario,
        [command.scenario],
        "scenario_started",
        "scenario_unavailable",
        execution,
      );
    case "reset_demo":
      return runAction(currentActions.resetDemo, [], "demo_reset", "reset_failed", execution);
    case "start_conversation":
      return runAction(
        currentActions.startConversation,
        [command.scenario],
        "conversation_started",
        "conversation_failed",
        execution,
      );
    case "submit_response":
      return runAction(
        currentActions.submitResponse,
        [command.decision_id, command.response],
        "response_applied",
        "response_failed",
        execution,
      );
    case "acknowledge_alarm":
    case "confirm_alarm":
      return runAction(
        currentActions.confirmAlarm,
        [command.decision_id],
        "alarm_acknowledged",
        "alarm_confirmation_failed",
        execution,
      );
    case "replay_voice":
      return runAction(
        currentActions.replayVoice,
        [command.decision_id],
        "voice_replayed",
        "voice_unavailable",
        execution,
      );
    default:
      return { phase: "rejected", code: "invalid_command" };
  }
}

export async function confirmLocalMonitorCommand(
  envelope,
  actions,
  authorityOrNow = Date.now,
) {
  const authority = typeof authorityOrNow === "object" && authorityOrNow !== null
    ? authorityOrNow
    : { now: authorityOrNow };
  const parsed = parseControlCommand(envelope);
  if (!parsed) return { phase: "rejected", code: "invalid_command" };
  if (parsed.expires_at_ms <= resolveNow(authority.now)) {
    return { phase: "rejected", code: "command_expired" };
  }
  const execution = createExecutionGuard(parsed, authority, "awaiting_local_confirmation");
  const rejection = validateCommandAuthority(
    parsed,
    authority,
    "awaiting_local_confirmation",
  );
  if (rejection) return rejection;
  const command = parsed.command;
  switch (command?.name) {
    case "select_source":
      return runAction(
        actions.selectSource,
        [command.source_id],
        "source_selected",
        "source_selection_failed",
        execution,
      );
    case "start_capture":
      return runAction(
        actions.startCapture,
        [],
        "capture_started",
        "capture_start_failed",
        execution,
      );
    default:
      return { phase: "rejected", code: "local_confirmation_not_required" };
  }
}

export async function switchAndCommitMonitorScene({
  nextScene,
  switchScene,
  commitScene,
  execution = null,
}) {
  const beforeSwitch = execution?.revalidate();
  if (beforeSwitch && !beforeSwitch.ok) {
    return { ok: false, code: beforeSwitch.code };
  }
  try {
    const switched = await switchScene(nextScene);
    const failure = normalizeFailure(switched, "scene_switch_failed");
    if (failure) return { ok: false, code: failure.code };
  } catch (error) {
    return {
      ok: false,
      code: error?.code || "scene_switch_failed",
      detail: error?.message || "场景切换失败",
    };
  }
  // The backend switch is the irreversible authoritative side effect. Once it
  // succeeds, commit that actual scene locally even if the controller lease or
  // expected revision expires while the request is in flight. The stale result
  // prevents a false applied ACK; Relay generation handling drops an ACK from a
  // superseded controller.
  commitScene(nextScene);
  const afterCommit = execution?.revalidate();
  if (afterCommit && !afterCommit.ok) {
    return {
      ok: false,
      code: afterCommit.code,
      authoritativeStateCommitted: true,
    };
  }
  return { ok: true, code: "scene_selected", authoritativeStateCommitted: true };
}
