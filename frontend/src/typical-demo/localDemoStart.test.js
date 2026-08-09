import assert from "node:assert/strict";
import test from "node:test";
import { startLocalDemoSession } from "./localDemoStart.js";

test("本机采集先于 Relay 启动且不等待 Relay 结果", async () => {
  const calls = [];
  let settleRelay;
  const relayPending = new Promise((resolve) => {
    settleRelay = resolve;
  });

  const started = startLocalDemoSession({
    markStarted() {
      calls.push("started");
    },
    startCapture() {
      calls.push("capture");
      return true;
    },
    startRelay() {
      calls.push("relay");
      return relayPending;
    },
  });

  assert.deepEqual(calls, ["started", "capture", "relay"]);
  assert.equal(await started, true);
  settleRelay(false);
});

test("Relay 失败不会把已经成功的本机采集判为失败", async () => {
  const started = await startLocalDemoSession({
    markStarted() {},
    startCapture: () => true,
    startRelay() {
      throw new Error("relay offline");
    },
  });

  assert.equal(started, true);
});

test("媒体权限失败仍会启动 Relay 的独立降级链路", async () => {
  let relayStarted = false;
  const started = await startLocalDemoSession({
    markStarted() {},
    startCapture() {
      throw new Error("permission denied");
    },
    startRelay() {
      relayStarted = true;
      return true;
    },
  });

  assert.equal(started, false);
  assert.equal(relayStarted, true);
});
