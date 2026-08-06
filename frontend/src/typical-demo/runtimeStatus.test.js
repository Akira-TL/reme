import assert from "node:assert/strict";
import test from "node:test";
import {
  describeSkeletonSource,
  getCameraHealth,
  getLinkHealth,
  getModelHealth,
} from "./runtimeStatus.js";

test("摄像头错误不能继续显示为连接中", () => {
  const health = getCameraHealth({ cameraReady: false, cameraError: "权限被拒绝" });
  assert.equal(health.state, "degraded");
  assert.equal(health.label, "摄像头不可用");
});

test("GPU 严格模式明确显示不可用而不是 ready", () => {
  const health = getModelHealth({
    modelReady: false,
    inferenceBackend: "unavailable",
    modelError: "禁止回退 CPU",
  });
  assert.equal(health.state, "degraded");
  assert.equal(health.label, "GPU 姿态不可用");
});

test("输入通道降级不能被 active 状态伪装为链路就绪", () => {
  const health = getLinkHealth({
    active: true,
    runtime: { state: "input_unavailable", reason: "输入 WS 断开" },
    decision: { connection: "open" },
  });
  assert.equal(health.state, "degraded");
  assert.equal(health.label, "输入通道降级");
});

test("只有感知运行且决策 WebSocket 打开才显示链路运行中", () => {
  const health = getLinkHealth({
    runtime: { state: "running" },
    decision: { connection: "open" },
  });
  assert.equal(health.state, "online");
});

test("骨架来源区分后端、本地 GPU 与演示降级", () => {
  assert.equal(describeSkeletonSource("a_backend"), "A 后端实时关键点");
  assert.equal(describeSkeletonSource("c_gpu"), "C 本地 GPU 关键点");
  assert.equal(describeSkeletonSource("demo_fallback"), "演示骨架（降级）");
});


test("运行中的感知不能掩盖已关闭的决策连接", () => {
  const health = getLinkHealth({
    runtime: { state: "running", sessionId: "session-1" },
    decision: { connection: "closed" },
  });
  assert.equal(health.state, "degraded");
  assert.equal(health.label, "决策连接已断开");
});
