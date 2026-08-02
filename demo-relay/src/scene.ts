import { isExactObject } from "./protocol";

const MAX_SCENE_JSON_BYTES = 3 * 1_024 * 1_024;
const MAX_VIDEO_BYTES = 2 * 1_024 * 1_024;
const MAX_KEYFRAME_BYTES = 640 * 1_024;
const MAX_MIMO_RESPONSE_BYTES = 64 * 1_024;
const MAX_VIDEO_DURATION_MS = 4_000;
const MIN_VIDEO_DURATION_MS = 250;
const REQUEST_BODY_TIMEOUT_MS = 2_000;
const TOTAL_TIMEOUT_MS = 8_000;
const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "mimo-v2.5";

type SceneClassification = "living" | "kitchen" | "bathroom" | "fall" | "uncertain";
type VisualKind = "video_clip" | "keyframe";
type MediaFormat = "mp4" | "jpeg";

interface SceneVerdict {
  scene_id: SceneClassification;
  confidence: number;
  reason: string;
  temporal_evidence: boolean;
}

interface VisualSample {
  visualKind: VisualKind;
  mediaFormat: MediaFormat;
  mediaB64: string;
  durationMs: number;
  mediaBytes: number;
}

type SampleParseResult =
  | { ok: true; sample: VisualSample }
  | { ok: false; error: "invalid_request" | "invalid_media" | "media_too_large" };

type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; error: "missing" | "too_large" | "timeout" | "unreadable" };

export type SceneRecognitionAttemptStart =
  | { ok: true; session_id: string }
  | { ok: false; error: "invalid_control_token" }
  | { ok: false; error: "scene_request_in_progress" }
  | { ok: false; error: "scene_rate_limited"; retry_after_ms: number };

export type SceneRecognitionAttemptFinish =
  | { ok: true }
  | { ok: false; error: "invalid_control_token" | "invalid_scene_attempt" };

export interface SceneRecognitionGate {
  authorizeTokenHash(tokenHash: string): Promise<boolean>;
  beginAttempt(tokenHash: string, requestId: string): Promise<SceneRecognitionAttemptStart>;
  finishAttempt(
    tokenHash: string,
    sessionId: string,
    requestId: string,
  ): Promise<SceneRecognitionAttemptFinish>;
}

