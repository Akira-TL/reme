export const SOURCE_KINDS = Object.freeze({
  CAMERA: "camera",
  DISPLAY: "display",
  FILE: "file",
});

export const REMOTE_VIDEO_STATES = Object.freeze({
  AVAILABLE: "available",
  LOCAL_ONLY: "local_only",
  UNAVAILABLE: "unavailable",
});

export const PERMISSION_STATES = Object.freeze({
  IDLE: "idle",
  PROMPT: "prompt",
  GRANTED: "granted",
  DENIED: "denied",
  NOT_REQUIRED: "not_required",
  UNAVAILABLE: "unavailable",
});

const DEFAULT_CAMERA_WIDTH = 1280;
const DEFAULT_CAMERA_HEIGHT = 720;
const DEFAULT_CAMERA_FPS = 30;

function callable(value) {
  return typeof value === "function";
}

export function normalizeFacingMode(value) {
  return value === "environment" ? "environment" : "user";
}

export function oppositeFacingMode(value) {
  return normalizeFacingMode(value) === "user" ? "environment" : "user";
}

export function inferFacingMode(label = "") {
  const normalized = String(label).toLocaleLowerCase();
  if (/(back|rear|environment|world|后置|后摄)/u.test(normalized)) return "environment";
  if (/(front|user|facetime|前置|前摄)/u.test(normalized)) return "user";
  return null;
}

export function buildCameraConstraints({ deviceId = null, facingMode = "user" } = {}) {
  const video = {
    width: { ideal: DEFAULT_CAMERA_WIDTH },
    height: { ideal: DEFAULT_CAMERA_HEIGHT },
    frameRate: { ideal: DEFAULT_CAMERA_FPS, max: DEFAULT_CAMERA_FPS },
  };
  if (deviceId) video.deviceId = { exact: deviceId };
  else video.facingMode = { ideal: normalizeFacingMode(facingMode) };
  return { audio: false, video };
}

export function getCaptureStreamMethod(target) {
  if (callable(target?.captureStream)) return "captureStream";
  if (callable(target?.webkitCaptureStream)) return "webkitCaptureStream";
  return null;
}

export function detectVideoSourceCapabilities({
  mediaDevices = null,
  videoPrototype = null,
  urlApi = null,
} = {}) {
  const cameraAvailable = callable(mediaDevices?.getUserMedia);
  const displayAvailable = callable(mediaDevices?.getDisplayMedia);
  const objectUrlAvailable = callable(urlApi?.createObjectURL) && callable(urlApi?.revokeObjectURL);
  const captureStreamMethod = getCaptureStreamMethod(videoPrototype);

  return {
    camera: {
      available: cameraAvailable,
      disabled_reason: cameraAvailable ? null : "当前浏览器不支持摄像头采集",
      remote_video: cameraAvailable
        ? REMOTE_VIDEO_STATES.AVAILABLE
        : REMOTE_VIDEO_STATES.UNAVAILABLE,
    },
    display: {
      available: displayAvailable,
      disabled_reason: displayAvailable ? null : "当前浏览器不支持屏幕或窗口共享",
      remote_video: displayAvailable
        ? REMOTE_VIDEO_STATES.AVAILABLE
        : REMOTE_VIDEO_STATES.UNAVAILABLE,
    },
    file: {
      available: objectUrlAvailable,
      capture_stream_method: captureStreamMethod,
      disabled_reason: objectUrlAvailable ? null : "当前浏览器不支持本地视频对象 URL",
      remote_video: objectUrlAvailable && captureStreamMethod
        ? REMOTE_VIDEO_STATES.AVAILABLE
        : objectUrlAvailable
          ? REMOTE_VIDEO_STATES.LOCAL_ONLY
          : REMOTE_VIDEO_STATES.UNAVAILABLE,
    },
  };
}

export function createSourceDescriptor({
  id,
  kind,
  label,
  facingMode = null,
  remoteVideo = REMOTE_VIDEO_STATES.UNAVAILABLE,
  disabledReason = null,
}) {
  return Object.freeze({
    id: String(id),
    kind,
    label: String(label),
    facing_mode: facingMode === "user" || facingMode === "environment" ? facingMode : null,
    remote_video: remoteVideo,
    disabled_reason: disabledReason || null,
  });
}

