import { useEffect, useState } from "react";

const VOICE_STAGE_COPY = Object.freeze({
  tts_request: "正在准备语音…",
  playing: "正在对您说话…",
  playing_fallback: "正在对您说话…",
  listening_prompt: "正在听您回答…",
  waiting_reply: "请说出您的回答",
  recording: "正在听您说话…",
  asr_request: "正在理解您的回答…",
  complete: "这一轮对话已完成",
  failed: "这次没有听清",
});

const DECISION_TITLE_COPY = Object.freeze({
  check_in_required: "想问您一句",
  consent_required: "想征求您的同意",
  resolved: "这一轮关怀已结束",
});

const DECISION_MESSAGE_COPY = Object.freeze({
  resolved: "这件事已经处理好了。",
});

const FAMILY_DELIVERY_COPY = Object.freeze({
  notification: {
    title: "已经通知家人",
    message: "家人已收到一条普通关怀消息；这不是安全告警。",
  },
  action_card: {
    title: "家庭行动卡已送达",
    message: "已按您的同意把具体需要告诉家人，等待家人确认处理。",
  },
  alarm: {
    title: "安全告警已发送",
    message: "家人已收到紧急提醒，请您先不要着急起身。",
  },
});

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function currentSceneDecision(scene, live) {
  const decision = live?.decision?.decision;
  if (!decision || typeof decision !== "object") return null;
  const sceneId = cleanText(scene?.id);
  if (sceneId && decision.scene_id !== sceneId) return null;
  return decision;
}

function voiceProgress(voice) {
  const error = cleanText(voice?.error) || cleanText(voice?.microphoneError);
  if (error) {
    return { text: `语音暂时不可用：${error}`, tone: "error" };
  }

  const stage = cleanText(voice?.stage);
  if (stage && stage !== "idle" && stage !== "complete") {
    return { text: VOICE_STAGE_COPY[stage] || "语音对话正在进行", tone: "active" };
  }

  const transcript = cleanText(voice?.transcript);
  if (transcript) {
    return { text: `听到您说：“${transcript}”`, tone: "complete" };
  }

  return {
    text: stage === "complete" ? VOICE_STAGE_COPY.complete : "",
    tone: stage === "complete" ? "complete" : "idle",
  };
}

function visualContextProgress(visualContext, sceneId, decisionId) {
  if (
    !sceneId
    || !decisionId
    || visualContext?.sceneId !== sceneId
    || visualContext?.decisionId !== decisionId
  ) {
    return { text: "", tone: "idle" };
  }
  if (visualContext.status === "sending") {
    return { text: "本次正在提交 1 帧用于 MiMo 跌倒确认。", tone: "active" };
  }
  if (visualContext.status === "sent") {
    return { text: "本次已提交 1 帧用于 MiMo 跌倒确认；确认结果将异步返回。", tone: "complete" };
  }
  if (visualContext.status === "failed") {
    return { text: "本次视觉确认未发送成功；等待后端发布下一条权威状态。", tone: "error" };
  }
  return { text: "", tone: "idle" };
}

// Kept beside the component so its product-state contract can be tested without rendering.
// eslint-disable-next-line react-refresh/only-export-components
export function deriveHomeCarePrompt(
  scene,
  live,
  started = Boolean(live?.active),
  available = Boolean(live?.active),
) {
  const liveAvailable = available === true;
  const candidateDecision = currentSceneDecision(scene, live);
  const decision = liveAvailable ? candidateDecision : null;
  const decisionState = cleanText(decision?.state);
  const decisionId = cleanText(decision?.decision_id) || null;
  const elderMessage = cleanText(decision?.elder_message);
  const familyDelivery = cleanText(decision?.family_delivery)
    || (decision?.alarm
      ? "alarm"
      : decision?.action_card
        ? "action_card"
        : decision?.family_notification
          ? "notification"
          : "none");
  const deliveryCopy = familyDelivery === "action_card"
    && ["confirmed", "done"].includes(decision?.action_card?.status)
    ? {
        title: "家庭行动卡已确认",
        message: "家人已经确认收到这项具体需要，本次行动卡正在按结果收尾。",
      }
    : FAMILY_DELIVERY_COPY[familyDelivery] || null;
  const fallbackTitle = !started
    ? "可靠事件才触发关怀"
    : liveAvailable
      ? "关怀已就绪"
      : "关怀能力暂不可用";
  const fallbackMessage = !started
    ? "视频数据先在本地转为姿态和事件；只有可靠事件才进入问询与家庭同步。"
    : liveAvailable
      ? "系统正在安静等待可靠事件，需要时才会出现。"
      : "当前没有可靠的实时关怀结果，请检查本机媒体源和运行时连接。";
  const consentQuestion = decisionState === "consent_required"
    && decision?.consent_required === true;
  const safetyQuestion = decisionState === "check_in_required"
    && decision?.consent_required !== true;
  const responseKind = consentQuestion ? "consent" : safetyQuestion ? "safety" : null;
  const hasCurrentQuestion = Boolean(responseKind && decisionId && elderMessage);
  const progress = voiceProgress(live?.voice);
  const visualContext = visualContextProgress(
    live?.decision?.visualContext,
    cleanText(scene?.id),
    decisionId,
  );

  return Object.freeze({
    kicker: started
      ? [cleanText(scene?.room), cleanText(scene?.privacy)].filter(Boolean).join(" · ")
      : "下游 · 事件关怀",
    title: deliveryCopy?.title || DECISION_TITLE_COPY[decisionState] || fallbackTitle,
    message: elderMessage
      || deliveryCopy?.message
      || DECISION_MESSAGE_COPY[decisionState]
      || fallbackMessage,
    source: decision?.source === "mimo"
      ? "MiMo 关怀"
      : decision?.source
        ? "本地安全规则"
        : "",
    decisionId,
    decisionState,
    familyDelivery,
    responseKind: hasCurrentQuestion ? responseKind : null,
    canRespond: Boolean(hasCurrentQuestion && liveAvailable),
    canReplay: Boolean(hasCurrentQuestion && liveAvailable),
    progress: progress.text,
    progressTone: progress.tone,
    visualContext: visualContext.text,
    visualContextTone: visualContext.tone,
    responseDeadlineMs: live?.decision?.deadline?.decisionId === decisionId
      && Number.isFinite(live.decision.deadline.expiresAt)
      ? live.decision.deadline.expiresAt
      : null,
  });
}