export async function handleSceneRecognition(
  request: Request,
  env: Env,
  gate: SceneRecognitionGate,
): Promise<Response> {
  const requestStartedAt = performance.now();
  const deadlineAt = requestStartedAt + TOTAL_TIMEOUT_MS;
  const token = readBearerToken(request);
  if (token === null) {
    return sceneJson({ ok: false, error: "missing_control_token" }, 401);
  }
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return sceneJson({ ok: false, error: "invalid_control_token" }, 401);
  }
  const tokenHash = await sha256Hex(token);
  if (!await gate.authorizeTokenHash(tokenHash)) {
    return sceneJson({ ok: false, error: "invalid_control_token" }, 401);
  }

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return sceneJson({ ok: false, error: "invalid_content_type" }, 415);
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return sceneJson({ ok: false, error: "invalid_request" }, 400);
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      return sceneJson({ ok: false, error: "invalid_request" }, 400);
    }
    if (declaredBytes > MAX_SCENE_JSON_BYTES) {
      return sceneJson({ ok: false, error: "request_too_large" }, 413);
    }
  }

  const bodyTimeoutMs = Math.min(REQUEST_BODY_TIMEOUT_MS, remainingMs(deadlineAt));
  if (bodyTimeoutMs < 1) {
    return sceneJson({ ok: false, error: "request_timeout" }, 408);
  }
  const body = await readBoundedText(request.body, MAX_SCENE_JSON_BYTES, bodyTimeoutMs);
  if (!body.ok) {
    if (body.error === "too_large") {
      return sceneJson({ ok: false, error: "request_too_large" }, 413);
    }
    if (body.error === "timeout") {
      return sceneJson({ ok: false, error: "request_timeout" }, 408);
    }
    return sceneJson({ ok: false, error: "invalid_request" }, 400);
  }

  const sampleResult = parseVisualSample(parseJson(body.text));
  if (!sampleResult.ok) {
    if (sampleResult.error === "media_too_large") {
      return sceneJson({ ok: false, error: "media_too_large" }, 413);
    }
    return sceneJson(
      { ok: false, error: sampleResult.error },
      sampleResult.error === "invalid_media" ? 415 : 400,
    );
  }
  const sample = sampleResult.sample;

  const apiKey = typeof env.MIMO_API_KEY === "string" ? env.MIMO_API_KEY.trim() : "";
  const model = typeof env.MIMO_MODEL === "string" && env.MIMO_MODEL.trim().length > 0
    ? env.MIMO_MODEL.trim()
    : DEFAULT_MIMO_MODEL;
  const baseUrlValue = typeof env.MIMO_BASE_URL === "string" && env.MIMO_BASE_URL.trim().length > 0
    ? env.MIMO_BASE_URL.trim()
    : DEFAULT_MIMO_BASE_URL;
  const endpoint = resolveMimoEndpoint(baseUrlValue);
  if (
    apiKey.length === 0
    || endpoint === null
    || !/^[a-zA-Z0-9._/-]{1,128}$/.test(model)
  ) {
    return sceneJson({ ok: false, error: "scene_recognition_misconfigured" }, 503);
  }

  const requestId = crypto.randomUUID();
  const attempt = await gate.beginAttempt(tokenHash, requestId);
  if (!attempt.ok) return sceneAttemptError(attempt);

  let attemptClosed = false;
  const finishAttempt = async (): Promise<SceneRecognitionAttemptFinish> => {
    const result = await gate.finishAttempt(tokenHash, attempt.session_id, requestId);
    attemptClosed = true;
    return result;
  };

  let upstreamStatus: number | null = null;
  try {
    const fetchTimeoutMs = remainingMs(deadlineAt);
    if (fetchTimeoutMs < 1) {
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome: "mimo_timeout",
        sample,
      });
      return sceneJson({ ok: false, error: "mimo_timeout" }, 504);
    }
    const timeoutSignal = AbortSignal.timeout(fetchTimeoutMs);
    let upstream: Response;
    try {
      upstream = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "reme-demo-relay/0.3",
        },
        body: JSON.stringify(buildMimoRequest(model, sample)),
        signal: timeoutSignal,
      });
    } catch (error) {
      const timedOut = timeoutSignal.aborted
        || performance.now() >= deadlineAt
        || (error instanceof DOMException && error.name === "TimeoutError");
      const outcome = timedOut ? "mimo_timeout" : "mimo_unavailable";
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome,
        sample,
      });
      return sceneJson({ ok: false, error: outcome }, timedOut ? 504 : 502);
    }

    upstreamStatus = upstream.status;
    if (timeoutSignal.aborted || performance.now() >= deadlineAt) {
      if (upstream.body !== null) await upstream.body.cancel().catch(() => undefined);
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome: "mimo_timeout",
        sample,
      });
      return sceneJson({ ok: false, error: "mimo_timeout" }, 504);
    }
    if (!upstream.ok) {
      if (upstream.body !== null) await upstream.body.cancel().catch(() => undefined);
      const outcome = upstream.status === 429
        ? "mimo_rate_limited"
        : upstream.status === 401 || upstream.status === 403
          ? "scene_recognition_misconfigured"
          : "mimo_unavailable";
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome,
        sample,
      });
      return sceneJson(
        { ok: false, error: outcome },
        outcome === "scene_recognition_misconfigured" ? 503 : 502,
      );
    }

    const responseTimeoutMs = remainingMs(deadlineAt);
    if (responseTimeoutMs < 1) {
      if (upstream.body !== null) await upstream.body.cancel().catch(() => undefined);
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome: "mimo_timeout",
        sample,
      });
      return sceneJson({ ok: false, error: "mimo_timeout" }, 504);
    }
    const responseBody = await readBoundedText(
      upstream.body,
      MAX_MIMO_RESPONSE_BYTES,
      responseTimeoutMs,
    );
    if (
      timeoutSignal.aborted
      || performance.now() >= deadlineAt
      || (!responseBody.ok && responseBody.error === "timeout")
    ) {
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome: "mimo_timeout",
        sample,
      });
      return sceneJson({ ok: false, error: "mimo_timeout" }, 504);
    }
    const verdict = responseBody.ok
      ? parseMimoVerdict(responseBody.text, sample.visualKind)
      : null;
    if (verdict === null) {
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs: elapsedMs(requestStartedAt),
        outcome: "invalid_mimo_response",
        sample,
      });
      return sceneJson({ ok: false, error: "invalid_mimo_response" }, 502);
    }

    const finish = await finishAttempt();
    const latencyMs = elapsedMs(requestStartedAt);
    if (!finish.ok) {
      logSceneCall({
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: finish.error,
        sample,
      });
      return sceneAttemptFinishError(finish.error);
    }

    logSceneCall({
      requestId,
      model,
      upstreamStatus,
      latencyMs,
      outcome: "success",
      sample,
    });
    return sceneJson({
      ok: true,
      ...verdict,
      model,
      latency_ms: latencyMs,
    });
  } finally {
    if (!attemptClosed) {
      try {
        await finishAttempt();
      } catch {
        console.error(JSON.stringify({
          event: "scene_recognition_attempt_cleanup",
          request_id: requestId,
          provider: "xiaomi_mimo",
          model,
          status: "cleanup_failed",
          latency_ms: elapsedMs(requestStartedAt),
          outcome: "internal_error",
          visual_kind: sample.visualKind,
          media_format: sample.mediaFormat,
          duration_ms: sample.durationMs,
          bytes: sample.mediaBytes,
        }));
      }
    }
  }
}

