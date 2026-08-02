import { isExactObject, isOpaqueId } from "./protocol";

const MAX_VOICE_SECONDS = 10;
const VOICE_SAMPLE_RATE = 16_000;
const VOICE_CHANNELS = 1;
const VOICE_BITS_PER_SAMPLE = 16;
const WAV_HEADER_BYTES = 44;
const MAX_VOICE_AUDIO_BYTES = WAV_HEADER_BYTES
  + MAX_VOICE_SECONDS * VOICE_SAMPLE_RATE * VOICE_CHANNELS * (VOICE_BITS_PER_SAMPLE / 8);
const MAX_VOICE_JSON_BYTES = 450 * 1_024;
const MAX_MIMO_RESPONSE_BYTES = 64 * 1_024;
const REQUEST_BODY_TIMEOUT_MS = 2_000;
const MIMO_TIMEOUT_MS = 6_000;
const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "mimo-v2.5";
const DANGER_HARD_PHRASES = [
  "救命",
  "快来人",
  "快来帮",
  "起不来",
  "站不起来",
  "动不了",
  "需要帮助",
  "请帮我",
  "帮我",
  "帮帮我",
  "扶我",
  "叫救护车",
  "打急救电话",
] as const;
const DANGER_SOFT_PHRASES = ["摔", "跌", "疼", "痛"] as const;
const DANGER_NEGATED_PHRASES = [
  "不需要帮助",
  "无需帮助",
  "不用帮助",
  "不需要帮我",
  "不用帮我",
  "不要帮我",
  "不用扶我",
  "不要扶我",
  "不用叫救护车",
  "不要叫救护车",
  "没摔",
  "没有摔",
  "没跌",
  "没有跌",
  "不疼",
  "不痛",
] as const;

type VoiceIntent = "safe" | "need_help" | "unclear";

export type DangerVoiceAttemptStart =
  | {
    ok: true;
    session_id: string;
    alarm_event_sequence: number;
    attempt: number;
  }
  | {
    ok: false;
    error:
      | "invalid_control_token"
      | "no_active_danger_event"
      | "voice_request_in_progress"
      | "voice_attempt_limit";
  };

export type DangerVoiceAttemptFinish =
  | { ok: true }
  | {
    ok: false;
    error: "invalid_control_token" | "invalid_voice_attempt" | "stale_danger_event";
  };

type DangerVoiceAttemptError = Extract<DangerVoiceAttemptStart, { ok: false }>["error"];
type DangerVoiceAttemptFinishError = Extract<DangerVoiceAttemptFinish, { ok: false }>["error"];

export interface DangerVoiceGate {
  authorizeTokenHash(tokenHash: string): Promise<boolean>;
  beginAttempt(
    tokenHash: string,
    eventId: string,
    requestId: string,
  ): Promise<DangerVoiceAttemptStart>;
  finishAttempt(
    tokenHash: string,
    sessionId: string,
    eventId: string,
    alarmEventSequence: number,
    requestId: string,
  ): Promise<DangerVoiceAttemptFinish>;
}

interface VoiceVerdict {
  intent: VoiceIntent;
  transcript: string | null;
}

type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; error: "missing" | "too_large" | "timeout" | "unreadable" };

