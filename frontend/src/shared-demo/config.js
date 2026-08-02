const DEFAULT_RELAY_BASE = "https://relay.reme.maniforld.com";

export function getRelayBase() {
  const configured = import.meta.env?.VITE_REME_DEMO_RELAY_URL;
  return String(configured || DEFAULT_RELAY_BASE).replace(/\/+$/, "");
}

export function relayHttpUrl(path) {
  return `${getRelayBase()}${path}`;
}

export function relayWebSocketUrl(path) {
  const url = new URL(path, `${getRelayBase()}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}
