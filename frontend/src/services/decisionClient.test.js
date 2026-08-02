import assert from "node:assert/strict";
import {
  after,
  afterEach,
  before,
  test,
} from "node:test";
import { createServer } from "vite";
import { startSessionWithTakeover } from "./decisionClient.js";

// 用脚本化 fetch 模拟 B：按调用顺序回放响应，记录请求轨迹。
const originalFetch = globalThis.fetch;
let runtimeHelpers;
let viteServer;

before(async () => {
  viteServer = await createServer({
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  runtimeHelpers = await viteServer.ssrLoadModule("/src/hooks/useDecisionRuntime.js");
});

after(async () => {
  await viteServer?.close();
});

function scriptFetch(steps) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: options.body ? JSON.parse(options.body) : null });
    const step = steps.shift();
    assert.ok(step, `未预期的请求: ${path}`);
    assert.equal(path, step.path, `请求顺序不符: 期待 ${step.path} 收到 ${path}`);
    return {
      ok: step.status < 400,
      status: step.status,
      json: async () => step.payload ?? {},
    };
  };
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BASE = "http://127.0.0.1:8100";
const REQUEST = { schema_version: "reme-runtime-session-request/v0-experiment", session_id: "s-new" };

test("首次启动成功时不做任何接管动作", async () => {
  const calls = scriptFetch([
    { path: "/api/session", status: 200, payload: { state: "running" } },
  ]);
  const result = await startSessionWithTakeover(BASE, REQUEST);
  assert.equal(result.state, "running");
  assert.equal(calls.length, 1);
});

test("409 时停掉残留会话并重试成功（页面刷新遗留场景）", async () => {
  const calls = scriptFetch([
    { path: "/api/session", status: 409, payload: { error: { code: "session_active_conflict" } } },
    { path: "/api/session/status", status: 200, payload: { session_id: "s-old", state: "degraded" } },
    { path: "/api/session/stop", status: 200, payload: { state: "stopped" } },
    { path: "/api/session", status: 200, payload: { state: "running" } },
  ]);
  const result = await startSessionWithTakeover(BASE, REQUEST);
  assert.equal(result.state, "running");
  assert.equal(calls[2].body.session_id, "s-old", "必须停掉活跃的旧会话而不是自己的新会话");
  assert.equal(calls.length, 4);
});

test("活跃会话就是自己时不自旋，原样抛出 409", async () => {
  scriptFetch([
    { path: "/api/session", status: 409, payload: null },
    { path: "/api/session/status", status: 200, payload: { session_id: "s-new" } },
  ]);
  await assert.rejects(startSessionWithTakeover(BASE, REQUEST), (error) => error.status === 409);
});

test("非 409 错误不触发接管", async () => {
  const calls = scriptFetch([
    { path: "/api/session", status: 422, payload: { error: { code: "contract_violation" } } },
  ]);
  await assert.rejects(startSessionWithTakeover(BASE, REQUEST), (error) => error.status === 422);
  assert.equal(calls.length, 1);
});

test("状态查询失败时放弃接管，保留原始 409", async () => {
  scriptFetch([
    { path: "/api/session", status: 409, payload: null },
    { path: "/api/session/status", status: 500, payload: null },
  ]);
  await assert.rejects(startSessionWithTakeover(BASE, REQUEST), (error) => error.status === 409);
});

test("跌倒语音应答选择 danger fast lane，普通对话不误走该端点", () => {
  assert.equal(runtimeHelpers.voiceReplyTransport({ confirm_channels: ["voice"] }), "danger");
  assert.equal(runtimeHelpers.voiceReplyTransport({ confirm_channels: [] }), "dialogue");
});

test("空录音会恢复 listening 状态并释放 decision lock", () => {
  const lock = runtimeHelpers.createVoiceCaptureLock();
  assert.equal(lock.claim("decision-empty"), true);
  const capture = lock.attach("decision-empty", {
    stop() {},
  });

  const recovered = runtimeHelpers.recoverVoiceStateAfterEmptyCapture({
    listening: true,
    stage: "recording",
  }, false);
  lock.release("decision-empty", capture);

  assert.equal(recovered.listening, false);
  assert.equal(recovered.stage, "waiting_reply");
  assert.equal(capture.pending, false);
  assert.equal(lock.isIdle(), true);
  assert.equal(lock.claim("decision-retry"), true, "空录音后必须允许重新录音");
});

test("取消录音无论 recorder 是否已创建都会释放 decision lock", () => {
  const lock = runtimeHelpers.createVoiceCaptureLock();

  assert.equal(lock.claim("decision-before-recorder"), true);
  lock.cancel();
  assert.equal(lock.isIdle(), true, "recorder 创建前取消也不能残留锁");

  let stops = 0;
  assert.equal(lock.claim("decision-recording"), true);
  const capture = lock.attach("decision-recording", {
    stop() {
      stops += 1;
    },
  });
  lock.cancel();

  assert.equal(stops, 1);
  assert.equal(capture.cancelled, true);
  assert.equal(capture.pending, false);
  assert.equal(lock.current(), null);
  assert.equal(lock.isIdle(), true);
  assert.equal(lock.claim("decision-after-cancel"), true, "取消后必须允许新 decision 录音");
});
