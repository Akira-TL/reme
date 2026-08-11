const CONFIG_KEYS = Object.freeze([
  "perceptionHttpUrl",
  "perceptionInputWsUrl",
  "decisionHttpUrl",
  "relayUrl",
  "mimoModel",
  "mimoConfigured",
]);

const CONFIG_KEY_SET = new Set(CONFIG_KEYS);
const SECRET_KEY_PATTERN = /(api.?key|credential|password|private|secret|token)/i;
const DEFAULT_BACKEND_HTTP_URL = "http://127.0.0.1:8770";
const DEFAULT_RELAY_PATH = "/_reme/relay/";

function runtimeOrigin(value) {
  if (typeof value === "string" && value.trim()) return new URL(value).origin;
  if (typeof globalThis.location?.origin === "string") return globalThis.location.origin;
  return "http://localhost";
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1";
}

function requireSafeTransport(url, kind, label) {
  const protocols = kind === "websocket" ? new Set(["ws:", "wss:"]) : new Set(["http:", "https:"]);
  if (!protocols.has(url.protocol)) throw new TypeError(`${label} 协议不受支持`);
  if (["http:", "ws:"].includes(url.protocol) && !isLoopbackHostname(url.hostname)) {
    throw new TypeError(`${label} 的非本机地址必须使用 TLS`);
  }
}

function normalizeHttpUrl(value, origin, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是非空 URL`);
  const url = new URL(value.trim(), origin);
  requireSafeTransport(url, "http", label);
  url.hash = "";
  return url.href;
}

function normalizeWebSocketUrl(value, origin, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是非空 URL`);
  const raw = value.trim();
  const url = new URL(raw, origin);
  if (raw.startsWith("/")) {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  requireSafeTransport(url, "websocket", label);
  url.hash = "";
  return url.href;
}

function environmentDefaults(environment, origin) {
  const perceptionHttpUrl = normalizeHttpUrl(
    environment?.VITE_REME_PERCEPTION_HTTP_URL || DEFAULT_BACKEND_HTTP_URL,
    origin,
    "感知服务 URL",
  );
  const perceptionBase = new URL(perceptionHttpUrl);
  perceptionBase.protocol = perceptionBase.protocol === "https:" ? "wss:" : "ws:";
  const defaultInput = new URL("ws/camera-input", perceptionBase.href.endsWith("/")
    ? perceptionBase
    : `${perceptionBase.href}/`);
  return {
    perceptionHttpUrl,
    perceptionInputWsUrl: normalizeWebSocketUrl(
      environment?.VITE_REME_PERCEPTION_INPUT_WS_URL || defaultInput.href,
      origin,
      "摄像头输入 URL",
    ),
    decisionHttpUrl: normalizeHttpUrl(
      environment?.VITE_REME_DECISION_HTTP_URL || DEFAULT_BACKEND_HTTP_URL,
      origin,
      "决策服务 URL",
    ),
    relayUrl: normalizeHttpUrl(
      environment?.VITE_REME_RELAY_URL || DEFAULT_RELAY_PATH,
      origin,
      "Relay URL",
    ),
    mimoModel: environment?.VITE_REME_MIMO_MODEL?.trim() || "mimo-v2.5",
    mimoConfigured: environment?.VITE_REME_MIMO_CONFIGURED === "true",
    source: "build",
  };
}

function assertExactPublicKeys(value) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new TypeError("公开运行配置禁止包含密钥或凭证字段");
    }
    if (!CONFIG_KEY_SET.has(key)) throw new TypeError(`公开运行配置包含未知字段: ${key}`);
  }
  const missing = CONFIG_KEYS.filter((key) => !Object.hasOwn(value, key));
  if (missing.length) throw new TypeError(`公开运行配置缺少字段: ${missing.join(", ")}`);
}

export function resolvePublicRuntimeConfig({
  runtimeConfig = null,
  environment = {},
  locationOrigin,
} = {}) {
  const origin = runtimeOrigin(locationOrigin);
  const fallback = environmentDefaults(environment, origin);
  if (runtimeConfig === null || runtimeConfig === undefined) return Object.freeze(fallback);
  if (!runtimeConfig || typeof runtimeConfig !== "object" || Array.isArray(runtimeConfig)) {
    throw new TypeError("公开运行配置必须是对象或 null");
  }
  assertExactPublicKeys(runtimeConfig);
  if (typeof runtimeConfig.mimoModel !== "string" || !runtimeConfig.mimoModel.trim()) {
    throw new TypeError("MiMo 模型名必须是非空字符串");
  }
  if (runtimeConfig.mimoModel.length > 128) throw new TypeError("MiMo 模型名过长");
  if (typeof runtimeConfig.mimoConfigured !== "boolean") {
    throw new TypeError("mimoConfigured 必须是布尔值");
  }
  return Object.freeze({
    perceptionHttpUrl: normalizeHttpUrl(
      runtimeConfig.perceptionHttpUrl,
      origin,
      "感知服务 URL",
    ),
    perceptionInputWsUrl: normalizeWebSocketUrl(
      runtimeConfig.perceptionInputWsUrl,
      origin,
      "摄像头输入 URL",
    ),
    decisionHttpUrl: normalizeHttpUrl(
      runtimeConfig.decisionHttpUrl,
      origin,
      "决策服务 URL",
    ),
    relayUrl: normalizeHttpUrl(runtimeConfig.relayUrl, origin, "Relay URL"),
    mimoModel: runtimeConfig.mimoModel.trim(),
    mimoConfigured: runtimeConfig.mimoConfigured,
    source: "runtime",
  });
}

export function getPublicRuntimeConfig() {
  return resolvePublicRuntimeConfig({
    runtimeConfig: globalThis.__REME_PUBLIC_CONFIG__,
    environment: import.meta.env,
    locationOrigin: globalThis.location?.origin,
  });
}
