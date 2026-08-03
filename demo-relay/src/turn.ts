const TURN_API_BASE_URL = "https://rtc.live.cloudflare.com/v1/turn/keys";
const TURN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_TURN_RESPONSE_BYTES = 32 * 1_024;

export const TURN_CREDENTIAL_GRACE_SECONDS = 15;
export const TURN_CREDENTIAL_MAX_TTL_SECONDS = 75;

export interface StunIceServer {
  urls: string[];
}

export interface TurnIceServer {
  urls: string[];
  username: string;
  credential: string;
}

export type BrowserIceServer = StunIceServer | TurnIceServer;

export type TurnCredentialResult =
  | { ok: true; ice_servers: BrowserIceServer[] }
  | {
    ok: false;
    error:
      | "turn_not_configured"
      | "turn_provider_unavailable"
      | "turn_provider_invalid_response";
  };

interface TurnEnvironment {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

export function providerTurnTtlSeconds(grantRemainingMs: number): number {
  return Math.min(
    TURN_CREDENTIAL_MAX_TTL_SECONDS,
    Math.ceil(Math.max(0, grantRemainingMs) / 1_000) + TURN_CREDENTIAL_GRACE_SECONDS,
  );
}

export function isBrowserIceServers(value: unknown): value is BrowserIceServer[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) return false;
  let hasStun = false;
  let hasTurn = false;
  for (const entry of value) {
    if (isExactObject(entry, ["urls"])) {
      const rawUrls = entry.urls;
      const urls = filterUrls(rawUrls, "stun");
      if (
        !Array.isArray(rawUrls)
        || urls === null
        || urls.length !== rawUrls.length
        || urls.length === 0
      ) return false;
      hasStun = true;
      continue;
    }
    if (isExactObject(entry, ["credential", "urls", "username"])) {
      const rawUrls = entry.urls;
      const urls = filterUrls(rawUrls, "turn");
      if (
        !Array.isArray(rawUrls)
        || urls === null
        || urls.length !== rawUrls.length
        || urls.length === 0
        || !isBoundedCredential(entry.username)
        || !isBoundedCredential(entry.credential)
      ) return false;
      hasTurn = true;
      continue;
    }
    return false;
  }
  return hasStun && hasTurn;
}

export async function generateTurnCredentials(
  env: TurnEnvironment,
  ttlSeconds: number,
): Promise<TurnCredentialResult> {
  const keyId = typeof env.TURN_KEY_ID === "string" ? env.TURN_KEY_ID.trim() : "";
  const apiToken = typeof env.TURN_KEY_API_TOKEN === "string"
    ? env.TURN_KEY_API_TOKEN.trim()
    : "";
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(keyId)
    || apiToken.length < 16
    || apiToken.length > 1_024
    || !Number.isSafeInteger(ttlSeconds)
    || ttlSeconds < 1
    || ttlSeconds > TURN_CREDENTIAL_MAX_TTL_SECONDS
  ) {
    return { ok: false, error: "turn_not_configured" };
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${TURN_API_BASE_URL}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: ttlSeconds }),
        signal: AbortSignal.timeout(TURN_REQUEST_TIMEOUT_MS),
      },
    );
  } catch {
    return { ok: false, error: "turn_provider_unavailable" };
  }

  if (upstream.status !== 201) {
    // Provider response bodies can include account details. Status alone is
    // sufficient operational evidence and avoids leaking credentials to logs.
    console.error(JSON.stringify({ message: "TURN credential provider failed", status: upstream.status }));
    return { ok: false, error: "turn_provider_unavailable" };
  }

  let text: string | null;
  try {
    text = await readBoundedText(upstream.body, MAX_TURN_RESPONSE_BYTES);
  } catch {
    return { ok: false, error: "turn_provider_invalid_response" };
  }
  if (text === null) return { ok: false, error: "turn_provider_invalid_response" };
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return { ok: false, error: "turn_provider_invalid_response" };
  }
  const iceServers = parseProviderIceServers(decoded);
  return iceServers === null
    ? { ok: false, error: "turn_provider_invalid_response" }
    : { ok: true, ice_servers: iceServers };
}

function parseProviderIceServers(value: unknown): BrowserIceServer[] | null {
  if (
    !isExactObject(value, ["iceServers"])
    || !Array.isArray(value.iceServers)
    || value.iceServers.length < 2
    || value.iceServers.length > 16
  ) return null;
  const result: BrowserIceServer[] = [];
  let hasStun = false;
  let hasTurn = false;

  for (const entry of value.iceServers) {
    if (isExactObject(entry, ["urls"])) {
      const urls = filterUrls(entry.urls, "stun");
      if (urls === null || urls.length === 0) continue;
      hasStun = true;
      result.push({ urls });
      continue;
    }
    if (isExactObject(entry, ["credential", "urls", "username"])) {
      const urls = filterUrls(entry.urls, "turn");
      if (
        urls === null
        || urls.length === 0
        || !isBoundedCredential(entry.username)
        || !isBoundedCredential(entry.credential)
      ) continue;
      hasTurn = true;
      result.push({
        urls,
        username: entry.username,
        credential: entry.credential,
      });
      continue;
    }
    return null;
  }

  return hasStun
    && hasTurn
    && result.length >= 2
    && result.length <= 16
    && isBrowserIceServers(result)
    ? result
    : null;
}

function filterUrls(value: unknown, kind: "stun" | "turn"): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) return null;
  const accepted: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || candidate.length < 1 || candidate.length > 512) {
      return null;
    }
    if (/:53(?:\?|$)/.test(candidate)) continue;
    const isAllowed = kind === "stun"
      ? /^stun:stun\.cloudflare\.com:3478(?:\?transport=udp)?$/.test(candidate)
      : /^turn:turn\.cloudflare\.com:3478\?transport=(?:udp|tcp)$/.test(candidate)
        || /^turn:turn\.cloudflare\.com:80\?transport=tcp$/.test(candidate)
        || /^turns:turn\.cloudflare\.com:(?:5349|443)(?:\?transport=tcp)?$/.test(candidate);
    if (!isAllowed) return null;
    if (!accepted.includes(candidate)) accepted.push(candidate);
  }
  return accepted;
}

function isBoundedCredential(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 1_024;
}

function isExactObject(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

async function readBoundedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string | null> {
  if (body === null) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
