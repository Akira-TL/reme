import { useCallback, useEffect, useRef, useState } from "react";
import {
  createEventParser,
  createFrameMeta,
  createSceneSignal,
  createSessionRequest,
  KEYPOINT_NAMES,
  mapFrameLandmarks,
  parseRuntimeStatus,
  POSTURE_SCHEMA,
  TRANSITION_SCHEMA,
} from "../adapters/perception";
import {
  getCapabilities,
  getPerceptionUrls,
  getStatus,
  startRuntime,
  stopRuntime,
} from "../services/perceptionClient";

const CAMERA_FPS = 10;
let pendingRuntimeStop = Promise.resolve();

function makeSessionId() {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `live-camera-${id}`;
}

function connectSocket(url, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = window.setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket 连接超时: ${url}`));
    }, timeoutMs);
    socket.onopen = () => {
      window.clearTimeout(timeout);
      resolve(socket);
    };
    socket.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error(`WebSocket 无法连接: ${url}`));
    };
  });
}

export function usePerceptionRuntime({ videoElement, sceneId, enabled = true }) {
  const [runtime, setRuntime] = useState({ state: "offline", reason: "正在检查 A 感知服务" });
  const [landmarkFrame, setLandmarkFrame] = useState(null);
  const [posture, setPosture] = useState(null);
  const [transition, setTransition] = useState(null);
  const [retryGeneration, setRetryGeneration] = useState(0);
  const inputSocketRef = useRef(null);
  const sessionRef = useRef(null);
  const sceneRef = useRef(sceneId);
  const frameIndexRef = useRef(0);
  const landmarksModeRef = useRef(false);
  const lastLandmarksSentRef = useRef(0);
  const retry = useCallback(() => {
    setRuntime({ state: "offline", reason: "正在重新连接 A 感知服务" });
    setRetryGeneration((value) => value + 1);
  }, []);

  // 关键点直传：A 声明 jpeg_inference=false 且接受 landmarks_frame 时，由浏览器本地
  // MediaPipe 推理结果直接上送，替代 JPEG 帧。节流到 ≤10fps，非直传模式下为空操作。
  const sendLandmarks = useCallback((points, timestampMs) => {
    if (!landmarksModeRef.current || !Array.isArray(points) || points.length === 0) return;
    const socket = inputSocketRef.current;
    const sessionId = sessionRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) return;
    const now = Number.isFinite(timestampMs) ? timestampMs : performance.now();
    if (now - lastLandmarksSentRef.current < 1000 / CAMERA_FPS) return;
    lastLandmarksSentRef.current = now;
    const visibleCount = points.filter((point) => Number(point.score) >= 0.2).length;
    socket.send(JSON.stringify({
      type: "landmarks_frame",
      session_id: sessionId,
      scene_id: sceneRef.current,
      frame_index: frameIndexRef.current++,
      timestamp_ms: now,
      person_detected: points.length === 17,
      keypoints: points.map((point, index) => ({
        name: KEYPOINT_NAMES[index],
        x_norm: point.x,
        y_norm: point.y,
        score: point.score,
      })),
      landmark_quality: visibleCount / points.length >= 0.5 ? "usable" : "degraded",
    }));
  }, []);

  useEffect(() => {
    sceneRef.current = sceneId;
    const socket = inputSocketRef.current;
    const sessionId = sessionRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) return;
    socket.send(JSON.stringify(createSceneSignal(sessionId, sceneId, "switch", performance.now())));
  }, [sceneId]);

  useEffect(() => {
    if (!enabled || !videoElement) return undefined;
    const urls = getPerceptionUrls();
    const sessionId = makeSessionId();
    const abortController = new AbortController();
    const canvas = document.createElement("canvas");
    let disposed = false;
    let eventsSocket = null;
    let inputSocket = null;
    let captureTimer = 0;
    let pollTimer = 0;
    let encoding = false;
    sessionRef.current = sessionId;
    frameIndexRef.current = 0;
    landmarksModeRef.current = false;
    lastLandmarksSentRef.current = 0;
    const parseEvent = createEventParser(sessionId);

    function applyStatus(payload) {
      const status = parseRuntimeStatus(payload, sessionId);
      if (!status) return;
      setRuntime((current) => {
        const inputMissing = current.sessionId === sessionId && current.state === "input_unavailable";
        if (inputMissing && ["starting", "running"].includes(status.state)) return current;
        return { state: status.state, reason: status.reason || "", sessionId };
      });
    }

    function sendScene(signal = "activate") {
      if (!inputSocket || inputSocket.readyState !== WebSocket.OPEN) return;
      inputSocket.send(JSON.stringify(createSceneSignal(
        sessionId,
        sceneRef.current,
        signal,
        performance.now(),
      )));
    }

    function captureFrame() {
      if (disposed || encoding || !inputSocket || inputSocket.readyState !== WebSocket.OPEN) return;
      if (videoElement.readyState < 2 || !videoElement.videoWidth || !videoElement.videoHeight) return;
      encoding = true;
      const width = Math.min(640, videoElement.videoWidth);
      const height = Math.round(width * videoElement.videoHeight / videoElement.videoWidth);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const context = canvas.getContext("2d", { alpha: false });
      context.drawImage(videoElement, 0, 0, width, height);
      canvas.toBlob((blob) => {
        encoding = false;
        if (!blob || disposed || inputSocket.readyState !== WebSocket.OPEN) return;
        const frameIndex = frameIndexRef.current++;
        inputSocket.send(JSON.stringify(createFrameMeta(
          sessionId,
          sceneRef.current,
          frameIndex,
          performance.now(),
        )));
        inputSocket.send(blob);
      }, "image/jpeg", 0.72);
    }

    async function start() {
      try {
        await pendingRuntimeStop;
        if (disposed) return;
        const capabilities = await getCapabilities(urls.httpBase, abortController.signal);
        if (capabilities?.schemas?.runtime_event !== "reme-runtime-event/v0-experiment") {
          throw new Error("A 的 runtime event schema 不兼容");
        }
        // capabilities 缺 input 字段时视为旧 A，保持 JPEG 帧行为
        const landmarksMode = Boolean(
          capabilities?.input
          && capabilities.input.jpeg_inference === false
          && Array.isArray(capabilities.input.accepts)
          && capabilities.input.accepts.includes("landmarks_frame"),
        );
        landmarksModeRef.current = landmarksMode;
        const starting = await startRuntime(
          urls.httpBase,
          createSessionRequest(sessionId, sceneRef.current),
          abortController.signal,
        );
        if (disposed) return;
        applyStatus(starting);

        eventsSocket = await connectSocket(urls.eventsWs(sessionId));
        if (disposed) return eventsSocket.close();
        eventsSocket.onmessage = (message) => {
          try {
            const event = parseEvent(message.data);
            if (!event) return;
            if (event.event_type === "frame_landmarks") {
              const landmarks = mapFrameLandmarks(event.payload);
              if (landmarks) setLandmarkFrame({ landmarks, receivedAt: performance.now(), payload: event.payload });
            } else if (event.event_type === "posture_observation" && event.payload?.schema_version === POSTURE_SCHEMA) {
              setPosture(event.payload);
            } else if (event.event_type === "transition_event" && event.payload?.schema_version === TRANSITION_SCHEMA) {
              setTransition({ ...event.payload, sequence: event.sequence, receivedAt: Date.now() });
            }
          } catch {
            setRuntime({ state: "degraded", reason: "A 返回了无法解析的事件", sessionId });
          }
        };
        eventsSocket.onclose = () => {
          if (!disposed) setRuntime((current) => current.state === "stopped" ? current : { ...current, state: "degraded", reason: "A 事件连接已断开" });
        };

        try {
          inputSocket = await connectSocket(urls.inputWs);
          if (disposed) return inputSocket.close();
          inputSocket.binaryType = "arraybuffer";
          inputSocketRef.current = inputSocket;
          sendScene("activate");
          if (!landmarksMode) captureTimer = window.setInterval(captureFrame, 1000 / CAMERA_FPS);
        } catch {
          setRuntime({
            state: "input_unavailable",
            reason: "A 尚未开放浏览器摄像头输入 WS，当前使用本地姿态后备",
            sessionId,
          });
        }

        pollTimer = window.setInterval(async () => {
          try {
            const status = await getStatus(urls.httpBase, abortController.signal);
            if (!disposed) applyStatus(status);
          } catch {
            if (!disposed) setRuntime({ state: "degraded", reason: "无法读取 A 运行状态", sessionId });
          }
        }, 1500);
      } catch (error) {
        if (!disposed && error.name !== "AbortError") {
          setRuntime({ state: "offline", reason: error.message || "A 感知服务不可用", sessionId });
        }
      }
    }

    start();
    return () => {
      disposed = true;
      abortController.abort();
      window.clearInterval(captureTimer);
      window.clearInterval(pollTimer);
      inputSocket?.close();
      eventsSocket?.close();
      inputSocketRef.current = null;
      pendingRuntimeStop = stopRuntime(urls.httpBase, sessionId).catch(() => {});
    };
  }, [enabled, retryGeneration, videoElement]);

  return { runtime, landmarkFrame, posture, transition, retry, sendLandmarks };
}