function parseVisualSample(value: unknown): SampleParseResult {
  if (
    !isExactObject(value, ["duration_ms", "media_b64", "media_format", "visual_kind"])
    || typeof value.media_b64 !== "string"
    || !Number.isSafeInteger(value.duration_ms)
  ) {
    return { ok: false, error: "invalid_request" };
  }

  let maxBytes: number;
  if (
    value.visual_kind === "video_clip"
    && value.media_format === "mp4"
    && (value.duration_ms as number) >= MIN_VIDEO_DURATION_MS
    && (value.duration_ms as number) <= MAX_VIDEO_DURATION_MS
  ) {
    maxBytes = MAX_VIDEO_BYTES;
  } else if (
    value.visual_kind === "keyframe"
    && value.media_format === "jpeg"
    && value.duration_ms === 0
  ) {
    maxBytes = MAX_KEYFRAME_BYTES;
  } else {
    return { ok: false, error: "invalid_request" };
  }

  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.media_b64.length > maxEncodedLength) {
    return { ok: false, error: "media_too_large" };
  }
  const media = decodeStrictBase64(value.media_b64);
  if (media === null) return { ok: false, error: "invalid_media" };
  if (media.byteLength > maxBytes) return { ok: false, error: "media_too_large" };
  if (
    (value.visual_kind === "video_clip" && !isMp4(media))
    || (value.visual_kind === "keyframe" && !isJpeg(media))
  ) {
    return { ok: false, error: "invalid_media" };
  }

  return {
    ok: true,
    sample: {
      visualKind: value.visual_kind,
      mediaFormat: value.media_format,
      mediaB64: value.media_b64,
      durationMs: value.duration_ms as number,
      mediaBytes: media.byteLength,
    },
  };
}

