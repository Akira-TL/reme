import { useCallback, useEffect, useRef, useState } from "react";
import { assertHardwareWebGl, inspectWebGlRenderer } from "../utils/gpu";
import { createDemoLandmarks, drawSkeleton, mapLandmarks } from "../utils/pose";

// 本地资产（predev 拷贝 wasm、模型已入库）：演示现场零 CDN 依赖。
const MP_WASM_URL = "/mediapipe/wasm";
const POSE_MODEL_URL = "/mediapipe/pose_landmarker_lite.task";
const MODEL_LOAD_TIMEOUT_MS = 15000;
const BACKEND_FRAME_TTL_MS = 1600;
const DEFAULT_RENDER_WIDTH = 960;
const DEFAULT_RENDER_HEIGHT = 540;
const MAX_RENDER_EDGE = 1280;

function withTimeout(promise, ms, label) {
  let timeout = 0;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = window.setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeoutPromise])
    .finally(() => window.clearTimeout(timeout));
}

function getSourceSize(source) {
  return {
    width: source?.videoWidth || source?.width || DEFAULT_RENDER_WIDTH,
    height: source?.videoHeight || source?.height || DEFAULT_RENDER_HEIGHT,
  };
}

function resolveRenderSize(video) {
  const source = getSourceSize(video);
  const scale = Math.min(1, MAX_RENDER_EDGE / Math.max(source.width, source.height));
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

function drawFrame(context, source, width, height, mirror = true) {
  if (!source) return;
  const sourceSize = getSourceSize(source);
  if (!sourceSize.width || !sourceSize.height) return;

  context.save();
  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
  }
  context.drawImage(source, 0, 0, width, height);
  context.restore();
}

function paintTarget(canvas, source) {
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);

  const sourceRatio = source.width / source.height;
  const targetRatio = rect.width / rect.height;
  const drawWidth = targetRatio > sourceRatio ? rect.height * sourceRatio : rect.width;
  const drawHeight = targetRatio > sourceRatio ? rect.height : rect.width / sourceRatio;
  const offsetX = (rect.width - drawWidth) / 2;
  const offsetY = (rect.height - drawHeight) / 2;
  context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
}

