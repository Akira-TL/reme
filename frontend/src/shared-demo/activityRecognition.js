const DEFAULT_MIN_CONFIDENCE = 0.65;
const DEFAULT_REQUIRED_CONSECUTIVE = 2;

function isUnitNumber(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function createCookingConfirmationTracker({
  minConfidence = DEFAULT_MIN_CONFIDENCE,
  requiredConsecutive = DEFAULT_REQUIRED_CONSECUTIVE,
} = {}) {
  let consecutive = 0;
  let confirmed = false;

  return {
    push(verdict) {
      if (
        !verdict
        || !["cooking", "not_cooking", "uncertain"].includes(verdict.classification)
        || !isUnitNumber(verdict.confidence)
      ) {
        consecutive = 0;
        return { phase: "unavailable", consecutive, confirmed: false };
      }
      if (verdict.classification === "cooking" && verdict.confidence >= minConfidence) {
        consecutive += 1;
      } else {
        consecutive = 0;
        confirmed = false;
      }
      if (consecutive >= requiredConsecutive) confirmed = true;
      return {
        phase: confirmed ? "confirmed" : "candidate",
        consecutive,
        confirmed,
      };
    },
    reset() {
      consecutive = 0;
      confirmed = false;
    },
  };
}

export function captureJpegBase64(video, { maxWidth = 640, quality = 0.7 } = {}) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null;
  const width = Math.max(1, Math.min(maxWidth, video.videoWidth));
  const height = Math.max(1, Math.round(width * (video.videoHeight / video.videoWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  try {
    const encoded = canvas.toDataURL("image/jpeg", quality);
    return encoded.startsWith("data:image/jpeg;base64,") ? encoded.split(",", 2)[1] : null;
  } catch {
    return null;
  }
}

export async function recognizeCooking(
  httpUrl,
  token,
  imageB64,
  fetchImpl = fetch,
  { signal } = {},
) {
  if (!token || !imageB64) throw new Error("缺少活动识别授权或画面样本");
  const startedAt = performance.now();
  const response = await fetchImpl(`${httpUrl}/api/activity/recognize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_b64: imageB64 }),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error || `活动识别失败 (${response.status})`);
    error.code = payload?.error || "activity_recognition_failed";
    throw error;
  }
  if (
    !["cooking", "not_cooking", "uncertain"].includes(payload.classification)
    || !isUnitNumber(payload.confidence)
    || typeof payload.reason !== "string"
    || typeof payload.model !== "string"
  ) {
    throw new Error("活动识别响应不符合合同");
  }
  return {
    classification: payload.classification,
    confidence: payload.confidence,
    reason: payload.reason,
    model: payload.model,
    latencyMs: Number.isFinite(payload.latency_ms)
      ? payload.latency_ms
      : performance.now() - startedAt,
  };
}

function supportedMomentMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

export function recordLocalMoment(stream, { durationMs = 6_000 } = {}) {
  if (!stream || typeof MediaRecorder === "undefined") {
    return { promise: Promise.resolve(null), cancel() {} };
  }
  const videoTracks = stream.getVideoTracks();
  if (!videoTracks.length) return { promise: Promise.resolve(null), cancel() {} };
  const mimeType = supportedMomentMimeType();
  let recorder;
  try {
    recorder = new MediaRecorder(new MediaStream(videoTracks), {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 450_000,
    });
  } catch {
    return { promise: Promise.resolve(null), cancel() {} };
  }
  let cancelled = false;
  let timer = 0;
  const chunks = [];
  const promise = new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      if (cancelled || !chunks.length) {
        resolve(null);
        return;
      }
      resolve({
        blob: new Blob(chunks, { type: recorder.mimeType || mimeType || "video/webm" }),
        mimeType: recorder.mimeType || mimeType || "video/webm",
        durationMs,
        recordedAtMs: Date.now(),
      });
    };
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size) chunks.push(event.data);
    });
    recorder.addEventListener("stop", finish, { once: true });
    recorder.addEventListener("error", () => resolve(null), { once: true });
    recorder.start(500);
    timer = window.setTimeout(() => {
      if (recorder.state !== "inactive") recorder.stop();
    }, durationMs);
  });

  return {
    promise,
    cancel() {
      cancelled = true;
      window.clearTimeout(timer);
      if (recorder.state !== "inactive") recorder.stop();
    },
  };
}
