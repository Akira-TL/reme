import { isExactObject } from "./protocol";

const MAX_ACTIVITY_JSON_BYTES = 900 * 1_024;
const MAX_MIMO_RESPONSE_BYTES = 64 * 1_024;
const MIMO_TIMEOUT_MS = 8_000;
const DEFAULT_MIMO_BASE_URL = "https://api.xiaomimimo.com/v1";
const DEFAULT_MIMO_MODEL = "mimo-v2.5";

type ActivityClassification = "cooking" | "not_cooking" | "uncertain";

interface ActivityVerdict {
  classification: ActivityClassification;
  confidence: number;
  reason: string;
}

type BoundedRead =
  | { ok: true; text: string }
  | { ok: false; error: "missing" | "too_large" | "unreadable" };

export async function handleActivityRecognition(
  request: Request,
  env: Env,
  authorizeTokenHash: (tokenHash: string) => Promise<boolean>,
): Promise<Response> {
  const token = readBearerToken(request);
  if (token === null) {
    return activityJson({ ok: false, error: "missing_control_token" }, 401);
  }
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return activityJson({ ok: false, error: "invalid_control_token" }, 401);
  }
  const tokenHash = await sha256Hex(token);
  if (!await authorizeTokenHash(tokenHash)) {
    return activityJson({ ok: false, error: "invalid_control_token" }, 401);
  }

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return activityJson({ ok: false, error: "invalid_content_type" }, 415);
  }

  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0) {
      return activityJson({ ok: false, error: "invalid_request" }, 400);
    }
    if (declaredBytes > MAX_ACTIVITY_JSON_BYTES) {
      return activityJson({ ok: false, error: "request_too_large" }, 413);
    }
  }

  const body = await readBoundedText(request.body, MAX_ACTIVITY_JSON_BYTES);
  if (!body.ok) {
    return activityJson(
      { ok: false, error: body.error === "too_large" ? "request_too_large" : "invalid_request" },
      body.error === "too_large" ? 413 : 400,
    );
  }
  const decoded = parseJson(body.text);
  if (!isExactObject(decoded, ["image_b64"]) || typeof decoded.image_b64 !== "string") {
    return activityJson({ ok: false, error: "invalid_request" }, 400);
  }
  const jpeg = decodeStrictBase64(decoded.image_b64);
  if (jpeg === null || !isJpeg(jpeg)) {
    return activityJson({ ok: false, error: "invalid_jpeg" }, 415);
  }

  const apiKey = typeof env.MIMO_API_KEY === "string" ? env.MIMO_API_KEY.trim() : "";
  const model = typeof env.MIMO_MODEL === "string" && env.MIMO_MODEL.trim().length > 0
    ? env.MIMO_MODEL.trim()
    : DEFAULT_MIMO_MODEL;
  const baseUrlValue = typeof env.MIMO_BASE_URL === "string" && env.MIMO_BASE_URL.trim().length > 0
    ? env.MIMO_BASE_URL.trim()
    : DEFAULT_MIMO_BASE_URL;
  const endpoint = resolveMimoEndpoint(baseUrlValue);
  if (apiKey.length === 0 || endpoint === null || model.length > 128) {
    return activityJson({ ok: false, error: "activity_recognition_misconfigured" }, 503);
  }

  const startedAt = performance.now();
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "User-Agent": "reme-demo-relay/0.2",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: [
              "你是家庭照护演示的保守视觉分类器。",
              "只判断当前单张图片是否明确显示人物正在做饭或备菜。",
              "洗碗、打扫、仅站在厨房、看不清或证据不足都不要判 cooking。",
              "只返回 JSON：classification 必须是 cooking、not_cooking 或 uncertain；",
              "confidence 是 0 到 1；reason 是不超过 240 字的一句可观察依据。",
            ].join(""),
          },
          {
            role: "user",
            content: [
              { type: "text", text: "请保守分类这一个最小现场样本。" },
              {
                type: "image_url",
                image_url: { url: `data:image/jpeg;base64,${decoded.image_b64}` },
              },
            ],
          },
        ],
        max_completion_tokens: 160,
        temperature: 0,
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(MIMO_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === "TimeoutError";
    return activityJson(
      { ok: false, error: timedOut ? "mimo_timeout" : "mimo_unavailable" },
      timedOut ? 504 : 502,
    );
  }

  if (!upstream.ok) {
    return activityJson(
      { ok: false, error: "mimo_unavailable", upstream_status: upstream.status },
      502,
    );
  }
  const responseBody = await readBoundedText(upstream.body, MAX_MIMO_RESPONSE_BYTES);
  if (!responseBody.ok) {
    return activityJson({ ok: false, error: "invalid_mimo_response" }, 502);
  }
  const verdict = parseMimoVerdict(responseBody.text);
  if (verdict === null) {
    return activityJson({ ok: false, error: "invalid_mimo_response" }, 502);
  }

  return activityJson({
    ok: true,
    ...verdict,
    model,
    latency_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  });
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
): Promise<BoundedRead> {
  if (stream === null) return { ok: false, error: "missing" };
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytesRead += result.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return { ok: false, error: "too_large" };
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch {
    return { ok: false, error: "unreadable" };
  } finally {
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

function resolveMimoEndpoint(baseUrl: string): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0) {
      return null;
    }
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/chat/completions`;
    return parsed.toString();
  } catch {
    return null;
  }
}

function parseMimoVerdict(raw: string): ActivityVerdict | null {
  const response = parseJson(raw);
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length < 1) {
    return null;
  }
  const first = response.choices[0];
  if (!isRecord(first) || !isRecord(first.message) || typeof first.message.content !== "string") {
    return null;
  }
  const content = parseJson(first.message.content);
  if (!isExactObject(content, ["classification", "confidence", "reason"])) return null;
  if (
    content.classification !== "cooking"
    && content.classification !== "not_cooking"
    && content.classification !== "uncertain"
  ) return null;
  if (
    typeof content.confidence !== "number"
    || !Number.isFinite(content.confidence)
    || content.confidence < 0
    || content.confidence > 1
  ) return null;
  if (
    typeof content.reason !== "string"
    || content.reason.length < 1
    || content.reason.length > 240
  ) return null;
  return {
    classification: content.classification,
    confidence: content.confidence,
    reason: content.reason,
  };
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

function activityJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
