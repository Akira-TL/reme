import { useCallback, useEffect, useRef, useState } from "react";
import { drawSkeleton } from "../utils/pose";

const BACKEND_FRAME_TTL_MS = 1600;
const DEFAULT_RENDER_WIDTH = 960;
const DEFAULT_RENDER_HEIGHT = 540;
const MAX_RENDER_EDGE = 1280;

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
  backendLandmarkFrame = null,
}) {
  const videoRef = useRef(null);
  const deviceCanvasRef = useRef(null);
  const phoneCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const cameraRequestRef = useRef(0);
  const renderFrameRef = useRef(0);
  const backendLandmarksRef = useRef([]);
  const backendReceivedAtRef = useRef(0);
  const deviceRenderCanvasRef = useRef(null);
  const phoneRenderCanvasRef = useRef(null);
  const deviceViewModeRef = useRef(deviceViewMode);
  const phoneViewModeRef = useRef(phoneViewMode);
  const skeletonColorRef = useRef(skeletonColor);
  const backendActiveRef = useRef(false);
  const cameraReadyRef = useRef(false);

  const [cameraReady, setCameraReady] = useState(false);
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RENDER_WIDTH / DEFAULT_RENDER_HEIGHT);
  const [personDetected, setPersonDetected] = useState(false);
  const [backendSkeletonActive, setBackendSkeletonActive] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [restartGeneration, setRestartGeneration] = useState(0);

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

  const startCamera = useCallback(async () => {
    const requestId = cameraRequestRef.current + 1;
    cameraRequestRef.current = requestId;
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraError("");

    const previousStream = streamRef.current;
    streamRef.current = null;
    previousStream?.getTracks().forEach((track) => track.stop());

    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError("当前浏览器不支持摄像头，无法采集实时画面");
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
      cameraReadyRef.current = false;
      setCameraReady(false);
      setCameraError(cameraFailure?.name === "NotAllowedError"
        ? "摄像头权限被拒绝，请允许权限后重试"
        : "摄像头连接失败，无法采集实时画面");
    }
  }, []);

  const retry = useCallback(() => {
    cameraReadyRef.current = false;
    setCameraReady(false);
    setCameraError("");
    setRestartGeneration((value) => value + 1);
  }, []);

  useEffect(() => {
    const mountedVideo = videoRef.current;
    const cameraTimer = window.setTimeout(startCamera, 0);
    return () => {
      cameraRequestRef.current += 1;
      cameraReadyRef.current = false;
      window.clearTimeout(cameraTimer);
      const stream = streamRef.current;
      streamRef.current = null;
      stream?.getTracks().forEach((track) => track.stop());
      if (mountedVideo) mountedVideo.srcObject = null;
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
      const backendActive = backendLandmarksRef.current.length === 17
        && now - backendReceivedAtRef.current <= BACKEND_FRAME_TTL_MS;
      const displayLandmarks = backendActive ? backendLandmarksRef.current : [];
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
        setPersonDetected(backendActive);
      }
      paintTarget(deviceCanvasRef.current, deviceRenderCanvas);
      paintTarget(phoneCanvasRef.current, phoneRenderCanvas);
      renderFrameRef.current = requestAnimationFrame(render);
    }

    renderFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(renderFrameRef.current);
  }, []);

  return {
    videoRef,
    deviceCanvasRef,
    phoneCanvasRef,
    cameraReady,
    aspectRatio,
    personDetected,
    backendSkeletonActive,
    skeletonSource: backendSkeletonActive ? "a_backend" : "unavailable",
    cameraError,
    error: cameraError,
    retry,
  };
}
