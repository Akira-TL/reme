import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSessionRequest,
  RUNTIME_EVENT_SCHEMA,
  SESSION_STATUS_SCHEMA,
} from "../adapters/perception";
import {
  getDecisionUrls,
  requestDecisionVoice,
  resetScene as requestSceneReset,
  startDemoConversation as requestDemoConversation,
  startSessionWithTakeover,
  submitVoiceDialogue,
  switchSessionScene,
  stopSession,
  submitResponse,
  uploadDangerFrame,
} from "../services/decisionClient";
import {
  ensureAudioUnlock,
  getSharedAudioContext,
  playAssetUrl,
} from "../utils/audioEngine";
import { recordVoiceReply } from "../utils/wavRecorder";

let pendingSessionStop = Promise.resolve();

function pluckDecision(payload) {
  if (payload?.decision_id) return payload;
  if (payload?.decision?.decision_id) return payload.decision;
  return null;
}

function captureJpegBase64(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const width = Math.min(640, video.videoWidth);
  const height = Math.max(1, Math.round(width * video.videoHeight / video.videoWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  try {
    return canvas.toDataURL("image/jpeg", 0.72).split(",")[1] || null;
  } catch {
    return null;
  }
}

function playAudioElement(audio) {
  return new Promise((resolve, reject) => {
    audio.onended = () => resolve();
    audio.onerror = () => reject(new Error("音频播放失败"));
    try {
      const playing = audio.play();
      playing?.catch?.(reject);
    } catch (error) {
      reject(error);
    }
  });
}

function playBase64Audio(audioB64, audioFormat = "wav") {
  if (!audioB64) return Promise.reject(new Error("语音数据为空"));
  const mimeType = audioFormat === "mp3" ? "audio/mpeg" : "audio/wav";
  const url = `data:${mimeType};base64,${audioB64}`;
  return playAssetUrl(url).catch(() => playAudioElement(new Audio(url)));
}

function speakElderMessage(text) {
  if (!text || !("speechSynthesis" in window)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "zh-CN";
      utterance.onend = () => resolve();
      utterance.onerror = () => reject(new Error("浏览器语音播放失败"));
      window.speechSynthesis.speak(utterance);
    } catch (error) {
      reject(error);
    }
  });
}

function decisionAwaitsReply(payload) {
  return Boolean(
    payload?.need_dialogue
    && ["check_in_required", "consent_required"].includes(payload.state),
  );
}

function decisionIsPassiveObservation(payload) {
  return Boolean(
    payload
    && ["normal", "observe"].includes(payload.state)
    && !payload.need_dialogue
    && !payload.alarm,
  );
}

function createVoiceState() {
  return {
    supported: typeof window !== "undefined"
      && typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && Boolean(window.AudioContext || window.webkitAudioContext),
    listening: false,
    stage: "idle",
    transcript: "",
    responseValue: "",
    asrModel: "mimo-v2.5-asr",
    ttsModel: "mimo-v2.5-tts",
    asrLatencyMs: null,
    ttsLatencyMs: null,
    error: "",
  };
}

