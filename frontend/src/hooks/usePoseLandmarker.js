import { useCallback, useEffect, useRef, useState } from "react";
import { createDemoLandmarks, drawSkeleton, mapLandmarks, resizeCanvas } from "../utils/pose";

const MP_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export function usePoseLandmarker(externalFrame = null) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const streamRef = useRef(null);
  const landmarkerRef = useRef(null);
  const frameRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastInferenceAtRef = useRef(0);
  const landmarksRef = useRef([]);
  const fallbackRef = useRef(false);
  const personDetectedRef = useRef(false);
  const externalFrameRef = useRef(externalFrame);

  const [cameraReady, setCameraReady] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [personDetected, setPersonDetected] = useState(false);
  const [status, setStatus] = useState({
    connection: "连接中",
    title: "正在请求摄像头",
    hint: "原画只在本机参与姿态计算",
    retryable: false,
    visible: true,
  });

  useEffect(() => {
    externalFrameRef.current = externalFrame;
  }, [externalFrame]);

  const enableFallback = useCallback((message = "姿态模型暂不可用，已使用动态演示数据") => {
    fallbackRef.current = true;
    setStatus({
      connection: "演示中",
      title: "动态演示模式",
      hint: message,
      retryable: false,
      visible: false,
    });
  }, []);

  const startCamera = useCallback(async () => {
    setStatus({
      connection: "连接中",
      title: "正在请求摄像头",
      hint: "原画只在本机参与姿态计算",
      retryable: false,
      visible: true,
    });

    if (!navigator.mediaDevices?.getUserMedia) {
      enableFallback("当前浏览器不支持摄像头权限");
      return;
    }

    if (!window.isSecureContext && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      enableFallback("请使用本地启动脚本或 HTTPS 地址打开");
      return;
    }

    try {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      streamRef.current = stream;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraReady(true);
      setStatus((current) => ({
        ...current,
        connection: "已连接",
        title: "摄像头已连接",
        hint: "正在初始化本地姿态模型",
        retryable: false,
      }));
    } catch (error) {
      const denied = error?.name === "NotAllowedError" || error?.name === "PermissionDeniedError";
      setCameraReady(false);
      setStatus({
        connection: "未连接",
        title: "无法连接摄像头",
        hint: denied ? "摄像头权限被拒绝，请允许后重试" : "摄像头不可用，可继续使用演示姿态",
        retryable: true,
        visible: true,
      });
      if (!denied) fallbackRef.current = true;
    }
  }, [enableFallback]);

  useEffect(() => {
    let cancelled = false;

    async function loadModel() {
      try {
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(MP_WASM_URL);
        const options = {
          baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
          outputSegmentationMasks: false,
        };

        try {
          landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, options);
        } catch {
          options.baseOptions = { modelAssetPath: POSE_MODEL_URL };
          landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, options);
        }

        if (!cancelled) setModelReady(true);
      } catch {
        if (!cancelled) enableFallback();
      }
    }

    const cameraTimer = window.setTimeout(startCamera, 0);
    loadModel();

    return () => {
      cancelled = true;
      window.clearTimeout(cameraTimer);
      cancelAnimationFrame(frameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      landmarkerRef.current?.close();
    };
  }, [enableFallback, startCamera]);

  useEffect(() => {
    function updateDetected(nextValue) {
      if (personDetectedRef.current === nextValue) return;
      personDetectedRef.current = nextValue;
      setPersonDetected(nextValue);
    }

    function detect(now) {
      const backendFrame = externalFrameRef.current;
      if (backendFrame && now - backendFrame.receivedAt < 1500) {
        landmarksRef.current = backendFrame.landmarks;
        return;
      }

      if (fallbackRef.current) {
        landmarksRef.current = createDemoLandmarks(now);
        return;
      }

      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!cameraReady || !modelReady || !video || !landmarker || now - lastInferenceAtRef.current < 70) return;
      if (video.readyState < 2 || video.currentTime === lastVideoTimeRef.current) return;

      lastInferenceAtRef.current = now;
      lastVideoTimeRef.current = video.currentTime;
      try {
        const result = landmarker.detectForVideo(video, now);
        landmarksRef.current = result?.landmarks?.[0] ? mapLandmarks(result.landmarks[0]) : [];
      } catch {
        landmarksRef.current = [];
      }
    }

    function render(now) {
      const canvas = canvasRef.current;
      if (!canvas) {
        frameRef.current = requestAnimationFrame(render);
        return;
      }

      detect(now);
      const { context, width, height } = resizeCanvas(canvas);
      context.clearRect(0, 0, width, height);
      const light = context.createRadialGradient(width * 0.5, height * 0.35, 1, width * 0.5, height * 0.35, width * 0.72);
      light.addColorStop(0, "rgba(255,255,255,0.34)");
      light.addColorStop(1, "rgba(238,230,218,0.08)");
      context.fillStyle = light;
      context.fillRect(0, 0, width, height);

      const detected = landmarksRef.current.length === 17;
      if (detected) drawSkeleton(context, landmarksRef.current, width, height, videoRef.current);
      updateDetected(detected);
      frameRef.current = requestAnimationFrame(render);
    }

    frameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameRef.current);
  }, [cameraReady, modelReady]);

  const backendActive = Boolean(externalFrame);
  const resolvedStatus = backendActive || (cameraReady && modelReady)
    ? {
        connection: "已连接",
        title: backendActive ? "A 感知结果已接入" : "本地姿态模型已就绪",
        hint: "检测到人物后只显示 17 节点火柴人",
        retryable: false,
        visible: false,
      }
    : status;

  return {
    videoRef,
    canvasRef,
    personDetected,
    status: resolvedStatus,
    retry: startCamera,
  };
}
