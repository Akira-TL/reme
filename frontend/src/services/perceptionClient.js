const DEFAULT_HTTP_URL = "http://127.0.0.1:8770";

export function getPerceptionUrls() {
  const httpBase = (import.meta.env.VITE_REME_PERCEPTION_HTTP_URL || DEFAULT_HTTP_URL).replace(/\/$/, "");
  const wsBase = httpBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return {
    httpBase,
    inputWs: import.meta.env.VITE_REME_PERCEPTION_INPUT_WS_URL || `${wsBase}/ws/camera-input`,
    eventsWs: (sessionId) => `${wsBase}/ws/events?session_id=${encodeURIComponent(sessionId)}`,
  };
}

async function request(httpBase, path, options = {}) {
  const response = await fetch(`${httpBase}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `A 接口请求失败 (${response.status})`);
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}

export function getCapabilities(httpBase, signal) {
  return request(httpBase, "/api/runtime/capabilities", { signal });
}

export function getStatus(httpBase, signal) {
  return request(httpBase, "/api/runtime/status", { signal });
}

export function startRuntime(httpBase, sessionRequest, signal) {
  return request(httpBase, "/api/runtime/start", {
    method: "POST",
    body: JSON.stringify(sessionRequest),
    signal,
  });
}

export function stopRuntime(httpBase, sessionId) {
  return request(httpBase, "/api/runtime/stop", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
    keepalive: true,
  });
}
