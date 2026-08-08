export function relayHttpBase() {
  const configured = import.meta.env.VITE_REME_RELAY_URL?.trim();
  return new URL(configured || window.location.origin, window.location.origin);
}

export function relayWebSocketUrl(pathname = "/ws/viewer") {
  const url = relayHttpBase();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function relayAvailabilityCopy() {
  return import.meta.env.VITE_REME_RELAY_URL?.trim()
    ? "Relay 已配置；公网发布仍需短期 TURN 凭证"
    : "同源 Relay；未配置 TURN 时仅保证本机或局域网媒体";
}
