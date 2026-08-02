import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import CameraAltRoundedIcon from "@mui/icons-material/CameraAltRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import KeyRoundedIcon from "@mui/icons-material/KeyRounded";
import PersonalInjuryRoundedIcon from "@mui/icons-material/PersonalInjuryRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { createMoveNetBrowserEstimator } from "../model/movenet.js";
import { ensureAudioContextRunning, recordVoiceReply } from "../utils/wavRecorder.js";
import {
  captureJpegBase64,
  createCookingConfirmationTracker,
  recognizeCooking,
  recordLocalMoment,
} from "./activityRecognition.js";
import { getRelayBase, relayHttpUrl, relayWebSocketUrl } from "./config.js";
import { createControllerMediaBridge } from "./controllerMedia.js";
import {
  clearControllerSession,
  controllerReconnectDelayMs,
  readControllerSession,
  updateControllerSession,
  writeControllerSession,
} from "./controllerSession.js";
import { createFallTransitionDetector } from "./fallDetection.js";
import {
  advanceControllerEventSequence,
  CONTROLLER_PROTOCOL,
  controllerProtocols,
  createDemoEvent,
  createMediaGrantRequest,
  createMediaGrantRevoke,
  createPoseFrame,
  isControllerReady,
  isDemoEvent,
  isForwardedMediaSignal,
  isHeartbeatAck,
} from "./protocol.js";
import { SkeletonStage } from "./SkeletonStage.jsx";
import { createMonitorState, reduceMonitorState } from "./state.js";
import {
  estimatePromptLeadMs,
  recognizeDangerVoice,
  selectFailClosedFallEvent,
  selectFallReconnectAction,
  selectVoiceIntentAction,
} from "./voiceIntent.js";

const MIN_PUBLISH_INTERVAL_MS = 100;
const HEARTBEAT_INTERVAL_MS = 15_000;
const COOKING_SAMPLE_INTERVAL_MS = 4_000;
const FALL_REPLY_WINDOW_MS = 8_000;
const CONTROLLER_READY_TIMEOUT_MS = 5_000;
const FALL_PROMPT_FALLBACK_MS = 7_000;
const FALL_PROMPT_WATCHDOG_MS = 9_000;

const VOICE_PHASE_COPY = Object.freeze({
  idle: ["语音回应", "进入跌倒场景后，系统会先申请麦克风权限。"],
  preparing: ["准备语音回应", "正在申请麦克风权限；授权后会立即释放，事件前不持续收音。"],
  ready: ["语音回应已就绪", "检测到跌倒并播完问询后，系统会自动短时收音。"],
  prompt: ["正在语音问询", "问询播放结束后才会开启麦克风，避免把系统声音当作回应。"],
  listening: ["正在聆听回应", "请直接说“我没事”或“需要帮助”；规则倒计时仍在运行。"],
  transcribing: ["MiMo 正在理解", "语音已停止采集并发送；安全倒计时不会等待模型。"],
  result: ["已识别语音回应", "语音结果已进入本次安全事件。"],
  fallback: ["语音已降级", "可继续使用按钮；没有语音结果时仍会按规则超时告警。"],
});

const DEMO_SCENES = Object.freeze([
  {
    id: "living",
    number: "01",
    label: "日常",
    shortLabel: "日常",
    detail: "抽象客厅 + 火柴人",
    Icon: HomeRoundedIcon,
  },
  {
    id: "kitchen",
    number: "02",
    label: "做饭",
    shortLabel: "做饭",
    detail: "视觉识别 + 家庭心跳",
    Icon: RestaurantRoundedIcon,
  },
  {
    id: "bathroom",
    number: "03",
    label: "完全隐私",
    shortLabel: "隐私",
    detail: "仅火柴人",
    Icon: VisibilityOffRoundedIcon,
  },
  {
    id: "fall",
    number: "04",
    label: "跌倒",
    shortLabel: "跌倒",
    detail: "问询后规则告警",
    Icon: PersonalInjuryRoundedIcon,
  },
]);

function createActivityState() {
  return {
    phase: "idle",
    classification: null,
    confidence: null,
    reason: "切到做饭场景后，系统才会开始最小视觉采样。",
    latencyMs: null,
    model: "",
    consecutive: 0,
  };
}

function createFallState() {
  return {
    phase: "idle",
    eventId: null,
    deadlineMs: null,
    trigger: null,
    message: "等待真实姿态流中的快速下移与横向转变。",
  };
}

function createVoiceState(overrides = {}) {
  return {
    phase: "idle",
    intent: null,
    transcript: "",
    latencyMs: null,
    model: "",
    detail: VOICE_PHASE_COPY.idle[1],
    ...overrides,
  };
}

