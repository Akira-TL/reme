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
  family_notification_required: "已经联系家人",
  urgent_attention: "家人正在赶来",
  resolved: "这一轮关怀已结束",
});

const DECISION_MESSAGE_COPY = Object.freeze({
  family_notification_required: "家人已经收到消息，请您安心等待。",
  urgent_attention: "家人已经收到紧急提醒，请您先不要着急起身。",
  resolved: "这件事已经处理好了。",
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
    return { text: "本次视觉确认未发送成功；规则倒计时仍继续。", tone: "error" };
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
  const candidateState = cleanText(candidateDecision?.state);
  const retainsSafetyAlert = Boolean(
    started
      && !liveAvailable
      && ["family_notification_required", "urgent_attention"].includes(candidateState),
  );
  const decision = liveAvailable || retainsSafetyAlert
    ? candidateDecision
    : null;
  const decisionState = cleanText(decision?.state);
  const decisionId = cleanText(decision?.decision_id) || null;
  const elderMessage = cleanText(decision?.elder_message);
  const fallbackTitle = !started
    ? "尚未开始关怀"
    : liveAvailable
      ? "关怀已就绪"
      : "关怀能力暂不可用";
  const fallbackMessage = !started
    ? "请先点击上方“开始关怀”，并在本机选择媒体源。"
    : liveAvailable
      ? "系统正在安静等待可靠事件，需要时才会出现。"
      : "当前没有可靠的实时关怀结果，请检查本机媒体源和运行时连接。";
  const consentQuestion = decisionState === "consent_required"
    && decision?.consent_required === true;
  const safetyQuestion = decisionState === "check_in_required"
    && decision?.consent_required !== true;
  const responseKind = consentQuestion ? "consent" : safetyQuestion ? "safety" : null;
  const hasCurrentQuestion = Boolean(responseKind && decisionId && elderMessage);
  const progress = retainsSafetyAlert
    ? {
        text: "当前连接不可用；已发出的安全提醒不会自动取消。",
        tone: "error",
      }
    : voiceProgress(live?.voice);
  const visualContext = visualContextProgress(
    live?.decision?.visualContext,
    cleanText(scene?.id),
    decisionId,
  );

  return Object.freeze({
    kicker: [cleanText(scene?.room), cleanText(scene?.privacy)].filter(Boolean).join(" · "),
    title: retainsSafetyAlert
      ? "安全提醒仍保持"
      : DECISION_TITLE_COPY[decisionState] || fallbackTitle,
    message: elderMessage
      || DECISION_MESSAGE_COPY[decisionState]
      || fallbackMessage,
    source: decision?.source === "mimo"
      ? "MiMo 关怀"
      : decision?.source
        ? "本地安全规则"
        : "",
    decisionId,
    decisionState,
    responseKind: hasCurrentQuestion ? responseKind : null,
    canRespond: Boolean(hasCurrentQuestion && liveAvailable),
    canReplay: Boolean(hasCurrentQuestion && liveAvailable),
    progress: progress.text,
    progressTone: progress.tone,
    visualContext: visualContext.text,
    visualContextTone: visualContext.tone,
  });
}

export function HomeCarePrompt({ scene, live, started = false, available = Boolean(live?.active) }) {
  const prompt = deriveHomeCarePrompt(scene, live, started, available);
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
                className="home-care-primary"
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
