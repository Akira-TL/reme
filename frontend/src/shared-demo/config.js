import { getPublicRuntimeConfig } from "../config/publicRuntimeConfig.js";

const LOCAL_RELAY_PROXY_PATH = "/_reme/relay/";

export function resolveRelayEndpointUrl(relayUrl, pathname) {
  const base = new URL(relayUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new TypeError("Relay URL 必须使用 http 或 https");
  }
  base.hash = "";
  base.search = "";
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  return new URL(String(pathname).replace(/^\/+/, ""), base);
}

export function relayHttpBase() {
  const configured = getPublicRuntimeConfig().relayUrl?.trim();
  const fallback = new URL(LOCAL_RELAY_PROXY_PATH, window.location.origin);
  return resolveRelayEndpointUrl(configured || fallback.href, "");
}

export function relayWebSocketUrl(pathname = "ws/viewer") {
  const url = resolveRelayEndpointUrl(relayHttpBase(), pathname);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function relayAvailabilityCopy() {
  return getPublicRuntimeConfig().relayUrl?.trim()
    ? "Relay 已配置；公网发布仍需短期 TURN 凭证"
    : "同源 Relay；未配置 TURN 时仅保证本机或局域网媒体";
}