// eslint-disable-next-line react-refresh/only-export-components
export function responseCountdownSeconds(expiresAtMs, nowMs = Date.now()) {
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) return null;
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}

export function HomeCarePrompt({ scene, live, started = false, available = Boolean(live?.active) }) {
  const prompt = deriveHomeCarePrompt(scene, live, started, available);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(prompt.responseDeadlineMs)) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [prompt.responseDeadlineMs]);
  const countdownSeconds = responseCountdownSeconds(prompt.responseDeadlineMs, nowMs);
  const canReplay = prompt.canReplay && typeof live?.replayVoice === "function";
  const canRespondSafe = prompt.canRespond && typeof live?.respondSafe === "function";
  const canRespondNeedHelp = prompt.canRespond
    && typeof live?.respondNeedHelp === "function";
  const canConsent = prompt.canRespond
    && typeof live?.respondConsentGranted === "function";
  const canDecline = prompt.canRespond
    && typeof live?.respondConsentDenied === "function";

  return (
    <section className="home-care-prompt" aria-label="老人关怀" aria-live="polite">
      <header>
        {prompt.kicker ? <p className="home-care-kicker">{prompt.kicker}</p> : null}
        <h2>{prompt.title}</h2>
      </header>

      {prompt.message ? <p className="home-care-message">{prompt.message}</p> : null}

      {prompt.progress ? (
        <p
          className="home-care-progress"
          data-tone={prompt.progressTone}
          role={prompt.progressTone === "error" ? "alert" : "status"}
        >
          {prompt.progress}
        </p>
      ) : null}

      {prompt.visualContext ? (
        <p
          className="home-care-visual-context"
          data-tone={prompt.visualContextTone}
          role={prompt.visualContextTone === "error" ? "alert" : "status"}
        >
          {prompt.visualContext}
        </p>
      ) : null}

      {countdownSeconds > 0 ? (
        <p className="home-care-progress" data-tone="active" role="status">
          回应时限提示 · 剩余 {countdownSeconds} 秒（仅页面显示）
        </p>
      ) : null}

      {prompt.responseKind ? (
        <div className="home-care-actions" role="group" aria-label="回答当前关怀问题">
          <button
            type="button"
            className="home-care-replay"
            disabled={!canReplay}
            onClick={() => live.replayVoice(prompt.decisionId)}
          >
            再听一遍
          </button>

          {prompt.responseKind === "consent" ? (
            <>
              <button
                type="button"
                className="home-care-primary"
                disabled={!canConsent}
                onClick={() => live.respondConsentGranted(prompt.decisionId)}
              >
                同意分享
              </button>
              <button
                type="button"
                className="home-care-secondary"
                disabled={!canDecline}
                onClick={() => live.respondConsentDenied(prompt.decisionId)}
              >
                这次不分享
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="home-care-safe"
                disabled={!canRespondSafe}
                onClick={() => live.respondSafe(prompt.decisionId)}
              >
                我没事
              </button>
              <button
                type="button"
                className="home-care-danger"
                disabled={!canRespondNeedHelp}
                onClick={() => live.respondNeedHelp(prompt.decisionId)}
              >
                我需要帮助
              </button>
            </>
          )}
        </div>
      ) : null}

      {prompt.source ? <p className="home-care-source">{prompt.source}</p> : null}
    </section>
  );
}
