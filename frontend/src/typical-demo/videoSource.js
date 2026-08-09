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

export const MEDIA_FAILURE_STAGES = Object.freeze({
  CAPTURE: "capture",
  PLAYBACK: "playback",
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
  isSecureContext = true,
} = {}) {
  const secureCaptureContext = isSecureContext !== false;
  const cameraAvailable = secureCaptureContext && callable(mediaDevices?.getUserMedia);
  const displayAvailable = secureCaptureContext && callable(mediaDevices?.getDisplayMedia);
  const objectUrlAvailable = callable(urlApi?.createObjectURL) && callable(urlApi?.revokeObjectURL);
  const captureStreamMethod = getCaptureStreamMethod(videoPrototype);
  const insecureCameraReason = "手机摄像头需要已受信任证书的 HTTPS 页面；局域网 HTTP 无法授权";
  const insecureDisplayReason = "屏幕共享需要受信任的 HTTPS 页面或本机地址";

  return {
    camera: {
      available: cameraAvailable,
      disabled_code: cameraAvailable
        ? null
        : secureCaptureContext ? "unsupported" : "insecure_context",
      disabled_reason: cameraAvailable
        ? null
        : secureCaptureContext ? "当前浏览器不支持摄像头采集" : insecureCameraReason,
      remote_video: cameraAvailable
        ? REMOTE_VIDEO_STATES.AVAILABLE
        : REMOTE_VIDEO_STATES.UNAVAILABLE,
    },
    display: {
      available: displayAvailable,
      disabled_code: displayAvailable
        ? null
        : secureCaptureContext ? "unsupported" : "insecure_context",
      disabled_reason: displayAvailable
        ? null
        : secureCaptureContext ? "当前浏览器不支持屏幕或窗口共享" : insecureDisplayReason,
      remote_video: displayAvailable
        ? REMOTE_VIDEO_STATES.AVAILABLE
        : REMOTE_VIDEO_STATES.UNAVAILABLE,
    },
    file: {
      available: objectUrlAvailable,
      disabled_code: objectUrlAvailable ? null : "unsupported",
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

export async function readMediaPermissionState(permissions, kind) {
  if (kind !== SOURCE_KINDS.CAMERA || !callable(permissions?.query)) return null;
  try {
    const result = await permissions.query({ name: "camera" });
    return ["granted", "denied", "prompt"].includes(result?.state)
      ? result.state
      : null;
  } catch {
    return null;
  }
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

export function classifyVideoSourceError(error, kind, {
  stage = MEDIA_FAILURE_STAGES.CAPTURE,
  isSecureContext = true,
  permissionState = null,
} = {}) {
  const name = error?.name || "Error";
  const playbackPermission = kind === SOURCE_KINDS.FILE
    ? PERMISSION_STATES.NOT_REQUIRED
    : PERMISSION_STATES.GRANTED;

  if (kind !== SOURCE_KINDS.FILE && isSecureContext === false) {
    return {
      code: "insecure_context",
      permission: PERMISSION_STATES.UNAVAILABLE,
      message: kind === SOURCE_KINDS.DISPLAY
        ? "屏幕共享需要受信任的 HTTPS 页面或本机地址"
        : "手机摄像头需要已受信任证书的 HTTPS 页面；局域网 HTTP 无法授权",
    };
  }

  if (stage === MEDIA_FAILURE_STAGES.PLAYBACK) {
    if (error?.code === "media_request_timeout") {
      return {
        code: "playback_timeout",
        permission: playbackPermission,
        message: kind === SOURCE_KINDS.FILE
          ? "本地视频已选择，但预览启动超时，请重试"
          : "摄像头权限已允许，但视频预览启动超时，请重试",
      };
    }
    if (name === "NotAllowedError" || name === "SecurityError") {
      return {
        code: "playback_blocked",
        permission: playbackPermission,
        message: kind === SOURCE_KINDS.FILE
          ? "本地视频已选择，但预览被浏览器阻止，请重试"
          : "摄像头权限已允许，但视频预览被浏览器或系统策略阻止，请重试",
      };
    }
    return {
      code: "playback_failed",
      permission: playbackPermission,
      message: kind === SOURCE_KINDS.FILE
        ? "本地视频已选择，但预览无法启动，请更换文件后重试"
        : "摄像头权限已允许，但视频预览无法启动，请重试",
    };
  }

  if (error?.code === "media_request_timeout") {
    return {
      code: "media_request_timeout",
      permission: kind === SOURCE_KINDS.FILE
        ? PERMISSION_STATES.NOT_REQUIRED
        : PERMISSION_STATES.PROMPT,
      message: kind === SOURCE_KINDS.FILE
        ? "本地视频启动超时，请更换文件后重试"
        : "媒体权限或设备启动超时，请重试",
    };
  }
  if (name === "SecurityError") {
    return {
      code: "capture_security_blocked",
      permission: permissionState === "granted"
        ? PERMISSION_STATES.GRANTED
        : PERMISSION_STATES.UNAVAILABLE,
      message: kind === SOURCE_KINDS.DISPLAY
        ? "屏幕共享被浏览器安全策略阻止"
        : "摄像头访问被浏览器或宿主应用的安全策略阻止；请检查网站与系统相机权限",
    };
  }
  if (name === "NotAllowedError" && permissionState === "granted") {
    return {
      code: "capture_blocked",
      permission: PERMISSION_STATES.GRANTED,
      message: "摄像头权限已允许，但浏览器或系统未能启动设备；请检查系统相机权限和占用情况",
    };
  }
  if (name === "NotAllowedError" && permissionState !== "denied") {
    return {
      code: "permission_unresolved",
      permission: PERMISSION_STATES.PROMPT,
      message: kind === SOURCE_KINDS.DISPLAY
        ? "屏幕共享已取消或未获允许"
        : "摄像头请求未获浏览器允许；这不一定是用户拒绝，请检查网站、系统或嵌入浏览器权限",
    };
  }
  if (name === "NotAllowedError") {
    return {
      code: "permission_denied",
      permission: PERMISSION_STATES.DENIED,
      message: kind === SOURCE_KINDS.DISPLAY
        ? "屏幕共享已取消或权限被拒绝"
        : "摄像头已被网站权限阻止；请先在浏览器的网站设置中改为允许，再点重试",
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