function buildMimoRequest(model: string, sample: VisualSample): Record<string, unknown> {
  const mediaPart = sample.visualKind === "video_clip"
    ? {
      type: "video_url",
      video_url: { url: `data:video/mp4;base64,${sample.mediaB64}` },
      fps: 1,
    }
    : {
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${sample.mediaB64}` },
    };
  return {
    model,
    messages: [
      {
        role: "system",
        content: [
          "你是家庭照护演示的保守场景分类器。",
          "scene_id 只能是 living、kitchen、bathroom、fall 或 uncertain。",
          "living 表示普通且未见下列特殊证据的居家活动；",
          "kitchen 只表示明确正在做饭或备菜，不能仅因位于厨房而选择；",
          "bathroom 表示明确的卫生间、洗浴或如厕环境；",
          "fall 只表示人物出现突然倒下、异常坍倒或倒地的可观察候选，不代表已经告警；",
          "正常坐下、弯腰、躺床、画面不清或证据冲突必须选择 uncertain。",
          "confidence 必须是 0 到 1；reason 是不超过 240 字的一句可观察依据；",
          "temporal_evidence 只有在视频跨帧运动直接支持结论时才为 true，单张图片必须为 false。",
          "只返回包含 scene_id、confidence、reason、temporal_evidence 的 JSON 对象。",
        ].join(""),
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: sample.visualKind === "video_clip"
              ? `请分类这段 ${sample.durationMs} 毫秒的显式短视频样本。`
              : "短视频不可用，请分类这一张显式降级关键帧。",
          },
          mediaPart,
        ],
      },
    ],
    max_completion_tokens: 180,
    temperature: 0,
    thinking: { type: "disabled" },
    response_format: { type: "json_object" },
  };
}

function parseMimoVerdict(raw: string, visualKind: VisualKind): SceneVerdict | null {
  const response = parseJson(raw);
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length !== 1) {
    return null;
  }
  const first = response.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    return null;
  }
  const content = parseJson(first.message.content);
  if (
    !isExactObject(content, ["confidence", "reason", "scene_id", "temporal_evidence"])
    || !isSceneClassification(content.scene_id)
    || typeof content.confidence !== "number"
    || !Number.isFinite(content.confidence)
    || content.confidence < 0
    || content.confidence > 1
    || typeof content.reason !== "string"
    || content.reason.trim().length < 1
    || content.reason.length > 240
    || typeof content.temporal_evidence !== "boolean"
    || (visualKind === "keyframe" && content.temporal_evidence)
  ) return null;
  return {
    scene_id: content.scene_id,
    confidence: content.confidence,
    reason: content.reason.trim(),
    temporal_evidence: content.temporal_evidence,
  };
}

function isSceneClassification(value: unknown): value is SceneClassification {
  return value === "living"
    || value === "kitchen"
    || value === "bathroom"
    || value === "fall"
    || value === "uncertain";
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : null;
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  timeoutMs: number,
): Promise<BoundedRead> {
  if (stream === null) return { ok: false, error: "missing" };
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytesRead = 0;
  let text = "";
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error("bounded read timed out"));
    }, timeoutMs);
  });
  try {
    while (true) {
      const result = await Promise.race([reader.read(), timeout]);
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, error: "too_large" };
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, error: timedOut ? "timeout" : "unreadable" };
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    reader.releaseLock();
  }
}

function decodeStrictBase64(value: string): Uint8Array | null {
  if (
    value.length < 4
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function isJpeg(value: Uint8Array): boolean {
  return value.length >= 4
    && value[0] === 0xff
    && value[1] === 0xd8
    && value[2] === 0xff
    && value[value.length - 2] === 0xff
    && value[value.length - 1] === 0xd9;
}

function isMp4(value: Uint8Array): boolean {
  if (value.length < 12) return false;
  const firstBoxSize = new DataView(value.buffer, value.byteOffset, 4).getUint32(0, false);
  return firstBoxSize >= 12
    && firstBoxSize <= value.length
    && value[4] === 0x66
    && value[5] === 0x74
    && value[6] === 0x79
    && value[7] === 0x70;
}

function resolveMimoEndpoint(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== "api.xiaomimimo.com"
      || parsed.port.length > 0
      || parsed.username.length > 0
      || parsed.password.length > 0
    ) return null;
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/chat/completions`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function sceneAttemptError(attempt: Extract<SceneRecognitionAttemptStart, { ok: false }>): Response {
  if (attempt.error === "invalid_control_token") {
    return sceneJson({ ok: false, error: attempt.error }, 401);
  }
  if (attempt.error === "scene_request_in_progress") {
    return sceneJson({ ok: false, error: attempt.error }, 409);
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(attempt.retry_after_ms / 1_000));
  return sceneJson(
    { ok: false, error: attempt.error, retry_after_ms: attempt.retry_after_ms },
    429,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

function sceneAttemptFinishError(error: Extract<SceneRecognitionAttemptFinish, { ok: false }>["error"]): Response {
  if (error === "invalid_control_token") {
    return sceneJson({ ok: false, error }, 401);
  }
  return sceneJson({ ok: false, error }, 409);
}

function logSceneCall(input: {
  requestId: string;
  model: string;
  upstreamStatus: number | null;
  latencyMs: number;
  outcome: string;
  sample: VisualSample;
}): void {
  console.log(JSON.stringify({
    event: "scene_recognition_mimo",
    request_id: input.requestId,
    provider: "xiaomi_mimo",
    model: input.model,
    status: input.upstreamStatus,
    latency_ms: input.latencyMs,
    outcome: input.outcome,
    visual_kind: input.sample.visualKind,
    media_format: input.sample.mediaFormat,
    duration_ms: input.sample.durationMs,
    bytes: input.sample.mediaBytes,
  }));
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, Math.ceil(deadlineAt - performance.now()));
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sceneJson(
  payload: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(payload, { status, headers });
}
