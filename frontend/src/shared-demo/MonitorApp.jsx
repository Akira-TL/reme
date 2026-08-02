import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
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
  classifyCookingConfirmationAck,
  createCookingConfirmationTracker,
  isCookingRecognitionContextCurrent,
  recognizeCooking,
  recordLocalMoment,
} from "./activityRecognition.js";
import {
  recognizeScene,
  recordAutomaticSceneSample,
  selectAutomaticSceneAction,
} from "./automaticSceneRecognition.js";
import { getRelayBase, relayHttpUrl, relayWebSocketUrl } from "./config.js";
import {
  createControllerMediaBridge,
  createMediaGrantRequestTracker,
} from "./controllerMedia.js";
import {
  clearPendingFallRecovery,
  clearControllerSession,
  controllerReconnectDelayMs,
  readControllerSession,
  readPendingFallRecovery,
  updateControllerSession,
  writePendingFallRecovery,
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
  isMediaGrantError,
} from "./protocol.js";
import { SkeletonStage } from "./SkeletonStage.jsx";
import { createMonitorState, reduceMonitorState } from "./state.js";
import {
  applyAlarmDeliveryAck,
  estimatePromptLeadMs,
  prepareFallRecoveryForNewSession,
  reconcileFallWithAuthoritativeAlarm,
  recognizeDangerVoice,
  selectControlReleaseAction,
  selectFailClosedFallEvent,
  selectFallCheckInStartAction,
  selectFallInterruptionAction,
  selectFallExitAction,
  selectFallResolutionAction,
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
const RELEASE_TIMEOUT_MS = 6_000;
const AUTOMATIC_SCENE_SAMPLE_MS = 2_000;
const AUTOMATIC_SCENE_REQUEST_TIMEOUT_MS = 10_000;
// Feasibility-only starting guardrail. This is not a calibrated probability or accepted product threshold.
const PROVISIONAL_AUTO_SCENE_CONFIDENCE = 0.65;

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
    delivery: "none",
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

function createAutomaticSceneState(reason = "点击后仅上传一次最小视觉样本，由 MiMo 选择四种展示模式之一。") {
  return {
    phase: "idle",
    accepted: null,
    decision: null,
    classification: null,
    confidence: null,
    reason,
    latencyMs: null,
    visualKind: null,
    durationMs: null,
    temporalEvidence: null,
  };
}

function waitForDisclosurePaint(signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let firstFrame = 0;
    let secondFrame = 0;
    let fallbackTimer = 0;
    const cleanup = () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(fallbackTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new DOMException("自动场景识别已取消", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(finish);
    });
    fallbackTimer = window.setTimeout(finish, 180);
  });
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
  const [restoredPendingFall] = useState(() => {
    const pending = readPendingFallRecovery({ now: Date.now() });
    if (
      restoredControllerSession?.fall?.phase === "resolved"
      && restoredControllerSession.fall.delivery === "accepted"
    ) {
      clearPendingFallRecovery();
      return null;
    }
    return pending;
  });
  const authoritativeRestoredFall = restoredControllerSession?.fall?.phase === "resolved"
    && restoredControllerSession.fall.delivery === "accepted"
    ? restoredControllerSession.fall
    : restoredPendingFall || restoredControllerSession?.fall || createFallState();
  const authoritativeRestoredScene = authoritativeRestoredFall.phase === "idle"
    ? restoredControllerSession?.sceneId || "living"
    : "fall";
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
  const [sceneId, setSceneId] = useState(authoritativeRestoredScene);
  const [sceneSelectionSource, setSceneSelectionSource] = useState(
    () => restoredControllerSession ? "restored" : "manual",
  );
  const [fallDetectionArmed, setFallDetectionArmed] = useState(false);
  const [activity, setActivity] = useState(createActivityState);
  const [heartCard, setHeartCard] = useState(null);
  const [kitchenLiveEventId, setKitchenLiveEventId] = useState(null);
  const [moment, setMoment] = useState({ status: "idle", size: 0, mimeType: "" });
  const [fall, setFall] = useState(authoritativeRestoredFall);
  const [voice, setVoice] = useState(createVoiceState);
  const [mediaStatus, setMediaStatus] = useState({ state: "idle", detail: "" });
  const [sessionPersistenceHealthy, setSessionPersistenceHealthy] = useState(true);
  const [automaticScene, setAutomaticScene] = useState(createAutomaticSceneState);

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
  const sceneIdRef = useRef(authoritativeRestoredScene);
  const fallDetectorRef = useRef(createFallTransitionDetector());
  const fallRef = useRef(authoritativeRestoredFall);
  const fallTimerRef = useRef(0);
  const pendingAlarmAckRef = useRef(null);
  const sessionPersistenceHealthyRef = useRef(true);
  const cookingTrackerRef = useRef(createCookingConfirmationTracker());
  const cookingRecognitionAbortRef = useRef(null);
  const cookingRecognitionGenerationRef = useRef(0);
  const recognitionUnavailableRef = useRef(false);
  const heartCardRef = useRef(null);
  const momentRecorderRef = useRef(null);
  const momentBlobRef = useRef(null);
  const momentExpiryRef = useRef(0);
  const activeGrantRef = useRef(null);
  const activeGrantContextRef = useRef(null);
  const mediaRequestTrackerRef = useRef(createMediaGrantRequestTracker());
  const grantExpiryRef = useRef(0);
  const pendingKitchenGrantRef = useRef(null);
  const kitchenLiveEventIdRef = useRef(null);
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
  const automaticSceneGenerationRef = useRef(0);
  const automaticSceneAbortRef = useRef(null);
  const fallDetectionArmedRef = useRef(false);

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
    try {
      socket.send(JSON.stringify(event));
    } catch {
      return null;
    }
    eventSequenceRef.current = advanceControllerEventSequence(
      eventSequenceRef.current,
      event.event_sequence,
    );
    return event;
  }, []);

  const requestMediaGrant = useCallback((eventId, scope, expiresInMs) => {
    const socket = controllerRef.current?.socket;
    const command = createMediaGrantRequest({ eventId, scope, expiresInMs });
    if (socket?.readyState !== WebSocket.OPEN || !command) {
      mediaRequestTrackerRef.current.invalidate();
      return false;
    }
    mediaRequestTrackerRef.current.begin({
      eventId,
      scope,
      sceneId: sceneIdRef.current,
      captureGeneration: captureGenerationRef.current,
      visibilityState: document.visibilityState,
    });
    try {
      socket.send(JSON.stringify(command));
      return true;
    } catch {
      mediaRequestTrackerRef.current.invalidate();
      return false;
    }
  }, []);

  const setSessionPersistenceStatus = useCallback((healthy) => {
    sessionPersistenceHealthyRef.current = healthy;
    setSessionPersistenceHealthy(healthy);
    if (!healthy) {
      setMediaStatus({
        state: "failed",
        detail: "浏览器无法保存当前安全事件；控制权已保留，请保持页面开启并检查会话存储设置。",
      });
    }
  }, []);

  const persistControllerSessionPatch = useCallback((patch) => {
    if (!tokenRef.current || !sessionIdRef.current) return true;
    const persisted = Boolean(updateControllerSession(patch, { now: Date.now() }));
    setSessionPersistenceStatus(persisted);
    return persisted;
  }, [setSessionPersistenceStatus]);

  const persistFallRecoveryState = useCallback((next, {
    confirmedInActiveSession = false,
  } = {}) => {
    if (
      next.phase === "idle"
      || (
        confirmedInActiveSession
        && next.phase === "resolved"
        && next.delivery === "accepted"
      )
    ) {
      return clearPendingFallRecovery();
    }
    return Boolean(writePendingFallRecovery(next, { now: Date.now() }));
  }, []);

  const commitFallState = useCallback((next) => {
    const hasActiveSession = Boolean(tokenRef.current && sessionIdRef.current);
    let sessionPersisted = true;
    let recoveryPersisted;
    const confirmedResolution = next.phase === "resolved"
      && next.delivery === "accepted"
      && hasActiveSession;

    if (confirmedResolution) {
      sessionPersisted = Boolean(updateControllerSession({ fall: next }, { now: Date.now() }));
      recoveryPersisted = sessionPersisted
        ? persistFallRecoveryState(next, { confirmedInActiveSession: true })
        : persistFallRecoveryState(next);
    } else {
      recoveryPersisted = persistFallRecoveryState(next);
      if (hasActiveSession) {
        sessionPersisted = Boolean(updateControllerSession({ fall: next }, { now: Date.now() }));
      }
    }

    const persisted = sessionPersisted && recoveryPersisted;
    setSessionPersistenceStatus(persisted);
    fallRef.current = next;
    setFall(next);
    return persisted;
  }, [persistFallRecoveryState, setSessionPersistenceStatus]);

  const publishAlarmState = useCallback((payload) => {
    pendingAlarmAckRef.current = null;
    const event = publishEvent("alarm_state", payload);
    if (event) {
      pendingAlarmAckRef.current = {
        eventId: payload.event_id,
        phase: payload.phase,
        eventSequence: event.event_sequence,
      };
    }
    return event;
  }, [publishEvent]);

  const acceptAlarmEvent = useCallback((eventSequence) => {
    const pending = pendingAlarmAckRef.current;
    const current = fallRef.current;
    const accepted = applyAlarmDeliveryAck({ fall: current, pending, eventSequence });
    if (!accepted) return false;
    pendingAlarmAckRef.current = null;
    if (accepted !== current) commitFallState(accepted);
    if (current.phase === "escalated") {
      const requested = requestMediaGrant(current.eventId, "fall_emergency", 30_000);
      setMediaStatus({
        state: requested ? "authorizing" : "waiting_viewer",
        detail: requested
          ? "告警已由 Relay 确认，正在签发 30 秒事件视频授权。"
          : "告警已由 Relay 确认；当前控制链路无法签发视频，告警仍保持有效。",
      });
    }
    return true;
  }, [commitFallState, requestMediaGrant]);

  const stopLocalMoment = useCallback(() => {
    momentRecorderRef.current?.cancel?.();
    momentRecorderRef.current = null;
    momentBlobRef.current = null;
    window.clearTimeout(momentExpiryRef.current);
    momentExpiryRef.current = 0;
    setMoment({ status: "idle", size: 0, mimeType: "" });
  }, []);

  const revokeActiveGrant = useCallback((reason = "revoked") => {
    mediaRequestTrackerRef.current.invalidate();
    const grantId = activeGrantRef.current?.payload?.grant_id;
    if (grantId) {
      const socket = controllerRef.current?.socket;
      const command = createMediaGrantRevoke(grantId);
      if (socket?.readyState === WebSocket.OPEN && command) {
        try {
          socket.send(JSON.stringify(command));
        } catch {
          // 本地授权仍必须立即撤销；Relay 会在控制 socket 关闭时 fail closed。
        }
      }
      mediaBridgeRef.current?.stopGrant(grantId, reason);
    }
    activeGrantRef.current = null;
    activeGrantContextRef.current = null;
    window.clearTimeout(grantExpiryRef.current);
    grantExpiryRef.current = 0;
    setMediaStatus({ state: "idle", detail: "" });
  }, []);

  const clearKitchenCaptureEvidence = useCallback((reason, {
    publishUnavailable = false,
  } = {}) => {
    cookingRecognitionGenerationRef.current += 1;
    cookingRecognitionAbortRef.current?.abort();
    cookingRecognitionAbortRef.current = null;
    if (publishUnavailable) {
      publishEvent("activity_state", {
        activity: "cooking",
        phase: "unavailable",
        source: "mimo_visual",
        confidence: null,
        reason,
      });
    }
    pendingKitchenGrantRef.current = null;
    kitchenLiveEventIdRef.current = null;
    setKitchenLiveEventId(null);
    cookingTrackerRef.current.reset();
    recognitionUnavailableRef.current = false;
    setActivity(publishUnavailable
      ? {
        ...createActivityState(),
        phase: "unavailable",
        reason,
      }
      : createActivityState());
  }, [publishEvent]);

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

  const presentAuthoritativeFall = useCallback((next) => {
    pendingAlarmAckRef.current = null;
    clearFallTimer();
    if (next.phase === "checking") {
      if (!Number.isFinite(next.deadlineMs) || next.deadlineMs <= Date.now()) {
        failClosedFallRef.current?.();
        return;
      }
      fallTimerRef.current = window.setTimeout(
        () => failClosedFallRef.current?.(),
        Math.max(0, next.deadlineMs - Date.now()),
      );
      return;
    }
    if (next.phase === "escalated") {
      cancelVoiceInteraction(createVoiceState({
        phase: "fallback",
        detail: "Relay 已按绝对截止时间确认升级；迟到的安全回应不会自动撤销告警。",
      }));
      const requested = requestMediaGrant(next.eventId, "fall_emergency", 30_000);
      setMediaStatus({
        state: requested ? "authorizing" : "waiting_viewer",
        detail: requested
          ? "Relay 已确认规则告警，正在签发 30 秒事件视频授权…"
          : "Relay 已确认规则告警；当前控制链路无法签发视频，告警仍保持有效。",
      });
      return;
    }
    if (next.phase === "resolved") {
      cancelVoiceInteraction(createVoiceState({
        phase: "result",
        intent: "safe",
        detail: "Relay 已确认本次安全事件关闭。",
      }));
      revokeActiveGrant("resolved");
    }
  }, [cancelVoiceInteraction, clearFallTimer, requestMediaGrant, revokeActiveGrant]);

  const acceptAuthoritativeAlarmEvent = useCallback((event) => {
    const sessionId = sessionIdRef.current;
    if (
      !sessionId
      || !isDemoEvent(event, { sessionId })
      || event.event_type !== "alarm_state"
    ) return "ignore";
    eventSequenceRef.current = advanceControllerEventSequence(
      eventSequenceRef.current,
      event.event_sequence,
    );
    const current = fallRef.current;
    const reconciliation = reconcileFallWithAuthoritativeAlarm(current, event.payload);
    if (reconciliation.action !== "adopt") return reconciliation.action;
    if (reconciliation.fall === current) return "adopt";

    if (sceneIdRef.current !== "fall") {
      sceneIdRef.current = "fall";
      setSceneId("fall");
      const sessionPersisted = persistControllerSessionPatch({
        sceneId: "fall",
        fall: reconciliation.fall,
      });
      const recoveryPersisted = persistFallRecoveryState(reconciliation.fall);
      setSessionPersistenceStatus(sessionPersisted && recoveryPersisted);
      fallRef.current = reconciliation.fall;
      setFall(reconciliation.fall);
    } else {
      commitFallState(reconciliation.fall);
    }
    presentAuthoritativeFall(reconciliation.fall);
    return "adopt";
  }, [
    commitFallState,
    persistControllerSessionPatch,
    persistFallRecoveryState,
    presentAuthoritativeFall,
    setSessionPersistenceStatus,
  ]);

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
    const completeKitchenConfirmation = (value) => {
      const pending = pendingKitchenGrantRef.current;
      const action = classifyCookingConfirmationAck(pending, value, {
        generation: cookingRecognitionGenerationRef.current,
        captureGeneration: captureGenerationRef.current,
        stream: streamRef.current,
        sessionId: sessionIdRef.current,
        token: tokenRef.current,
        captureActive: captureActiveRef.current,
        sceneId: sceneIdRef.current,
        visibilityState: document.visibilityState,
      });
      if (action === "ignore") return false;
      pendingKitchenGrantRef.current = null;
      if (action === "stale") return true;
      if (action === "rejected") {
        const reason = "Relay 未验证本次做饭证据；不会创建心跳、短片或实景授权。";
        clearKitchenCaptureEvidence(reason, { publishUnavailable: true });
        recognitionUnavailableRef.current = true;
        setMediaStatus({ state: "failed", detail: reason });
        return true;
      }

      const { activity: confirmedActivity, context, eventId } = pending;
      kitchenLiveEventIdRef.current = eventId;
      setKitchenLiveEventId(eventId);
      setActivity(confirmedActivity);
      const card = {
        card_id: randomId("heartbeat"),
        event_id: eventId,
        kind: "family_heartbeat",
        title: "厨房里的家庭心跳",
        body: "连续两次真实视觉判定观察到做饭活动；已形成家庭心跳，6 秒短时刻仅在本机内存暂存。",
        occurred_at_ms: Date.now(),
        share_state: "local_only",
      };
      heartCardRef.current = card;
      setHeartCard(card);
      publishEvent("care_card", card);

      const recorder = recordLocalMoment(context.stream);
      momentRecorderRef.current = recorder;
      setMoment({ status: "recording", size: 0, mimeType: "" });
      void recorder.promise.then((recorded) => {
        if (momentRecorderRef.current !== recorder) return;
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
          stopLocalMoment();
        }, 60_000);
      });

      const requested = requestMediaGrant(eventId, "kitchen_moment", 60_000);
      setMediaStatus({
        state: requested ? "authorizing" : "failed",
        detail: requested
          ? "做饭活动已由 Relay 验证，正在开放最多 60 秒厨房实时画面。"
          : "做饭活动已验证，但当前控制链路无法签发厨房实景。",
      });
      return true;
    };
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
        const previousFall = fallRef.current;
        const readyReconciliation = value.current_alarm
          ? reconcileFallWithAuthoritativeAlarm(previousFall, value.current_alarm.payload)
          : { action: "ignore", fall: previousFall };
        const readyFall = readyReconciliation.action === "adopt"
          ? readyReconciliation.fall
          : previousFall;
        const readySceneId = readyReconciliation.action === "adopt"
          && readyFall.phase !== "idle"
          ? "fall"
          : sceneIdRef.current;
        const stored = writeControllerSession({
          version: 2,
          token: tokenRef.current,
          sessionId: value.session_id,
          leaseExpiresAtMs: value.lease_expires_at_ms,
          sceneId: readySceneId,
          fall: readyFall,
        }, {
          now: Date.now(),
        });
        if (!stored) {
          setSessionPersistenceStatus(false);
          invalidateControllerSession("短期控制会话已到期，请重新输入密钥。");
          return;
        }
        setSessionPersistenceStatus(persistFallRecoveryState(readyFall, {
          confirmedInActiveSession: true,
        }));
        connection.ready = true;
        window.clearTimeout(connection.readyTimeout);
        leaseExpiresAtRef.current = value.lease_expires_at_ms;
        const readyFrameSequence = Number.isSafeInteger(value.last_frame_sequence)
          ? value.last_frame_sequence
          : -1;
        const readyEventSequence = Number.isSafeInteger(value.last_event_sequence)
          ? value.last_event_sequence
          : -1;
        sequenceRef.current = readyFrameSequence + 1;
        if (readyEventSequence >= 0) {
          eventSequenceRef.current = advanceControllerEventSequence(
            eventSequenceRef.current,
            readyEventSequence,
          );
        }
        if (readyReconciliation.action === "adopt") {
          pendingAlarmAckRef.current = null;
          sceneIdRef.current = readySceneId;
          setSceneId(readySceneId);
          fallRef.current = readyFall;
          setFall(readyFall);
        }
        reconnectAttemptRef.current = 0;
        dispatch({ type: "controller_connected" });
        publishEvent("scene_state", {
          scene_id: sceneIdRef.current,
          visual_mode: sceneIdRef.current === "bathroom"
            ? "skeleton_only"
            : "abstract_environment",
        });
        if (readyReconciliation.action === "adopt") {
          presentAuthoritativeFall(readyFall);
        } else {
          fallSyncRef.current?.();
        }
        return;
      }
      if (!connection.ready) return;
      if (
        value?.type === "error"
        && value.error === "activity_evidence_not_verified"
        && completeKitchenConfirmation(value)
      ) return;
      if (isMediaGrantError(value)) {
        mediaRequestTrackerRef.current.invalidate();
        if (value.error === "media_grant_already_active" && activeGrantRef.current) {
          return;
        }
        const noViewer = value.error === "no_connected_viewers";
        const waiting = noViewer || value.error === "media_grant_already_active";
        const kitchenContext = sceneIdRef.current === "kitchen";
        setMediaStatus({
          state: waiting ? "waiting_viewer" : "failed",
          detail: noViewer
            ? `当前没有评委端在线；${kitchenContext ? "厨房实景" : "告警视频"}保持关闭。`
            : value.error === "media_grant_already_active"
              ? "本事件已有一份短时视频授权；授权到期后自动回到骨架。"
              : `当前事件不满足${kitchenContext ? "厨房实景" : "告警视频"}授权条件；视频保持关闭。`,
        });
        return;
      }
      if (isHeartbeatAck(value)) {
        if (!tokenRef.current || !sessionIdRef.current) return;
        const stored = writeControllerSession({
          version: 2,
          token: tokenRef.current,
          sessionId: sessionIdRef.current,
          leaseExpiresAtMs: value.lease_expires_at_ms,
          sceneId: sceneIdRef.current,
          fall: fallRef.current,
        }, {
          now: Date.now(),
        });
        if (!stored) {
          setSessionPersistenceStatus(false);
          invalidateControllerSession("短期控制会话已到期，请重新输入密钥。");
          return;
        }
        setSessionPersistenceStatus(persistFallRecoveryState(fallRef.current, {
          confirmedInActiveSession: true,
        }));
        leaseExpiresAtRef.current = value.lease_expires_at_ms;
        return;
      }
      if (isForwardedMediaSignal(value)) {
        void mediaBridgeRef.current?.handleSignal(value);
        return;
      }
      if (
        isDemoEvent(value, { sessionId: sessionIdRef.current })
        && value.event_type === "alarm_state"
      ) {
        acceptAuthoritativeAlarmEvent(value);
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
        if (value.event_type === "alarm_state") {
          acceptAlarmEvent(value.event_sequence);
        }
        if (value.event_type === "activity_state") {
          completeKitchenConfirmation(value);
        }
        return;
      }
      if (value?.type === "media_grant_accepted" && isDemoEvent(value.grant)) {
        const grantAction = mediaRequestTrackerRef.current.classify(value.grant, {
          activeGrant: activeGrantRef.current,
          activeContext: activeGrantContextRef.current,
          current: {
            sceneId: sceneIdRef.current,
            captureActive: captureActiveRef.current,
            captureGeneration: captureGenerationRef.current,
            visibilityState: document.visibilityState,
            kitchenEventId: kitchenLiveEventIdRef.current,
            fall: fallRef.current,
          },
        });
        if (grantAction === "revoke") {
          mediaRequestTrackerRef.current.invalidate();
          const command = createMediaGrantRevoke(value.grant.payload.grant_id);
          if (socket.readyState === WebSocket.OPEN && command) {
            try {
              socket.send(JSON.stringify(command));
            } catch {
              // The controller socket close path is independently fail-closed.
            }
          }
          mediaBridgeRef.current?.stopGrant(value.grant.payload.grant_id, "stale_ack");
          setMediaStatus({
            state: "failed",
            detail: "迟到的视频授权与当前场景或采集状态不匹配，已立即撤销。",
          });
          return;
        }
        eventSequenceRef.current = advanceControllerEventSequence(
          eventSequenceRef.current,
          value.grant.event_sequence,
        );
        if (grantAction === "accept_initial") {
          activeGrantContextRef.current = mediaRequestTrackerRef.current.accept();
        }
        activeGrantRef.current = value.grant;
        const viewerIds = Array.isArray(value.viewer_ids) ? value.viewer_ids : [];
        setMediaStatus({
          state: viewerIds.length ? "connecting" : "waiting_viewer",
          detail: viewerIds.length
            ? `正在向 ${viewerIds.length} 个授权评委建立短期原画…`
            : value.grant.payload.scope === "kitchen_moment"
              ? "厨房实景授权已生效；评委在到期前打开页面会自动接入。"
              : "授权已生效，但签发时没有在场评委",
        });
        void mediaBridgeRef.current?.startGrant(value.grant, viewerIds);
        window.clearTimeout(grantExpiryRef.current);
        const receivedAtMs = Date.now();
        const serverTtlMs = Math.max(
          0,
          value.grant.payload.expires_at_ms - value.grant.timestamp_ms,
        );
        const fallbackExpiryMs = Math.max(0, Math.min(
          serverTtlMs,
          value.grant.payload.expires_at_ms - receivedAtMs,
        ));
        grantExpiryRef.current = window.setTimeout(() => {
          mediaBridgeRef.current?.stopGrant(value.grant.payload.grant_id, "expired");
          activeGrantRef.current = null;
          activeGrantContextRef.current = null;
          setMediaStatus({
            state: "expired",
            detail: value.grant.payload.scope === "kitchen_moment"
              ? "厨房实景 60 秒授权已到期，评委端已回到家具背景板与骨架。"
              : "事件视频授权已到期，评委端已回到骨架。",
          });
        }, fallbackExpiryMs);
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
        const activeGrantId = activeGrantRef.current?.payload?.grant_id;
        if (!activeGrantId || grantId !== activeGrantId) return;
        mediaBridgeRef.current?.stopGrant(grantId, "revoked");
        activeGrantRef.current = null;
        activeGrantContextRef.current = null;
        mediaRequestTrackerRef.current.invalidate();
        window.clearTimeout(grantExpiryRef.current);
        setMediaStatus(grant?.payload?.status === "expired"
          ? {
            state: "expired",
            detail: grant.payload.scope === "kitchen_moment"
              ? "厨房实景已由 Relay 权威时钟关闭，评委端已回到家具背景板与骨架。"
              : "事件视频已由 Relay 权威时钟关闭，评委端已回到骨架。",
          }
          : { state: "idle", detail: "" });
      }
    };
    socket.onclose = () => {
      if (controllerRef.current !== connection) return;
      window.clearInterval(connection.heartbeat);
      window.clearTimeout(connection.readyTimeout);
      controllerRef.current = null;
      const automaticRequest = automaticSceneAbortRef.current;
      if (automaticRequest) {
        automaticSceneGenerationRef.current += 1;
        automaticSceneAbortRef.current = null;
        automaticRequest.abort("控制链路中断，本次 MiMo 请求已取消；连接恢复后可再次识别。");
        setAutomaticScene(createAutomaticSceneState(
          "控制链路中断，本次 MiMo 请求已取消；连接恢复后可再次识别。",
        ));
      }
      mediaBridgeRef.current?.stopGrant(null, "socket_closed");
      activeGrantRef.current = null;
      activeGrantContextRef.current = null;
      mediaRequestTrackerRef.current.invalidate();
      clearKitchenCaptureEvidence("控制链路中断，旧做饭确认已失效；重连后需要重新取得真实证据。");
      window.clearTimeout(grantExpiryRef.current);
      grantExpiryRef.current = 0;
      setMediaStatus({ state: "idle", detail: "" });
      if (!intentionalCloseRef.current) scheduleControllerReconnect();
    };
    socket.onerror = () => socket.close();
  }, [
    acceptAuthoritativeAlarmEvent,
    acceptAlarmEvent,
    clearKitchenCaptureEvidence,
    clearReconnectTimer,
    closeControllerSocket,
    invalidateControllerSession,
    persistFallRecoveryState,
    presentAuthoritativeFall,
    publishEvent,
    requestMediaGrant,
    scheduleControllerReconnect,
    setSessionPersistenceStatus,
    stopLocalMoment,
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
    sceneIdRef.current = authoritativeRestoredScene;
    sequenceRef.current = 0;
    eventSequenceRef.current = 0;
    reconnectAttemptRef.current = 0;
    connectController(restored.token);
  }, [authoritativeRestoredScene, connectController, restoredControllerSession]);

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
        ? "语音回应表示需要帮助，已进入告警状态。"
        : manuallyTriggered
          ? "本人已表示需要帮助，已进入告警状态。"
          : "完整问询窗口没有收到回应，规则已进入告警状态。",
      delivery: "pending",
    };
    commitFallState(next);
    const published = publishAlarmState({
      event_id: eventId,
      phase: "escalated",
      trigger,
      message: next.message,
      response_deadline_ms: null,
      media_scope: "fall_emergency",
    });
    setMediaStatus({
      state: published ? "authorizing" : "waiting_viewer",
      detail: published
        ? "告警正在同步，Relay 确认后将签发 30 秒事件视频授权…"
        : "控制链路离线，告警尚未送达；重连后会自动同步。",
    });
    try {
      navigator.vibrate?.([350, 120, 350, 120, 700]);
    } catch {
      // 振动不可用不影响规则告警。
    }
  }, [cancelVoiceInteraction, clearFallTimer, commitFallState, publishAlarmState]);

  const resolveFallSafe = useCallback((requestedEventId = null, {
    trigger = null,
    preserveVoice = false,
  } = {}) => {
    const current = fallRef.current;
    const eventId = typeof requestedEventId === "string" ? requestedEventId : current.eventId;
    const action = selectFallResolutionAction(current, eventId, Date.now());
    if (action === "escalate") {
      escalateFall(eventId, "check_in_timeout");
      return;
    }
    if (action === "block") {
      setMediaStatus({
        state: "waiting_viewer",
        detail: "告警尚未获得 Relay 确认，不能用本地关闭覆盖待同步的升级。",
      });
      return;
    }
    if (action !== "resolve") return;

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
      delivery: "pending",
    };
    commitFallState(next);
    publishAlarmState({
      event_id: eventId,
      phase: "resolved",
      trigger: resolvedTrigger,
      message: next.message,
      response_deadline_ms: null,
      media_scope: "none",
    });
    revokeActiveGrant("resolved");
    fallDetectorRef.current.reset();
  }, [cancelVoiceInteraction, clearFallTimer, commitFallState, escalateFall, publishAlarmState, revokeActiveGrant]);

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

  useEffect(() => {
    const current = fallRef.current;
    if (!restoredControllerSession || current.phase !== "checking" || !current.eventId) {
      return undefined;
    }
    const nowMs = Date.now();
    const remainingMs = current.deadlineMs - nowMs;
    const interruptionAction = selectFallInterruptionAction({
      kind: "visibility",
      fall: current,
      nowMs,
      visibilityState: document.visibilityState,
    });
    if (interruptionAction === "escalate") {
      escalateFall(current.eventId, "check_in_timeout");
      return undefined;
    }
    clearFallTimer();
    fallTimerRef.current = window.setTimeout(
      () => escalateFall(current.eventId, "check_in_timeout"),
      remainingMs,
    );
    return clearFallTimer;
  }, [clearFallTimer, escalateFall, restoredControllerSession]);

  const synchronizeFallAfterReconnect = useCallback(() => {
    const current = fallRef.current;
    const action = selectFallReconnectAction(current, Date.now());
    if (action === "none") return false;
    if (action === "escalate") {
      escalateFall(current.eventId, "check_in_timeout");
      return true;
    }

    const syncing = current.delivery === "pending"
      ? current
      : { ...current, delivery: "pending" };
    if (syncing !== current) commitFallState(syncing);
    const published = publishAlarmState({
      event_id: syncing.eventId,
      phase: syncing.phase,
      trigger: syncing.trigger || "fall_transition",
      message: syncing.message || (syncing.phase === "checking"
        ? "刚才的动作有些突然，您还好吗？"
        : "本次安全事件状态已恢复。"),
      response_deadline_ms: syncing.phase === "checking" ? syncing.deadlineMs : null,
      media_scope: syncing.phase === "escalated" ? "fall_emergency" : "none",
    });

    if (action === "republish_checking") {
      clearFallTimer();
      fallTimerRef.current = window.setTimeout(
        () => escalateFall(current.eventId, "check_in_timeout"),
        Math.max(0, current.deadlineMs - Date.now()),
      );
    } else if (action === "republish_escalated" && published) {
      setMediaStatus({ state: "authorizing", detail: "告警正在重新同步，并重签 30 秒事件视频授权…" });
      requestMediaGrant(current.eventId, "fall_emergency", 30_000);
    }
    return Boolean(published);
  }, [clearFallTimer, commitFallState, escalateFall, publishAlarmState, requestMediaGrant]);

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
      const next = { ...current, deadlineMs, delivery: "pending" };
      commitFallState(next);
      publishAlarmState({
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
  }, [clearFallTimer, commitFallState, escalateFall, publishAlarmState, runFallVoiceReply]);

  const startFallCheckIn = useCallback(() => {
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
      delivery: "pending",
    };
    commitFallState(next);
    publishAlarmState({
      event_id: eventId,
      phase: "checking",
      trigger: "fall_transition",
      message: "刚才的动作有些突然，您还好吗？",
      response_deadline_ms: deadlineMs,
      media_scope: "none",
    });
    if (selectFallCheckInStartAction(document.visibilityState) === "escalate") {
      escalateFall(eventId, "check_in_timeout");
      return;
    }
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
  }, [armFallResponseWindow, cancelVoiceInteraction, clearFallTimer, commitFallState, escalateFall, publishAlarmState]);

  const continueKitchenLive = useCallback(() => {
    const eventId = kitchenLiveEventIdRef.current;
    if (
      !eventId
      || activeGrantRef.current
      || sceneIdRef.current !== "kitchen"
      || !captureActiveRef.current
      || document.visibilityState === "hidden"
    ) return;
    const requested = requestMediaGrant(eventId, "kitchen_moment", 60_000);
    setMediaStatus({
      state: requested ? "authorizing" : "failed",
      detail: requested
        ? "正在重新开放最多 60 秒厨房实时画面；心跳卡与本机短片不受影响。"
        : "当前控制链路无法重新开放厨房实景。",
    });
  }, [requestMediaGrant]);

  const cancelAutomaticSceneRecognition = useCallback((reason) => {
    automaticSceneGenerationRef.current += 1;
    automaticSceneAbortRef.current?.abort();
    automaticSceneAbortRef.current = null;
    if (reason) setAutomaticScene(createAutomaticSceneState(reason));
  }, []);

  const commitSceneDisplay = useCallback((nextSceneId, source) => {
    if (!DEMO_SCENES.some((scene) => scene.id === nextSceneId)) return false;
    if (!persistControllerSessionPatch({ sceneId: nextSceneId })) return false;
    sceneIdRef.current = nextSceneId;
    setSceneId(nextSceneId);
    setSceneSelectionSource(source);
    setActivity(source === "automatic" && nextSceneId === "kitchen"
      ? {
        ...createActivityState(),
        reason: "MiMo 只切换到做饭展示；为兑现单次样本承诺，本次不会级联第二次 cooking 视觉请求。手动点击“做饭”可启动独立活动识别。",
      }
      : createActivityState());
    publishEvent("scene_state", {
      scene_id: nextSceneId,
      visual_mode: nextSceneId === "bathroom" ? "skeleton_only" : "abstract_environment",
    });
    return true;
  }, [persistControllerSessionPatch, publishEvent]);

  const applyManualScene = useCallback((nextSceneId) => {
    if (!DEMO_SCENES.some((scene) => scene.id === nextSceneId)) return;
    const exitAction = selectFallExitAction(fallRef.current, {
      persistenceHealthy: sessionPersistenceHealthyRef.current,
    });
    if (exitAction === "escalate") {
      failClosedFallCheckIn();
      return;
    }
    if (exitAction === "block") {
      setMediaStatus({
        state: "waiting_viewer",
        detail: "请先明确关闭安全事件，并等待 Relay 确认后再切换场景。",
      });
      return;
    }
    revokeActiveGrant("scene_changed");
    clearKitchenCaptureEvidence("场景已切换，旧做饭确认已失效；再次进入厨房需要重新识别。", {
      publishUnavailable: sceneIdRef.current === "kitchen" || nextSceneId === "kitchen",
    });
    stopLocalMoment();
    clearFallTimer();
    releaseVoiceResources(createVoiceState({
      detail: nextSceneId === "fall"
        ? "正在准备事件触发式语音回应。"
        : VOICE_PHASE_COPY.idle[1],
    }));
    fallDetectorRef.current.reset();
    const emptyFall = createFallState();
    if (!clearPendingFallRecovery()) {
      setSessionPersistenceStatus(false);
      return;
    }
    if (!persistControllerSessionPatch({ fall: emptyFall, sceneId: nextSceneId })) return;
    fallRef.current = emptyFall;
    setFall(emptyFall);
    fallDetectionArmedRef.current = nextSceneId === "fall";
    setFallDetectionArmed(nextSceneId === "fall");
    setSceneSelectionSource("manual");
    sceneIdRef.current = nextSceneId;
    setSceneId(nextSceneId);
    setActivity(createActivityState());
    publishEvent("scene_state", {
      scene_id: nextSceneId,
      visual_mode: nextSceneId === "bathroom" ? "skeleton_only" : "abstract_environment",
    });
    if (nextSceneId === "fall") void preauthorizeMicrophone();
  }, [
    clearFallTimer,
    clearKitchenCaptureEvidence,
    failClosedFallCheckIn,
    persistControllerSessionPatch,
    preauthorizeMicrophone,
    publishEvent,
    releaseVoiceResources,
    revokeActiveGrant,
    setSessionPersistenceStatus,
    stopLocalMoment,
  ]);

  const selectScene = useCallback((nextSceneId) => {
    cancelAutomaticSceneRecognition("已使用手动场景；此前的 MiMo 结果已取消。可再次点击真实识别。");
    applyManualScene(nextSceneId);
  }, [applyManualScene, cancelAutomaticSceneRecognition]);

  const runAutomaticSceneRecognition = useCallback(async () => {
    const stream = streamRef.current;
    const video = videoRef.current;
    const token = tokenRef.current;
    const sessionId = sessionIdRef.current;
    if (!captureActiveRef.current || !stream || !video) {
      setAutomaticScene(createAutomaticSceneState("请先开启后置摄像头，再进行真实识别。"));
      return;
    }
    if (ui.connection !== "connected" || !token || !sessionId) {
      setAutomaticScene(createAutomaticSceneState("控制链路恢复后才能请求 MiMo 识别。"));
      return;
    }
    if (
      !sessionPersistenceHealthyRef.current
      || fallDetectionArmedRef.current
      || fallRef.current.phase !== "idle"
    ) {
      setAutomaticScene(createAutomaticSceneState(
        "当前安全状态尚未关闭或无法持久化，禁止自动切换展示模式。",
      ));
      return;
    }
    if (
      pendingKitchenGrantRef.current
      || kitchenLiveEventIdRef.current
      || activeGrantRef.current?.payload?.scope === "kitchen_moment"
      || momentRecorderRef.current
    ) {
      setAutomaticScene(createAutomaticSceneState("请先处理当前厨房时刻与授权，再进行真实识别。"));
      return;
    }

    cancelAutomaticSceneRecognition();
    const generation = automaticSceneGenerationRef.current + 1;
    automaticSceneGenerationRef.current = generation;
    const captureGeneration = captureGenerationRef.current;
    const controller = new AbortController();
    automaticSceneAbortRef.current = controller;
    setAutomaticScene({
      ...createAutomaticSceneState("仅本次点击：正在截取最小样本，不会持续上传。"),
      phase: "capturing",
    });

    const isCurrent = () => (
      automaticSceneGenerationRef.current === generation
      && captureGenerationRef.current === captureGeneration
      && captureActiveRef.current
      && tokenRef.current === token
      && sessionIdRef.current === sessionId
      && controllerRef.current?.ready === true
      && controllerRef.current.socket.readyState === WebSocket.OPEN
      && !controller.signal.aborted
    );

    let sample = null;
    let requestTimeout = 0;
    try {
      sample = await recordAutomaticSceneSample(stream, video, {
        signal: controller.signal,
        durationMs: AUTOMATIC_SCENE_SAMPLE_MS,
      });
      if (!isCurrent()) return;
      setAutomaticScene({
        ...createAutomaticSceneState(
          sample.visual_kind === "video_clip"
            ? "已截取约 2 秒视频，MiMo 正在判断场景。"
            : "浏览器无法录制 MP4，已透明回退为单张关键帧。",
        ),
        phase: "analyzing",
        visualKind: sample.visual_kind,
        durationMs: sample.duration_ms,
      });

      await waitForDisclosurePaint(controller.signal);
      if (!isCurrent()) return;

      requestTimeout = window.setTimeout(() => {
        if (isCurrent()) {
          controller.abort("MiMo 场景识别超过 10 秒，本次请求已取消，当前模式保持不变。");
        }
      }, AUTOMATIC_SCENE_REQUEST_TIMEOUT_MS);
      const verdict = await recognizeScene(getRelayBase(), token, sample, {
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (
        !sessionPersistenceHealthyRef.current
        || fallRef.current.phase !== "idle"
        || fallDetectionArmedRef.current
        || pendingKitchenGrantRef.current
        || kitchenLiveEventIdRef.current
        || activeGrantRef.current?.payload?.scope === "kitchen_moment"
        || momentRecorderRef.current
      ) {
        setAutomaticScene({
          ...createAutomaticSceneState("识别期间出现安全事件或待处理授权，结果已丢弃，当前模式保持不变。"),
          phase: "uncertain",
          accepted: false,
          decision: "blocked_by_local_state",
          classification: verdict.classification,
          confidence: verdict.confidence,
          latencyMs: verdict.latencyMs,
          visualKind: sample.visual_kind,
          durationMs: sample.duration_ms,
          temporalEvidence: verdict.temporalEvidence,
        });
        return;
      }

      const action = selectAutomaticSceneAction(sceneIdRef.current, verdict, {
        minConfidence: PROVISIONAL_AUTO_SCENE_CONFIDENCE,
      });
      const proposedAcceptance = action.type === "switch" || action.reason === "already_active";
      const displayCommitted = proposedAcceptance
        ? commitSceneDisplay(action.sceneId, "automatic")
        : false;
      const accepted = proposedAcceptance && displayCommitted;
      const decision = proposedAcceptance && !displayCommitted
        ? "persistence_unavailable"
        : action.reason;
      const decisionReason = proposedAcceptance && !displayCommitted
        ? "浏览器无法保存当前安全状态，本次提议未切换；请检查会话存储设置。"
        : action.reason === "low_confidence"
          ? `模型分值低于未校准的 65% 实验门槛，未切换。${verdict.reason}`
          : action.reason === "uncertain"
            ? `MiMo 表示证据不足，未切换。${verdict.reason}`
            : action.reason === "already_active"
              ? `MiMo 提议与当前模式一致，无需切换。${verdict.reason}`
              : `已采纳 MiMo 提议并切换展示。${verdict.reason}`;
      setAutomaticScene({
        phase: proposedAcceptance && !displayCommitted
          ? "unavailable"
          : accepted ? "result" : "uncertain",
        accepted,
        decision,
        classification: verdict.classification,
        confidence: verdict.confidence,
        reason: decisionReason,
        latencyMs: verdict.latencyMs,
        visualKind: sample.visual_kind,
        durationMs: sample.duration_ms,
        temporalEvidence: verdict.temporalEvidence,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (
          automaticSceneGenerationRef.current === generation
          && captureGenerationRef.current === captureGeneration
          && sessionIdRef.current === sessionId
        ) {
          setAutomaticScene(createAutomaticSceneState(
            typeof controller.signal.reason === "string"
              ? controller.signal.reason
              : "本次 MiMo 请求已取消，当前模式保持不变。",
          ));
        }
        return;
      }
      if (!isCurrent()) return;
      setAutomaticScene({
        ...createAutomaticSceneState(
          error instanceof Error ? error.message : "MiMo 场景识别暂时不可用，当前模式保持不变。",
        ),
        phase: "unavailable",
        visualKind: sample?.visual_kind || null,
        durationMs: sample?.duration_ms ?? null,
      });
    } finally {
      window.clearTimeout(requestTimeout);
      if (automaticSceneAbortRef.current === controller) {
        automaticSceneAbortRef.current = null;
      }
    }
  }, [cancelAutomaticSceneRecognition, commitSceneDisplay, ui.connection]);

  useEffect(() => {
    if (!automaticSceneAbortRef.current) return;
    if (!sessionPersistenceHealthy || fallDetectionArmed || fall.phase !== "idle") {
      automaticSceneAbortRef.current.abort(
        "安全状态未关闭或无法持久化，本次 MiMo 请求已取消，当前模式保持不变。",
      );
      return;
    }
    if (
      pendingKitchenGrantRef.current
      || kitchenLiveEventIdRef.current
      || activeGrantRef.current?.payload?.scope === "kitchen_moment"
      || moment.status === "recording"
    ) {
      automaticSceneAbortRef.current.abort("厨房时刻或授权处理中，本次 MiMo 请求已取消。");
      return;
    }
    if (ui.connection !== "connected") {
      automaticSceneAbortRef.current.abort(
        "控制链路中断，本次 MiMo 请求已取消；连接恢复后可再次识别。",
      );
    }
  }, [fall.phase, fallDetectionArmed, mediaStatus.state, moment.status, sessionPersistenceHealthy, ui.connection]);

  const stopCapture = useCallback(async () => {
    cancelAutomaticSceneRecognition("摄像头已停止；自动识别样本与待返回结果均已取消。");
    captureGenerationRef.current += 1;
    captureActiveRef.current = false;
    window.cancelAnimationFrame(animationRef.current);
    animationRef.current = 0;
    failClosedFallCheckIn();
    releaseVoiceResources();
    clearKitchenCaptureEvidence("摄像头已停止，旧做饭确认不能用于后续实景。", {
      publishUnavailable: sceneIdRef.current === "kitchen",
    });
    revokeActiveGrant("capture_stopped");
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
  }, [
    cancelAutomaticSceneRecognition,
    clearKitchenCaptureEvidence,
    failClosedFallCheckIn,
    releaseVoiceResources,
    revokeActiveGrant,
    stopLocalMoment,
  ]);

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

      const unlockNow = Date.now();
      const storedRecovery = readPendingFallRecovery({ now: unlockNow });
      const currentFall = fallRef.current;
      const inMemoryRecovery = currentFall.phase !== "idle"
        && !(currentFall.phase === "resolved" && currentFall.delivery === "accepted")
        ? currentFall
        : null;
      const currentIsConfirmedResolution = currentFall.phase === "resolved"
        && currentFall.delivery === "accepted";
      const recovery = currentIsConfirmedResolution
        ? null
        : inMemoryRecovery || storedRecovery;
      const initialFall = prepareFallRecoveryForNewSession(recovery, unlockNow)
        || createFallState();
      const initialSceneId = initialFall.phase === "idle" ? sceneIdRef.current : "fall";
      const recoveryStored = persistFallRecoveryState(initialFall);
      const stored = writeControllerSession({
        version: 2,
        token: payload.token,
        sessionId: payload.session_id,
        leaseExpiresAtMs: payload.lease_expires_at_ms,
        sceneId: initialSceneId,
        fall: initialFall,
      }, {
        now: Date.now(),
      });
      setControlKey("");
      if (!recoveryStored || !stored) {
        const rollbackAbort = new AbortController();
        const rollbackTimeout = window.setTimeout(
          () => rollbackAbort.abort(),
          RELEASE_TIMEOUT_MS,
        );
        try {
          await fetch(relayHttpUrl("/api/release"), {
            method: "POST",
            headers: { Authorization: `Bearer ${payload.token}` },
            signal: rollbackAbort.signal,
          });
        } catch {
          // The short lease expires independently; the UI must never remain
          // stuck in unlocking while a failed rollback request hangs.
        } finally {
          window.clearTimeout(rollbackTimeout);
        }
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
      pendingAlarmAckRef.current = null;
      sceneIdRef.current = initialSceneId;
      setSceneId(initialSceneId);
      commitFallState(initialFall);
      clearFallTimer();
      if (initialFall.phase === "checking") {
        fallTimerRef.current = window.setTimeout(
          () => escalateFall(initialFall.eventId, "check_in_timeout"),
          Math.max(0, initialFall.deadlineMs - Date.now()),
        );
      }
      dispatch({ type: "unlocked", sessionId: payload.session_id });
      connectController(payload.token);
    } catch {
      dispatch({ type: "degraded", error: "无法连接控制服务，请确认网络后重试。" });
    }
  }, [
    clearFallTimer,
    commitFallState,
    connectController,
    controlKey,
    escalateFall,
    persistFallRecoveryState,
  ]);

  const startCapture = useCallback(async () => {
    if (captureActiveRef.current || ui.connection !== "connected") return;
    if (!navigator.mediaDevices?.getUserMedia) {
      dispatch({ type: "degraded", error: "当前浏览器不支持摄像头采集。" });
      return;
    }

    dispatch({ type: "starting" });
    clearKitchenCaptureEvidence("新一轮采集尚未形成做饭确认。");
    if (fallDetectionArmedRef.current) void preauthorizeMicrophone();
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
          if (fallDetectionArmedRef.current) {
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
  }, [clearKitchenCaptureEvidence, preauthorizeMicrophone, startFallCheckIn, stopCapture, ui.connection, ui.sessionId]);

  const stopOnly = useCallback(async () => {
    await stopCapture();
    dispatch({ type: "capture_stopped" });
  }, [stopCapture]);

  const releaseControl = useCallback(async () => {
    const exitAction = selectFallExitAction(fallRef.current, {
      persistenceHealthy: sessionPersistenceHealthyRef.current,
    });
    if (exitAction === "escalate") {
      failClosedFallCheckIn();
      return;
    }
    if (exitAction === "block") {
      setMediaStatus({
        state: "waiting_viewer",
        detail: "安全事件尚未明确关闭并获 Relay 确认，控制权不会释放。",
      });
      return;
    }

    const token = tokenRef.current;
    await stopCapture();
    if (selectFallExitAction(fallRef.current, {
      persistenceHealthy: sessionPersistenceHealthyRef.current,
    }) !== "allow") {
      return;
    }
    if (!clearPendingFallRecovery()) {
      setSessionPersistenceStatus(false);
      return;
    }
    intentionalCloseRef.current = true;
    clearReconnectTimer();
    let releaseStatus = 204;
    if (token) {
      const releaseAbort = new AbortController();
      const releaseTimeout = window.setTimeout(
        () => releaseAbort.abort(),
        RELEASE_TIMEOUT_MS,
      );
      try {
        const response = await fetch(relayHttpUrl("/api/release"), {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: releaseAbort.signal,
        });
        releaseStatus = response.status;
      } catch {
        releaseStatus = null;
      } finally {
        window.clearTimeout(releaseTimeout);
      }
    }
    if (selectControlReleaseAction(releaseStatus) === "retry") {
      intentionalCloseRef.current = false;
      setMediaStatus({
        state: "failed",
        detail: "Relay 尚未确认释放控制权；本地凭证已保留，可在网络恢复后重试。",
      });
      if (!controllerRef.current) scheduleControllerReconnect();
      return;
    }

    closeControllerSocket();
    clearControllerSession();
    tokenRef.current = null;
    sessionIdRef.current = null;
    leaseExpiresAtRef.current = null;
    sequenceRef.current = 0;
    eventSequenceRef.current = 0;
    reconnectAttemptRef.current = 0;
    pendingAlarmAckRef.current = null;
    commitFallState(createFallState());
    intentionalCloseRef.current = false;
    dispatch({ type: "released" });
  }, [
    clearReconnectTimer,
    closeControllerSocket,
    commitFallState,
    failClosedFallCheckIn,
    scheduleControllerReconnect,
    setSessionPersistenceStatus,
    stopCapture,
  ]);

  const retryConnection = useCallback(() => {
    const token = tokenRef.current;
    if (!token) return;
    clearReconnectTimer();
    connectController(token);
  }, [clearReconnectTimer, connectController]);

  useEffect(() => {
    if (
      sceneId !== "kitchen"
      || sceneSelectionSource !== "manual"
      || ["capturing", "analyzing"].includes(automaticScene.phase)
      || !ui.captureActive
      || ui.connection !== "connected"
      || !tokenRef.current
    ) return undefined;
    let cancelled = false;
    let inFlight = false;
    let interval = 0;
    let recognitionController = null;
    const currentRecognitionContext = () => ({
      generation: cookingRecognitionGenerationRef.current,
      captureGeneration: captureGenerationRef.current,
      stream: streamRef.current,
      sessionId: sessionIdRef.current,
      token: tokenRef.current,
      captureActive: captureActiveRef.current,
      sceneId: sceneIdRef.current,
      visibilityState: document.visibilityState,
    });
    const run = async () => {
      if (
        cancelled
        || inFlight
        || recognitionUnavailableRef.current
        || kitchenLiveEventIdRef.current
        || pendingKitchenGrantRef.current
        || document.visibilityState === "hidden"
      ) return;
      const imageB64 = captureJpegBase64(videoRef.current);
      if (!imageB64) return;
      inFlight = true;
      const controller = new AbortController();
      recognitionController = controller;
      cookingRecognitionAbortRef.current = controller;
      const context = {
        generation: cookingRecognitionGenerationRef.current,
        captureGeneration: captureGenerationRef.current,
        stream: streamRef.current,
        sessionId: sessionIdRef.current,
        token: tokenRef.current,
      };
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
          context.token,
          imageB64,
          globalThis.fetch,
          { signal: controller.signal },
        );
        if (
          cancelled
          || controller.signal.aborted
          || !isCookingRecognitionContextCurrent(
            context,
            currentRecognitionContext(),
          )
        ) return;
        const tracked = cookingTrackerRef.current.push(verdict);
        const serverVerified = Boolean(
          tracked.confirmed
          && verdict.receiptId
          && verdict.consecutive >= 2,
        );
        const activityPhase = serverVerified
          ? "confirmed"
          : tracked.phase === "confirmed" ? "candidate" : tracked.phase;
        const reason = verdict.reason.slice(0, 240);
        const confirmedActivity = {
          phase: "confirmed",
          classification: verdict.classification,
          confidence: verdict.confidence,
          reason,
          latencyMs: verdict.latencyMs,
          model: verdict.model,
          consecutive: verdict.consecutive,
        };
        setActivity(serverVerified
          ? {
            ...confirmedActivity,
            phase: "candidate",
            reason: `${reason} Relay 正在验证本次真实识别凭证。`,
          }
          : {
            ...confirmedActivity,
            phase: activityPhase,
          });
        const activityEvent = publishEvent("activity_state", {
          activity: "cooking",
          phase: activityPhase,
          source: "mimo_visual",
          confidence: verdict.confidence,
          reason,
        });
        if (serverVerified && !kitchenLiveEventIdRef.current) {
          if (!activityEvent) {
            recognitionUnavailableRef.current = true;
            setActivity({
              ...createActivityState(),
              phase: "unavailable",
              reason: "控制链路未接受本次真实识别；不会创建心跳、短片或实景授权。",
            });
            return;
          }
          const eventId = `activity-${activityEvent.event_sequence}`;
          pendingKitchenGrantRef.current = {
            activity: confirmedActivity,
            context,
            eventId,
            eventSequence: activityEvent.event_sequence,
          };
        }
      } catch (error) {
        if (
          cancelled
          || controller.signal.aborted
          || !isCookingRecognitionContextCurrent(
            context,
            currentRecognitionContext(),
          )
        ) return;
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
        if (recognitionController === controller) recognitionController = null;
        if (cookingRecognitionAbortRef.current === controller) {
          cookingRecognitionAbortRef.current = null;
        }
        inFlight = false;
      }
    };
    const first = window.setTimeout(() => void run(), 800);
    interval = window.setInterval(() => void run(), COOKING_SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      cookingRecognitionGenerationRef.current += 1;
      recognitionController?.abort();
      if (cookingRecognitionAbortRef.current === recognitionController) {
        cookingRecognitionAbortRef.current = null;
      }
      window.clearTimeout(first);
      window.clearInterval(interval);
    };
  }, [
    automaticScene.phase,
    publishEvent,
    sceneId,
    sceneSelectionSource,
    stopLocalMoment,
    ui.captureActive,
    ui.connection,
  ]);

  useEffect(() => {
    const suspendController = () => {
      intentionalCloseRef.current = true;
      clearReconnectTimer();
      if (selectFallInterruptionAction({
        kind: "pagehide",
        fall: fallRef.current,
        nowMs: Date.now(),
      }) === "escalate") failClosedFallCheckIn();
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
        cancelAutomaticSceneRecognition(
          "页面已隐藏；自动识别样本与待返回结果均已取消。",
        );
        const currentFall = fallRef.current;
        const checkingEventId = selectFailClosedFallEvent(currentFall);
        const interruptionAction = selectFallInterruptionAction({
          kind: "visibility",
          fall: currentFall,
          nowMs: Date.now(),
          visibilityState: document.visibilityState,
        });
        if (interruptionAction === "escalate") failClosedFallCheckIn();
        clearKitchenCaptureEvidence("页面已隐藏，旧做饭确认和实景授权已失效。", {
          publishUnavailable: sceneIdRef.current === "kitchen",
        });
        revokeActiveGrant("page_hidden");
        if (sceneIdRef.current === "kitchen") stopLocalMoment();
        releaseVoiceResources(checkingEventId
          ? createVoiceState({
            phase: "fallback",
            detail: interruptionAction === "escalate"
              ? "页面已隐藏且响应期限已到，麦克风已停止；本次事件已按规则升级。"
              : "页面已隐藏，麦克风已停止；本次安全问询保留原有绝对响应期限。",
          })
          : createVoiceState());
        return;
      }
      const current = fallRef.current;
      if (selectFallInterruptionAction({
        kind: "visibility",
        fall: current,
        nowMs: Date.now(),
        visibilityState: document.visibilityState,
      }) === "escalate") failClosedFallCheckIn();
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
    cancelAutomaticSceneRecognition,
    clearKitchenCaptureEvidence,
    clearReconnectTimer,
    closeControllerSocket,
    failClosedFallCheckIn,
    releaseVoiceResources,
    revokeActiveGrant,
    stopLocalMoment,
    stopCapture,
  ]);

  const locked = ui.phase === "locked" || (ui.phase === "degraded" && !ui.sessionId);
  const canStart = ui.connection === "connected" && !ui.captureActive && ui.phase !== "starting";
  const activeScene = DEMO_SCENES.find((scene) => scene.id === sceneId) || DEMO_SCENES[0];
  const fallExitAction = selectFallExitAction(fall, { persistenceHealthy: sessionPersistenceHealthy });
  const automaticSceneBusy = ["capturing", "analyzing"].includes(automaticScene.phase);
  const kitchenOperationActive = Boolean(
    kitchenLiveEventId
    || (sceneId === "kitchen" && ["authorizing", "connecting"].includes(mediaStatus.state))
    || moment.status === "recording",
  );
  const automaticSceneSafetyBlocked = !sessionPersistenceHealthy
    || fallDetectionArmed
    || fall.phase !== "idle"
    || kitchenOperationActive;
  const canRecognizeScene = ui.captureActive
    && ui.connection === "connected"
    && !automaticSceneBusy
    && !automaticSceneSafetyBlocked;
  const automaticSceneLabel = automaticScene.phase === "capturing"
    ? "正在采集 2 秒片段…"
    : automaticScene.phase === "analyzing"
      ? "MiMo 正在判断…"
      : ["result", "uncertain", "unavailable"].includes(automaticScene.phase)
        ? "再次真实识别"
        : "真实识别 · MiMo";
  const automaticSceneHint = !sessionPersistenceHealthy
    ? "会话存储不可用 · 恢复后可识别"
    : fall.phase !== "idle"
      ? "安全事件尚未关闭 · 先完成确认"
      : fallDetectionArmed
        ? "本地跌倒规则已启用 · 先手动切换其他场景"
        : kitchenOperationActive
          ? "厨房时刻处理中 · 完成后可识别"
          : sceneId === "bathroom"
            ? "完全隐私例外 · 向 MiMo 上传一次真实画面"
            : "向 MiMo 上传一次真实画面 · 约 2 秒 / 必要时单帧";
  const recognizedScene = DEMO_SCENES.find(
    (scene) => scene.id === automaticScene.classification,
  );

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
              <span><i>4</i>真实做饭确认或跌倒告警后才短期开原画</span>
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
                  <p>只有点击下方按钮后才申请摄像头；手动启用跌倒规则时才准备麦克风权限，事件前不监听。</p>
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
              <p className="intro-copy">后置摄像头在本机运行团队提供的 MoveNet 权重。骨架、事件、授权视频与事件语音保持独立通道。</p>
            </div>

            <button
              type="button"
              className={`auto-scene-action is-${automaticScene.phase}`}
              onClick={runAutomaticSceneRecognition}
              disabled={!canRecognizeScene}
              aria-busy={automaticSceneBusy}
              aria-describedby="automatic-scene-detail"
            >
              <span className="auto-scene-action-icon" aria-hidden="true">
                <AutoAwesomeRoundedIcon />
              </span>
              <span>
                <b>{automaticSceneLabel}</b>
                <small>{automaticSceneHint}</small>
              </span>
            </button>

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
                    disabled={fallExitAction === "block" && scene.id !== sceneId}
                    onClick={() => selectScene(scene.id)}
                  >
                    <SceneIcon className="scene-tab-icon" aria-hidden="true" />
                    <span>{scene.shortLabel}</span>
                    <small>{scene.number}</small>
                  </button>
                );
              })}
            </nav>

            <div
              id="automatic-scene-detail"
              className={`automatic-scene-card is-${automaticScene.phase}`}
              role="status"
              aria-live="polite"
            >
              <div className="automatic-scene-card-head">
                <b>MiMo 自动场景</b>
                <span>{automaticSceneBusy
                  ? "处理中"
                  : recognizedScene
                    ? automaticScene.accepted
                      ? `已采纳：${recognizedScene.label}`
                      : `未采纳：${recognizedScene.label}`
                    : "显式单次"}</span>
              </div>
              <p>{automaticScene.reason}</p>
              {(automaticScene.visualKind || Number.isFinite(automaticScene.confidence)) && (
                <small>
                  {automaticScene.visualKind === "video_clip" ? "约 2 秒 MP4" : "JPEG 关键帧"}
                  {Number.isFinite(automaticScene.confidence)
                    ? ` · 模型分值 ${Math.round(automaticScene.confidence * 100)}%（实验门槛 65%）`
                    : ""}
                  {Number.isFinite(automaticScene.latencyMs)
                    ? ` · ${Math.round(automaticScene.latencyMs)} ms`
                    : ""}
                  {automaticScene.temporalEvidence === false ? " · 无时序证据" : ""}
                </small>
              )}
              <small className="automatic-scene-boundary">
                即使在完全隐私模式，本按钮也只授权本次最小样本；MiMo 的“跌倒”只切换展示，不直接触发或解除报警。
              </small>
            </div>

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
                    <small>家庭心跳与 6 秒本机短片不会上传；评委实景是独立、最长 60 秒的 WebRTC 演示通道。</small>
                    {heartCard.share_state === "local_only"
                      && heartCard.event_id === kitchenLiveEventId
                      && ["idle", "expired"].includes(mediaStatus.state)
                      && (
                        <button
                          type="button"
                          className="primary-action"
                          onClick={continueKitchenLive}
                          disabled={!ui.captureActive}
                        >继续向评委开放 60 秒厨房实景</button>
                      )}
                    <small>心跳记录状态：{heartCard.share_state}</small>
                  </div>
                )}
              </div>
            )}

            {sceneId === "fall" && (
              <div className={`scenario-card fall-card is-${fall.phase}`}>
                <div className="scenario-card-head">
                  <b>{fall.phase === "idle" && !fallDetectionArmed
                    ? sceneSelectionSource === "automatic" ? "MiMo 跌倒展示候选" : "跌倒展示已恢复"
                    : "真实姿态跌倒链路"}</b>
                  <span>{fall.phase === "idle" && !fallDetectionArmed ? "仅展示"
                    : fall.phase === "idle" ? "规则待命"
                    : fall.phase === "checking" ? "正在问询"
                      : fall.phase === "escalated"
                        ? fall.delivery === "accepted" ? "已告警" : "告警待同步"
                        : fall.delivery === "accepted" ? "已关闭" : "关闭待同步"}</span>
                </div>
                <p>{fall.phase === "idle" && !fallDetectionArmed
                  ? "自动提议不会启动报警链；手动点击下方“跌倒”按钮后，才启用本地 MoveNet 时序规则。"
                  : fall.message}</p>
                {fall.eventId && fall.delivery !== "accepted" && (
                  <small role="status">Relay 尚未确认当前安全事件；控制端会保留会话并在重连后自动补发。</small>
                )}
                {!sessionPersistenceHealthy && (
                  <small role="alert">当前安全状态未能写入会话存储；在恢复前不能切换场景或释放控制权。</small>
                )}
                {(fallDetectionArmed || fall.phase !== "idle") && (
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
                )}
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
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={resolveFallSafe}
                    disabled={fall.delivery !== "accepted"}
                  >{fall.delivery === "accepted" ? "本人已确认安全，关闭事件" : "等待 Relay 确认告警后再关闭"}</button>
                )}
              </div>
            )}

            {mediaStatus.state !== "idle" && (
              <div className={`media-status is-${mediaStatus.state}`} role="status">
                <b>{sceneId === "kitchen" ? "厨房实景演示通道" : "事件视频通道"}</b>
                <p>{mediaStatus.detail}</p>
              </div>
            )}

            <div className="control-actions">
              {!ui.captureActive ? (
                <button type="button" className="primary-action" onClick={startCapture} disabled={!canStart}>
                  {ui.phase === "starting" ? "正在启动…"
                    : fallDetectionArmed ? "开启摄像头并准备语音" : "开启后置摄像头"}
                </button>
              ) : (
                <button type="button" className="secondary-action" onClick={stopOnly}>停止采集</button>
              )}
              <button
                type="button"
                className="release-action"
                onClick={releaseControl}
                disabled={fallExitAction === "block"}
              >释放控制权</button>
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