export function useLiveDemoCamera({
  deviceViewMode,
  phoneViewMode,
  skeletonColor,
  onLandmarks = null,
  backendLandmarkFrame = null,
}) {
  const videoRef = useRef(null);
  const deviceCanvasRef = useRef(null);
  const phoneCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const landmarkerRef = useRef(null);
  const cameraRequestRef = useRef(0);
  const renderFrameRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastInferenceAtRef = useRef(0);
  const localLandmarksRef = useRef([]);
  const backendLandmarksRef = useRef([]);
  const backendReceivedAtRef = useRef(0);
  const deviceRenderCanvasRef = useRef(null);
  const phoneRenderCanvasRef = useRef(null);
  const deviceViewModeRef = useRef(deviceViewMode);
  const phoneViewModeRef = useRef(phoneViewMode);
  const skeletonColorRef = useRef(skeletonColor);
  const cameraFallbackRef = useRef(false);
  const modelFallbackRef = useRef(false);
  const onLandmarksRef = useRef(onLandmarks);
  const detectedRef = useRef(false);
  const backendActiveRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const modelReadyRef = useRef(false);

  const [cameraReady, setCameraReady] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RENDER_WIDTH / DEFAULT_RENDER_HEIGHT);
  const [modelReady, setModelReady] = useState(false);
  const [personDetected, setPersonDetected] = useState(false);
  const [backendSkeletonActive, setBackendSkeletonActive] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [modelError, setModelError] = useState("");
  const [inferenceBackend, setInferenceBackend] = useState("loading");
  const [gpuRenderer, setGpuRenderer] = useState("detecting");
  const [restartGeneration, setRestartGeneration] = useState(0);

  useEffect(() => {
    onLandmarksRef.current = onLandmarks;
  }, [onLandmarks]);

  useEffect(() => {
    const landmarks = backendLandmarkFrame?.landmarks;
    if (!Array.isArray(landmarks) || landmarks.length !== 17) {
      backendLandmarksRef.current = [];
      backendReceivedAtRef.current = 0;
      return;
    }
    backendLandmarksRef.current = landmarks;
    backendReceivedAtRef.current = Number.isFinite(backendLandmarkFrame.receivedAt)
      ? backendLandmarkFrame.receivedAt
      : performance.now();
  }, [backendLandmarkFrame]);

  useEffect(() => {
    deviceViewModeRef.current = deviceViewMode;
    phoneViewModeRef.current = phoneViewMode;
    skeletonColorRef.current = skeletonColor;
  }, [deviceViewMode, phoneViewMode, skeletonColor]);

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  useEffect(() => {
    modelReadyRef.current = modelReady;
  }, [modelReady]);

  const startCamera = useCallback(async () => {
    const requestId = cameraRequestRef.current + 1;
    cameraRequestRef.current = requestId;
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraError("");
    cameraFallbackRef.current = false;
    localLandmarksRef.current = [];

    const previousStream = streamRef.current;
    streamRef.current = null;
    previousStream?.getTracks().forEach((track) => track.stop());

    if (!navigator.mediaDevices?.getUserMedia) {
      cameraFallbackRef.current = true;
      setCameraError("当前浏览器不支持摄像头，已进入动态骨架演示");
      return;
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "user" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      if (cameraRequestRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      if (cameraRequestRef.current !== requestId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const track = stream.getVideoTracks()[0];
      const settings = track?.getSettings?.() || {};
      const sourceWidth = video.videoWidth || settings.width;
      const sourceHeight = video.videoHeight || settings.height;
      if (sourceWidth && sourceHeight) setAspectRatio(sourceWidth / sourceHeight);
      track?.addEventListener("ended", () => {
        if (cameraRequestRef.current !== requestId) return;
        cameraReadyRef.current = false;
        setCameraReady(false);
        setCameraError("摄像头连接已中断，请检查设备后重试");
      }, { once: true });
      cameraReadyRef.current = true;
      setCameraReady(true);
    } catch (cameraFailure) {
      stream?.getTracks().forEach((track) => track.stop());
      if (cameraRequestRef.current !== requestId) return;
      cameraFallbackRef.current = true;
      cameraReadyRef.current = false;
      setCameraReady(false);
      setCameraError(cameraFailure?.name === "NotAllowedError"
        ? "摄像头权限被拒绝，请允许权限后重试"
        : "摄像头连接失败，已进入动态骨架演示");
    }
  }, []);

  const retry = useCallback(() => {
    cameraReadyRef.current = false;
    modelReadyRef.current = false;
    cameraFallbackRef.current = false;
    modelFallbackRef.current = false;
    localLandmarksRef.current = [];
    setCameraReady(false);
    setModelReady(false);
    setCameraError("");
    setModelError("");
    setInferenceBackend("loading");
    setGpuRenderer("detecting");
    setRestartGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const mountedVideo = videoRef.current;

    async function loadModel() {
      modelFallbackRef.current = false;
      modelReadyRef.current = false;
      setModelReady(false);
      setModelError("");
      setInferenceBackend("loading");
      let createdLandmarker = null;
      try {
        const rendererInfo = inspectWebGlRenderer();
        if (!cancelled) setGpuRenderer(rendererInfo.renderer);
        assertHardwareWebGl(rendererInfo);

        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const vision = await withTimeout(
          FilesetResolver.forVisionTasks(MP_WASM_URL),
          MODEL_LOAD_TIMEOUT_MS,
          "wasm 加载超时",
        );
        createdLandmarker = await withTimeout(
          PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate: "GPU" },
            runningMode: "VIDEO",
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: false,
          }),
          MODEL_LOAD_TIMEOUT_MS,
          "GPU 姿态模型加载超时",
        );
        if (cancelled) {
          createdLandmarker.close();
          return;
        }
        landmarkerRef.current?.close();
        landmarkerRef.current = createdLandmarker;
        createdLandmarker = null;
        modelReadyRef.current = true;
        setModelReady(true);
        setInferenceBackend("gpu");
        setModelError("");
      } catch (error) {
        createdLandmarker?.close();
        modelFallbackRef.current = true;
        modelReadyRef.current = false;
        if (!cancelled) {
          setModelReady(false);
          setInferenceBackend("unavailable");
          setModelError(
            `GPU 姿态推理不可用，已禁止回退 CPU：${error?.message || "初始化失败"}`,
          );
        }
      }
    }

    const cameraTimer = window.setTimeout(startCamera, 0);
    loadModel();
    return () => {
      cancelled = true;
      cameraRequestRef.current += 1;
      cameraReadyRef.current = false;
      modelReadyRef.current = false;
      window.clearTimeout(cameraTimer);
      const stream = streamRef.current;
      streamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (mountedVideo) mountedVideo.srcObject = null;
      const landmarker = landmarkerRef.current;
      landmarkerRef.current = null;
      landmarker?.close();
    };
  }, [restartGeneration, startCamera]);

  useEffect(() => {
    const deviceRenderCanvas = document.createElement("canvas");
    const phoneRenderCanvas = document.createElement("canvas");
    deviceRenderCanvasRef.current = deviceRenderCanvas;
    phoneRenderCanvasRef.current = phoneRenderCanvas;
    deviceRenderCanvas.width = DEFAULT_RENDER_WIDTH;
    deviceRenderCanvas.height = DEFAULT_RENDER_HEIGHT;
    phoneRenderCanvas.width = DEFAULT_RENDER_WIDTH;
    phoneRenderCanvas.height = DEFAULT_RENDER_HEIGHT;
    const deviceContext = deviceRenderCanvas.getContext("2d");
    const phoneContext = phoneRenderCanvas.getContext("2d");

    function detect(now) {
      if (cameraFallbackRef.current || modelFallbackRef.current) {
        localLandmarksRef.current = createDemoLandmarks(now);
        return;
      }
      const video = videoRef.current;
      const landmarker = landmarkerRef.current;
      if (!cameraReadyRef.current || !modelReadyRef.current || !video || !landmarker) return;
      if (now - lastInferenceAtRef.current < 75 || video.readyState < 2 || video.currentTime === lastVideoTimeRef.current) return;
      lastInferenceAtRef.current = now;
      lastVideoTimeRef.current = video.currentTime;
      try {
        const result = landmarker.detectForVideo(video, now);
        localLandmarksRef.current = result?.landmarks?.[0] ? mapLandmarks(result.landmarks[0]) : [];
        // 本地真实推理只在 A 明确要求 landmarks 输入时上送；演示骨架永不上送。
        if (localLandmarksRef.current.length === 17) {
          onLandmarksRef.current?.(localLandmarksRef.current, now);
        }
      } catch {
        localLandmarksRef.current = [];
      }
    }

    function drawMode(context, mode, points, video) {
      const width = context.canvas.width;
      const height = context.canvas.height;
      context.clearRect(0, 0, width, height);
      const showVideo = mode === "video" || mode === "video_skeleton";
      if (showVideo && cameraReadyRef.current && video?.readyState >= 2) {
        drawFrame(context, video, width, height);
      }
      if ((mode === "skeleton" || mode === "video_skeleton") && points.length === 17) {
        drawSkeleton(
          context,
          points,
          width,
          height,
          video,
          skeletonColorRef.current,
        );
      }
    }

    function render(now) {
      detect(now);
      const backendActive = backendLandmarksRef.current.length === 17
        && now - backendReceivedAtRef.current <= BACKEND_FRAME_TTL_MS;
      const displayLandmarks = backendActive
        ? backendLandmarksRef.current
        : localLandmarksRef.current;
      const video = videoRef.current;
      const renderSize = resolveRenderSize(cameraReadyRef.current ? video : null);
      if (
        deviceRenderCanvas.width !== renderSize.width
        || deviceRenderCanvas.height !== renderSize.height
      ) {
        deviceRenderCanvas.width = renderSize.width;
        deviceRenderCanvas.height = renderSize.height;
        phoneRenderCanvas.width = renderSize.width;
        phoneRenderCanvas.height = renderSize.height;
      }

      drawMode(deviceContext, deviceViewModeRef.current, displayLandmarks, video);
      drawMode(phoneContext, phoneViewModeRef.current, displayLandmarks, video);

      if (backendActive !== backendActiveRef.current) {
        backendActiveRef.current = backendActive;
        setBackendSkeletonActive(backendActive);
      }
      const fallbackSkeleton = !backendActive
        && (cameraFallbackRef.current || modelFallbackRef.current);
      const detected = !fallbackSkeleton && displayLandmarks.length === 17;
      if (detected !== detectedRef.current) {
        detectedRef.current = detected;
        setPersonDetected(detected);
      }
      paintTarget(deviceCanvasRef.current, deviceRenderCanvas);
      paintTarget(phoneCanvasRef.current, phoneRenderCanvas);
      renderFrameRef.current = requestAnimationFrame(render);
    }

    renderFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(renderFrameRef.current);
  }, []);

  const skeletonSource = backendSkeletonActive
    ? "a_backend"
    : cameraReady && modelReady
      ? "c_gpu"
      : cameraError || modelError
        ? "demo_fallback"
        : "unavailable";

  return {
    videoRef,
    deviceCanvasRef,
    phoneCanvasRef,
    cameraReady,
    aspectRatio,
    modelReady,
    inferenceBackend,
    gpuRenderer,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    cameraError,
    modelError,
    error: cameraError || modelError,
    retry,
  };
}
