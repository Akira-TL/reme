import { useCallback, useEffect, useRef, useState } from "react";
import { createDemoLandmarks, drawSkeleton, mapLandmarks } from "../utils/pose";

const MP_WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const RENDER_WIDTH = 960;
const RENDER_HEIGHT = 540;

function drawCover(context, source, width, height, mirror = true) {
  const sourceWidth = source.videoWidth || source.width;
  const sourceHeight = source.videoHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  context.save();
  if (mirror) {
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
  } else {
    context.drawImage(source, offsetX, offsetY, drawWidth, drawHeight);
  }
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
  context.drawImage(source, 0, 0, rect.width, rect.height);
}

export function useLiveDemoCamera({ viewMode, skeletonColor }) {
  const videoRef = useRef(null);
  const deviceCanvasRef = useRef(null);
  const phoneCanvasRef = useRef(null);
  const streamRef = useRef(null);
  const landmarkerRef = useRef(null);
  const renderFrameRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastInferenceAtRef = useRef(0);
  const landmarksRef = useRef([]);
  const maskCanvasRef = useRef(null);
  const renderCanvasRef = useRef(null);
  const viewModeRef = useRef(viewMode);
  const skeletonColorRef = useRef(skeletonColor);
  const cameraFallbackRef = useRef(false);
  const modelFallbackRef = useRef(false);
  const detectedRef = useRef(false);
  const cameraReadyRef = useRef(false);
  const modelReadyRef = useRef(false);

  const [cameraReady, setCameraReady] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [segmentationReady, setSegmentationReady] = useState(false);
  const [personDetected, setPersonDetected] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const [modelError, setModelError] = useState("");

  useEffect(() => {
    viewModeRef.current = viewMode;
    skeletonColorRef.current = skeletonColor;
  }, [skeletonColor, viewMode]);

  useEffect(() => {
    cameraReadyRef.current = cameraReady;
  }, [cameraReady]);

  useEffect(() => {
    modelReadyRef.current = modelReady;
  }, [modelReady]);

  const startCamera = useCallback(async () => {
    setCameraError("");
    cameraFallbackRef.current = false;
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraFallbackRef.current = true;
      setCameraError("当前浏览器不支持摄像头，已进入动态骨架演示");
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
    } catch (cameraError) {
      cameraFallbackRef.current = true;
      setCameraReady(false);
      setCameraError(cameraError?.name === "NotAllowedError"
        ? "摄像头权限被拒绝，请允许权限后重试"
        : "摄像头连接失败，已进入动态骨架演示");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModel() {
      modelFallbackRef.current = false;
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
          outputSegmentationMasks: true,
        };
        try {
          landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, options);
        } catch {
          options.baseOptions = { modelAssetPath: POSE_MODEL_URL };
          landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, options);
        }
        if (!cancelled) {
          setModelReady(true);
          setModelError("");
        }
      } catch {
        modelFallbackRef.current = true;
        if (!cancelled) {
          setModelReady(false);
          setModelError("姿态/抠像模型暂不可用，真人场景将显示摄像头原画");
        }
      }
    }

    const cameraTimer = window.setTimeout(startCamera, 0);
    loadModel();
    return () => {
      cancelled = true;
      window.clearTimeout(cameraTimer);
      cancelAnimationFrame(renderFrameRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      landmarkerRef.current?.close();
    };
  }, [startCamera]);

  useEffect(() => {
    const renderCanvas = document.createElement("canvas");
    const maskCanvas = document.createElement("canvas");
    renderCanvasRef.current = renderCanvas;
    maskCanvasRef.current = maskCanvas;
    renderCanvas.width = RENDER_WIDTH;
    renderCanvas.height = RENDER_HEIGHT;
    const renderContext = renderCanvas.getContext("2d");

    function updateMask(mask) {
      try {
        const values = mask.getAsFloat32Array();
        const maskCanvas = maskCanvasRef.current;
        if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
          maskCanvas.width = mask.width;
          maskCanvas.height = mask.height;
        }
        const maskContext = maskCanvas.getContext("2d");
        const image = maskContext.createImageData(mask.width, mask.height);
        for (let index = 0; index < values.length; index += 1) {
          const alpha = Math.max(0, Math.min(1, (values[index] - 0.2) / 0.58));
          const pixel = index * 4;
          image.data[pixel] = 255;
          image.data[pixel + 1] = 255;
          image.data[pixel + 2] = 255;
          image.data[pixel + 3] = Math.round(alpha * 255);
        }
        maskContext.putImageData(image, 0, 0);
        setSegmentationReady((current) => current || true);
      } catch {
        setSegmentationReady(false);
      } finally {
        mask.close?.();
      }
    }

    function detect(now) {
      if (cameraFallbackRef.current || modelFallbackRef.current) {
        landmarksRef.current = createDemoLandmarks(now);
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
        landmarksRef.current = result?.landmarks?.[0] ? mapLandmarks(result.landmarks[0]) : [];
        const mask = result?.segmentationMasks?.[0];
        if (mask) updateMask(mask);
      } catch {
        landmarksRef.current = [];
      }
    }

    function render(now) {
      detect(now);
      renderContext.clearRect(0, 0, RENDER_WIDTH, RENDER_HEIGHT);
      const video = videoRef.current;
      const showVideo = viewModeRef.current === "video";

      if (showVideo && cameraReadyRef.current && video?.readyState >= 2) {
        drawCover(renderContext, video, RENDER_WIDTH, RENDER_HEIGHT);
        if (segmentationReady && maskCanvasRef.current?.width) {
          renderContext.globalCompositeOperation = "destination-in";
          drawCover(renderContext, maskCanvasRef.current, RENDER_WIDTH, RENDER_HEIGHT);
          renderContext.globalCompositeOperation = "source-over";
        }
      } else if (!showVideo && landmarksRef.current.length === 17) {
        drawSkeleton(
          renderContext,
          landmarksRef.current,
          RENDER_WIDTH,
          RENDER_HEIGHT,
          video,
          skeletonColorRef.current,
        );
      }

      const detected = landmarksRef.current.length === 17;
      if (detected !== detectedRef.current) {
        detectedRef.current = detected;
        setPersonDetected(detected);
      }
      paintTarget(deviceCanvasRef.current, renderCanvas);
      paintTarget(phoneCanvasRef.current, renderCanvas);
      renderFrameRef.current = requestAnimationFrame(render);
    }

    renderFrameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(renderFrameRef.current);
  }, [segmentationReady]);

  return {
    videoRef,
    deviceCanvasRef,
    phoneCanvasRef,
    cameraReady,
    modelReady,
    segmentationReady,
    personDetected,
    error: cameraError || modelError,
    retry: startCamera,
  };
}
