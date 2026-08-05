import assert from "node:assert/strict";
import test from "node:test";
import { assertHardwareWebGl, isSoftwareWebGlRenderer } from "./gpu.js";

test("识别常见软件 WebGL 渲染器", () => {
  assert.equal(isSoftwareWebGlRenderer("Google SwiftShader"), true);
  assert.equal(isSoftwareWebGlRenderer("ANGLE (LLVMpipe)"), true);
  assert.equal(isSoftwareWebGlRenderer("ANGLE (NVIDIA GeForce RTX 2080 Ti)"), false);
});

test("GPU 严格模式拒绝无 WebGL 或软件渲染", () => {
  assert.throws(
    () => assertHardwareWebGl({ available: false, renderer: "WebGL unavailable", software: false }),
    /无法启用 GPU 姿态推理/,
  );
  assert.throws(
    () => assertHardwareWebGl({ available: true, renderer: "Google SwiftShader", software: true }),
    /软件渲染器/,
  );
  assert.doesNotThrow(() => assertHardwareWebGl({
    available: true,
    renderer: "ANGLE (NVIDIA GeForce RTX 2080 Ti)",
    software: false,
  }));
});
