import { relayHttpBase, resolveRelayEndpointUrl } from "./config.js";
import { RTC_CONFIG_SCHEMA } from "./protocol.js";

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isIceUrl(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 2_048
    && /^(?:stun|stuns|turn|turns):/i.test(value);
}

function isIceServer(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (!["urls", "credential,urls,username"].includes(keys.join(","))) return false;
  const urls = Array.isArray(value.urls) ? value.urls : [value.urls];
  if (urls.length < 1 || urls.length > 16 || !urls.every(isIceUrl)) return false;
  if (keys.length === 3) {
    return typeof value.username === "string"
      && value.username.length <= 1_024
      && typeof value.credential === "string"
      && value.credential.length <= 2_048;
  }
  return true;
}

export function isRtcConfigurationWire(value) {
  return exactKeys(value, [
    "schema_version",
    "iceServers",
    "expires_at_ms",
    "capability",
  ])
    && value.schema_version === RTC_CONFIG_SCHEMA
    && Array.isArray(value.iceServers)
    && value.iceServers.length <= 8
    && value.iceServers.every(isIceServer)
    && Number.isFinite(value.expires_at_ms)
    && value.expires_at_ms > 0
    && ["turn", "stun_only"].includes(value.capability)
    && (value.capability !== "turn" || value.iceServers.some((server) => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.some((url) => /^turns?:/i.test(url));
    }));
}

export async function fetchRtcConfiguration({
  fetchImpl = fetch,
  relayUrl = relayHttpBase(),
} = {}) {
  const url = resolveRelayEndpointUrl(relayUrl, "api/rtc-config");
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`RTC 配置不可用（${response.status}）`);
  const value = await response.json();
  if (!isRtcConfigurationWire(value)) throw new Error("RTC 配置不符合精确协议");
  return Object.freeze({
    schemaVersion: value.schema_version,
    iceServers: Object.freeze(value.iceServers.map((server) => Object.freeze({
      ...server,
      ...(Array.isArray(server.urls) ? { urls: Object.freeze([...server.urls]) } : {}),
    }))),
    expiresAtMs: value.expires_at_ms,
    capability: value.capability,
  });
}
