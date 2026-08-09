import { useCallback, useEffect, useMemo, useState } from "react";
import { useDecisionRuntime } from "../hooks/useDecisionRuntime";
import { usePerceptionRuntime } from "../hooks/usePerceptionRuntime";
import { mapCareDecisionToPhase } from "./phoneState";
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

export function useFallLiveLink({ enabled, videoElement, sceneId, sourceGeneration = 0 }) {
  const [authorizationClockMs, setAuthorizationClockMs] = useState(() => performance.now());
  const perception = usePerceptionRuntime({
    videoElement,
    sceneId,
    sourceGeneration,
    enabled: Boolean(enabled && videoElement),
  });
  const decision = useDecisionRuntime({
    sessionId: perception.runtime.sessionId,
    sceneId,
    videoElement,
    enabled: Boolean(enabled && videoElement),
  });
  const receivedDecision = decision.decision?.scene_id === sceneId ? decision.decision : null;
  const current = decision.connection === "open" ? receivedDecision : null;
  useEffect(() => {
    const expiresAtMs = decision.mediaAuthorization?.expiresAtMonotonicMs;
    if (!Number.isFinite(expiresAtMs)) return undefined;
    const remainingMs = Math.max(0, expiresAtMs - performance.now());
    const timer = window.setTimeout(
      () => setAuthorizationClockMs(expiresAtMs),
      remainingMs + 5,
    );
    return () => window.clearTimeout(timer);
  }, [decision.mediaAuthorization?.expiresAtMonotonicMs]);

  const kitchenConsentActive = Boolean(
    decision.mediaAuthorization?.sceneId === "kitchen"
      && current?.scene_id === "kitchen"
      && current.decision_id === decision.mediaAuthorization.decisionId
      && decision.mediaAuthorization.expiresAtMonotonicMs > authorizationClockMs,
  );

  const active = Boolean(
    enabled
      && decision.connection === "open"
      && perception.runtime.state === "running"
  );

  const phase = useMemo(() => {
    if (!enabled) return "idle";
    const decisionPhase = mapCareDecisionToPhase(current);
    if (decisionPhase !== "idle") return decisionPhase;
    if (!active) return "idle";
    // 决策尚未跟上最新转移时短暂显示"候选"；check-in 一到即被上面的分支接管。
    const transition = perception.transition;
    if (
      transition?.transition === "fall_like_transition"
      && transition.end_ms > (current?.timestamp_ms ?? -1)
    ) {
      return "candidate";
    }
    return "idle";
  }, [active, current, enabled, perception.transition]);

  const fallState = useMemo(() => {
    if (!enabled) return null;
    const trigger = current?.family_delivery === "alarm" && current?.alarm
      ? TRIGGER_LABELS[current.alarm.trigger] || ""
      : "";
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
      case "attention":
        return {
          status: current?.family_delivery === "action_card"
            ? "家属行动卡已送达"
            : "家属关怀信息已送达",
          message: decisionMessage || "这是一条普通关怀信息，不是安全告警。",
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
  }, [current, enabled, phase]);

  const respondSafe = useCallback((decisionId = null) => {
    return decision.respondSafe(decisionId);
  }, [decision]);

  const respondNeedHelp = useCallback((decisionId = null) => {
    return decision.respondNeedHelp(decisionId);
  }, [decision]);

  const respondNeedHelpWithText = useCallback((text, decisionId = null) => {
    return decision.respondNeedHelpWithText(text, decisionId);
  }, [decision]);

  const triggerDebugScenario = perception.triggerDebugScenario;

  const confirmAlarm = useCallback((decisionId = null) => {
    return decision.confirmAlarm(decisionId);
  }, [decision]);

  const familyVideoAllowed = Boolean(active && (
    (sceneId === "kitchen" && kitchenConsentActive)
    || (sceneId === "fall" && current?.family_delivery === "alarm" && current?.alarm)
  ));
  const emergencyNote = sceneId === "bathroom"
    ? "浴室永不开放原画"
    : familyVideoAllowed
      ? "本次事件已临时授权原画；授权到期会自动关闭"
      : "日常只同步骨架；厨房需本人同意，跌倒需权威升级";

  return {
    active,
    phase,
    fallState,
    emergencyNote,
    showEmergencyVideo: familyVideoAllowed,
    familyVideoAllowed,
    kitchenConsentActive,
    mediaAuthorization: decision.mediaAuthorization,
    connection: decision.connection,
    perceptionState: perception.runtime.state,
    runtime: perception.runtime,
    landmarkFrame: perception.landmarkFrame,
    posture: perception.posture,
    transition: perception.transition,
    triggerDebugScenario,
    respondSafe,
    respondNeedHelp,
    respondNeedHelpWithText,
    respondConsentGranted: decision.respondConsentGranted,
    respondConsentDenied: decision.respondConsentDenied,
    startDemoConversation: decision.startDemoConversation,
    switchScene: decision.switchScene,
    confirmAlarm,
    resetSceneState: decision.resetSceneState,
    replayVoice: decision.replayVoice,
    startVoiceReply: decision.startVoiceReply,
    voice: decision.voice,
    decision: { ...decision, decision: current },
  };
}