function randomId(prefix) {
  const suffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${performance.now().toFixed(0)}`;
  return `${prefix}-${suffix}`;
}

function unlockError(response, payload) {
  if (payload?.error === "invalid_control_key" || response.status === 401) {
    return "控制密钥不正确，请重新输入。";
  }
  if (payload?.error === "controller_locked" || response.status === 423) {
    return "已有监控端占用控制权。请先在原设备释放，或等待租约到期。";
  }
  if (payload?.error === "unlock_rate_limited" || response.status === 429) {
    return "密钥尝试次数过多，请稍后再试。";
  }
  return "控制端暂时无法解锁，请检查网络后重试。";
}

function waitForVideo(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("摄像头首帧等待超时"));
    }, 10_000);
    const onReady = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.removeEventListener("loadeddata", onReady);
    };
    video.addEventListener("loadeddata", onReady, { once: true });
  });
}

export function MonitorApp() {
  const [restoredControllerSession] = useState(() => readControllerSession({
    now: Date.now(),
  }));
  const [ui, dispatch] = useReducer(
    reduceMonitorState,
    restoredControllerSession,
    (restored) => restored
      ? reduceMonitorState(createMonitorState(), {
        type: "unlocked",
        sessionId: restored.sessionId,
      })
      : createMonitorState(),
  );
  const [controlKey, setControlKey] = useState("");
  const [localFrame, setLocalFrame] = useState(null);
  const [stats, setStats] = useState({ inferenceMs: null, published: 0, quality: "—" });
  const [sceneId, setSceneId] = useState(
    () => restoredControllerSession?.sceneId || "living",
  );
  const [activity, setActivity] = useState(createActivityState);
  const [heartCard, setHeartCard] = useState(null);
  const [moment, setMoment] = useState({ status: "idle", size: 0, mimeType: "" });
  const [fall, setFall] = useState(createFallState);
  const [voice, setVoice] = useState(createVoiceState);
  const [mediaStatus, setMediaStatus] = useState({ state: "idle", detail: "" });

  const videoRef = useRef(null);
  const tokenRef = useRef(null);
  const sessionIdRef = useRef(null);
  const controllerRef = useRef(null);
  const connectControllerRef = useRef(null);
  const reconnectTimerRef = useRef(0);
  const reconnectAttemptRef = useRef(0);
  const leaseExpiresAtRef = useRef(null);
  const failClosedFallRef = useRef(null);
  const fallSyncRef = useRef(null);
  const stopCaptureRef = useRef(null);
  const streamRef = useRef(null);
  const estimatorRef = useRef(null);
  const mediaBridgeRef = useRef(null);
  const animationRef = useRef(0);
  const captureGenerationRef = useRef(0);
  const captureActiveRef = useRef(false);
  const sequenceRef = useRef(0);
  const eventSequenceRef = useRef(0);
  const sceneIdRef = useRef("living");
  const fallDetectorRef = useRef(createFallTransitionDetector());
  const fallRef = useRef(createFallState());
  const fallTimerRef = useRef(0);
  const cookingTrackerRef = useRef(createCookingConfirmationTracker());
  const recognitionUnavailableRef = useRef(false);
  const heartCardRef = useRef(null);
  const momentRecorderRef = useRef(null);
  const momentBlobRef = useRef(null);
  const momentExpiryRef = useRef(0);
  const activeGrantRef = useRef(null);
  const grantExpiryRef = useRef(0);
  const checkInAudioRef = useRef(null);
  const voiceAudioContextRef = useRef(null);
  const voiceCapabilityRef = useRef("unknown");
  const voiceGenerationRef = useRef(0);
  const voicePermissionGenerationRef = useRef(0);
  const voicePermissionPromiseRef = useRef(null);
  const voicePromptRef = useRef(null);
  const voiceRecorderRef = useRef(null);
  const voiceRequestAbortRef = useRef(null);
  const intentionalCloseRef = useRef(false);

  const publishEvent = useCallback((eventType, payload) => {
    const socket = controllerRef.current?.socket;
    const sessionId = sessionIdRef.current;
    if (socket?.readyState !== WebSocket.OPEN || !sessionId) return null;
    const event = createDemoEvent({
      sessionId,
      eventSequence: eventSequenceRef.current,
      timestampMs: Date.now(),
      eventType,
      payload,
    });
    if (!event) return null;
    socket.send(JSON.stringify(event));
    eventSequenceRef.current = advanceControllerEventSequence(
      eventSequenceRef.current,
      event.event_sequence,
    );
    return event;
  }, []);

  const stopLocalMoment = useCallback(() => {
    momentRecorderRef.current?.cancel?.();
    momentRecorderRef.current = null;
    momentBlobRef.current = null;
    window.clearTimeout(momentExpiryRef.current);
    momentExpiryRef.current = 0;
    setMoment({ status: "idle", size: 0, mimeType: "" });
  }, []);

  const revokeActiveGrant = useCallback((reason = "revoked") => {
    const grantId = activeGrantRef.current?.payload?.grant_id;
    if (grantId) {
      const socket = controllerRef.current?.socket;
      const command = createMediaGrantRevoke(grantId);
      if (socket?.readyState === WebSocket.OPEN && command) {
        socket.send(JSON.stringify(command));
      }
      mediaBridgeRef.current?.stopGrant(grantId, reason);
    }
    activeGrantRef.current = null;
    window.clearTimeout(grantExpiryRef.current);
    grantExpiryRef.current = 0;
    setMediaStatus({ state: "idle", detail: "" });
  }, []);

  const clearFallTimer = useCallback(() => {
    window.clearTimeout(fallTimerRef.current);
    fallTimerRef.current = 0;
  }, []);

  const cancelVoiceInteraction = useCallback((nextState = null) => {
    voiceGenerationRef.current += 1;
    voicePromptRef.current?.cancel?.();
    voicePromptRef.current = null;
    voiceRecorderRef.current?.cancel?.();
    voiceRecorderRef.current = null;
    voiceRequestAbortRef.current?.abort?.();
    voiceRequestAbortRef.current = null;
    if (nextState) setVoice(nextState);
  }, []);

  const releaseVoiceResources = useCallback((nextState = createVoiceState()) => {
    voicePermissionGenerationRef.current += 1;
    voicePermissionPromiseRef.current = null;
    if (voiceCapabilityRef.current !== "denied") voiceCapabilityRef.current = "unknown";
    cancelVoiceInteraction(nextState);
    const context = voiceAudioContextRef.current;
    voiceAudioContextRef.current = null;
    void context?.close?.().catch(() => {});
  }, [cancelVoiceInteraction]);

  const preauthorizeMicrophone = useCallback(() => {
    if (voiceCapabilityRef.current === "denied") {
      setVoice(createVoiceState({
        phase: "fallback",
        detail: "麦克风权限未开启，可继续使用“我没事 / 需要帮助”按钮。",
      }));
      return Promise.resolve(false);
    }
    if (
      voiceCapabilityRef.current === "ready"
      && voiceAudioContextRef.current?.state === "running"
    ) return Promise.resolve(true);
    if (voicePermissionPromiseRef.current) return voicePermissionPromiseRef.current;

    const mediaDevices = navigator.mediaDevices;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const generation = voicePermissionGenerationRef.current + 1;
    voicePermissionGenerationRef.current = generation;
    if (!mediaDevices?.getUserMedia || !AudioContextClass) {
      voiceCapabilityRef.current = "unavailable";
      setVoice(createVoiceState({
        phase: "fallback",
        detail: "当前浏览器不支持网页麦克风录音，可继续使用按钮回应。",
      }));
      return Promise.resolve(false);
    }

    setVoice(createVoiceState({
      phase: "preparing",
      detail: VOICE_PHASE_COPY.preparing[1],
    }));
    const attempt = (async () => {
      let context = voiceAudioContextRef.current;
      let stream = null;
      try {
        if (!context || context.state === "closed") {
          context = new AudioContextClass();
          voiceAudioContextRef.current = context;
        }
        await ensureAudioContextRunning(context);
        stream = await mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
        if (
          voicePermissionGenerationRef.current !== generation
          || sceneIdRef.current !== "fall"
        ) return false;
        voiceCapabilityRef.current = "ready";
        setVoice(createVoiceState({
          phase: "ready",
          detail: VOICE_PHASE_COPY.ready[1],
        }));
        return true;
      } catch (error) {
        if (voicePermissionGenerationRef.current !== generation) return false;
        const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
        const suspended = error?.code === "audio_context_suspended";
        voiceCapabilityRef.current = denied ? "denied" : "unavailable";
        setVoice(createVoiceState({
          phase: "fallback",
          detail: denied
            ? "麦克风权限未开启，可继续使用“我没事 / 需要帮助”按钮。"
            : suspended
              ? "浏览器没有解锁语音处理，可点按页面后继续使用按钮回应。"
              : "麦克风暂时不可用，规则倒计时与按钮回应仍然有效。",
        }));
        if (voiceAudioContextRef.current === context) {
          voiceAudioContextRef.current = null;
          await context?.close?.().catch(() => {});
        }
        return false;
      } finally {
        stream?.getTracks?.().forEach((track) => track.stop());
      }
    })();
    voicePermissionPromiseRef.current = attempt;
    void attempt.finally(() => {
      if (voicePermissionPromiseRef.current === attempt) {
        voicePermissionPromiseRef.current = null;
      }
    });
    return attempt;
  }, []);

  useEffect(() => {
    const bridge = createControllerMediaBridge({
      getSocket: () => controllerRef.current?.socket ?? null,
      getStream: () => streamRef.current,
      onStatus: ({ state, viewerId }) => {
        const copy = {
          connected: viewerId ? `评委 ${viewerId.slice(-6)} 已接入短期原画` : "短期原画已连接",
          connecting: "正在建立事件视频通道…",
          failed: "视频连接失败，告警仍保持有效",
          offer_failed: "无法创建视频连接，已回落骨架",
          signal_unavailable: "信令中断，已回落骨架",
          unsupported: "当前浏览器不支持 WebRTC，已回落骨架",
          stream_unavailable: "摄像头轨道不可用，已回落骨架",
        };
        if (copy[state]) setMediaStatus({ state, detail: copy[state] });
      },
    });
    mediaBridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      if (mediaBridgeRef.current === bridge) mediaBridgeRef.current = null;
    };
  }, []);

  const clearReconnectTimer = useCallback(() => {
    window.clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = 0;
  }, []);

  const closeControllerSocket = useCallback(() => {
    const connection = controllerRef.current;
    controllerRef.current = null;
    if (!connection) return;
    window.clearInterval(connection.heartbeat);
    window.clearTimeout(connection.readyTimeout);
    connection.socket.onopen = null;
    connection.socket.onmessage = null;
    connection.socket.onclose = null;
    connection.socket.onerror = null;
    connection.socket.close();
    mediaBridgeRef.current?.stopGrant(null, "socket_closed");
  }, []);

  const invalidateControllerSession = useCallback((error) => {
    clearReconnectTimer();
    intentionalCloseRef.current = true;
    failClosedFallRef.current?.();
    closeControllerSocket();
    clearControllerSession();
    tokenRef.current = null;
    sessionIdRef.current = null;
    leaseExpiresAtRef.current = null;
    sequenceRef.current = 0;
    eventSequenceRef.current = 0;
    reconnectAttemptRef.current = 0;
    void stopCaptureRef.current?.();
    intentionalCloseRef.current = false;
    dispatch({
      type: "session_expired",
      error: error || "短期控制会话已到期，请重新输入密钥。",
    });
  }, [clearReconnectTimer, closeControllerSocket]);

  const scheduleControllerReconnect = useCallback(() => {
    clearReconnectTimer();
    const token = tokenRef.current;
    const expiresAtMs = leaseExpiresAtRef.current;
    if (!token) return;
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
      invalidateControllerSession("短期控制会话已到期，请重新输入密钥。");
      return;
    }
    const attempt = reconnectAttemptRef.current;
    const delayMs = controllerReconnectDelayMs(attempt);
    reconnectAttemptRef.current = attempt + 1;
    dispatch({
      type: "degraded",
      connection: "connecting",
      captureActive: captureActiveRef.current,
      error: captureActiveRef.current
        ? `控制链路中断，摄像头仍在本机运行；${Math.ceil(delayMs / 100) / 10} 秒后自动恢复。`
        : `控制链路中断，${Math.ceil(delayMs / 100) / 10} 秒后自动恢复。`,
    });
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = 0;
      if (tokenRef.current === token) connectControllerRef.current?.(token);
    }, delayMs);
  }, [clearReconnectTimer, invalidateControllerSession]);

  const connectController = useCallback((token) => {
    clearReconnectTimer();
    intentionalCloseRef.current = true;
    closeControllerSocket();
    intentionalCloseRef.current = false;
    dispatch({ type: "controller_connecting" });

    let socket;
    try {
      socket = new WebSocket(
        relayWebSocketUrl("/ws/controller"),
        controllerProtocols(token),
      );
    } catch {
      scheduleControllerReconnect();
      return;
    }

    const connection = { socket, heartbeat: 0, readyTimeout: 0, ready: false };
    controllerRef.current = connection;
    socket.onopen = () => {
      if (controllerRef.current !== connection) return;
      if (socket.protocol !== CONTROLLER_PROTOCOL) {
        socket.close(1002, "unexpected subprotocol");
        return;
      }
      socket.send(JSON.stringify({ type: "heartbeat" }));
      connection.heartbeat = window.setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: "heartbeat" }));
        }
      }, HEARTBEAT_INTERVAL_MS);
      connection.readyTimeout = window.setTimeout(() => {
        if (!connection.ready && socket.readyState === WebSocket.OPEN) {
          socket.close(4000, "controller_ready_timeout");
        }
      }, CONTROLLER_READY_TIMEOUT_MS);
    };
    socket.onmessage = (message) => {
      if (controllerRef.current !== connection || typeof message.data !== "string") return;
      let value;
      try {
        value = JSON.parse(message.data);
      } catch {
        return;
      }
      if (value?.type === "controller_ready") {
        if (!tokenRef.current) return;
        if (!isControllerReady(value) || value.session_id !== sessionIdRef.current) {
          invalidateControllerSession("控制会话校验失败，请重新输入密钥。");
          return;
        }
        const stored = writeControllerSession({
          version: 1,
          token: tokenRef.current,
          sessionId: value.session_id,
          leaseExpiresAtMs: value.lease_expires_at_ms,
          sceneId: sceneIdRef.current,
        }, {
          now: Date.now(),
        });
        if (!stored) {
          invalidateControllerSession("短期控制会话已到期，请重新输入密钥。");
          return;
        }
        connection.ready = true;
        window.clearTimeout(connection.readyTimeout);
        leaseExpiresAtRef.current = value.lease_expires_at_ms;
        sequenceRef.current = value.last_frame_sequence + 1;
        if (value.last_event_sequence >= 0) {
          eventSequenceRef.current = advanceControllerEventSequence(
            eventSequenceRef.current,
            value.last_event_sequence,
          );
        }
        reconnectAttemptRef.current = 0;
        dispatch({ type: "controller_connected" });
        publishEvent("scene_state", {
          scene_id: sceneIdRef.current,
          visual_mode: sceneIdRef.current === "bathroom"
            ? "skeleton_only"
            : "abstract_environment",
        });
        fallSyncRef.current?.();
        return;
      }
      if (!connection.ready) return;
      if (isHeartbeatAck(value)) {
        if (!tokenRef.current || !sessionIdRef.current) return;
        const stored = writeControllerSession({
          version: 1,
          token: tokenRef.current,
          sessionId: sessionIdRef.current,
          leaseExpiresAtMs: value.lease_expires_at_ms,
          sceneId: sceneIdRef.current,
        }, {
          now: Date.now(),
        });
        if (!stored) {
          invalidateControllerSession("短期控制会话已到期，请重新输入密钥。");
          return;
        }
        leaseExpiresAtRef.current = value.lease_expires_at_ms;
        return;
      }
      if (isForwardedMediaSignal(value)) {
        void mediaBridgeRef.current?.handleSignal(value);
        return;
      }
      if (
        value?.type === "event_accepted"
        && Number.isSafeInteger(value.event_sequence)
        && value.event_sequence >= 0
      ) {
        eventSequenceRef.current = advanceControllerEventSequence(
          eventSequenceRef.current,
          value.event_sequence,
        );
        return;
      }
      if (value?.type === "media_grant_accepted" && isDemoEvent(value.grant)) {
        eventSequenceRef.current = advanceControllerEventSequence(
          eventSequenceRef.current,
          value.grant.event_sequence,
        );
        activeGrantRef.current = value.grant;
        const viewerIds = Array.isArray(value.viewer_ids) ? value.viewer_ids : [];
        setMediaStatus({
          state: viewerIds.length ? "connecting" : "waiting_viewer",
          detail: viewerIds.length
            ? `正在向 ${viewerIds.length} 个已在场评委建立短期原画…`
            : "授权已生效，但签发时没有在场评委",
        });
        void mediaBridgeRef.current?.startGrant(value.grant, viewerIds);
        window.clearTimeout(grantExpiryRef.current);
        grantExpiryRef.current = window.setTimeout(() => {
          mediaBridgeRef.current?.stopGrant(value.grant.payload.grant_id, "expired");
          activeGrantRef.current = null;
          setMediaStatus({ state: "expired", detail: "事件视频授权已到期，已回到骨架" });
        }, Math.max(0, value.grant.payload.expires_at_ms - Date.now()));
        return;
      }
      if (value?.type === "media_grant_revoked") {
        const grant = isDemoEvent(value.grant) ? value.grant : null;
        const grantId = grant?.payload?.grant_id || value.grant_id;
        if (grant) {
          eventSequenceRef.current = advanceControllerEventSequence(
            eventSequenceRef.current,
            grant.event_sequence,
          );
        }
        mediaBridgeRef.current?.stopGrant(grantId, "revoked");
        activeGrantRef.current = null;
        window.clearTimeout(grantExpiryRef.current);
        setMediaStatus({ state: "idle", detail: "" });
      }
    };
    socket.onclose = () => {
      if (controllerRef.current !== connection) return;
      window.clearInterval(connection.heartbeat);
      window.clearTimeout(connection.readyTimeout);
      controllerRef.current = null;
      mediaBridgeRef.current?.stopGrant(null, "socket_closed");
      activeGrantRef.current = null;
      window.clearTimeout(grantExpiryRef.current);
      grantExpiryRef.current = 0;
      setMediaStatus({ state: "idle", detail: "" });
      if (!intentionalCloseRef.current) scheduleControllerReconnect();
    };
    socket.onerror = () => socket.close();
  }, [
    clearReconnectTimer,
    closeControllerSocket,
    invalidateControllerSession,
    publishEvent,
    scheduleControllerReconnect,
  ]);

  useEffect(() => {
    connectControllerRef.current = connectController;
    return () => {
      if (connectControllerRef.current === connectController) {
        connectControllerRef.current = null;
      }
    };
  }, [connectController]);

  useEffect(() => {
    const restored = restoredControllerSession;
    if (!restored) return;
    tokenRef.current = restored.token;
    sessionIdRef.current = restored.sessionId;
    leaseExpiresAtRef.current = restored.leaseExpiresAtMs;
    sceneIdRef.current = restored.sceneId;
    sequenceRef.current = 0;
    eventSequenceRef.current = 0;
    reconnectAttemptRef.current = 0;
    connectController(restored.token);
  }, [connectController, restoredControllerSession]);

  const requestMediaGrant = useCallback((eventId, scope, expiresInMs) => {
    const socket = controllerRef.current?.socket;
    const command = createMediaGrantRequest({ eventId, scope, expiresInMs });
    if (socket?.readyState !== WebSocket.OPEN || !command) return false;
    socket.send(JSON.stringify(command));
    return true;
  }, []);

  const resolveFallSafe = useCallback((requestedEventId = null, {
    trigger = null,
    preserveVoice = false,
  } = {}) => {
    const current = fallRef.current;
    const eventId = typeof requestedEventId === "string" ? requestedEventId : current.eventId;
    if (!eventId || current.eventId !== eventId || current.phase === "resolved") return;
    clearFallTimer();
    cancelVoiceInteraction(preserveVoice ? null : createVoiceState({
      phase: "result",
      intent: "safe",
      detail: "本人已通过按钮确认安全。",
    }));
    const resolvedTrigger = trigger || current.trigger || "fall_transition";
    const next = {
      phase: "resolved",
      eventId,
      deadlineMs: null,
      trigger: resolvedTrigger,
      message: "本人已确认安全，本次事件已关闭。",
    };
    fallRef.current = next;
    setFall(next);
    publishEvent("alarm_state", {
      event_id: eventId,
      phase: "resolved",
      trigger: resolvedTrigger,
      message: next.message,
      response_deadline_ms: null,
      media_scope: "none",
    });
    revokeActiveGrant("resolved");
    fallDetectorRef.current.reset();
  }, [cancelVoiceInteraction, clearFallTimer, publishEvent, revokeActiveGrant]);

  const escalateFall = useCallback((eventId, trigger = "check_in_timeout") => {
    if (!eventId || fallRef.current.eventId !== eventId) return;
    if (["escalated", "resolved"].includes(fallRef.current.phase)) return;
    clearFallTimer();
    const voiceTriggered = trigger === "voice_intent";
    const manuallyTriggered = trigger === "elder_need_help";
    cancelVoiceInteraction(voiceTriggered ? null : createVoiceState({
      phase: manuallyTriggered ? "result" : "fallback",
      intent: manuallyTriggered ? "need_help" : null,
      detail: manuallyTriggered
        ? "本人已通过按钮表示需要帮助。"
        : "没有在时限内取得可用语音结果，已按确定性规则告警。",
    }));
    const next = {
      phase: "escalated",
      eventId,
      deadlineMs: null,
      trigger,
      message: voiceTriggered
        ? "语音回应表示需要帮助，已立即通知评委查看。"
        : manuallyTriggered
          ? "本人已表示需要帮助，已立即通知评委查看。"
          : "完整问询窗口没有收到回应，规则已通知评委查看。",
    };
    fallRef.current = next;
    setFall(next);
    publishEvent("alarm_state", {
      event_id: eventId,
      phase: "escalated",
      trigger,
      message: next.message,
      response_deadline_ms: null,
      media_scope: "fall_emergency",
    });
    setMediaStatus({ state: "authorizing", detail: "告警已送达，正在签发 30 秒事件视频授权…" });
    requestMediaGrant(eventId, "fall_emergency", 30_000);
    try {
      navigator.vibrate?.([350, 120, 350, 120, 700]);
    } catch {
      // 振动不可用不影响规则告警。
    }
  }, [cancelVoiceInteraction, clearFallTimer, publishEvent, requestMediaGrant]);

  const failClosedFallCheckIn = useCallback(() => {
    const eventId = selectFailClosedFallEvent(fallRef.current);
    if (!eventId) {
      clearFallTimer();
      return false;
    }
    escalateFall(eventId, "check_in_timeout");
    return true;
  }, [clearFallTimer, escalateFall]);

  useEffect(() => {
    failClosedFallRef.current = failClosedFallCheckIn;
    return () => {
      if (failClosedFallRef.current === failClosedFallCheckIn) {
        failClosedFallRef.current = null;
      }
    };
  }, [failClosedFallCheckIn]);

  const synchronizeFallAfterReconnect = useCallback(() => {
    const current = fallRef.current;
    const action = selectFallReconnectAction(current, Date.now());
    if (action === "none") return false;
    if (action === "escalate") {
      escalateFall(current.eventId, "check_in_timeout");
      return true;
    }

    const published = publishEvent("alarm_state", {
      event_id: current.eventId,
      phase: current.phase,
      trigger: current.trigger || "fall_transition",
      message: current.message || (current.phase === "checking"
        ? "刚才的动作有些突然，您还好吗？"
        : "本次安全事件状态已恢复。"),
      response_deadline_ms: current.phase === "checking" ? current.deadlineMs : null,
      media_scope: current.phase === "escalated" ? "fall_emergency" : "none",
    });

    if (action === "republish_checking") {
      clearFallTimer();
      fallTimerRef.current = window.setTimeout(
        () => escalateFall(current.eventId, "check_in_timeout"),
        Math.max(0, current.deadlineMs - Date.now()),
      );
    } else if (action === "republish_escalated" && published) {
      setMediaStatus({ state: "authorizing", detail: "告警状态已恢复，正在重新签发 30 秒事件视频授权…" });
      requestMediaGrant(current.eventId, "fall_emergency", 30_000);
    }
    return Boolean(published);
  }, [clearFallTimer, escalateFall, publishEvent, requestMediaGrant]);

  useEffect(() => {
    fallSyncRef.current = synchronizeFallAfterReconnect;
    return () => {
      if (fallSyncRef.current === synchronizeFallAfterReconnect) {
        fallSyncRef.current = null;
      }
    };
  }, [synchronizeFallAfterReconnect]);

  const runFallVoiceReply = useCallback(async (eventId, generation, maxDurationMs) => {
    if (
      voiceGenerationRef.current !== generation
      || fallRef.current.eventId !== eventId
      || fallRef.current.phase !== "checking"
    ) return;
    if (
      voiceCapabilityRef.current !== "ready"
      || voiceAudioContextRef.current?.state !== "running"
    ) {
      setVoice(createVoiceState({
        phase: "fallback",
        detail: "麦克风未在用户手势中完成授权，本次继续使用按钮与规则倒计时。",
      }));
      return;
    }
    setVoice(createVoiceState({
      phase: "listening",
      detail: VOICE_PHASE_COPY.listening[1],
    }));
    const recorder = recordVoiceReply({
      audioContext: voiceAudioContextRef.current,
      maxLeadinSilenceMs: maxDurationMs,
      maxDurationMs,
    });
    voiceRecorderRef.current = recorder;
    let requestAbort = null;
    try {
      const audioB64 = await recorder.promise;
      if (voiceRecorderRef.current === recorder) voiceRecorderRef.current = null;
      if (
        voiceGenerationRef.current !== generation
        || fallRef.current.eventId !== eventId
        || fallRef.current.phase !== "checking"
      ) return;
      if (fallRef.current.deadlineMs <= Date.now()) {
        escalateFall(eventId, "check_in_timeout");
        return;
      }
      if (!audioB64) {
        setVoice(createVoiceState({
          phase: "fallback",
          detail: "没有听到清晰人声，规则倒计时继续；也可以直接点击按钮回应。",
        }));
        return;
      }

      setVoice(createVoiceState({
        phase: "transcribing",
        detail: VOICE_PHASE_COPY.transcribing[1],
      }));
      requestAbort = new AbortController();
      voiceRequestAbortRef.current = requestAbort;
      const verdict = await recognizeDangerVoice(getRelayBase(), tokenRef.current, {
        eventId,
        audioB64,
        signal: requestAbort.signal,
      });
      if (voiceRequestAbortRef.current === requestAbort) voiceRequestAbortRef.current = null;
      if (voiceGenerationRef.current !== generation) return;
      const action = selectVoiceIntentAction({
        eventId,
        fall: fallRef.current,
        intent: verdict.intent,
        nowMs: Date.now(),
      });
      if (action === "ignore") return;
      if (action === "expire") {
        escalateFall(eventId, "check_in_timeout");
        return;
      }
      const transcript = verdict.transcript || "未返回可显示的转写";
      const terminalIntent = verdict.intent === "safe" || verdict.intent === "need_help";
      setVoice(createVoiceState({
        phase: "result",
        intent: verdict.intent,
        transcript: terminalIntent ? "" : verdict.transcript || "",
        latencyMs: verdict.latencyMs,
        model: verdict.model,
        detail: verdict.intent === "safe"
          ? "MiMo 已判定为明确安全回应，本次事件已关闭。"
          : verdict.intent === "need_help"
            ? "MiMo 已判定为明确求助回应，已立即升级家庭告警。"
            : `听到“${transcript}”，含义仍不明确，规则倒计时继续。`,
      }));
      if (action === "resolve") {
        resolveFallSafe(eventId, { trigger: "voice_intent", preserveVoice: true });
      } else if (action === "escalate") {
        escalateFall(eventId, "voice_intent");
      }
    } catch (error) {
      if (voiceRecorderRef.current === recorder) voiceRecorderRef.current = null;
      if (voiceRequestAbortRef.current === requestAbort) voiceRequestAbortRef.current = null;
      if (
        error?.name === "AbortError"
        || voiceGenerationRef.current !== generation
        || fallRef.current.eventId !== eventId
        || fallRef.current.phase !== "checking"
      ) return;
      if (fallRef.current.deadlineMs <= Date.now()) {
        escalateFall(eventId, "check_in_timeout");
        return;
      }
      setVoice(createVoiceState({
        phase: "fallback",
        detail: error?.code === "microphone_denied"
          ? "麦克风权限未开启，可继续使用按钮；未回应时仍按规则告警。"
          : "语音识别暂时不可用，规则倒计时与按钮回应仍然有效。",
      }));
    }
  }, [escalateFall, resolveFallSafe]);

  const armFallResponseWindow = useCallback((eventId, generation) => {
    const current = fallRef.current;
    if (
      voiceGenerationRef.current !== generation
      || current.eventId !== eventId
      || current.phase !== "checking"
    ) return;
    const now = Date.now();
    const deadlineMs = Math.min(current.deadlineMs, now + FALL_REPLY_WINDOW_MS);
    if (deadlineMs !== current.deadlineMs) {
      const next = { ...current, deadlineMs };
      fallRef.current = next;
      setFall(next);
      publishEvent("alarm_state", {
        event_id: eventId,
        phase: "checking",
        trigger: "fall_transition",
        message: "刚才的动作有些突然，您还好吗？",
        response_deadline_ms: deadlineMs,
        media_scope: "none",
      });
      clearFallTimer();
      fallTimerRef.current = window.setTimeout(
        () => escalateFall(eventId, "check_in_timeout"),
        Math.max(0, deadlineMs - Date.now()),
      );
    }
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      escalateFall(eventId, "check_in_timeout");
      return;
    }
    void runFallVoiceReply(eventId, generation, Math.min(FALL_REPLY_WINDOW_MS, remainingMs));
  }, [clearFallTimer, escalateFall, publishEvent, runFallVoiceReply]);

  const startFallCheckIn = useCallback((transition) => {
    if (sceneIdRef.current !== "fall" || fallRef.current.phase !== "idle") return;
    cancelVoiceInteraction(createVoiceState({
      phase: "prompt",
      detail: VOICE_PHASE_COPY.prompt[1],
    }));
    const generation = voiceGenerationRef.current;
    const eventId = randomId("fall");
    const audio = checkInAudioRef.current;
    const promptLeadMs = estimatePromptLeadMs(audio?.duration, FALL_PROMPT_FALLBACK_MS);
    const deadlineMs = Date.now() + promptLeadMs + FALL_REPLY_WINDOW_MS;
    const next = {
      phase: "checking",
      eventId,
      deadlineMs,
      trigger: "fall_transition",
      message: "检测到真实姿态快速下移并转为横向，正在询问：您还好吗？",
      evidenceScore: transition.evidence_score,
    };
    fallRef.current = next;
    setFall(next);
    publishEvent("alarm_state", {
      event_id: eventId,
      phase: "checking",
      trigger: "fall_transition",
      message: "刚才的动作有些突然，您还好吗？",
      response_deadline_ms: deadlineMs,
      media_scope: "none",
    });
    clearFallTimer();
    fallTimerRef.current = window.setTimeout(
      () => escalateFall(eventId, "check_in_timeout"),
      Math.max(0, deadlineMs - Date.now()),
    );
    try {
      navigator.vibrate?.([140, 90, 140]);
    } catch {
      // 振动仅为可选反馈。
    }

    if (!audio) {
      armFallResponseWindow(eventId, generation);
      return;
    }
    let settled = false;
    let watchdog = 0;
    const cleanup = () => {
      window.clearTimeout(watchdog);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
    };
    const finish = (stopAudio = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopAudio) {
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          // 音频元素失败时直接进入回应窗。
        }
      }
      voicePromptRef.current = null;
      armFallResponseWindow(eventId, generation);
    };
    const onEnded = () => finish(false);
    const onError = () => finish(true);
    voicePromptRef.current = {
      cancel() {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          audio.pause();
          audio.currentTime = 0;
        } catch {
          // 释放流程继续。
        }
      },
    };
    audio.addEventListener("ended", onEnded, { once: true });
    audio.addEventListener("error", onError, { once: true });
    watchdog = window.setTimeout(() => finish(true), FALL_PROMPT_WATCHDOG_MS);
    try {
      audio.currentTime = 0;
      void audio.play().catch(() => finish(true));
    } catch {
      finish(true);
    }
  }, [armFallResponseWindow, cancelVoiceInteraction, clearFallTimer, escalateFall, publishEvent]);

  const updateHeartCard = useCallback((shareState) => {
    const current = heartCardRef.current;
    if (!current) return null;
    const next = { ...current, share_state: shareState };
    heartCardRef.current = next;
    setHeartCard(next);
    publishEvent("care_card", next);
    return next;
  }, [publishEvent]);

  const consentKitchenMoment = useCallback(() => {
    const card = updateHeartCard("consented");
    if (!card) return;
    setMediaStatus({ state: "authorizing", detail: "本人已同意，正在签发 15 秒厨房时刻授权…" });
    requestMediaGrant(card.event_id, "kitchen_moment", 15_000);
  }, [requestMediaGrant, updateHeartCard]);

  const denyKitchenMoment = useCallback(() => {
    updateHeartCard("denied");
    revokeActiveGrant("denied");
    stopLocalMoment();
  }, [revokeActiveGrant, stopLocalMoment, updateHeartCard]);

  const selectScene = useCallback((nextSceneId) => {
    if (!DEMO_SCENES.some((scene) => scene.id === nextSceneId)) return;
    if (selectFailClosedFallEvent(fallRef.current)) {
      failClosedFallCheckIn();
      return;
    }
    if (heartCardRef.current && !["denied", "expired"].includes(heartCardRef.current.share_state)) {
      updateHeartCard("expired");
    }
    revokeActiveGrant("scene_changed");
    stopLocalMoment();
    clearFallTimer();
    releaseVoiceResources(createVoiceState({
      detail: nextSceneId === "fall"
        ? "正在准备事件触发式语音回应。"
        : VOICE_PHASE_COPY.idle[1],
    }));
    cookingTrackerRef.current.reset();
    recognitionUnavailableRef.current = false;
    fallDetectorRef.current.reset();
    const emptyFall = createFallState();
    fallRef.current = emptyFall;
    heartCardRef.current = null;
    sceneIdRef.current = nextSceneId;
    setSceneId(nextSceneId);
    updateControllerSession({ sceneId: nextSceneId }, {
      now: Date.now(),
    });
    setActivity(createActivityState());
    setHeartCard(null);
    setFall(emptyFall);
    publishEvent("scene_state", {
      scene_id: nextSceneId,
      visual_mode: nextSceneId === "bathroom" ? "skeleton_only" : "abstract_environment",
    });
    if (nextSceneId === "fall") void preauthorizeMicrophone();
  }, [
    clearFallTimer,
    failClosedFallCheckIn,
    preauthorizeMicrophone,
    publishEvent,
    releaseVoiceResources,
    revokeActiveGrant,
    stopLocalMoment,
    updateHeartCard,
  ]);

  const stopCapture = useCallback(async () => {
    captureGenerationRef.current += 1;
    captureActiveRef.current = false;
    window.cancelAnimationFrame(animationRef.current);
    animationRef.current = 0;
    failClosedFallCheckIn();
    releaseVoiceResources();
    mediaBridgeRef.current?.stopGrant(null, "capture_stopped");
    stopLocalMoment();

    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) videoRef.current.srcObject = null;

    const estimator = estimatorRef.current;
    estimatorRef.current = null;
    if (estimator) {
      try {
        await estimator.dispose();
      } catch {
        // 资源已经从页面引用中移除，释放失败不掩盖后续 UI 状态。
      }
    }
    setLocalFrame(null);
  }, [failClosedFallCheckIn, releaseVoiceResources, stopLocalMoment]);

  useEffect(() => {
    stopCaptureRef.current = stopCapture;
    return () => {
      if (stopCaptureRef.current === stopCapture) stopCaptureRef.current = null;
    };
  }, [stopCapture]);

  const unlock = useCallback(async (event) => {
    event.preventDefault();
    const key = controlKey.trim();
    if (!key) return;
    dispatch({ type: "unlocking" });
    try {
      const response = await fetch(relayHttpUrl("/api/unlock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const payload = await response.json().catch(() => null);
      if (
        !response.ok
        || !payload?.ok
        || !payload.token
        || !payload.session_id
        || !Number.isFinite(payload.lease_expires_at_ms)
      ) {
        dispatch({ type: "degraded", error: unlockError(response, payload) });
        return;
      }

      const stored = writeControllerSession({
        version: 1,
        token: payload.token,
        sessionId: payload.session_id,
        leaseExpiresAtMs: payload.lease_expires_at_ms,
        sceneId: sceneIdRef.current,
      }, {
        now: Date.now(),
      });
      setControlKey("");
      if (!stored) {
        await fetch(relayHttpUrl("/api/release"), {
          method: "POST",
          headers: { Authorization: `Bearer ${payload.token}` },
        }).catch(() => null);
        dispatch({
          type: "degraded",
          error: "当前浏览器无法保存短期控制会话，请退出隐私模式或允许会话存储后重试。",
        });
        return;
      }

      tokenRef.current = payload.token;
      sessionIdRef.current = payload.session_id;
      leaseExpiresAtRef.current = payload.lease_expires_at_ms;
      sequenceRef.current = 0;
      eventSequenceRef.current = 0;
      reconnectAttemptRef.current = 0;
      dispatch({ type: "unlocked", sessionId: payload.session_id });
      connectController(payload.token);
    } catch {
      dispatch({ type: "degraded", error: "无法连接控制服务，请确认网络后重试。" });
    }
  }, [connectController, controlKey]);

  const startCapture = useCallback(async () => {
    if (captureActiveRef.current || ui.connection !== "connected") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: "degraded", error: "当前浏览器不支持摄像头采集。" });
      return;
    }

    dispatch({ type: "starting" });
    if (sceneIdRef.current === "fall") void preauthorizeMicrophone();
    const checkInAudio = new Audio("/voice/fall_check_in.m4a");
    checkInAudio.preload = "auto";
    checkInAudioRef.current = checkInAudio;
    try {
      checkInAudio.muted = true;
      const unlockAudio = checkInAudio.play();
      unlockAudio?.then(() => {
        checkInAudio.pause();
        checkInAudio.currentTime = 0;
        checkInAudio.muted = false;
      }).catch(() => {
        checkInAudio.muted = false;
      });
    } catch {
      checkInAudio.muted = false;
    }
    const generation = captureGenerationRef.current + 1;
    captureGenerationRef.current = generation;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      streamRef.current = stream;
      const estimator = await createMoveNetBrowserEstimator();
      if (captureGenerationRef.current !== generation) {
        stream.getTracks().forEach((track) => track.stop());
        await estimator.dispose();
        return;
      }

      estimatorRef.current = estimator;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();
      await waitForVideo(video);
      captureActiveRef.current = true;
      setStats({ inferenceMs: null, published: 0, quality: "准备首帧" });

      const socketReady = controllerRef.current?.socket.readyState === WebSocket.OPEN;
      if (socketReady) {
        dispatch({ type: "live" });
      } else {
        dispatch({
          type: "degraded",
          connection: "disconnected",
          captureActive: true,
          error: "摄像头已在本机运行，但中继未连接，暂未向评委发布。",
        });
      }

      let lastAttemptMs = -MIN_PUBLISH_INTERVAL_MS;
      const sample = async () => {
        try {
          const result = await estimator.infer(video);
          if (captureGenerationRef.current !== generation) return;
          const frame = createPoseFrame({
            sessionId: ui.sessionId,
            sequence: sequenceRef.current,
            timestampMs: Date.now(),
            sourceWidth: video.videoWidth,
            sourceHeight: video.videoHeight,
            personDetected: result.person_detected,
            landmarkQuality: result.landmark_quality,
            keypoints: result.keypoints,
          });
          if (!frame) {
            throw new Error("姿态结果不符合 17 点发布合同");
          }
          setLocalFrame(frame);
          if (sceneIdRef.current === "fall") {
            const fallResult = fallDetectorRef.current.push(frame);
            if (fallResult.event) startFallCheckIn(fallResult.event);
          }
          const activeSocket = controllerRef.current?.socket;
          if (activeSocket?.readyState === WebSocket.OPEN) {
            activeSocket.send(JSON.stringify(frame));
            sequenceRef.current += 1;
            setStats((current) => ({
              inferenceMs: result.inference_ms,
              published: current.published + 1,
              quality: result.landmark_quality,
            }));
          } else {
            setStats((current) => ({
              ...current,
              inferenceMs: result.inference_ms,
              quality: result.landmark_quality,
            }));
          }
        } catch (error) {
          if (captureGenerationRef.current !== generation) return;
          await stopCapture();
          dispatch({
            type: "degraded",
            captureActive: false,
            error: `姿态模型已停止：${error instanceof Error ? error.message : "推理失败"}`,
          });
          return;
        }
        if (captureGenerationRef.current === generation) {
          animationRef.current = window.requestAnimationFrame(loop);
        }
      };
      const loop = (nowMs) => {
        if (captureGenerationRef.current !== generation) return;
        if (nowMs - lastAttemptMs < MIN_PUBLISH_INTERVAL_MS) {
          animationRef.current = window.requestAnimationFrame(loop);
          return;
        }
        lastAttemptMs = nowMs;
        void sample();
      };
      animationRef.current = window.requestAnimationFrame(loop);
    } catch (error) {
      if (captureGenerationRef.current !== generation) return;
      await stopCapture();
      dispatch({
        type: "degraded",
        captureActive: false,
        error: `无法开始采集：${error instanceof Error ? error.message : "摄像头或模型不可用"}`,
      });
    }
  }, [preauthorizeMicrophone, startFallCheckIn, stopCapture, ui.connection, ui.sessionId]);

  const stopOnly = useCallback(async () => {
    revokeActiveGrant("capture_stopped");
    await stopCapture();
    dispatch({ type: "capture_stopped" });
  }, [revokeActiveGrant, stopCapture]);

  const releaseControl = useCallback(async () => {
    const token = tokenRef.current;
    intentionalCloseRef.current = true;
    clearReconnectTimer();
    clearControllerSession();
    tokenRef.current = null;
    sessionIdRef.current = null;
    leaseExpiresAtRef.current = null;
    const releaseRequest = token
      ? fetch(relayHttpUrl("/api/release"), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null)
      : Promise.resolve(null);
    await stopCapture();
    await releaseRequest;
    closeControllerSocket();
    sequenceRef.current = 0;
    eventSequenceRef.current = 0;
    reconnectAttemptRef.current = 0;
    intentionalCloseRef.current = false;
    dispatch({ type: "released" });
  }, [clearReconnectTimer, closeControllerSocket, stopCapture]);

  const retryConnection = useCallback(() => {
    const token = tokenRef.current;
    if (!token) return;
    clearReconnectTimer();
    connectController(token);
  }, [clearReconnectTimer, connectController]);

  useEffect(() => {
    if (
      sceneId !== "kitchen"
      || !ui.captureActive
      || ui.connection !== "connected"
      || !tokenRef.current
    ) return undefined;
    let cancelled = false;
    let inFlight = false;
    let interval = 0;
    const run = async () => {
      if (
        cancelled
        || inFlight
        || recognitionUnavailableRef.current
        || heartCardRef.current
      ) return;
      const imageB64 = captureJpegBase64(videoRef.current);
      if (!imageB64) return;
      inFlight = true;
      setActivity((current) => ({
        ...current,
        phase: "sampling",
        reason: "一张降采样 JPEG 正在显式发送给 MiMo 做活动判定。",
      }));
      publishEvent("activity_state", {
        activity: "cooking",
        phase: "sampling",
        source: "mimo_visual",
        confidence: null,
        reason: "最小视觉样本已发送，等待判定。",
      });
      try {
        const verdict = await recognizeCooking(
          getRelayBase(),
          tokenRef.current,
          imageB64,
        );
        if (cancelled || sceneIdRef.current !== "kitchen") return;
        const tracked = cookingTrackerRef.current.push(verdict);
        const reason = verdict.reason.slice(0, 240);
        setActivity({
          phase: tracked.phase,
          classification: verdict.classification,
          confidence: verdict.confidence,
          reason,
          latencyMs: verdict.latencyMs,
          model: verdict.model,
          consecutive: tracked.consecutive,
        });
        publishEvent("activity_state", {
          activity: "cooking",
          phase: tracked.phase,
          source: "mimo_visual",
          confidence: verdict.confidence,
          reason,
        });
        if (tracked.confirmed && !heartCardRef.current) {
          const eventId = randomId("cooking");
          const card = {
            card_id: randomId("heartbeat"),
            event_id: eventId,
            kind: "family_heartbeat",
            title: "厨房里的家庭心跳",
            body: "连续两次视觉判定观察到做饭活动；短时刻只在本机暂存，等待本人决定是否分享。",
            occurred_at_ms: Date.now(),
            share_state: "consent_pending",
          };
          heartCardRef.current = card;
          setHeartCard(card);
          publishEvent("care_card", card);
          const recorder = recordLocalMoment(streamRef.current);
          momentRecorderRef.current = recorder;
          setMoment({ status: "recording", size: 0, mimeType: "" });
          void recorder.promise.then((recorded) => {
            if (cancelled || momentRecorderRef.current !== recorder) return;
            momentRecorderRef.current = null;
            if (!recorded) {
              setMoment({ status: "unavailable", size: 0, mimeType: "" });
              return;
            }
            momentBlobRef.current = recorded.blob;
            setMoment({
              status: "ready",
              size: recorded.blob.size,
              mimeType: recorded.mimeType,
            });
            window.clearTimeout(momentExpiryRef.current);
            momentExpiryRef.current = window.setTimeout(() => {
              if (heartCardRef.current) updateHeartCard("expired");
              stopLocalMoment();
            }, 60_000);
          });
        }
      } catch (error) {
        if (cancelled) return;
        recognitionUnavailableRef.current = true;
        const reason = error instanceof Error ? error.message.slice(0, 240) : "活动识别不可用";
        setActivity({
          phase: "unavailable",
          classification: null,
          confidence: null,
          reason,
          latencyMs: null,
          model: "",
          consecutive: 0,
        });
        publishEvent("activity_state", {
          activity: "cooking",
          phase: "unavailable",
          source: "mimo_visual",
          confidence: null,
          reason,
        });
      } finally {
        inFlight = false;
      }
    };
    const first = window.setTimeout(() => void run(), 800);
    interval = window.setInterval(() => void run(), COOKING_SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [publishEvent, sceneId, stopLocalMoment, ui.captureActive, ui.connection, updateHeartCard]);

  useEffect(() => {
    const suspendController = () => {
      intentionalCloseRef.current = true;
      clearReconnectTimer();
      failClosedFallCheckIn();
      closeControllerSocket();
      void stopCapture();
      intentionalCloseRef.current = false;
    };
    const resumeController = () => {
      const token = tokenRef.current;
      if (!token || controllerRef.current) return;
      intentionalCloseRef.current = false;
      clearReconnectTimer();
      dispatch({ type: "capture_stopped" });
      connectControllerRef.current?.(token);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        const checkingEventId = selectFailClosedFallEvent(fallRef.current);
        releaseVoiceResources(checkingEventId
          ? createVoiceState({
            phase: "fallback",
            detail: "页面已隐藏，麦克风已停止；规则倒计时仍会继续。",
          })
          : createVoiceState());
        return;
      }
      const current = fallRef.current;
      if (
        selectFailClosedFallEvent(current)
        && Number.isFinite(current.deadlineMs)
        && current.deadlineMs <= Date.now()
      ) failClosedFallCheckIn();
    };
    window.addEventListener("pagehide", suspendController);
    window.addEventListener("pageshow", resumeController);
    window.addEventListener("online", resumeController);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("pagehide", suspendController);
      window.removeEventListener("pageshow", resumeController);
      window.removeEventListener("online", resumeController);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      suspendController();
    };
  }, [
    clearReconnectTimer,
    closeControllerSocket,
    failClosedFallCheckIn,
    releaseVoiceResources,
    stopCapture,
  ]);

  const locked = ui.phase === "locked" || (ui.phase === "degraded" && !ui.sessionId);
  const canStart = ui.connection === "connected" && !ui.captureActive && ui.phase !== "starting";
  const activeScene = DEMO_SCENES.find((scene) => scene.id === sceneId) || DEMO_SCENES[0];

  return (
    <div className="demo-shell monitor-role">
      <header className="demo-header">
        <a className="demo-brand" href="https://reme.maniforld.com/" aria-label="返回 Reme 评委旁观端">
          <span className="brand-mark">R</span>
          <span><b>Reme</b><small>现场采集控制台</small></span>
        </a>
        <div className={`role-lockup ${locked ? "is-locked" : "is-unlocked"}`}>
          <span className="role-pill monitor-pill">唯一监控端</span>
          {!locked && (
            <span className={`connection-pill is-${ui.connection}`}>
              <i />{ui.connection === "connected"
                ? "控制租约在线"
                : ui.connection === "connecting"
                  ? "自动恢复中"
                  : "控制链路中断"}
            </span>
          )}
        </div>
      </header>

      {locked ? (
        <main className="unlock-layout">
          <section className="unlock-copy">
            <div className="eyebrow">MONITOR ACCESS</div>
            <h1>监控入口<br />与旁观入口分开。</h1>
            <p>只有一台设备可以取得控制租约。原始密钥不会保存；本标签页只保留可跨刷新的短期控制凭证。</p>
            <div className="boundary-list">
              <span><i>1</i>解锁唯一控制租约</span>
              <span><i>2</i>主动授权摄像头；跌倒场景预授权麦克风后立即释放</span>
              <span><i>3</i>默认只发布骨架与结构化事件</span>
              <span><i>4</i>厨房同意或跌倒告警后才短期开原画</span>
            </div>
          </section>
          <form className="unlock-card" onSubmit={unlock} autoComplete="off">
            <span className="key-icon" aria-hidden="true"><KeyRoundedIcon /></span>
            <h2>输入控制密钥</h2>
            <p>评委访问首页无需密钥，也无法进入此控制台。</p>
            <label htmlFor="control-key">本次演示密钥</label>
            <input
              id="control-key"
              name="reme-demo-control-key"
              type="password"
              value={controlKey}
              onChange={(event) => setControlKey(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              disabled={ui.phase === "unlocking"}
              placeholder="••••••••••••"
            />
            {ui.error && <p className="form-error" role="alert">{ui.error}</p>}
            <button className="primary-action" type="submit" disabled={!controlKey.trim() || ui.phase === "unlocking"}>
              {ui.phase === "unlocking" ? "正在验证…" : "解锁监控端"}
            </button>
            <small>原始密钥不保存；短期凭证仅存本标签页，释放控制权或关闭标签页后失效。</small>
          </form>
        </main>
      ) : (
        <main className="monitor-layout">
          <section className="monitor-visual-column">
            <div className="monitor-stage">
              <video
                ref={videoRef}
                muted
                playsInline
                className={`camera-preview ${sceneId === "bathroom" ? "is-privacy-hidden" : ""}`}
              />
              <div className="stage-grid" />
              <SkeletonStage frame={localFrame} color="#ff5a00" className="monitor-skeleton" />
              {!ui.captureActive && (
                <div className="stage-placeholder compact">
                  <span className="camera-glyph" aria-hidden="true"><CameraAltRoundedIcon /></span>
                  <b>{ui.phase === "starting" ? "正在加载摄像头与模型…" : "摄像头尚未开启"}</b>
                  <p>只有点击下方按钮后才申请摄像头；跌倒场景会同时准备麦克风权限，但事件前不监听。</p>
                </div>
              )}
              <div className="stage-topline">
                <span><i className={ui.phase === "live" ? "live-dot" : "wait-dot"} />{ui.phase === "live" ? "PUBLISHING" : "LOCAL / PAUSED"}</span>
                <span>{sceneId === "bathroom" ? "完全隐私 · 画面本机也已遮蔽" : "原始画面默认仅在本机"}</span>
              </div>
            </div>
            <div
              className={`monitor-scene-summary is-${sceneId}`}
              role="status"
              aria-live="polite"
            >
              <small>{activeScene.number}</small>
              <span>
                <b>{activeScene.label}</b>
                <em>{activeScene.detail}</em>
              </span>
            </div>
          </section>

          <aside className="control-panel">
            <div>
              <div className="eyebrow">CONTROLLER</div>
              <h1>四场景监控端</h1>
              <p className="intro-copy">后置摄像头在本机运行自训练 MoveNet。骨架、事件、授权视频与事件语音保持独立通道。</p>
            </div>

            <nav className="monitor-scene-tabs" aria-label="选择演示场景">
              {DEMO_SCENES.map((scene) => {
                const SceneIcon = scene.Icon;
                const className = [
                  sceneId === scene.id ? "is-active" : "",
                  scene.id === "fall" && fall.phase === "escalated" ? "has-alert" : "",
                ].filter(Boolean).join(" ");
                return (
                  <button
                    type="button"
                    key={scene.id}
                    className={className}
                    aria-label={`${scene.label}场景：${scene.detail}`}
                    aria-pressed={sceneId === scene.id}
                    onClick={() => selectScene(scene.id)}
                  >
                    <SceneIcon className="scene-tab-icon" aria-hidden="true" />
                    <span>{scene.shortLabel}</span>
                    <small>{scene.number}</small>
                  </button>
                );
              })}
            </nav>

            {ui.error && (
              <div className="degraded-card" role="alert">
                <b>已明确降级</b>
                <p>{ui.error}</p>
                {ui.connection !== "connected" && (
                  <button type="button" className="secondary-action" onClick={retryConnection}>立即重试连接</button>
                )}
                <a href="/typical-demo.html">改用单机演示备份</a>
              </div>
            )}

            <dl className="session-facts compact-facts">
              <div><dt>会话</dt><dd title={ui.sessionId}>{ui.sessionId ? `…${ui.sessionId.slice(-12)}` : "—"}</dd></div>
              <div><dt>发布帧</dt><dd>{stats.published}</dd></div>
              <div><dt>单帧推理</dt><dd>{Number.isFinite(stats.inferenceMs) ? `${stats.inferenceMs.toFixed(1)} ms` : "—"}</dd></div>
              <div><dt>骨架质量</dt><dd>{stats.quality}</dd></div>
            </dl>

            {sceneId === "living" && (
              <div className="scenario-card is-living">
                <b>日常 · 通用环境抽象</b>
                <p>评委端会用固定虚拟家具衬托同一火柴人；这不是对真实家庭家具的重建。</p>
              </div>
            )}

            {sceneId === "bathroom" && (
              <div className="scenario-card is-private">
                <b>完全隐私已强制开启</b>
                <p>两端都只显示火柴人；环境、原画和事件视频按钮全部 fail closed。</p>
              </div>
            )}

            {sceneId === "kitchen" && (
              <div className={`scenario-card activity-card is-${activity.phase}`}>
                <div className="scenario-card-head">
                  <b>实验做饭识别</b>
                  <span>{activity.phase === "sampling" ? "识别中"
                    : activity.phase === "confirmed" ? "连续确认"
                      : activity.phase === "unavailable" ? "不可用"
                        : "观察中"}</span>
                </div>
                <p>{activity.reason}</p>
                <dl className="mini-metrics">
                  <div><dt>MiMo 结果</dt><dd>{activity.classification || "—"}</dd></div>
                  <div><dt>置信度</dt><dd>{Number.isFinite(activity.confidence) ? `${Math.round(activity.confidence * 100)}%` : "—"}</dd></div>
                  <div><dt>连续证据</dt><dd>{activity.consecutive}/2</dd></div>
                  <div><dt>延迟</dt><dd>{Number.isFinite(activity.latencyMs) ? `${Math.round(activity.latencyMs)} ms` : "—"}</dd></div>
                </dl>
                {heartCard && (
                  <div className="consent-card" role="status">
                    <b>{heartCard.title}</b>
                    <p>{heartCard.body}</p>
                    <small>本地短时刻：{moment.status === "recording" ? "录制中"
                      : moment.status === "ready" ? `${Math.ceil(moment.size / 1024)} KB · 内存暂存`
                        : moment.status === "unavailable" ? "浏览器不支持录制"
                          : "已清理"}</small>
                    {heartCard.share_state === "consent_pending" && (
                      <div className="consent-actions">
                        <button type="button" className="primary-action" onClick={consentKitchenMoment}>本人同意分享 15 秒现场</button>
                        <button type="button" className="release-action" onClick={denyKitchenMoment}>不同意，仅保留心跳卡</button>
                      </div>
                    )}
                    {heartCard.share_state !== "consent_pending" && (
                      <small>授权状态：{heartCard.share_state}</small>
                    )}
                  </div>
                )}
              </div>
            )}

            {sceneId === "fall" && (
              <div className={`scenario-card fall-card is-${fall.phase}`}>
                <div className="scenario-card-head">
                  <b>真实姿态跌倒链路</b>
                  <span>{fall.phase === "idle" ? "规则待命"
                    : fall.phase === "checking" ? "正在问询"
                      : fall.phase === "escalated" ? "已告警"
                        : "已关闭"}</span>
                </div>
                <p>{fall.message}</p>
                <div
                  className={`voice-status-card is-${voice.phase} is-${voice.intent || "none"}`}
                  role={voice.phase === "fallback" ? "alert" : "status"}
                  aria-live="polite"
                >
                  <div className="voice-status-head">
                    <b>{VOICE_PHASE_COPY[voice.phase]?.[0] || "语音回应"}</b>
                    <span>{voice.phase === "listening" ? "MIC ON"
                      : voice.phase === "transcribing" ? "MIMO"
                        : "EVENT ONLY"}</span>
                  </div>
                  <p>{voice.detail}</p>
                  {voice.transcript && fall.phase === "checking" && (
                    <q>{voice.transcript}</q>
                  )}
                  {(voice.model || Number.isFinite(voice.latencyMs)) && (
                    <small>{voice.model || "MiMo"}{Number.isFinite(voice.latencyMs)
                      ? ` · ${Math.round(voice.latencyMs)} ms`
                      : ""}</small>
                  )}
                </div>
                {fall.phase === "checking" && (
                  <>
                    <small>问询播放完成后，在冻结的回应截止时间内短时收音；此阶段评委仍只看骨架。</small>
                    <div className="consent-actions">
                      <button type="button" className="secondary-action" onClick={resolveFallSafe}>我没事</button>
                      <button type="button" className="primary-action danger-action" onClick={() => escalateFall(fall.eventId, "elder_need_help")}>需要帮助</button>
                    </div>
                  </>
                )}
                {fall.phase === "escalated" && (
                  <button type="button" className="secondary-action" onClick={resolveFallSafe}>本人已确认安全，关闭事件</button>
                )}
              </div>
            )}

            {mediaStatus.state !== "idle" && (
              <div className={`media-status is-${mediaStatus.state}`} role="status">
                <b>事件视频通道</b>
                <p>{mediaStatus.detail}</p>
              </div>
            )}

            <div className="control-actions">
              {!ui.captureActive ? (
                <button type="button" className="primary-action" onClick={startCapture} disabled={!canStart}>
                  {ui.phase === "starting" ? "正在启动…"
                    : sceneId === "fall" ? "开启摄像头并准备语音" : "开启后置摄像头"}
                </button>
              ) : (
                <button type="button" className="secondary-action" onClick={stopOnly}>停止采集</button>
              )}
              <button type="button" className="release-action" onClick={releaseControl}>释放控制权</button>
            </div>
            <small className="control-footnote">释放后会停止摄像头与麦克风、撤销事件视频，并允许下一台设备取得控制权。语音只在跌倒问询后短时上传。</small>
          </aside>
        </main>
      )}

      <footer className="demo-footer">
        <span>Reme Monitor · 控制入口</span>
        <a href="https://reme.maniforld.com/">查看评委只读页</a>
      </footer>
    </div>
  );
}
