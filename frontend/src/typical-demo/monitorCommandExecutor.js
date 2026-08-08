import { classifyControlCommand } from "./remoteCommand.js";

const REJECT_CODES = new Set([
  "stale_decision",
  "safety_event_active",
  "bathroom_video_forbidden",
  "source_unavailable",
]);

function normalizeFailure(result, fallbackCode) {
  if (result && typeof result === "object" && result.ok === false) {
    return {
      phase: REJECT_CODES.has(result.code) ? "rejected" : "failed",
      code: result.code || fallbackCode,
    };
  }
  if (result === false || result === null) {
    return { phase: "failed", code: fallbackCode };
  }
  return null;
}

async function runAction(action, args, successCode, failureCode) {
  if (typeof action !== "function") {
    return { phase: "failed", code: "command_not_supported" };
  }
  try {
    const result = await action(...args);
    const failure = normalizeFailure(result, failureCode);
    return failure || { phase: "applied", code: result?.code || successCode };
  } catch (error) {
    return {
      phase: "failed",
      code: error?.code || failureCode,
      detail: error?.message || "命令执行失败",
    };
  }
}

export async function executeMonitorCommand(envelope, { context, actions, now = Date.now() }) {
  const classification = classifyControlCommand(envelope, context, now);
  if (classification.disposition === "rejected") {
    return { phase: "rejected", code: classification.code };
  }
  if (classification.disposition === "awaiting_local_confirmation") {
    return {
      phase: "awaiting_local_confirmation",
      code: classification.code,
      pendingCommand: envelope,
    };
  }

  const command = envelope.command;
  switch (command.name) {
    case "select_scene":
      return runAction(actions.selectScene, [command.scene_id], "scene_selected", "scene_switch_failed");
    case "stop_capture":
      return runAction(actions.stopCapture, [], "capture_stopped", "capture_stop_failed");
    case "run_demo_scenario":
      return runAction(actions.runDemoScenario, [command.scenario], "scenario_started", "scenario_unavailable");
    case "reset_demo":
      return runAction(actions.resetDemo, [], "demo_reset", "reset_failed");
    case "start_conversation":
      return runAction(
        actions.startConversation,
        [command.scenario],
        "conversation_started",
        "conversation_failed",
      );
    case "submit_response":
      return runAction(
        actions.submitResponse,
        [command.decision_id, command.response],
        "response_applied",
        "response_failed",
      );
    case "confirm_alarm":
      return runAction(
        actions.confirmAlarm,
        [command.decision_id],
        "alarm_confirmed",
        "alarm_confirmation_failed",
      );
    case "replay_voice":
      return runAction(
        actions.replayVoice,
        [command.decision_id],
        "voice_replayed",
        "voice_unavailable",
      );
    default:
      return { phase: "rejected", code: "invalid_command" };
  }
}

export async function confirmLocalMonitorCommand(envelope, actions) {
  const command = envelope?.command;
  switch (command?.name) {
    case "select_source":
      return runAction(
        actions.selectSource,
        [command.source_id],
        "source_selected",
        "source_selection_failed",
      );
    case "start_capture":
      return runAction(actions.startCapture, [], "capture_started", "capture_start_failed");
    default:
      return { phase: "rejected", code: "local_confirmation_not_required" };
  }
}

