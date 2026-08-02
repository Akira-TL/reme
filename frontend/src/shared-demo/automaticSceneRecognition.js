import { captureJpegBase64 } from "./activityRecognition.js";

export const AUTOMATIC_SCENE_SAMPLE_DURATION_MS = 2_000;
const MAX_AUTOMATIC_SCENE_CLIP_BYTES = 2 * 1_024 * 1_024;
const MAX_AUTOMATIC_SCENE_KEYFRAME_BYTES = 640 * 1_024;
export const MAX_AUTOMATIC_SCENE_CLIP_BASE64_CHARS = Math.ceil(
  MAX_AUTOMATIC_SCENE_CLIP_BYTES / 3,
) * 4;
export const MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS = Math.ceil(
  MAX_AUTOMATIC_SCENE_KEYFRAME_BYTES / 3,
) * 4;

const MIN_CLIP_DURATION_MS = 250;
const MAX_CLIP_DURATION_MS = 4_000;
const DEFAULT_MIN_CONFIDENCE = 0.65;
const SCENE_IDS = Object.freeze(["living", "kitchen", "bathroom", "fall"]);
const CLASSIFICATIONS = Object.freeze([...SCENE_IDS, "uncertain"]);
const MP4_MIME_TYPES = Object.freeze(["video/mp4;codecs=h264", "video/mp4"]);
const SAMPLE_KEYS = Object.freeze([
  "duration_ms",
  "media_b64",
  "media_format",
  "visual_kind",
]);
const SUCCESS_KEYS = Object.freeze([
  "confidence",
  "latency_ms",
  "model",
  "ok",
  "reason",
  "scene_id",
  "temporal_evidence",
]);