export function buildSourceCatalog({ devices = [], capabilities } = {}) {
  const safeCapabilities = capabilities || detectVideoSourceCapabilities();
  const videoInputs = Array.from(devices).filter((device) => device?.kind === "videoinput");
  const cameras = [
    createSourceDescriptor({
      id: "camera-user",
      kind: SOURCE_KINDS.CAMERA,
      label: "前置摄像头",
      facingMode: "user",
      remoteVideo: safeCapabilities.camera.remote_video,
      disabledReason: safeCapabilities.camera.disabled_reason,
    }),
    createSourceDescriptor({
      id: "camera-environment",
      kind: SOURCE_KINDS.CAMERA,
      label: "后置摄像头",
      facingMode: "environment",
      remoteVideo: safeCapabilities.camera.remote_video,
      disabledReason: safeCapabilities.camera.disabled_reason,
    }),
    ...videoInputs.map((device, index) => createSourceDescriptor({
        id: `camera-device-${index + 1}`,
        kind: SOURCE_KINDS.CAMERA,
        label: device.label || `摄像头 ${index + 1}`,
        facingMode: inferFacingMode(device.label),
        remoteVideo: safeCapabilities.camera.remote_video,
        disabledReason: safeCapabilities.camera.disabled_reason,
      })),
  ];

  return [
    ...cameras,
    createSourceDescriptor({
      id: "display",
      kind: SOURCE_KINDS.DISPLAY,
      label: "屏幕或窗口",
      remoteVideo: safeCapabilities.display.remote_video,
      disabledReason: safeCapabilities.display.disabled_reason,
    }),
    createSourceDescriptor({
      id: "file",
      kind: SOURCE_KINDS.FILE,
      label: "本地视频文件",
      remoteVideo: safeCapabilities.file.remote_video,
      disabledReason: safeCapabilities.file.disabled_reason,
    }),
  ];
}

export function createSourceGenerationBarrier(initialGeneration = 0) {
  let generation = Number.isInteger(initialGeneration) ? initialGeneration : 0;
  return Object.freeze({
    next() {
      generation += 1;
      return generation;
    },
    current() {
      return generation;
    },
    isCurrent(candidate) {
      return candidate === generation;
    },
    invalidate() {
      generation += 1;
      return generation;
    },
  });
}

export function stopMediaStream(stream) {
  if (!stream || !callable(stream.getTracks)) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop?.();
    } catch {
      // Releasing every remaining track is more important than surfacing a stop failure.
    }
  }
}

function clearVideoElement(video, resource) {
  if (!video) return;
  const ownsStream = resource.stream && video.srcObject === resource.stream;
  const ownsObjectUrl = resource.objectUrl
    && (video.src === resource.objectUrl || video.getAttribute?.("src") === resource.objectUrl);
  if (!ownsStream && !ownsObjectUrl) return;

  try {
    video.pause?.();
  } catch {
    // Some lightweight test doubles and browser engines do not implement pause.
  }
  if (ownsStream) video.srcObject = null;
  if (ownsObjectUrl) {
    video.removeAttribute?.("src");
    if (!video.removeAttribute) video.src = "";
  }
  try {
    video.load?.();
  } catch {
    // Clearing src/srcObject is sufficient when load is unavailable.
  }
}

export function releaseVideoSourceResource(resource, {
  video = null,
  urlApi = null,
} = {}) {
  if (!resource || resource.released) return;
  resource.released = true;

  for (const cleanup of resource.cleanup || []) {
    try {
      cleanup();
    } catch {
      // Continue releasing the media resources even if one listener cleanup fails.
    }
  }

  const streams = new Set([resource.stream, resource.remoteStream].filter(Boolean));
  for (const stream of streams) stopMediaStream(stream);
  clearVideoElement(video, resource);
  if (resource.objectUrl && callable(urlApi?.revokeObjectURL)) {
    urlApi.revokeObjectURL(resource.objectUrl);
  }
}

export function classifyVideoSourceError(error, kind) {
  const name = error?.name || "Error";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "permission_denied",
      permission: PERMISSION_STATES.DENIED,
      message: kind === SOURCE_KINDS.DISPLAY
        ? "屏幕共享已取消或权限被拒绝"
        : "摄像头权限被拒绝，请允许权限后重试",
    };
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return {
      code: "source_not_found",
      permission: PERMISSION_STATES.GRANTED,
      message: kind === SOURCE_KINDS.CAMERA ? "未找到可用摄像头" : "未找到可用媒体源",
    };
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return {
      code: "source_busy",
      permission: PERMISSION_STATES.GRANTED,
      message: "媒体源正被其他应用占用或无法读取",
    };
  }
  if (name === "AbortError") {
    return {
      code: "source_aborted",
      permission: PERMISSION_STATES.PROMPT,
      message: "媒体源选择已取消",
    };
  }
  return {
    code: "source_failed",
    permission: kind === SOURCE_KINDS.FILE
      ? PERMISSION_STATES.NOT_REQUIRED
      : PERMISSION_STATES.PROMPT,
    message: kind === SOURCE_KINDS.FILE
      ? "本地视频无法播放，请更换文件后重试"
      : "媒体源连接失败，请检查设备后重试",
  };
}
