import { useCallback, useMemo } from "react";
import { useDecisionRuntime } from "../hooks/useDecisionRuntime";
import { usePerceptionRuntime } from "../hooks/usePerceptionRuntime";
import { FALL_PHASES } from "./scenes";

// 单机真实链路：A 在全部场景持续产出骨架/姿态/转变，B 按同一会话做决策。
// 深夜跌倒场景额外把 CareDecision 映射回演示壳的 fallPhase 词表。

const TRIGGER_LABELS = {
  elder_report: "老人求助",
  voice_intent: "语音求助",
  visual_confirm: "画面确认跌倒",
  check_in_timeout: "呼叫无回应",
  unclear_response: "无法确认状态",
  family_unresponsive: "家属未确认",
};

export function useFallLiveLink({ enabled, videoElement, sceneId }) {
  const perception = usePerceptionRuntime({
    videoElement,
    sceneId,
    enabled: Boolean(enabled && videoElement),
  });
  const decision = useDecisionRuntime({
    sessionId: perception.runtime.sessionId,
    sceneId,
    videoElement,
    enabled: Boolean(enabled && videoElement),
  });
  const current = decision.decision?.scene_id === sceneId ? decision.decision : null;
  // 本轮会话里是否出现过告警（history 由决策钩子维护，纯派生）。
  const wasAlarmed = useMemo(
    () => decision.history.some((item) => item?.alarm),
    [decision.history],
  );

  const active = Boolean(
    enabled
      && decision.connection === "open"
      && perception.runtime.state === "running"
  );

  const phase = useMemo(() => {
    if (!enabled || !active || sceneId !== "fall") return "idle";
    if (current) {
      if (current.state === "check_in_required") return "checking";
      if (["family_notification_required", "urgent_attention"].includes(current.state)) {
        return "emergency";
      }
      if (current.state === "resolved") {
        return wasAlarmed ? "resolved" : "idle";
      }
    }
    // 决策尚未跟上最新转移时短暂显示"候选"；check-in 一到即被上面的分支接管。
    const transition = perception.transition;
    if (
      transition?.transition === "fall_like_transition"
      && transition.end_ms > (current?.timestamp_ms ?? -1)
    ) {
      return "candidate";
    }
    return "idle";
  }, [active, current, enabled, perception.transition, sceneId, wasAlarmed]);

  const fallState = useMemo(() => {
    if (!active) return null;
    const trigger = current?.alarm ? TRIGGER_LABELS[current.alarm.trigger] || "" : "";
    const decisionMessage = current?.family_notification
      || current?.elder_message
      || current?.reason_summary
      || "";
    switch (phase) {
      case "checking":
        return {
          status: "正在确认安全（统一后端决策流）",
          message: decisionMessage || FALL_PHASES.checking.message,
        };
      case "emergency":
        return {
          status: trigger ? `已通知家属 · ${trigger}` : "已通知家属",
          message: decisionMessage || FALL_PHASES.emergency.message,
        };
      case "resolved":
        return {
          status: "MiMo 已处理结果",
          message: decisionMessage || FALL_PHASES.resolved.message,
        };
      case "candidate":
        return FALL_PHASES.candidate;
      default:
        return {
          status: "真实决策流待命",
          message: "统一运行时链路已接入：请在镜头前演示跌倒动作，无需按键触发",
        };
    }
  }, [active, current, phase]);

  const respondSafe = useCallback(() => {
    decision.respondSafe();
  }, [decision]);

  const respondNeedHelp = useCallback(() => {
    decision.respondNeedHelp();
  }, [decision]);

  const triggerDebugScenario = perception.triggerDebugScenario;

  const confirmAlarm = useCallback(() => {
    decision.confirmAlarm();
  }, [decision]);

  const emergencyNote = sceneId === "bathroom"
    ? "浴室场景不可查看原视频"
    : "家属可主动查看原视频与 A 骨架叠加";
  const familyVideoAllowed = Boolean(active && sceneId !== "bathroom");

  return {
    active,
    phase,
    fallState,
    emergencyNote,
    showEmergencyVideo: familyVideoAllowed,
    familyVideoAllowed,
    connection: decision.connection,
    perceptionState: perception.runtime.state,
    runtime: perception.runtime,
    landmarkFrame: perception.landmarkFrame,
    posture: perception.posture,
    transition: perception.transition,
    triggerDebugScenario,
    respondSafe,
    respondNeedHelp,
    respondConsentGranted: decision.respondConsentGranted,
    respondConsentDenied: decision.respondConsentDenied,
    startDemoConversation: decision.startDemoConversation,
    confirmAlarm,
    resetSceneState: decision.resetSceneState,
    replayVoice: decision.replayVoice,
    startVoiceReply: decision.startVoiceReply,
    voice: decision.voice,
    decision: { ...decision, decision: current },
  };
}