export async function handleDangerVoice(
  request: Request,
  env: Env,
  gate: DangerVoiceGate,
): Promise<Response> {
  const token = readBearerToken(request);
  if (token === null) {
    return voiceJson({ ok: false, error: "missing_control_token" }, 401);
  }
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return voiceJson({ ok: false, error: "invalid_control_token" }, 401);
  }
  const tokenHash = await sha256Hex(token);
  if (!await gate.authorizeTokenHash(tokenHash)) {
    return voiceJson({ ok: false, error: "invalid_control_token" }, 401);
  }

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return voiceJson({ ok: false, error: "invalid_content_type" }, 415);
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      return voiceJson({ ok: false, error: "invalid_request" }, 400);
    }
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes)) {
      return voiceJson({ ok: false, error: "invalid_request" }, 400);
    }
    if (declaredBytes > MAX_VOICE_JSON_BYTES) {
      return voiceJson({ ok: false, error: "request_too_large" }, 413);
    }
  }

  const body = await readBoundedText(
    request.body,
    MAX_VOICE_JSON_BYTES,
    REQUEST_BODY_TIMEOUT_MS,
  );
  if (!body.ok) {
    if (body.error === "too_large") {
      return voiceJson({ ok: false, error: "request_too_large" }, 413);
    }
    if (body.error === "timeout") {
      return voiceJson({ ok: false, error: "request_timeout" }, 408);
    }
    return voiceJson({ ok: false, error: "invalid_request" }, 400);
  }

  const decoded = parseJson(body.text);
  if (
    !isExactObject(decoded, ["audio_b64", "audio_format", "event_id"])
    || !isOpaqueId(decoded.event_id)
    || decoded.audio_format !== "wav"
    || typeof decoded.audio_b64 !== "string"
  ) {
    return voiceJson({ ok: false, error: "invalid_request" }, 400);
  }

  const eventId = decoded.event_id;
  const audioB64 = decoded.audio_b64;

  const audio = decodeStrictBase64(audioB64, MAX_VOICE_AUDIO_BYTES);
  if (audio === null || !isExpectedWav(audio)) {
    return voiceJson({ ok: false, error: "invalid_wav" }, 415);
  }

  const apiKey = typeof env.MIMO_API_KEY === "string" ? env.MIMO_API_KEY.trim() : "";
  const model = typeof env.MIMO_MODEL === "string" && env.MIMO_MODEL.trim().length > 0
    ? env.MIMO_MODEL.trim()
    : DEFAULT_MIMO_MODEL;
  const baseUrlValue = typeof env.MIMO_BASE_URL === "string" && env.MIMO_BASE_URL.trim().length > 0
    ? env.MIMO_BASE_URL.trim()
    : DEFAULT_MIMO_BASE_URL;
  const endpoint = resolveMimoEndpoint(baseUrlValue);
  if (apiKey.length === 0 || endpoint === null || !/^[a-zA-Z0-9._/-]{1,128}$/.test(model)) {
    return voiceJson({ ok: false, error: "voice_recognition_misconfigured" }, 503);
  }

  const requestId = crypto.randomUUID();
  const attempt = await gate.beginAttempt(tokenHash, eventId, requestId);
  if (!attempt.ok) {
    return voiceAttemptError(attempt.error);
  }

  let attemptClosed = false;
  const finishAttempt = async (): Promise<DangerVoiceAttemptFinish> => {
    const result = await gate.finishAttempt(
      tokenHash,
      attempt.session_id,
      eventId,
      attempt.alarm_event_sequence,
      requestId,
    );
    attemptClosed = true;
    return result;
  };

  const startedAt = performance.now();
  const upstreamDeadlineAt = startedAt + MIMO_TIMEOUT_MS;
  let upstreamStatus: number | null = null;
  try {
    const timeoutSignal = AbortSignal.timeout(MIMO_TIMEOUT_MS);
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
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: [
                "你是老人跌倒问询后的语音回应判读器。",
                "只返回 JSON 对象，intent 必须是 safe、need_help 或 unclear，",
                "transcript 是听到的老人原话；无人声或听不清时 transcript 为 null。",
                "明确表示没事、不需要帮助为 safe；疼痛、摔倒、起不来、呼救或需要帮助为 need_help；",
                "证据不足为 unclear。不要输出其他字段。",
              ].join(""),
            },
            {
              role: "user",
              content: [
                { type: "text", text: "这是老人对“您还好吗、是否需要帮助”的短语音回应。" },
                {
                  type: "input_audio",
                  input_audio: { data: `data:audio/wav;base64,${audioB64}` },
                },
              ],
            },
          ],
          max_completion_tokens: 160,
          temperature: 0,
          thinking: { type: "disabled" },
          response_format: { type: "json_object" },
        }),
        signal: timeoutSignal,
      });
    } catch {
      const latencyMs = elapsedMs(startedAt);
      const timedOut = timeoutSignal.aborted;
      logVoiceCall({
        eventId,
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: timedOut ? "mimo_timeout" : "mimo_unavailable",
        audioBytes: audio.byteLength,
      });
      return voiceJson(
        { ok: false, error: timedOut ? "mimo_timeout" : "mimo_unavailable" },
        timedOut ? 504 : 502,
      );
    }

    upstreamStatus = upstream.status;
    if (timeoutSignal.aborted || performance.now() >= upstreamDeadlineAt) {
      if (upstream.body !== null) await upstream.body.cancel().catch(() => undefined);
      const latencyMs = elapsedMs(startedAt);
      logVoiceCall({
        eventId,
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: "mimo_timeout",
        audioBytes: audio.byteLength,
      });
      return voiceJson({ ok: false, error: "mimo_timeout" }, 504);
    }
    if (!upstream.ok) {
      if (upstream.body !== null) await upstream.body.cancel().catch(() => undefined);
      const latencyMs = elapsedMs(startedAt);
      const error = upstream.status === 429
        ? "mimo_rate_limited"
        : upstream.status === 401 || upstream.status === 403
          ? "mimo_auth_failed"
          : "mimo_unavailable";
      logVoiceCall({
        eventId,
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: error,
        audioBytes: audio.byteLength,
      });
      return voiceJson({ ok: false, error }, error === "mimo_auth_failed" ? 503 : 502);
    }

    const responseBody = await readBoundedText(
      upstream.body,
      MAX_MIMO_RESPONSE_BYTES,
      Math.max(1, Math.ceil(upstreamDeadlineAt - performance.now())),
    );
    if (
      timeoutSignal.aborted
      || performance.now() >= upstreamDeadlineAt
      || (!responseBody.ok && responseBody.error === "timeout")
    ) {
      const latencyMs = elapsedMs(startedAt);
      logVoiceCall({
        eventId,
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: "mimo_timeout",
        audioBytes: audio.byteLength,
      });
      return voiceJson({ ok: false, error: "mimo_timeout" }, 504);
    }
    const parsedVerdict = responseBody.ok ? parseMimoVerdict(responseBody.text) : null;
    const verdict = parsedVerdict === null ? null : applyDangerGuardrail(parsedVerdict);
    if (verdict === null) {
      const latencyMs = elapsedMs(startedAt);
      logVoiceCall({
        eventId,
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: "invalid_mimo_response",
        audioBytes: audio.byteLength,
      });
      return voiceJson({ ok: false, error: "invalid_mimo_response" }, 502);
    }

    const finish = await finishAttempt();
    const latencyMs = elapsedMs(startedAt);
    if (!finish.ok) {
      logVoiceCall({
        eventId,
        requestId,
        model,
        upstreamStatus,
        latencyMs,
        outcome: finish.error,
        audioBytes: audio.byteLength,
      });
      return voiceAttemptFinishError(finish.error);
    }

    logVoiceCall({
      eventId,
      requestId,
      model,
      upstreamStatus,
      latencyMs,
      outcome: verdict.intent,
      audioBytes: audio.byteLength,
    });
    return voiceJson({
      ok: true,
      intent: verdict.intent,
      transcript: verdict.transcript,
      model,
      latency_ms: latencyMs,
    });
  } finally {
    if (!attemptClosed) {
      try {
        await finishAttempt();
      } catch {
        console.error(JSON.stringify({
          event: "danger_voice_attempt_cleanup",
          event_id: eventId,
          request_id: requestId,
          provider: "xiaomi_mimo",
          model,
          status: "cleanup_failed",
          latency_ms: elapsedMs(startedAt),
          outcome: "internal_error",
          bytes: audio.byteLength,
        }));
      }
    }
  }
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

