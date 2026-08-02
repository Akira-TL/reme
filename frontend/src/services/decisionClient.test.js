import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { startSessionWithTakeover } from "./decisionClient.js";

// 用脚本化 fetch 模拟 B：按调用顺序回放响应，记录请求轨迹。
const originalFetch = globalThis.fetch;

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
