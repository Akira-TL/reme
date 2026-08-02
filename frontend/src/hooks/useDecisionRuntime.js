import { useCallback, useEffect, useRef, useState } from "react";
import {
  createSessionRequest,
  RUNTIME_EVENT_SCHEMA,
  SESSION_STATUS_SCHEMA,
} from "../adapters/perception";
import {
  getDecisionUrls,
  startSessionWithTakeover,
  stopSession,
  submitResponse,
  uploadDangerFrame,
  uploadDangerVoice,
} from "../services/decisionClient";
import { recordWav } from "../utils/wavRecorder";

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

function speakElderMessage(text) {
  if (!text || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    window.speechSynthesis.speak(utterance);
  } catch {
    // 语音播报失败静默
  }
}

export function useDecisionRuntime({ sessionId, sceneId, videoElement, enabled = true }) {
  const [connection, setConnection] = useState("closed");
  const [reason, setReason] = useState("");
  const [decision, setDecision] = useState(null);
  const [history, setHistory] = useState([]);
  const [deadline, setDeadline] = useState(null);
  const [alarm, setAlarm] = useState(null);

  const sceneRef = useRef(sceneId);
  const videoRef = useRef(videoElement);
  const apiRef = useRef({});

  useEffect(() => {
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
        setDeadline(null);
        setAlarm(null);
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
    let vibrateTimer = 0;
    let ring = null;

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
        ring.context.close().catch(() => {});
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
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return;
        const context = new AudioContextCtor();
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
        ring = { context, oscillator, toggle };
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

    function playDecisionVoice(payload) {
      if (payload.voice_asset) {
        try {
          const audio = new Audio(`${httpBase}${payload.voice_asset}`);
          const playing = audio.play();
          playing?.catch?.(() => speakElderMessage(payload.elder_message));
        } catch {
          speakElderMessage(payload.elder_message);
        }
        return;
      }
      if (payload.elder_message && payload.need_dialogue) speakElderMessage(payload.elder_message);
    }

    async function submitFor(target, response, source) {
      try {
        const result = await submitResponse(httpBase, {
          scene_id: target.scene_id || sceneRef.current,
          decision_id: target.decision_id,
          timestamp_ms: performance.now(),
          response,
          source,
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
    }

    function ingestDecision(payload) {
      if (disposed || !payload?.decision_id) return;
      if (seenDecisionIds.has(payload.decision_id)) return;
      seenDecisionIds.add(payload.decision_id);

      latestDecision = payload;
      setDecision(payload);
      setHistory((current) => [payload, ...current].slice(0, 5));

      // 任何新 decision 到达都清掉旧倒计时
      clearCountdown();

      playDecisionVoice(payload);

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
      if (channels.includes("voice")) {
        recordWav({ durationMs: 4000, sampleRate: 16000 })
          .then((audioB64) => uploadDangerVoice(httpBase, {
            sceneId: payload.scene_id || sceneRef.current,
            decisionId: payload.decision_id,
            timestampMs: performance.now(),
            audioB64,
          }))
          .catch(() => {});
      }

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
      if (frame.session_id !== sessionId || frame.event_type !== "care_decision") return;
      if (!frame.payload || typeof frame.payload !== "object") return;
      ingestDecision(frame.payload);
    }

    apiRef.current = {
      respond(response, source) {
        const target = latestDecision;
        if (!target?.decision_id || respondedDecisionIds.has(target.decision_id)) return;
        markResponded(target.decision_id);
        submitFor(target, response, source);
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
      setDeadline(null);
      setAlarm(null);
      try {
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
      stopAlarmLocal();
      try {
        socket?.close();
      } catch {
        // 忽略关闭失败
      }
      stopSession(httpBase, sessionId).catch(() => {});
    };
  }, [enabled, sessionId]);

  const respondSafe = useCallback(() => {
    apiRef.current.respond?.("safe", "user_input");
  }, []);
  const respondNeedHelp = useCallback(() => {
    apiRef.current.respond?.("need_help", "user_input");
  }, []);
  const confirmAlarm = useCallback(() => {
    apiRef.current.confirmAlarm?.();
  }, []);
  const dismissAlarm = useCallback(() => {
    apiRef.current.dismissAlarm?.();
  }, []);

  return {
    connection,
    reason,
    decision,
    history,
    deadline,
    alarm,
    respondSafe,
    respondNeedHelp,
    confirmAlarm,
    dismissAlarm,
  };
}