function codedError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function abortError() {
  if (typeof DOMException === "function") {
    return new DOMException("自动场景采样已取消", "AbortError");
  }
  const error = new Error("自动场景采样已取消");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function isExactObject(value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isUnitNumber(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function isBoundedString(value, maxLength, allowEmpty = false) {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function isStrictBase64(value, maxChars, maxBytes) {
  const padding = typeof value === "string" && value.endsWith("==")
    ? 2
    : typeof value === "string" && value.endsWith("=") ? 1 : 0;
  return typeof value === "string"
    && value.length >= 4
    && value.length <= maxChars
    && value.length % 4 === 0
    && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    && ((value.length / 4) * 3) - padding <= maxBytes;
}

function isAutomaticSceneSample(value) {
  if (!isExactObject(value, SAMPLE_KEYS)) return false;
  if (value.visual_kind === "video_clip") {
    return value.media_format === "mp4"
      && Number.isSafeInteger(value.duration_ms)
      && value.duration_ms >= MIN_CLIP_DURATION_MS
      && value.duration_ms <= MAX_CLIP_DURATION_MS
      && isStrictBase64(
        value.media_b64,
        MAX_AUTOMATIC_SCENE_CLIP_BASE64_CHARS,
        MAX_AUTOMATIC_SCENE_CLIP_BYTES,
      );
  }
  return value.visual_kind === "keyframe"
    && value.media_format === "jpeg"
    && value.duration_ms === 0
    && isStrictBase64(
      value.media_b64,
      MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS,
      MAX_AUTOMATIC_SCENE_KEYFRAME_BYTES,
    );
}

function recognitionUrl(baseUrl) {
  if (typeof baseUrl !== "string" || baseUrl.length === 0) return null;
  try {
    const url = new URL(baseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:")
      || url.username.length > 0
      || url.password.length > 0
    ) return null;
    url.hash = "";
    url.search = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/scene/recognize`;
    return url.toString();
  } catch {
    return null;
  }
}

function responseErrorCode(payload) {
  return isBoundedString(payload?.error, 64)
    && /^[a-z0-9_]+$/.test(payload.error)
    ? payload.error
    : "scene_recognition_failed";
}

function parseSceneVerdict(payload, sample) {
  if (!isExactObject(payload, SUCCESS_KEYS) || payload.ok !== true) return null;
  if (!CLASSIFICATIONS.includes(payload.scene_id)) return null;
  if (!isUnitNumber(payload.confidence)) return null;
  if (!isBoundedString(payload.reason, 240)) return null;
  if (!isBoundedString(payload.model, 128)) return null;
  if (!Number.isFinite(payload.latency_ms) || payload.latency_ms < 0) return null;
  if (typeof payload.temporal_evidence !== "boolean") return null;
  if (sample.visual_kind === "keyframe" && payload.temporal_evidence) return null;
  return {
    classification: payload.scene_id,
    confidence: payload.confidence,
    reason: payload.reason,
    latencyMs: payload.latency_ms,
    temporalEvidence: payload.temporal_evidence,
    model: payload.model,
  };
}

export async function recognizeScene(
  baseUrl,
  token,
  sample,
  { signal, fetchImpl = globalThis.fetch } = {},
) {
  const url = recognitionUrl(baseUrl);
  if (url === null) {
    throw codedError("自动场景识别地址无效", "invalid_scene_recognition_url");
  }
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
    throw codedError("自动场景识别授权无效", "invalid_control_token");
  }
  if (!isAutomaticSceneSample(sample)) {
    throw codedError("自动场景样本不符合合同", "invalid_scene_sample");
  }
  if (typeof fetchImpl !== "function") {
    throw codedError("自动场景识别请求不可用", "scene_recognition_unavailable");
  }
  throwIfAborted(signal);

  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(sample),
    signal,
  });
  throwIfAborted(signal);
  const payload = await response.json().catch(() => null);
  throwIfAborted(signal);
  if (!response.ok) {
    const code = responseErrorCode(payload);
    throw codedError(payload?.error || `自动场景识别失败 (${response.status})`, code);
  }
  const verdict = parseSceneVerdict(payload, sample);
  if (verdict === null) {
    throw codedError("自动场景识别响应不符合合同", "invalid_scene_recognition_response");
  }
  return verdict;
}

function supportedMp4MimeType(MediaRecorderImpl) {
  if (typeof MediaRecorderImpl !== "function") return "";
  return MP4_MIME_TYPES.find((mimeType) => {
    try {
      return MediaRecorderImpl.isTypeSupported?.(mimeType) === true;
    } catch {
      return false;
    }
  }) || "";
}

function bytesToBase64(bytes) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const hasSecond = index + 1 < bytes.length;
    const hasThird = index + 2 < bytes.length;
    const second = hasSecond ? bytes[index + 1] : 0;
    const third = hasThird ? bytes[index + 2] : 0;
    const combined = (first << 16) | (second << 8) | third;
    encoded += alphabet[(combined >> 18) & 63];
    encoded += alphabet[(combined >> 12) & 63];
    encoded += hasSecond ? alphabet[(combined >> 6) & 63] : "=";
    encoded += hasThird ? alphabet[combined & 63] : "=";
  }
  return encoded;
}

async function blobToBase64(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

function captureKeyframe(video, captureJpegImpl) {
  const mediaB64 = safelyCaptureJpeg(video, captureJpegImpl);
  if (!isStrictBase64(
    mediaB64,
    MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS,
    MAX_AUTOMATIC_SCENE_KEYFRAME_BYTES,
  )) {
    throw codedError("无法取得自动场景视觉样本", "automatic_scene_sample_unavailable");
  }
  return {
    visual_kind: "keyframe",
    media_format: "jpeg",
    media_b64: mediaB64,
    duration_ms: 0,
  };
}

function safelyCaptureJpeg(video, captureJpegImpl) {
  try {
    return captureJpegImpl(video);
  } catch {
    return null;
  }
}

function readVideoTracks(stream) {
  try {
    return stream?.getVideoTracks?.() || [];
  } catch {
    return [];
  }
}

export function recordAutomaticSceneSample(
  stream,
  video,
  {
    signal,
    durationMs = AUTOMATIC_SCENE_SAMPLE_DURATION_MS,
    captureJpegImpl = captureJpegBase64,
    MediaRecorderImpl = globalThis.MediaRecorder,
    MediaStreamImpl = globalThis.MediaStream,
    setTimeoutImpl = globalThis.setTimeout,
    clearTimeoutImpl = globalThis.clearTimeout,
  } = {},
) {
  if (
    !Number.isSafeInteger(durationMs)
    || durationMs < MIN_CLIP_DURATION_MS
    || durationMs > MAX_CLIP_DURATION_MS
  ) {
    return Promise.reject(codedError(
      "自动场景视频采样时长无效",
      "invalid_scene_sample_duration",
    ));
  }
  if (typeof captureJpegImpl !== "function") {
    return Promise.reject(codedError(
      "自动场景关键帧采样不可用",
      "automatic_scene_sample_unavailable",
    ));
  }
  if (signal?.aborted) return Promise.reject(abortError());

  const mimeType = supportedMp4MimeType(MediaRecorderImpl);
  const videoTracks = readVideoTracks(stream);
  if (!mimeType || videoTracks.length === 0 || typeof MediaStreamImpl !== "function") {
    try {
      throwIfAborted(signal);
      return Promise.resolve(captureKeyframe(video, captureJpegImpl));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  let recorder;
  try {
    recorder = new MediaRecorderImpl(new MediaStreamImpl(videoTracks), {
      mimeType,
      videoBitsPerSecond: 600_000,
    });
  } catch {
    try {
      throwIfAborted(signal);
      return Promise.resolve(captureKeyframe(video, captureJpegImpl));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let timer = null;
    let settled = false;
    let finishing = false;

    const clearTimer = () => {
      if (timer !== null) clearTimeoutImpl(timer);
      timer = null;
    };
    const removeRecorderListeners = () => {
      recorder.removeEventListener?.("dataavailable", onData);
      recorder.removeEventListener?.("stop", onStop);
      recorder.removeEventListener?.("error", onError);
    };
    const cleanup = () => {
      clearTimer();
      removeRecorderListeners();
      signal?.removeEventListener?.("abort", onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fallback = () => {
      if (settled) return;
      try {
        throwIfAborted(signal);
        settle(resolve, captureKeyframe(video, captureJpegImpl));
      } catch (error) {
        settle(reject, error);
      }
    };
    const stopRecorder = () => {
      if (recorder.state === "inactive") return;
      try {
        recorder.stop();
      } catch {
        fallback();
      }
    };
    const finishClip = async () => {
      if (settled || finishing) return;
      finishing = true;
      clearTimer();
      if (chunks.length === 0) {
        fallback();
        return;
      }
      const blob = new Blob(chunks, { type: mimeType });
      if (blob.size > MAX_AUTOMATIC_SCENE_CLIP_BYTES) {
        fallback();
        return;
      }
      try {
        const mediaB64 = await blobToBase64(blob);
        throwIfAborted(signal);
        if (!isStrictBase64(
          mediaB64,
          MAX_AUTOMATIC_SCENE_CLIP_BASE64_CHARS,
          MAX_AUTOMATIC_SCENE_CLIP_BYTES,
        )) {
          fallback();
          return;
        }
        settle(resolve, {
          visual_kind: "video_clip",
          media_format: "mp4",
          media_b64: mediaB64,
          duration_ms: durationMs,
        });
      } catch (error) {
        if (error?.name === "AbortError") settle(reject, error);
        else fallback();
      }
    };
    function onData(event) {
      if (event.data?.size) chunks.push(event.data);
    }
    function onStop() {
      void finishClip();
    }
    function onError() {
      if (settled) return;
      finishing = true;
      cleanup();
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // The keyframe fallback below is independent of recorder shutdown.
      }
      finishing = false;
      fallback();
    }
    function onAbort() {
      if (settled) return;
      cleanup();
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // Cancellation remains complete even if MediaRecorder.stop() fails.
      }
      settle(reject, abortError());
    }

    recorder.addEventListener("dataavailable", onData);
    recorder.addEventListener("stop", onStop);
    recorder.addEventListener("error", onError);
    signal?.addEventListener?.("abort", onAbort, { once: true });
    try {
      recorder.start(250);
      if (!settled) timer = setTimeoutImpl(stopRecorder, durationMs);
    } catch {
      fallback();
    }
  });
}

export function selectAutomaticSceneAction(
  currentSceneId,
  verdict,
  { minConfidence = DEFAULT_MIN_CONFIDENCE } = {},
) {
  if (!SCENE_IDS.includes(currentSceneId)) {
    throw new TypeError("currentSceneId must be a supported demo scene");
  }
  if (!isUnitNumber(minConfidence)) {
    throw new TypeError("minConfidence must be between 0 and 1");
  }
  const classification = verdict?.classification;
  const confidence = verdict?.confidence;
  if (!CLASSIFICATIONS.includes(classification) || !isUnitNumber(confidence)) {
    return { type: "retain", sceneId: currentSceneId, reason: "invalid_verdict" };
  }
  if (classification === "uncertain") {
    return { type: "retain", sceneId: currentSceneId, reason: "uncertain" };
  }
  if (confidence < minConfidence) {
    return { type: "retain", sceneId: currentSceneId, reason: "low_confidence" };
  }
  if (classification === currentSceneId) {
    return { type: "retain", sceneId: currentSceneId, reason: "already_active" };
  }
  return { type: "switch", sceneId: classification, reason: "confident_scene" };
}
