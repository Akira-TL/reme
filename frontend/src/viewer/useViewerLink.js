import { useCallback, useEffect, useRef, useState } from "react";
import { getDecisionUrls, getSessionStatus, submitResponse } from "../services/decisionClient";
import { getPerceptionUrls, getStatus } from "../services/perceptionClient";
import { ensureAudioUnlock, getSharedAudioContext } from "../utils/audioEngine";
import {
  createFeedState,
  keypointsToSkeleton,
  reduceAEvent,
  reduceBEvent,
} from "./viewerFeed";

// 家属端旁观链路：不发起会话、不开摄像头。
// 从 B /api/session/status 发现活跃会话（B 是决策侧事实源），
// 只读订阅 A /ws/events 与 B /ws；唯一的写操作是家属确认（card_confirmed）。

const POLL_MS = 2000;
const RETRY_MS = 1500;
// running：正常旁观；degraded：A 流断但会话仍在（决策仍可能由回应触发），保持订阅。
const WATCHABLE_STATES = ["starting", "running", "degraded"];

export function useViewerLink() {
  const [target, setTarget] = useState(null);
  const [aStatus, setAStatus] = useState(null);
  const [bStatus, setBStatus] = useState(null);
  const [connectionA, setConnectionA] = useState("idle");
  const [connectionB, setConnectionB] = useState("idle");
  const [posture, setPosture] = useState(null);
  const [transition, setTransition] = useState(null);
  const [decision, setDecision] = useState(null);
  const [history, setHistory] = useState([]);
  const [alarm, setAlarm] = useState(null);
  const [confirmState, setConfirmState] = useState("idle"); // idle | sending | done | failed
  const skeletonRef = useRef(null); // { points, wallTime } 由画布 rAF 循环消费

  const alarmDecisionRef = useRef(null);
  const ringRef = useRef(null);
  const vibrateTimerRef = useRef(0);

  const stopAlarmEffects = useCallback(() => {
    if (vibrateTimerRef.current) {
      window.clearInterval(vibrateTimerRef.current);
      vibrateTimerRef.current = 0;
    }
    try {
      navigator.vibrate?.(0);
    } catch {
      // 忽略振动停止失败
    }
    const ring = ringRef.current;
    if (ring) {
      window.clearInterval(ring.toggle);
      try {
        ring.oscillator.stop();
      } catch {
        // 振荡器可能已停止
      }
      if (!ring.shared) ring.context.close().catch(() => {});
      ringRef.current = null;
    }
  }, []);

  const startAlarmEffects = useCallback(() => {
    stopAlarmEffects();
    try {
      navigator.vibrate?.([400, 120, 400]);
    } catch {
      // 忽略振动失败
    }
    vibrateTimerRef.current = window.setInterval(() => {
      try {
        navigator.vibrate?.([400, 120, 400]);
      } catch {
        // 忽略振动失败
      }
    }, 1200);
    try {
      const shared = getSharedAudioContext();
      const context = shared || new (window.AudioContext || window.webkitAudioContext)();
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
      ringRef.current = { context, oscillator, toggle, shared: context === shared };
    } catch {
      ringRef.current = null;
    }
  }, [stopAlarmEffects]);

  // 手势解锁监听尽早安装：家属点击任意处后，告警响铃可经共享上下文发声。
  useEffect(() => {
    ensureAudioUnlock();
  }, []);

  // 会话发现：轮询 A/B 状态；活跃会话变化时重置全部旁观状态。
  useEffect(() => {
    let disposed = false;
    const { httpBase: aBase } = getPerceptionUrls();
    const { httpBase: bBase } = getDecisionUrls();

    async function tick() {
      const [aResult, bResult] = await Promise.allSettled([
        getStatus(aBase),
        getSessionStatus(bBase),
      ]);
      if (disposed) return;
      setAStatus(aResult.status === "fulfilled" ? aResult.value : null);
      const bPayload = bResult.status === "fulfilled" ? bResult.value : null;
      setBStatus(bPayload);
      const activeId =
        bPayload && WATCHABLE_STATES.includes(bPayload.state) ? bPayload.session_id : null;
      setTarget((current) => {
        if ((current?.sessionId ?? null) === (activeId ?? null)) return current;
        return activeId ? { sessionId: activeId } : null;
      });
    }

    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, []);

  // 会话切换：清空上一会话的画面与决策残留（setTimeout(0) 遵循仓库
  // 对 react-hooks/set-state-in-effect 的既定处理习惯）。
  useEffect(() => {
    skeletonRef.current = null;
    alarmDecisionRef.current = null;
    stopAlarmEffects();
    const timer = window.setTimeout(() => {
      setPosture(null);
      setTransition(null);
      setDecision(null);
      setHistory([]);
      setAlarm(null);
      setConfirmState("idle");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [target?.sessionId, stopAlarmEffects]);

  // A 感知流：骨架/姿态/转变，只读订阅，断开退避重连。
  useEffect(() => {
    const sessionId = target?.sessionId;
    if (!sessionId) {
      const timer = window.setTimeout(() => setConnectionA("idle"), 0);
      return () => window.clearTimeout(timer);
    }
    const { eventsWs } = getPerceptionUrls();
    const feed = createFeedState();
    let disposed = false;
    let socket = null;
    let retryTimer = 0;

    function connect() {
      if (disposed) return;
      setConnectionA("connecting");
      socket = new WebSocket(eventsWs(sessionId));
      socket.onopen = () => {
        if (!disposed) setConnectionA("open");
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnectionA("closed");
        retryTimer = window.setTimeout(connect, RETRY_MS);
      };
      socket.onerror = () => {
        if (!disposed) setConnectionA("error");
      };
      socket.onmessage = (message) => {
        if (disposed || typeof message.data !== "string") return;
        let envelope;
        try {
          envelope = JSON.parse(message.data);
        } catch {
          return;
        }
        const event = reduceAEvent(feed, envelope, sessionId);
        if (!event) return;
        if (event.kind === "frame_landmarks") {
          const points = keypointsToSkeleton(event.payload);
          skeletonRef.current = points
            ? { points, timestampMs: event.payload.timestamp_ms, wallTime: performance.now() }
            : null;
          return;
        }
        if (event.kind === "posture_observation") {
          setPosture(event.payload);
          return;
        }
        setTransition(event.payload);
      };
    }

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      try {
        socket?.close();
      } catch {
        // 忽略关闭失败
      }
    };
  }, [target?.sessionId]);

  // B 决策流：决策卡、家属告警，断开退避重连。
  useEffect(() => {
    const sessionId = target?.sessionId;
    if (!sessionId) {
      const timer = window.setTimeout(() => setConnectionB("idle"), 0);
      return () => window.clearTimeout(timer);
    }
    const { wsUrl } = getDecisionUrls();
    const seenDecisionIds = new Set();
    let disposed = false;
    let socket = null;
    let retryTimer = 0;

    function connect() {
      if (disposed) return;
      setConnectionB("connecting");
      socket = new WebSocket(wsUrl);
      socket.onopen = () => {
        if (!disposed) setConnectionB("open");
      };
      socket.onclose = () => {
        if (disposed) return;
        setConnectionB("closed");
        retryTimer = window.setTimeout(connect, RETRY_MS);
      };
      socket.onerror = () => {
        if (!disposed) setConnectionB("error");
      };
      socket.onmessage = (message) => {
        if (disposed || typeof message.data !== "string") return;
        let frame;
        try {
          frame = JSON.parse(message.data);
        } catch {
          return;
        }
        const payload = reduceBEvent(seenDecisionIds, frame, sessionId);
        if (!payload) return;
        setDecision(payload);
        setHistory((current) => [payload, ...current].slice(0, 6));
        if (payload.alarm) {
          alarmDecisionRef.current = payload;
          setAlarm({
            channels: Array.isArray(payload.alarm.channels) ? payload.alarm.channels : [],
            trigger: payload.alarm.trigger || "",
            decision: payload,
          });
          setConfirmState("idle");
          startAlarmEffects();
        }
        if (payload.state === "resolved") {
          alarmDecisionRef.current = null;
          setAlarm(null);
          stopAlarmEffects();
        }
      };
    }

    connect();
    return () => {
      disposed = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      stopAlarmEffects();
      try {
        socket?.close();
      } catch {
        // 忽略关闭失败
      }
    };
  }, [target?.sessionId, startAlarmEffects, stopAlarmEffects]);

  // 家属确认收到：唯一的写操作（card_confirmed / family_input）。
  const confirmAlarm = useCallback(async () => {
    const targetDecision = alarmDecisionRef.current;
    if (!targetDecision) {
      setAlarm(null);
      stopAlarmEffects();
      return;
    }
    setConfirmState("sending");
    const { httpBase } = getDecisionUrls();
    try {
      await submitResponse(httpBase, {
        scene_id: targetDecision.scene_id,
        decision_id: targetDecision.decision_id,
        timestamp_ms: Number(targetDecision.timestamp_ms) || 0,
        response: "card_confirmed",
        source: "family_input",
      });
      setConfirmState("done");
      alarmDecisionRef.current = null;
      setAlarm(null);
      stopAlarmEffects();
    } catch {
      setConfirmState("failed");
    }
  }, [stopAlarmEffects]);

  // 静音但保留告警卡片（现场演示时避免持续响铃）。
  const muteAlarm = useCallback(() => {
    stopAlarmEffects();
  }, [stopAlarmEffects]);

  return {
    watching: Boolean(target),
    sessionId: target?.sessionId ?? null,
    aStatus,
    bStatus,
    connectionA,
    connectionB,
    skeletonRef,
    posture,
    transition,
    decision,
    history,
    alarm,
    confirmState,
    confirmAlarm,
    muteAlarm,
  };
}