function decodeStrictBase64(value: string, maxDecodedBytes: number): Uint8Array | null {
  const maxEncodedLength = Math.ceil(maxDecodedBytes / 3) * 4;
  if (
    value.length < 4
    || value.length > maxEncodedLength
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) return null;
  try {
    const binary = atob(value);
    if (binary.length > maxDecodedBytes) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function isExpectedWav(value: Uint8Array): boolean {
  if (value.byteLength < WAV_HEADER_BYTES) return false;
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const ascii = (offset: number, length: number): string =>
    String.fromCharCode(...value.subarray(offset, offset + length));
  const dataBytes = view.getUint32(40, true);
  return ascii(0, 4) === "RIFF"
    && view.getUint32(4, true) === value.byteLength - 8
    && ascii(8, 4) === "WAVE"
    && ascii(12, 4) === "fmt "
    && view.getUint32(16, true) === 16
    && view.getUint16(20, true) === 1
    && view.getUint16(22, true) === VOICE_CHANNELS
    && view.getUint32(24, true) === VOICE_SAMPLE_RATE
    && view.getUint32(28, true) === VOICE_SAMPLE_RATE * 2
    && view.getUint16(32, true) === 2
    && view.getUint16(34, true) === VOICE_BITS_PER_SAMPLE
    && ascii(36, 4) === "data"
    && dataBytes > 0
    && dataBytes === value.byteLength - WAV_HEADER_BYTES
    && dataBytes <= MAX_VOICE_AUDIO_BYTES - WAV_HEADER_BYTES;
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

function parseMimoVerdict(raw: string): VoiceVerdict | null {
  const response = parseJson(raw);
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length !== 1) {
    return null;
  }
  const first = response.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    return null;
  }
  const content = parseJson(first.message.content);
  if (!isExactObject(content, ["intent", "transcript"])) return null;
  if (content.intent !== "safe" && content.intent !== "need_help" && content.intent !== "unclear") {
    return null;
  }
  if (content.transcript !== null && typeof content.transcript !== "string") return null;
  const transcript = content.transcript?.trim() || null;
  if (transcript !== null && transcript.length > 240) return null;
  return { intent: content.intent, transcript };
}

function applyDangerGuardrail(verdict: VoiceVerdict): VoiceVerdict {
  if (verdict.transcript === null) {
    return verdict.intent === "safe" ? { ...verdict, intent: "unclear" } : verdict;
  }
  if (verdict.intent === "need_help") return verdict;
  let unnegated = verdict.transcript;
  for (const phrase of DANGER_NEGATED_PHRASES) {
    unnegated = unnegated.split(phrase).join("");
  }
  if (DANGER_HARD_PHRASES.some((phrase) => unnegated.includes(phrase))) {
    return { ...verdict, intent: "need_help" };
  }
  if (
    verdict.intent === "unclear"
    && DANGER_SOFT_PHRASES.some((phrase) => unnegated.includes(phrase))
  ) {
    return { ...verdict, intent: "need_help" };
  }
  return verdict;
}

function voiceAttemptError(error: DangerVoiceAttemptError): Response {
  if (error === "invalid_control_token") {
    return voiceJson({ ok: false, error }, 401);
  }
  if (error === "no_active_danger_event") {
    return voiceJson({ ok: false, error }, 409);
  }
  if (error === "voice_request_in_progress") {
    return voiceJson({ ok: false, error }, 409);
  }
  return voiceJson({ ok: false, error: "voice_attempt_limit" }, 429);
}

function voiceAttemptFinishError(error: DangerVoiceAttemptFinishError): Response {
  if (error === "invalid_control_token") {
    return voiceJson({ ok: false, error }, 401);
  }
  return voiceJson({ ok: false, error }, 409);
}

function logVoiceCall(input: {
  eventId: string;
  requestId: string;
  model: string;
  upstreamStatus: number | null;
  latencyMs: number;
  outcome: string;
  audioBytes: number;
}): void {
  console.log(JSON.stringify({
    event: "danger_voice_mimo",
    event_id: input.eventId,
    request_id: input.requestId,
    provider: "xiaomi_mimo",
    model: input.model,
    status: input.upstreamStatus,
    latency_ms: input.latencyMs,
    outcome: input.outcome,
    bytes: input.audioBytes,
  }));
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

function voiceJson(
  payload: unknown,
  status = 200,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(payload, { status, headers });
}
