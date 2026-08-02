const DEFAULT_MIN_CONFIDENCE = 0.65;
const DEFAULT_REQUIRED_CONSECUTIVE = 2;
const DEFAULT_RECORDER_SETTLEMENT_MS = 1_500;

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
    || !Number.isSafeInteger(payload.consecutive)
    || payload.consecutive < 0
    || payload.consecutive > 100
    || !(
      payload.receipt_id === null
      || (typeof payload.receipt_id === "string"
        && /^activity-receipt-[a-f0-9]{32}$/.test(payload.receipt_id))
    )
    || ((payload.consecutive >= 2) !== (payload.receipt_id !== null))
    || (payload.receipt_id !== null
      && (payload.classification !== "cooking" || payload.confidence < DEFAULT_MIN_CONFIDENCE))
  ) {
    throw new Error("活动识别响应不符合合同");
  }
  return {
    classification: payload.classification,
    confidence: payload.confidence,
    reason: payload.reason,
    model: payload.model,
    receiptId: payload.receipt_id,
    consecutive: payload.consecutive,
    latencyMs: Number.isFinite(payload.latency_ms)
      ? payload.latency_ms
      : performance.now() - startedAt,
  };
}

export function isCookingRecognitionContextCurrent(context, current) {
  return Boolean(
    context
    && current
    && current.captureActive === true
    && current.sceneId === "kitchen"
    && current.visibilityState === "visible"
    && context.generation === current.generation
    && context.captureGeneration === current.captureGeneration
    && context.stream === current.stream
    && context.sessionId === current.sessionId
    && context.token === current.token,
  );
}

export function classifyCookingConfirmationAck(pending, ack, current) {
  if (!pending || !ack) return "ignore";
  const rejected = ack.type === "error"
    && ack.error === "activity_evidence_not_verified"
    && ack.event_type === "activity_state"
    && Number.isSafeInteger(ack.event_sequence)
    && ack.event_sequence === pending.eventSequence;
  const acknowledged = ack.type === "event_accepted"
    && ack.event_type === "activity_state"
    && Number.isSafeInteger(ack.event_sequence)
    && ack.event_sequence === pending.eventSequence;
  if (!acknowledged && !rejected) return "ignore";
  if (!isCookingRecognitionContextCurrent(pending.context, current)) return "stale";
  // Older Relay versions emit the same generic ACK without proving that the
  // one-time receipt was consumed, so absence of this marker must fail closed.
  return acknowledged && ack.activity_verified === true ? "verified" : "rejected";
}

function supportedMomentMimeType(MediaRecorderImpl) {
  if (!MediaRecorderImpl) return "";
  const candidates = [
    "video/mp4;codecs=h264",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  return candidates.find((type) => MediaRecorderImpl.isTypeSupported?.(type)) || "";
}

export function recordLocalMoment(stream, {
  MediaRecorderImpl = globalThis.MediaRecorder,
  MediaStreamImpl = globalThis.MediaStream,
  clearTimeoutImpl = globalThis.clearTimeout,
  durationMs = 6_000,
  nowImpl = Date.now,
  setTimeoutImpl = globalThis.setTimeout,
  settlementTimeoutMs = DEFAULT_RECORDER_SETTLEMENT_MS,
} = {}) {
  if (!stream || !MediaRecorderImpl || !MediaStreamImpl) {
    const promise = Promise.resolve(null);
    return { promise, cancel: () => promise };
  }
  const videoTracks = stream.getVideoTracks();
  if (
    !videoTracks.length
    || !Number.isFinite(durationMs)
    || durationMs < 0
    || !Number.isFinite(settlementTimeoutMs)
    || settlementTimeoutMs < 0
  ) {
    const promise = Promise.resolve(null);
    return { promise, cancel: () => promise };
  }
  const mimeType = supportedMomentMimeType(MediaRecorderImpl);
  let recorder;
  try {
    recorder = new MediaRecorderImpl(new MediaStreamImpl(videoTracks), {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: 450_000,
    });
  } catch {
    const promise = Promise.resolve(null);
    return { promise, cancel: () => promise };
  }
  let cancelled = false;
  let durationTimer = 0;
  let settlementTimer = 0;
  let settled = false;
  let cancelRecording = () => {};
  const chunks = [];
  const promise = new Promise((resolve) => {
    const cleanup = () => {
      clearTimeoutImpl(durationTimer);
      clearTimeoutImpl(settlementTimer);
      recorder.removeEventListener("dataavailable", onData);
      recorder.removeEventListener("stop", onStop);
      recorder.removeEventListener("error", onError);
    };
    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onData = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };
    const onStop = () => {
      if (cancelled || !chunks.length) {
        settle(null);
        return;
      }
      const resolvedMimeType = recorder.mimeType || mimeType || "video/webm";
      settle({
        blob: new Blob(chunks, { type: resolvedMimeType }),
        mimeType: resolvedMimeType,
        durationMs,
        recordedAtMs: nowImpl(),
      });
    };
    const onError = () => {
      cancelled = true;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // The error event is already terminal for this local-only draft.
        }
      }
      settle(null);
    };
    const requestStop = () => {
      if (settled) return;
      if (recorder.state === "inactive") {
        settle(null);
        return;
      }
      try {
        recorder.stop();
      } catch {
        settle(null);
        return;
      }
      if (!settled) {
        settlementTimer = setTimeoutImpl(
          () => settle(null),
          settlementTimeoutMs,
        );
      }
    };
    recorder.addEventListener("dataavailable", onData);
    recorder.addEventListener("stop", onStop, { once: true });
    recorder.addEventListener("error", onError, { once: true });
    try {
      recorder.start(500);
    } catch {
      settle(null);
      return;
    }
    if (settled) return;
    durationTimer = setTimeoutImpl(requestStop, durationMs);

    cancelRecording = () => {
      cancelled = true;
      requestStop();
      if (!settled) settle(null);
    };
  });

  return {
    promise,
    cancel() {
      cancelRecording();
      return promise;
    },
  };
}
