import { useCallback, useMemo, useState } from "react";
import { useDecisionRuntime } from "../hooks/useDecisionRuntime";
import { usePerceptionRuntime } from "../hooks/usePerceptionRuntime";
import { FALL_PHASES } from "./scenes";

// 场景 4 的真实链路：把主应用的 A 感知接线与 B 决策接线组合起来，
// 并把 B 的 CareDecision 映射回演示壳自己的 fallPhase 词表。
// 链路不可用（A 或 B 未起）时返回 active=false，演示壳退回键盘剧本。

const LIVE_SCENE_ID = "fall";

const TRIGGER_LABELS = {
  elder_report: "老人求助",
  voice_intent: "语音求助",
  visual_confirm: "画面确认跌倒",
  check_in_timeout: "呼叫无回应",
  unclear_response: "无法确认状态",
  family_unresponsive: "家属未确认",
};

const PRIVACY_LABELS = {
  visible: "原画可见",
  blurred: "模糊处理",
  skeleton_only: "仅骨架",
  hidden: "画面隐藏",
};

export function useFallLiveLink({ enabled, videoElement }) {
  const perception = usePerceptionRuntime({
    videoElement,
    sceneId: LIVE_SCENE_ID,
    enabled: Boolean(enabled && videoElement),
  });
  const decision = useDecisionRuntime({
    sessionId: perception.runtime.sessionId,
    sceneId: LIVE_SCENE_ID,
    videoElement,
    enabled: Boolean(enabled && videoElement),
  });
  // 已在子女端确认过的告警决策 id：新告警事件天然拿到新 id，无需清理副作用。
  const [confirmedDecisionId, setConfirmedDecisionId] = useState(null);

  const current = decision.decision;
  // 本轮会话里是否出现过告警（history 由决策钩子维护，纯派生）。
  const wasAlarmed = useMemo(
    () => decision.history.some((item) => item?.alarm),
    [decision.history],
  );

  const active = Boolean(
    enabled
      && decision.connection === "open"
      && ["starting", "running", "input_unavailable"].includes(perception.runtime.state)
  );

  const phase = useMemo(() => {
    if (!enabled || !active) return "idle";
    if (current) {
      if (current.state === "check_in_required") return "checking";
      if (["family_notification_required", "urgent_attention"].includes(current.state)) {
        return current.decision_id === confirmedDecisionId ? "contacting" : "emergency";
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
  }, [active, confirmedDecisionId, current, enabled, perception.transition, wasAlarmed]);

  const fallState = useMemo(() => {
    if (!active) return null;
    const trigger = current?.alarm ? TRIGGER_LABELS[current.alarm.trigger] || "" : "";
    switch (phase) {
      case "checking":
        return {
          status: "正在确认安全（B 决策流）",
          message: current?.elder_message || FALL_PHASES.checking.message,
        };
      case "emergency":
        return {
          status: trigger ? `已通知家属 · ${trigger}` : "已通知家属",
          message: current?.family_notification || FALL_PHASES.emergency.message,
        };
      case "contacting":
        return { status: "确认回执已发送", message: "家人已收到并确认处理，等待事件关闭" };
      case "resolved":
        return {
          status: "事件已化解",
          message: current?.elder_message || "家人已确认收到，紧急提醒结束",
        };
      case "candidate":
        return FALL_PHASES.candidate;
      default:
        return {
          status: "真实决策流待命",
          message: "A/B 链路已接入：请在镜头前演示跌倒动作，无需按键触发",
        };
    }
  }, [active, current, phase]);

  const respondSafe = useCallback(() => {
    decision.respondSafe();
  }, [decision]);

  const respondNeedHelp = useCallback(() => {
    decision.respondNeedHelp();
  }, [decision]);

  const confirmAlarm = useCallback(() => {
    if (current) setConfirmedDecisionId(current.decision_id);
    decision.confirmAlarm();
  }, [current, decision]);

  const privacyLabel = PRIVACY_LABELS[current?.privacy_mode] || "仅骨架";
  const emergencyNote = current?.privacy_mode === "visible"
    ? "画面已按隐私档位开放"
    : `隐私档位：${privacyLabel}，未开放原画`;
  const showEmergencyVideo = Boolean(
    active
      && ["emergency", "contacting", "resolved"].includes(phase)
      && current?.privacy_mode === "visible"
  );

  return {
    active,
    phase,
    fallState,
    emergencyNote,
    showEmergencyVideo,
    connection: decision.connection,
    perceptionState: perception.runtime.state,
    sendLandmarks: perception.sendLandmarks,
    deadline: decision.deadline,
    respondSafe,
    respondNeedHelp,
    confirmAlarm,
    decision,
  };
}
