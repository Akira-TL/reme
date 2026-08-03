import { relayHttpUrl } from "./config.js";

export const MEDIA_ICE_CAPABILITY_TYPE = "media_ice_capability";
export const MEDIA_ICE_REQUEST_TIMEOUT_MS = 5_000;

const ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const CAPABILITY_KEYS = ["bearer_token", "expires_at_ms", "grant_id", "type"];
const RESPONSE_KEYS = ["expires_at_ms", "ice_servers", "ttl_ms"];
const STUN_SERVER_KEYS = ["urls"];
const TURN_SERVER_KEYS = ["credential", "urls", "username"];

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isBoundedString(value, maxLength, { allowEmpty = false } = {}) {
  return typeof value === "string"
    && value.length <= maxLength
    && (allowEmpty || value.length > 0);
}

function isSafeIceUrl(value, kind) {
  if (!isBoundedString(value, 512) || /:53(?:\?|$)/.test(value)) return false;
  return kind === "stun"
    ? /^stun:stun\.cloudflare\.com:3478(?:\?transport=udp)?$/.test(value)
    : /^turn:turn\.cloudflare\.com:3478\?transport=(?:udp|tcp)$/.test(value)
      || /^turn:turn\.cloudflare\.com:80\?transport=tcp$/.test(value)
      || /^turns:turn\.cloudflare\.com:(?:5349|443)(?:\?transport=tcp)?$/.test(value);
}

function isIceUrlList(value, kind) {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= 16
    && value.every((url) => isSafeIceUrl(url, kind));
}

function isStunServer(value) {
  return hasExactKeys(value, STUN_SERVER_KEYS)
    && isIceUrlList(value.urls, "stun");
}

function isTurnServer(value) {
  return hasExactKeys(value, TURN_SERVER_KEYS)
    && isIceUrlList(value.urls, "turn")
    && isBoundedString(value.username, 1_024)
    && isBoundedString(value.credential, 1_024);
}

export function isMediaIceCapability(value) {
  return hasExactKeys(value, CAPABILITY_KEYS)
    && value.type === MEDIA_ICE_CAPABILITY_TYPE
    && ID_PATTERN.test(value.grant_id)
    && TOKEN_PATTERN.test(value.bearer_token)
    && Number.isSafeInteger(value.expires_at_ms)
    && value.expires_at_ms >= 0;
}

export function parseMediaIceCapability(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    return isMediaIceCapability(value) ? value : null;
  } catch {
    return null;
  }
}

export function selectMediaIceCapability(capability, grant, nowMs = Date.now()) {
  return isMediaIceCapability(capability)
    && capability.grant_id === grant?.grant_id
    && capability.expires_at_ms > nowMs
    ? capability
    : null;
}

export function isMediaIceResponse(value) {
  if (
    !hasExactKeys(value, RESPONSE_KEYS)
    || !Array.isArray(value.ice_servers)
    || value.ice_servers.length < 2
    || value.ice_servers.length > 16
    || !Number.isSafeInteger(value.expires_at_ms)
    || value.expires_at_ms < 0
    || !Number.isSafeInteger(value.ttl_ms)
    || value.ttl_ms < 0
    || value.ttl_ms > 60_000
  ) return false;

  let hasStun = false;
  let hasTurn = false;
  for (const server of value.ice_servers) {
    if (isStunServer(server)) hasStun = true;
    else if (isTurnServer(server)) hasTurn = true;
    else return false;
  }
  return hasStun && hasTurn;
}

function mediaIceErrorMessage(status, code) {
  if (status === 404) {
    return "当前 Relay 尚未启用可靠实景网络能力；已保持隐私骨架。";
  }
  if (code === "turn_not_configured") {
    return "可靠实景中继尚未配置；已保持隐私骨架。";
  }
  if (["turn_provider_unavailable", "turn_provider_invalid_response"].includes(code)) {
    return "可靠实景网络服务暂不可用；已保持隐私骨架。";
  }
  if (["media_ice_not_authorized", "invalid_media_ice_token"].includes(code)) {
    return "本次实景网络凭证已失效；已保持隐私骨架。";
  }
  if (code === "media_ice_rate_limited") {
    return "实景网络请求过于频繁；本次已安全关闭。";
  }
  if (code === "media_ice_request_in_progress") {
    return "同一授权的实景网络配置正在处理中；本次未重复建连。";
  }
  return "无法取得可靠实景网络配置；已保持隐私骨架。";
}

export async function fetchMediaIceServers({
  bearerToken,
  grantId,
  fetchImpl = globalThis.fetch,
  signal = null,
  timeoutMs = MEDIA_ICE_REQUEST_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (!TOKEN_PATTERN.test(bearerToken || "")) {
    throw new TypeError("media ICE bearer token is invalid");
  }
  if (!ID_PATTERN.test(grantId || "")) {
    throw new TypeError("media ICE grant id is invalid");
  }
  if (typeof fetchImpl !== "function") {
    throw new TypeError("media ICE fetch implementation is required");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("media ICE request timeout must be positive");
  }

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener?.("abort", abortFromParent, { once: true });
  const timeout = globalThis.setTimeout(() => controller.abort("media_ice_timeout"), timeoutMs);

  try {
    const response = await fetchImpl(relayHttpUrl("/api/media/ice"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ grant_id: grantId }),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      // Invalid provider/Relay responses remain an explicit media-only failure.
    }
    if (!response.ok) {
      const code = typeof payload?.error === "string" ? payload.error : null;
      throw new Error(mediaIceErrorMessage(response.status, code));
    }
    if (!isMediaIceResponse(payload)) {
      throw new Error("可靠实景网络配置格式无效；已保持隐私骨架。");
    }
    const receivedAtMs = now();
    if (
      payload.ttl_ms < 1_000
      || payload.expires_at_ms <= receivedAtMs
    ) {
      throw new Error("本次实景网络授权剩余时间不足；已保持隐私骨架。");
    }
    return {
      iceServers: payload.ice_servers.map((server) => ({
        ...server,
        urls: [...server.urls],
      })),
      expiresAtMs: payload.expires_at_ms,
      receivedAtMs,
      ttlMs: payload.ttl_ms,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(signal?.aborted
        ? "实景网络请求已取消；已保持隐私骨架。"
        : "取得可靠实景网络配置超时；已保持隐私骨架。", { cause: error });
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
    signal?.removeEventListener?.("abort", abortFromParent);
  }
}
