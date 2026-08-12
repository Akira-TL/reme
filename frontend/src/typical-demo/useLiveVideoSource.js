import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { drawSkeleton } from "../utils/pose";
import {
  buildCameraConstraints,
  buildSourceCatalog,
  classifyVideoSourceError,
  createSourceDescriptor,
  createSourceGenerationBarrier,
  detectVideoSourceCapabilities,
  getCaptureStreamMethod,
  MEDIA_FAILURE_STAGES,
  normalizeFacingMode,
  oppositeFacingMode,
  PERMISSION_STATES,
  readMediaPermissionState,
  releaseVideoSourceResource,
  REMOTE_VIDEO_STATES,
  SOURCE_KINDS,
} from "./videoSource";

const BACKEND_FRAME_TTL_MS = 5_000;
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

function drawFrame(context, source, width, height, mirror) {
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

function browserDependencies() {
  const browserNavigator = typeof navigator === "undefined" ? null : navigator;
  const mediaDevices = browserNavigator?.mediaDevices || null;
  const permissions = browserNavigator?.permissions || null;
  const videoPrototype = typeof HTMLVideoElement === "undefined"
    ? null
    : HTMLVideoElement.prototype;
  const urlApi = typeof URL === "undefined" ? null : URL;
  const isSecureContext = typeof globalThis.isSecureContext === "boolean"
    ? globalThis.isSecureContext
    : true;
  return { isSecureContext, mediaDevices, permissions, videoPrototype, urlApi };
}

function initialSourceState(capabilities) {
  return {
    status: "idle",
    descriptor: null,
    generation: 0,
    permission: capabilities.camera.available
      ? PERMISSION_STATES.PROMPT
      : PERMISSION_STATES.UNAVAILABLE,
    error: null,
  };
}

function requestedDescriptor(request, capabilities) {
  if (request.kind === SOURCE_KINDS.DISPLAY) {
    return createSourceDescriptor({
      id: "display",
      kind: SOURCE_KINDS.DISPLAY,
      label: "屏幕或窗口",
      remoteVideo: capabilities.display.remote_video,
      disabledReason: capabilities.display.disabled_reason,
    });
  }
  if (request.kind === SOURCE_KINDS.FILE) {
    return createSourceDescriptor({
      id: "file",
      kind: SOURCE_KINDS.FILE,
      label: request.file?.name || "本地视频文件",
      remoteVideo: capabilities.file.remote_video,
      disabledReason: capabilities.file.disabled_reason,
    });
  }
  return createSourceDescriptor({
    id: request.sourceId || `camera-${normalizeFacingMode(request.facingMode)}`,
    kind: SOURCE_KINDS.CAMERA,
    label: request.label || (request.facingMode === "environment" ? "后置摄像头" : "前置摄像头"),
    facingMode: normalizeFacingMode(request.facingMode),
    remoteVideo: capabilities.camera.remote_video,
    disabledReason: capabilities.camera.disabled_reason,
  });
}

function sourceCapability(capabilities, kind) {
  return capabilities[kind] || {
    available: false,
    disabled_code: "unsupported",
    disabled_reason: "未知媒体源",
    remote_video: REMOTE_VIDEO_STATES.UNAVAILABLE,
  };
}

function safePlay(video) {
  const playResult = video.play?.();
  return playResult && typeof playResult.then === "function"
    ? playResult
    : Promise.resolve();
}

function createResource() {
  return {
    stream: null,
    remoteStream: null,
    objectUrl: null,
    cleanup: [],
    released: false,
  };
}

export function useLiveVideoSource({
  deviceViewMode,
  phoneViewMode,
  skeletonColor,
  backendLandmarkFrame = null,
  autoStart = true,
  initialFacingMode = "user",
  onSourceGenerationChange = null,
}) {
  const [dependencies] = useState(browserDependencies);
  const [capabilities] = useState(() => detectVideoSourceCapabilities(dependencies));
  const [sourceState, setSourceState] = useState(() => initialSourceState(capabilities));
  const [cameraDevices, setCameraDevices] = useState([]);
  const [mediaStreams, setMediaStreams] = useState({ local: null, remote: null });
  const [aspectRatio, setAspectRatio] = useState(DEFAULT_RENDER_WIDTH / DEFAULT_RENDER_HEIGHT);
  const [personDetected, setPersonDetected] = useState(false);
  const [backendSkeletonActive, setBackendSkeletonActive] = useState(false);

  const videoRef = useRef(null);
  const deviceCanvasRef = useRef(null);
  const phoneCanvasRef = useRef(null);
  const activeResourceRef = useRef(null);
  const generationBarrierRef = useRef(createSourceGenerationBarrier());
  const mountedRef = useRef(false);
  const lastRequestRef = useRef(null);
  const onGenerationChangeRef = useRef(onSourceGenerationChange);
  const cameraDevicesRef = useRef([]);
  const cameraReadyRef = useRef(false);
  const mirrorRef = useRef(true);
  const renderFrameRef = useRef(0);
  const backendLandmarksRef = useRef([]);
  const backendReceivedAtRef = useRef(0);
  const deviceRenderCanvasRef = useRef(null);
  const phoneRenderCanvasRef = useRef(null);
  const deviceViewModeRef = useRef(deviceViewMode);
  const phoneViewModeRef = useRef(phoneViewMode);
  const skeletonColorRef = useRef(skeletonColor);
  const backendActiveRef = useRef(false);

  const sourceCatalog = useMemo(
    () => buildSourceCatalog({ devices: cameraDevices, capabilities }),
    [cameraDevices, capabilities],
  );

  useEffect(() => {
    onGenerationChangeRef.current = onSourceGenerationChange;
  }, [onSourceGenerationChange]);

  useEffect(() => {
    cameraDevicesRef.current = cameraDevices;
  }, [cameraDevices]);

  useEffect(() => {
    const landmarks = backendLandmarkFrame?.landmarks;
    const frameGeneration = backendLandmarkFrame?.sourceGeneration;
    if (
      !Array.isArray(landmarks)
      || landmarks.length !== 17
      || (Number.isInteger(frameGeneration)
        && !generationBarrierRef.current.isCurrent(frameGeneration))
    ) {
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

  const resetBackendFrame = useCallback(() => {
    backendLandmarksRef.current = [];
    backendReceivedAtRef.current = 0;
    backendActiveRef.current = false;
    setBackendSkeletonActive(false);
    setPersonDetected(false);
  }, []);

  const refreshCameraDevices = useCallback(async () => {
    const mediaDevices = dependencies.mediaDevices;
    if (!capabilities.camera.available || typeof mediaDevices?.enumerateDevices !== "function") {
      if (mountedRef.current) setCameraDevices([]);
      return [];
    }
    try {
      const devices = (await mediaDevices.enumerateDevices())
        .filter((device) => device?.kind === "videoinput");
      if (mountedRef.current) setCameraDevices(devices);
      return devices;
    } catch {
      if (mountedRef.current) setCameraDevices([]);
      return [];
    }
  }, [capabilities.camera.available, dependencies.mediaDevices]);

  const beginGeneration = useCallback((reason) => {
    const generation = generationBarrierRef.current.next();
    onGenerationChangeRef.current?.({ generation, reason });
    const previous = activeResourceRef.current;
    activeResourceRef.current = null;
    releaseVideoSourceResource(previous, {
      video: videoRef.current,
      urlApi: dependencies.urlApi,
    });
    cameraReadyRef.current = false;
    setMediaStreams({ local: null, remote: null });
    mirrorRef.current = true;
    resetBackendFrame();
    return generation;
  }, [dependencies.urlApi, resetBackendFrame]);

  const openSource = useCallback(async (request) => {
    const generation = beginGeneration(`select_${request.kind}`);
    const descriptor = requestedDescriptor(request, capabilities);
    const capability = sourceCapability(capabilities, request.kind);
    const initialPermission = request.kind === SOURCE_KINDS.FILE
      ? PERMISSION_STATES.NOT_REQUIRED
      : capability.available
        ? PERMISSION_STATES.PROMPT
        : PERMISSION_STATES.UNAVAILABLE;

    setSourceState({
      status: capability.available ? "requesting" : "unsupported",
      descriptor,
      generation,
      permission: initialPermission,
      error: capability.available
        ? null
        : { code: capability.disabled_code || "unsupported", message: capability.disabled_reason },
    });
    if (!capability.available) return false;

    const resource = createResource();
    let nextDescriptor;
    let failureStage = MEDIA_FAILURE_STAGES.CAPTURE;
    try {
      const video = videoRef.current;
      if (!video) throw new Error("VideoElementUnavailable");

      if (request.kind === SOURCE_KINDS.CAMERA) {
        resource.stream = await dependencies.mediaDevices.getUserMedia(
          buildCameraConstraints({
            deviceId: request.deviceId,
            facingMode: request.facingMode,
          }),
        );
        resource.remoteStream = resource.stream;
      } else if (request.kind === SOURCE_KINDS.DISPLAY) {
        resource.stream = await dependencies.mediaDevices.getDisplayMedia({
          audio: false,
          video: { frameRate: { ideal: 30, max: 30 } },
        });
        resource.remoteStream = resource.stream;
      } else {
        if (!request.file || !String(request.file.type || "").startsWith("video/")) {
          const invalidFile = new Error("VideoFileRequired");
          invalidFile.name = "NotSupportedError";
          throw invalidFile;
        }
        resource.objectUrl = dependencies.urlApi.createObjectURL(request.file);
      }

      if (!generationBarrierRef.current.isCurrent(generation)) {
        releaseVideoSourceResource(resource, { urlApi: dependencies.urlApi });
        return false;
      }

      failureStage = MEDIA_FAILURE_STAGES.PLAYBACK;
      video.pause?.();
      if (resource.stream) {
        video.removeAttribute?.("src");
        video.srcObject = resource.stream;
      } else {
        video.srcObject = null;
        video.src = resource.objectUrl;
      }
      await safePlay(video);

      if (!generationBarrierRef.current.isCurrent(generation)) {
        releaseVideoSourceResource(resource, { video, urlApi: dependencies.urlApi });
        return false;
      }

      const videoTrack = resource.stream?.getVideoTracks?.()[0] || null;
      const trackSettings = videoTrack?.getSettings?.() || {};
      if (request.kind === SOURCE_KINDS.FILE) {
        const captureMethod = getCaptureStreamMethod(video);
        if (captureMethod) {
          try {
            resource.remoteStream = video[captureMethod]();
          } catch {
            resource.remoteStream = null;
          }
        }
        nextDescriptor = createSourceDescriptor({
          id: descriptor.id,
          kind: SOURCE_KINDS.FILE,
          label: request.file.name || "本地视频文件",
          remoteVideo: resource.remoteStream
            ? REMOTE_VIDEO_STATES.AVAILABLE
            : REMOTE_VIDEO_STATES.LOCAL_ONLY,
          disabledReason: resource.remoteStream
            ? null
            : "当前浏览器无法把本地视频转换为远程媒体流",
        });
      } else if (request.kind === SOURCE_KINDS.DISPLAY) {
        nextDescriptor = createSourceDescriptor({
          id: "display",
          kind: SOURCE_KINDS.DISPLAY,
          label: videoTrack?.label || "屏幕或窗口",
          remoteVideo: REMOTE_VIDEO_STATES.AVAILABLE,
        });
      } else {
        const facingMode = trackSettings.facingMode
          ? normalizeFacingMode(trackSettings.facingMode)
          : normalizeFacingMode(request.facingMode);
        nextDescriptor = createSourceDescriptor({
          id: request.sourceId || `camera-${facingMode}`,
          kind: SOURCE_KINDS.CAMERA,
          label: videoTrack?.label || descriptor.label,
          facingMode,
          remoteVideo: REMOTE_VIDEO_STATES.AVAILABLE,
        });
      }

      const endedTarget = videoTrack || (request.kind === SOURCE_KINDS.FILE ? video : null);
      if (endedTarget?.addEventListener) {
        const endedEvent = videoTrack ? "ended" : "ended";
        const handleEnded = () => {
          if (!generationBarrierRef.current.isCurrent(generation) || !mountedRef.current) return;
          const endedGeneration = beginGeneration("source_ended");
          setSourceState({
            status: "ended",
            descriptor: nextDescriptor,
            generation: endedGeneration,
            permission: request.kind === SOURCE_KINDS.FILE
              ? PERMISSION_STATES.NOT_REQUIRED
              : PERMISSION_STATES.GRANTED,
            error: request.kind === SOURCE_KINDS.FILE
              ? null
              : { code: "source_ended", message: request.kind === SOURCE_KINDS.DISPLAY
                  ? "屏幕共享已停止"
                  : "摄像头连接已中断，请检查设备后重试" },
          });
        };
        endedTarget.addEventListener(endedEvent, handleEnded, { once: true });
        resource.cleanup.push(() => endedTarget.removeEventListener(endedEvent, handleEnded));
      }

      activeResourceRef.current = resource;
      setMediaStreams({ local: resource.stream, remote: resource.remoteStream });
      const sourceWidth = video.videoWidth || trackSettings.width;
      const sourceHeight = video.videoHeight || trackSettings.height;
      if (sourceWidth && sourceHeight) setAspectRatio(sourceWidth / sourceHeight);
      cameraReadyRef.current = true;
      mirrorRef.current = nextDescriptor.kind === SOURCE_KINDS.CAMERA
        && nextDescriptor.facing_mode !== "environment";
      setSourceState({
        status: "ready",
        descriptor: nextDescriptor,
        generation,
        permission: request.kind === SOURCE_KINDS.FILE
          ? PERMISSION_STATES.NOT_REQUIRED
          : PERMISSION_STATES.GRANTED,
        error: null,
      });
      if (request.kind === SOURCE_KINDS.CAMERA) void refreshCameraDevices();
      return true;
    } catch (sourceFailure) {
      releaseVideoSourceResource(resource, {
        video: videoRef.current,
        urlApi: dependencies.urlApi,
      });
      if (!generationBarrierRef.current.isCurrent(generation)) return false;
      const permissionState = await readMediaPermissionState(
        dependencies.permissions,
        request.kind,
      );
      if (!generationBarrierRef.current.isCurrent(generation)) return false;
      const failure = classifyVideoSourceError(sourceFailure, request.kind, {
        stage: failureStage,
        isSecureContext: dependencies.isSecureContext,
        permissionState,
      });
      cameraReadyRef.current = false;
      setSourceState({
        status: "error",
        descriptor,
        generation,
        permission: failure.permission,
        error: { code: failure.code, message: failure.message },
      });
      return false;
    }
  }, [
    beginGeneration,
    capabilities,
    dependencies.isSecureContext,
    dependencies.mediaDevices,
    dependencies.permissions,
    dependencies.urlApi,
    refreshCameraDevices,
  ]);

  const requestSource = useCallback((request) => {
    lastRequestRef.current = request;
    return openSource(request);
  }, [openSource]);

  const selectCamera = useCallback(({ sourceId = null, deviceId = null, facingMode = "user" } = {}) => {
    let selectedDeviceId = deviceId;
    let selectedLabel = null;
    let selectedFacingMode = normalizeFacingMode(facingMode);
    if (sourceId?.startsWith("camera-device-")) {
      const index = Number.parseInt(sourceId.slice("camera-device-".length), 10) - 1;
      const selected = Number.isInteger(index) ? cameraDevicesRef.current[index] : null;
      if (selected) {
        selectedDeviceId = selected.deviceId;
        selectedLabel = selected.label;
        const catalogDescriptor = buildSourceCatalog({
          devices: cameraDevicesRef.current,
          capabilities,
        }).find((item) => item.id === sourceId);
        selectedFacingMode = catalogDescriptor?.facing_mode || selectedFacingMode;
      }
    }
    return requestSource({
      kind: SOURCE_KINDS.CAMERA,
      sourceId,
      deviceId: selectedDeviceId,
      facingMode: selectedFacingMode,
      label: selectedLabel,
    });
  }, [capabilities, requestSource]);

  const switchCameraFacing = useCallback(() => {
    const currentFacing = sourceState.descriptor?.kind === SOURCE_KINDS.CAMERA
      ? sourceState.descriptor.facing_mode
      : lastRequestRef.current?.facingMode;
    return selectCamera({ facingMode: oppositeFacingMode(currentFacing) });
  }, [selectCamera, sourceState.descriptor]);

  const selectDisplay = useCallback(
    () => requestSource({ kind: SOURCE_KINDS.DISPLAY }),
    [requestSource],
  );

  const selectFile = useCallback(
    (file) => requestSource({ kind: SOURCE_KINDS.FILE, file }),
    [requestSource],
  );

  const selectSource = useCallback((source, { file = null } = {}) => {
    const descriptor = typeof source === "string"
      ? sourceCatalog.find((item) => item.id === source)
      : source;
    if (!descriptor) return Promise.resolve(false);
    if (descriptor.kind === SOURCE_KINDS.DISPLAY) return selectDisplay();
    if (descriptor.kind === SOURCE_KINDS.FILE) return selectFile(file);
    return selectCamera({
      sourceId: descriptor.id,
      facingMode: descriptor.facing_mode || "user",
    });
  }, [selectCamera, selectDisplay, selectFile, sourceCatalog]);

  const stop = useCallback(() => {
    const generation = beginGeneration("stop_capture");
    setSourceState({
      status: "stopped",
      descriptor: null,
      generation,
      permission: PERMISSION_STATES.IDLE,
      error: null,
    });
  }, [beginGeneration]);

  const retry = useCallback(() => {
    const request = lastRequestRef.current;
    return request ? openSource(request) : selectCamera({ facingMode: initialFacingMode });
  }, [initialFacingMode, openSource, selectCamera]);

  const getRemoteStream = useCallback(
    () => activeResourceRef.current?.remoteStream || null,
    [],
  );

  useEffect(() => {
    const generationBarrier = generationBarrierRef.current;
    const mountedVideo = videoRef.current;
    mountedRef.current = true;
    const enumerateTimer = window.setTimeout(() => {
      void refreshCameraDevices();
    }, 0);
    return () => {
      window.clearTimeout(enumerateTimer);
      mountedRef.current = false;
      generationBarrier.invalidate();
      const resource = activeResourceRef.current;
      activeResourceRef.current = null;
      releaseVideoSourceResource(resource, {
        video: mountedVideo,
        urlApi: dependencies.urlApi,
      });
      cameraReadyRef.current = false;
    };
  }, [dependencies.urlApi, refreshCameraDevices]);

  useEffect(() => {
    if (!autoStart) return undefined;
    const timer = window.setTimeout(() => {
      void selectCamera({ facingMode: initialFacingMode });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [autoStart, initialFacingMode, selectCamera]);

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

    function drawMode(context, mode, points, video, mirror) {
      const width = context.canvas.width;
      const height = context.canvas.height;
      context.clearRect(0, 0, width, height);
      const showVideo = mode === "video"
        || mode === "video_skeleton"
        || mode === "blurred"
        || mode === "blurred_skeleton";
      if (showVideo && cameraReadyRef.current && video?.readyState >= 2) {
        context.save();
        if (mode === "blurred" || mode === "blurred_skeleton") {
          context.filter = "blur(24px)";
        }
        drawFrame(context, video, width, height, mirror);
        context.restore();
      }
      if (
        ["skeleton", "video_skeleton", "blurred_skeleton"].includes(mode)
        && points.length === 17
      ) {
        drawSkeleton(
          context,
          points,
          width,
          height,
          video,
          skeletonColorRef.current,
          mirror,
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

      drawMode(
        deviceContext,
        deviceViewModeRef.current,
        displayLandmarks,
        video,
        mirrorRef.current,
      );
      drawMode(
        phoneContext,
        phoneViewModeRef.current,
        displayLandmarks,
        video,
        mirrorRef.current,
      );

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

  const ready = sourceState.status === "ready";
  const errorMessage = sourceState.error?.message || "";
  return {
    videoRef,
    deviceCanvasRef,
    phoneCanvasRef,
    source: sourceState.descriptor,
    sourceDescriptor: sourceState.descriptor,
    sourceStatus: sourceState.status,
    sourceGeneration: sourceState.generation,
    permissionState: sourceState.permission,
    sourceError: sourceState.error,
    remoteVideoState: sourceState.descriptor?.remote_video || REMOTE_VIDEO_STATES.UNAVAILABLE,
    capabilities,
    availableSources: sourceCatalog,
    localStream: mediaStreams.local,
    remoteStream: mediaStreams.remote,
    getRemoteStream,
    refreshCameraDevices,
    selectSource,
    selectCamera,
    switchCameraFacing,
    selectDisplay,
    selectFile,
    stop,
    retry,
    ready,
    cameraReady: ready,
    aspectRatio,
    personDetected,
    backendSkeletonActive,
    skeletonSource: backendSkeletonActive ? "a_backend" : "unavailable",
    cameraError: errorMessage,
    error: errorMessage,
  };
}
