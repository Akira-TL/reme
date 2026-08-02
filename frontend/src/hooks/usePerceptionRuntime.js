import { useEffect, useRef, useState } from "react";
import {
  createEventParser,
  createSessionRequest,
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
  const inputSocketRef = useRef(null);
  const sessionRef = useRef(null);
  const sceneRef = useRef(sceneId);
  const frameIndexRef = useRef(0);

  useEffect(() => {
    sceneRef.current = sceneId;
    const socket = inputSocketRef.current;
    const sessionId = sessionRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN || !sessionId) return;
    socket.send(JSON.stringify({
      type: "scene_signal",
      session_id: sessionId,
      scene_id: sceneId,
      timestamp_ms: performance.now(),
      signal: "switch",
    }));
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
      inputSocket.send(JSON.stringify({
        type: "scene_signal",
        session_id: sessionId,
        scene_id: sceneRef.current,
        timestamp_ms: performance.now(),
        signal,
      }));
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
        inputSocket.send(JSON.stringify({
          type: "frame_meta",
          session_id: sessionId,
          scene_id: sceneRef.current,
          frame_index: frameIndex,
          timestamp_ms: performance.now(),
        }));
        inputSocket.send(blob);
      }, "image/jpeg", 0.72);
    }

    async function start() {
      try {
        const capabilities = await getCapabilities(urls.httpBase, abortController.signal);
        if (capabilities?.schemas?.runtime_event !== "reme-runtime-event/v0-experiment") {
          throw new Error("A 的 runtime event schema 不兼容");
        }
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
          captureTimer = window.setInterval(captureFrame, 1000 / CAMERA_FPS);
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
      stopRuntime(urls.httpBase, sessionId).catch(() => {});
    };
  }, [enabled, videoElement]);

  return { runtime, landmarkFrame, posture, transition };
}