export function useDecisionRuntime({ sessionId, sceneId, videoElement, enabled = true }) {
  const [connection, setConnection] = useState("closed");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState(null);
  const [history, setHistory] = useState([]);
  const [replies, setReplies] = useState([]);
  const [deadline, setDeadline] = useState(null);
  const [alarm, setAlarm] = useState(null);
  const [mimoRequest, setMimoRequest] = useState({
    status: "idle",
    scenario: null,
    requestedAt: null,
    respondedAt: null,
    source: null,
    decisionId: null,
    error: "",
  });
  const [voice, setVoice] = useState(createVoiceState);

  const sceneRef = useRef(sceneId);
  const videoRef = useRef(videoElement);
  const apiRef = useRef({});

  useEffect(() => {
    // 尽早装手势解锁监听：用户任意一次点击/按键后，问询语音与响铃
    // 都能绕过浏览器自动播放限制。
    ensureAudioUnlock();
  }, []);

  useEffect(() => {
    // 麦克风权限预请求：授权弹窗放在会话开始时，而不是跌倒问询的
    // 4 秒录音窗里（那时再弹基本来不及）。拿到即释放轨道，只留权限。
    if (!enabled) return;
    navigator.mediaDevices
      ?.getUserMedia?.({ audio: true })
      .then((stream) => stream.getTracks().forEach((track) => track.stop()))
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (sceneRef.current === sceneId) return;
    if (apiRef.current.switchScene) {
      apiRef.current.switchScene(sceneId).catch(() => {});
      return;
    }
    sceneRef.current = sceneId;
  }, [sceneId]);

  useEffect(() => {
    videoRef.current = videoElement;
  }, [videoElement]);

  useEffect(() => {
    if (!enabled || !sessionId) {
      const timer = window.setTimeout(() => {
        setConnection("closed");
        setReason("");
        setDecision(null);
        setHistory([]);
        setReplies([]);
        setDeadline(null);
        setAlarm(null);
        setMimoRequest({
          status: "idle",
          scenario: null,
          requestedAt: null,
          respondedAt: null,
          source: null,
          decisionId: null,
          error: "",
        });
        setVoice(createVoiceState());
      }, 0);
      return () => window.clearTimeout(timer);
    }

    const { httpBase, wsUrl } = getDecisionUrls();
    const abortController = new AbortController();
    const seenDecisionIds = new Set();
    const respondedDecisionIds = new Set();
    let disposed = false;
    let socket = null;
    let latestDecision = null;
    let latestAlarmDecision = null;
    let countdown = { decisionId: null, timer: 0 };
    let pendingSceneSwitch = Promise.resolve();
    let vibrateTimer = 0;
    let ring = null;
    let voiceTurnDecisionId = null;
    const spokenDecisionIds = new Set();
    let voiceCapture = null; // {decisionId, recorder, cancelled, pending}

    function stopVoiceCapture(cancel) {
      const capture = voiceCapture;
      if (!capture) return;
      if (cancel) {
        // 按钮/新决策已接管：录到一半的音频不再上传。
        capture.cancelled = true;
        voiceCapture = null;
        if (voiceTurnDecisionId === capture.decisionId) voiceTurnDecisionId = null;
      }
      capture.recorder.stop();
    }

    function stopAlarmLocal() {
      if (vibrateTimer) {
        window.clearInterval(vibrateTimer);
        vibrateTimer = 0;
      }
      try {
        navigator.vibrate?.(0);
      } catch {
        // 忽略振动停止失败
      }
      if (ring) {
        window.clearInterval(ring.toggle);
        try {
          ring.oscillator.stop();
        } catch {
          // 振荡器可能已停止
        }
        // 共享上下文要留给问询语音复用，只能关自建的。
        if (!ring.shared) ring.context.close().catch(() => {});
        ring = null;
      }
    }

    function startAlarmLocal() {
      stopAlarmLocal();
      try {
        navigator.vibrate?.([400, 120, 400]);
      } catch {
        // 忽略振动失败
      }
      vibrateTimer = window.setInterval(() => {
        try {
          navigator.vibrate?.([400, 120, 400]);
        } catch {
          // 忽略振动失败
        }
      }, 1200);
      try {
        // 优先用手势解锁过的共享上下文；仍锁定时保底新建（可能无声，
        // 但振动与全屏爆闪不受影响）。
        const context = getSharedAudioContext()
          || new (window.AudioContext || window.webkitAudioContext)();
        context.resume().catch(() => {});
        const gain = context.createGain();
        gain.gain.value = 0.2;
        gain.connect(context.destination);
        const oscillator = context.createOscillator();
        oscillator.type = "square";
        oscillator.frequency.value = 880;
        oscillator.connect(gain);
        oscillator.start();
        let high = true;
        const toggle = window.setInterval(() => {
          high = !high;
          try {
            oscillator.frequency.value = high ? 880 : 660;
          } catch {
            // 忽略频率切换失败
          }
        }, 600);
        ring = { context, oscillator, toggle, shared: context === getSharedAudioContext() };
      } catch {
        ring = null;
      }
    }

    function clearAlarmState() {
      stopAlarmLocal();
      latestAlarmDecision = null;
      setAlarm(null);
    }

    function clearCountdown() {
      if (countdown.timer) window.clearTimeout(countdown.timer);
      countdown = { decisionId: null, timer: 0 };
      setDeadline(null);
    }

    async function playDecisionVoice(payload, { force = false, autoReply = true } = {}) {
      if (!payload?.elder_message) return;
      if (!force && spokenDecisionIds.has(payload.decision_id)) return;
      spokenDecisionIds.add(payload.decision_id);
      setVoice((current) => ({
        ...current,
        stage: "tts_request",
        listening: false,
        error: "",
      }));
      try {
        const speech = await requestDecisionVoice(httpBase, {
          sceneId: payload.scene_id || sceneRef.current,
          decisionId: payload.decision_id,
        });
        if (disposed) return;
        setVoice((current) => ({
          ...current,
          stage: "playing",
          ttsModel: speech.tts_model || current.ttsModel,
          ttsLatencyMs: speech.tts_latency_ms ?? null,
          error: "",
        }));
        await playBase64Audio(speech.audio_b64, speech.audio_format);
      } catch (error) {
        if (disposed) return;
        try {
          if (payload.voice_asset) {
            const url = `${httpBase}${payload.voice_asset}`;
            await playAssetUrl(url).catch(() => playAudioElement(new Audio(url)));
          } else {
            await speakElderMessage(payload.elder_message);
          }
          setVoice((current) => ({
            ...current,
            stage: "playing_fallback",
            error: `MiMo TTS 失败，已降级播放：${error.message || "unknown"}`,
          }));
        } catch (fallbackError) {
          setVoice((current) => ({
            ...current,
            stage: "failed",
            error: fallbackError.message || "语音播放失败",
          }));
          return;
        }
      }
      if (disposed) return;
      setVoice((current) => ({
        ...current,
        stage: decisionAwaitsReply(payload) ? "waiting_reply" : "complete",
      }));
      if (
        autoReply
        && decisionAwaitsReply(payload)
        && !respondedDecisionIds.has(payload.decision_id)
      ) {
        window.setTimeout(() => runVoiceReply(payload), 250);
      }
    }

    async function runVoiceReply(target = latestDecision) {
      if (
        !target?.decision_id
        || target.scene_id !== sceneRef.current
        || !decisionAwaitsReply(target)
        || respondedDecisionIds.has(target.decision_id)
        || voiceTurnDecisionId === target.decision_id
      ) return;
      if (!createVoiceState().supported) {
        setVoice((current) => ({
          ...current,
          supported: false,
          stage: "failed",
          error: "当前浏览器无法采集麦克风 WAV",
        }));
        return;
      }
      voiceTurnDecisionId = target.decision_id;
      setVoice((current) => ({
        ...current,
        supported: true,
        listening: true,
        stage: "recording",
        transcript: "",
        responseValue: "",
        asrLatencyMs: null,
        error: "",
      }));
      let marked = false;
      let capture = null;
      try {
        capture = {
          decisionId: target.decision_id,
          recorder: recordVoiceReply(),
          cancelled: false,
          pending: true,
        };
        voiceCapture = capture;
        const audioB64 = await capture.recorder.promise;
        capture.pending = false;
        if (voiceCapture === capture) voiceCapture = null;
        if (!audioB64 || capture.cancelled || disposed) return;
        markResponded(target.decision_id);
        marked = true;
        setVoice((current) => ({
          ...current,
          listening: false,
          stage: "asr_request",
        }));
        const result = await submitVoiceDialogue(httpBase, {
          sceneId: target.scene_id || sceneRef.current,
          decisionId: target.decision_id,
          timestampMs: performance.now(),
          audioB64,
        });
        if (disposed) return;
        const next = pluckDecision(result);
        if (next) ingestDecision(next, { suppressVoice: true });
        setVoice((current) => ({
          ...current,
          listening: false,
          stage: result.audio_b64 ? "playing" : "complete",
          transcript: result.transcript || "",
          responseValue: result.response_value || "",
          asrModel: result.asr_model || current.asrModel,
          ttsModel: result.tts_model || current.ttsModel,
          asrLatencyMs: result.asr_latency_ms ?? null,
          ttsLatencyMs: result.tts_latency_ms ?? null,
          error: "",
        }));
        if (result.audio_b64) {
          await playBase64Audio(result.audio_b64, result.audio_format);
        }
        if (disposed) return;
        setVoice((current) => ({
          ...current,
          stage: decisionAwaitsReply(next) ? "waiting_reply" : "complete",
        }));
        voiceTurnDecisionId = null;
        if (decisionAwaitsReply(next) && !respondedDecisionIds.has(next.decision_id)) {
          window.setTimeout(() => runVoiceReply(next), 250);
        }
      } catch (error) {
        if (capture) capture.pending = false;
        if (voiceCapture === capture) voiceCapture = null;
        voiceTurnDecisionId = null;
        setVoice((current) => ({
          ...current,
          listening: false,
          stage: "failed",
          error: error.message || "MiMo 语音对话失败",
        }));
        if (marked && !disposed) submitFor(target, "none", "timeout");
      }
    }

    async function submitFor(target, response, source, text = null) {
      try {
        const result = await submitResponse(httpBase, {
          scene_id: target.scene_id || sceneRef.current,
          decision_id: target.decision_id,
          timestamp_ms: performance.now(),
          response,
          source,
          ...(text ? { text } : {}),
        });
        if (!disposed) {
          const next = pluckDecision(result);
          if (next) ingestDecision(next);
        }
        return true;
      } catch {
        // 提交失败静默：B 侧倒计时兜底仍在
        return false;
      }
    }

    function markResponded(decisionId) {
      respondedDecisionIds.add(decisionId);
      if (countdown.decisionId === decisionId) clearCountdown();
      // 按钮已回答：进行中的录音作废，麦克风立即释放。
      if (voiceCapture?.decisionId === decisionId) stopVoiceCapture(true);
    }

    function ingestDecision(payload, { suppressVoice = false } = {}) {
      if (disposed || !payload?.decision_id) return;
      if (seenDecisionIds.has(payload.decision_id)) return;
      seenDecisionIds.add(payload.decision_id);
      if (
        decisionAwaitsReply(latestDecision)
        && payload.scene_id === latestDecision.scene_id
        && decisionIsPassiveObservation(payload)
      ) {
        return;
      }

      latestDecision = payload;
      setDecision(payload);
      setHistory((current) => [payload, ...current].slice(0, 5));

      // 任何新 decision 到达都清掉旧倒计时
      clearCountdown();

      if (!suppressVoice && voiceTurnDecisionId === null) playDecisionVoice(payload);

      if (Number.isFinite(payload.response_timeout_ms) && payload.response_timeout_ms > 0) {
        const decisionId = payload.decision_id;
        const timeoutMs = payload.response_timeout_ms;
        setDeadline({ decisionId, timeoutMs, expiresAt: Date.now() + timeoutMs });
        countdown = {
          decisionId,
          timer: window.setTimeout(() => {
            countdown = { decisionId: null, timer: 0 };
            setDeadline(null);
            if (respondedDecisionIds.has(decisionId)) return;
            // 老人正在说话（或语音已在上传/识别中）：本地不抢答超时，
            // 让语音结果收尾；链路失败时 B 侧倒计时兜底网（+2s 宽限）
            // 仍会升级，"沉默必须升级"的安全不因此松动。
            const capture = voiceCapture;
            if (
              capture &&
              capture.decisionId === decisionId &&
              capture.pending &&
              capture.recorder.speechActive()
            ) {
              return;
            }
            stopVoiceCapture(true);
            submitFor(payload, "none", "timeout");
          }, timeoutMs),
        };
      }

      const channels = Array.isArray(payload.confirm_channels) ? payload.confirm_channels : [];
      if (channels.includes("frame")) {
        const imageB64 = captureJpegBase64(videoRef.current);
        if (imageB64) {
          uploadDangerFrame(httpBase, {
            sceneId: payload.scene_id || sceneRef.current,
            decisionId: payload.decision_id,
            timestampMs: performance.now(),
            imageB64,
          }).catch(() => {});
        }
      }
      // 旧决策的录音一律作废；新决策播放问询后会重新开始静音收尾录音。
      stopVoiceCapture(true);
      if (payload.alarm) {
        latestAlarmDecision = payload;
        setAlarm({
          channels: Array.isArray(payload.alarm.channels) ? payload.alarm.channels : [],
          trigger: payload.alarm.trigger || "",
          decision: payload,
        });
        startAlarmLocal();
      }
    }

    function handleMessage(message) {
      if (disposed || typeof message.data !== "string") return;
      let frame;
      try {
        frame = JSON.parse(message.data);
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object") return;
      if (frame.schema_version === SESSION_STATUS_SCHEMA) {
        if (frame.session_id === sessionId && frame.state === "stopped") setConnection("closed");
        return;
      }
      if (frame.schema_version !== RUNTIME_EVENT_SCHEMA) return;
      if (frame.session_id !== sessionId) return;
      if (frame.event_type === "interaction_response") {
        // B 回执的老人应答（含语音转写）：对话记录的另一半。
        const reply = frame.payload;
        if (reply && typeof reply === "object" && reply.decision_id) {
          setReplies((current) => [reply, ...current].slice(0, 20));
        }
        return;
      }
      if (frame.event_type !== "care_decision") return;
      if (!frame.payload || typeof frame.payload !== "object") return;
      ingestDecision(frame.payload);
    }

    apiRef.current = {
      respond(response, source, text = null) {
        const target = latestDecision;
        if (!target?.decision_id || respondedDecisionIds.has(target.decision_id)) return;
        markResponded(target.decision_id);
        submitFor(target, response, source, text);
      },
      replayVoice() {
        if (latestDecision) playDecisionVoice(latestDecision, { force: true, autoReply: false });
      },
      startVoiceReply() {
        runVoiceReply(latestDecision);
      },
      switchScene(nextSceneId) {
        if (!nextSceneId || nextSceneId === sceneRef.current) return pendingSceneSwitch;
        pendingSceneSwitch = switchSessionScene(httpBase, {
          sessionId,
          sceneId: nextSceneId,
        }).then(() => {
          if (disposed) return;
          sceneRef.current = nextSceneId;
          latestDecision = null;
          latestAlarmDecision = null;
          clearAlarmState();
          clearCountdown();
          setDecision(null);
          setHistory([]);
          setMimoRequest({
            status: "idle",
            scenario: null,
            requestedAt: null,
            respondedAt: null,
            source: null,
            decisionId: null,
            error: "",
          });
          setVoice((current) => ({
            ...current,
            listening: false,
            transcript: "",
            error: "",
          }));
        }).catch((error) => {
          if (!disposed) setReason(error.message || "B 场景切换失败");
          throw error;
        });
        return pendingSceneSwitch;
      },
      startDemoConversation(scenario) {
        let requestedAt = null;
        setMimoRequest({
          status: "waiting_scene",
          scenario,
          requestedAt: null,
          respondedAt: null,
          source: null,
          decisionId: null,
          error: "",
        });
        return pendingSceneSwitch.then(() => {
          requestedAt = Date.now();
          if (!disposed) {
            setMimoRequest({
              status: "requesting",
              scenario,
              requestedAt,
              respondedAt: null,
              source: null,
              decisionId: null,
              error: "",
            });
          }
          return requestDemoConversation(httpBase, {
            sceneId: sceneRef.current,
            scenario,
            timestampMs: performance.now(),
          });
        }).then((payload) => {
          if (disposed) return null;
          const next = pluckDecision(payload);
          if (next) ingestDecision(next);
          setMimoRequest({
            status: "succeeded",
            scenario,
            requestedAt,
            respondedAt: Date.now(),
            source: next?.source || null,
            decisionId: next?.decision_id || null,
            error: "",
          });
          return next;
        }).catch((error) => {
          if (!disposed) {
            setMimoRequest({
              status: "failed",
              scenario,
              requestedAt: requestedAt || Date.now(),
              respondedAt: Date.now(),
              source: null,
              decisionId: null,
              error: error.message || "MiMo 请求失败",
            });
          }
          throw error;
        });
      },
      resetScene() {
        return requestSceneReset(httpBase, sceneRef.current)
          .then(() => {
            if (disposed) return;
            latestDecision = null;
            clearAlarmState();
            clearCountdown();
            setDecision(null);
            setHistory([]);
          })
          .catch(() => {});
      },
      confirmAlarm() {
        const target = latestAlarmDecision || latestDecision;
        if (!target?.decision_id) {
          clearAlarmState();
          return;
        }
        markResponded(target.decision_id);
        submitFor(target, "card_confirmed", "family_input").then((succeeded) => {
          if (succeeded && !disposed) clearAlarmState();
        });
      },
      dismissAlarm() {
        clearAlarmState();
      },
    };

    async function start() {
      await Promise.resolve();
      if (disposed) return;
      setConnection("connecting");
      setReason("");
      setDecision(null);
      setHistory([]);
      setReplies([]);
      setDeadline(null);
      setAlarm(null);
      setMimoRequest({
        status: "idle",
        scenario: null,
        requestedAt: null,
        respondedAt: null,
        source: null,
        decisionId: null,
        error: "",
      });
      setVoice(createVoiceState());
      try {
        await pendingSessionStop;
        if (disposed) return;
        await startSessionWithTakeover(
          httpBase,
          createSessionRequest(sessionId, sceneRef.current),
          abortController.signal,
        );
        if (disposed) return;
        socket = new WebSocket(wsUrl);
        socket.onopen = () => {
          if (!disposed) setConnection("open");
        };
        socket.onclose = () => {
          if (!disposed) setConnection("closed");
        };
        socket.onerror = () => {
          if (!disposed) setConnection("error");
        };
        socket.onmessage = handleMessage;
      } catch (error) {
        if (disposed || error.name === "AbortError") return;
        setConnection("error");
        setReason(error.code === "profile_mismatch"
          ? "B 会话画像不匹配 (profile_mismatch)"
          : error.message || "B 决策服务不可用");
      }
    }

    start();

    return () => {
      disposed = true;
      apiRef.current = {};
      abortController.abort();
      if (countdown.timer) window.clearTimeout(countdown.timer);
      countdown = { decisionId: null, timer: 0 };
      stopVoiceCapture(true);
      stopAlarmLocal();
      try {
        socket?.close();
      } catch {
        // 忽略关闭失败
      }
      pendingSessionStop = stopSession(httpBase, sessionId).catch(() => {});
    };
  }, [enabled, sessionId]);

  const respondSafe = useCallback(() => {
    apiRef.current.respond?.("safe", "user_input");
  }, []);
  const respondNeedHelp = useCallback(() => {
    apiRef.current.respond?.("need_help", "user_input");
  }, []);
  const respondConsentGranted = useCallback(() => {
    apiRef.current.respond?.("consent_granted", "user_input");
  }, []);
  const respondConsentDenied = useCallback(() => {
    apiRef.current.respond?.("consent_denied", "user_input");
  }, []);
  const startDemoConversation = useCallback((scenario) => (
    apiRef.current.startDemoConversation?.(scenario) || Promise.resolve(null)
  ), []);
  const confirmAlarm = useCallback(() => {
    apiRef.current.confirmAlarm?.();
  }, []);
  const dismissAlarm = useCallback(() => {
    apiRef.current.dismissAlarm?.();
  }, []);
  const replayVoice = useCallback(() => {
    apiRef.current.replayVoice?.();
  }, []);
  const startVoiceReply = useCallback(() => {
    apiRef.current.startVoiceReply?.();
  }, []);
  const resetSceneState = useCallback(() => (
    apiRef.current.resetScene?.() || Promise.resolve()
  ), []);

  return {
    connection,
    reason,
    decision,
    history,
    replies,
    deadline,
    alarm,
    mimoRequest,
    respondSafe,
    respondNeedHelp,
    respondConsentGranted,
    respondConsentDenied,
    startDemoConversation,
    confirmAlarm,
    dismissAlarm,
    replayVoice,
    startVoiceReply,
    resetSceneState,
    voice,
  };
}
