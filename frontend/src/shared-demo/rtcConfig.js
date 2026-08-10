import { relayHttpBase, resolveRelayEndpointUrl } from "./config.js";

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
  if (!Array.isArray(value.urls)) return false;
  const urls = value.urls;
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
    "iceServers",
    "mode",
    "credential_expires_at_ms",
  ])
    && Array.isArray(value.iceServers)
    && value.iceServers.length <= 8
    && value.iceServers.every(isIceServer)
    && ["local_network_only", "stun_only", "turn_configured"].includes(value.mode)
    && (value.credential_expires_at_ms === null
      || (Number.isFinite(value.credential_expires_at_ms)
        && value.credential_expires_at_ms > 0))
    && (() => {
      const urls = value.iceServers.flatMap((server) => server.urls);
      const hasStun = urls.some((url) => /^stuns?:/i.test(url));
      const hasTurn = urls.some((url) => /^turns?:/i.test(url));
      if (value.mode === "local_network_only") {
        return value.iceServers.length === 0 && value.credential_expires_at_ms === null;
      }
      if (value.mode === "stun_only") {
        return hasStun && !hasTurn && value.credential_expires_at_ms === null;
      }
      return hasTurn && Number.isFinite(value.credential_expires_at_ms);
    })();
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
    iceServers: Object.freeze(value.iceServers.map((server) => Object.freeze({
      ...server,
      urls: Object.freeze([...server.urls]),
    }))),
    credentialExpiresAtMs: value.credential_expires_at_ms,
    mode: value.mode,
  });
}
