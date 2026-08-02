const DEFAULT_HTTP_URL = "http://127.0.0.1:8100";

export const RESPONSE_SCHEMA = "reme-interaction-response/v0-experiment";

const RESPONSE_SOURCE_RULES = {
  safe: "user_input",
  need_help: "user_input",
  unclear: "user_input",
  consent_granted: "user_input",
  consent_denied: "user_input",
  none: "timeout",
  card_confirmed: "family_input",
};

export function getDecisionUrls() {
  const httpBase = (import.meta.env.VITE_REME_DECISION_HTTP_URL || DEFAULT_HTTP_URL).replace(/\/$/, "");
  const wsBase = httpBase.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return { httpBase, wsUrl: `${wsBase}/ws` };
}

async function request(httpBase, path, options = {}) {
  const response = await fetch(`${httpBase}${path}`, {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `B 接口请求失败 (${response.status})`);
    error.code = payload?.error?.code;
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export function startSession(httpBase, sessionRequest, signal) {
  return request(httpBase, "/api/session", {
    method: "POST",
    body: JSON.stringify({
      ...sessionRequest,
      // C 是本地单实例页面。刷新/HMR 可能来不及执行旧页面 cleanup，
      // 因此由 B 原子接管遗留 session，而不是让新页面永久卡在 409。
      replace_active: true,
    }),
    signal,
  });
}

export function getSessionStatus(httpBase, signal) {
  return request(httpBase, "/api/session/status", { signal });
}

// B 是单会话制：页面刷新/崩溃遗留的旧会话会让新会话永远 409，且旧页面的
// stop 与新页面的 start 在重载瞬间存在到达顺序竞态（同一秒内 200→409→stop
// 的日志签名）。合同规定 C 是运行模式的唯一发起者，接管旧会话属于 C 的职权，
// 语义与 A 侧 start 自动接管保持一致：查活跃会话 → 停掉 → 重试一次。
export async function startSessionWithTakeover(httpBase, sessionRequest, signal) {
  try {
    return await startSession(httpBase, sessionRequest, signal);
  } catch (error) {
    if (error.status !== 409) throw error;
    const status = await getSessionStatus(httpBase, signal).catch(() => null);
    const activeId = status?.session_id;
    if (!activeId || activeId === sessionRequest.session_id) throw error;
    await stopSession(httpBase, activeId).catch(() => {});
    return startSession(httpBase, sessionRequest, signal);
  }
}

export function stopSession(httpBase, sessionId) {
  return request(httpBase, "/api/session/stop", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId }),
    keepalive: true,
  });
}

export function switchSessionScene(httpBase, { sessionId, sceneId }) {
  return request(httpBase, "/api/session/scene", {
    method: "POST",
    body: JSON.stringify({ session_id: sessionId, scene_id: sceneId }),
  });
}

export function resetScene(httpBase, sceneId) {
  return request(httpBase, "/api/scene/reset", {
    method: "POST",
    body: JSON.stringify({ scene_id: sceneId }),
  });
}

export function startDemoConversation(httpBase, { sceneId, scenario, timestampMs }) {
  return request(httpBase, "/api/demo/conversation", {
    method: "POST",
    body: JSON.stringify({
      scene_id: sceneId,
      scenario,
      timestamp_ms: timestampMs,
    }),
  });
}

export function requestDecisionVoice(httpBase, { sceneId, decisionId }) {
  return request(httpBase, "/api/voice/tts", {
    method: "POST",
    body: JSON.stringify({ scene_id: sceneId, decision_id: decisionId }),
  });
}

export function submitVoiceDialogue(httpBase, {
  sceneId,
  decisionId,
  timestampMs,
  audioB64,
}) {
  return request(httpBase, "/api/voice/dialogue", {
    method: "POST",
    body: JSON.stringify({
      scene_id: sceneId,
      decision_id: decisionId,
      timestamp_ms: timestampMs,
      audio_b64: audioB64,
      audio_format: "wav",
    }),
  });
}

export function submitResponse(httpBase, response) {
  const payload = { schema_version: RESPONSE_SCHEMA, ...response };
  const expectedSource = RESPONSE_SOURCE_RULES[payload.response];
  if (!expectedSource) throw new Error(`无效回应类型: ${payload.response}`);
  if (payload.source !== expectedSource) {
    throw new Error(`回应 ${payload.response} 只允许来源 ${expectedSource}，收到 ${payload.source}`);
  }
  if (!payload.scene_id || !payload.decision_id) throw new Error("回应缺少 scene_id 或 decision_id");
  if (!Number.isFinite(payload.timestamp_ms)) throw new Error("回应缺少数值 timestamp_ms");
  return request(httpBase, "/api/response", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function uploadDangerFrame(httpBase, { sceneId, decisionId, timestampMs, imageB64 }) {
  return request(httpBase, "/api/danger/frame", {
    method: "POST",
    body: JSON.stringify({
      scene_id: sceneId,
      decision_id: decisionId,
      timestamp_ms: timestampMs,
      image_b64: imageB64,
      mime_type: "image/jpeg",
    }),
  });
}

export function uploadDangerVoiceText(httpBase, {
  sceneId,
  decisionId,
  timestampMs,
  text,
}) {
  return request(httpBase, "/api/danger/voice", {
    method: "POST",
    body: JSON.stringify({
      scene_id: sceneId,
      decision_id: decisionId,
      timestamp_ms: timestampMs,
      text,
    }),
  });
}

export function uploadDangerVoice(httpBase, { sceneId, decisionId, timestampMs, audioB64 }) {
  return request(httpBase, "/api/danger/voice", {
    method: "POST",
    body: JSON.stringify({
      scene_id: sceneId,
      decision_id: decisionId,
      timestamp_ms: timestampMs,
      audio_b64: audioB64,
      audio_format: "wav",
    }),
  });
}
