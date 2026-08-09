import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runnerImport } from "vite";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const componentPath = fileURLToPath(new URL("./DevicePanel.jsx", import.meta.url));
const { module: { DevicePanel } } = await runnerImport(componentPath, {
  root: frontendRoot,
  logLevel: "silent",
});

const SCENE = Object.freeze({
  id: "living",
  title: "客厅日常",
  tone: "calm",
  backgroundImage: "/scenes/living-room.jpg",
});

const CAMERA = Object.freeze({
  aspectRatio: 16 / 9,
  cameraReady: false,
  cameraError: "",
  error: "",
  inputMode: null,
  perceptionReason: "",
  perceptionState: "offline",
  retry() {},
  skeletonSource: "unavailable",
});

function renderPanel(props = {}) {
  return renderToStaticMarkup(createElement(DevicePanel, {
    scene: SCENE,
    canvasRef: { current: null },
    camera: CAMERA,
    viewMode: "skeleton",
    ...props,
  }));
}

test("Home 未启动时显示真实等待状态而不是默认场景事实", () => {
  const html = renderPanel({ surface: "home", started: false });

  assert.match(html, /aria-label="等待开启的本机视频源"/);
  assert.match(html, />当前采集源 · 本机视频</);
  assert.match(html, />视频源尚未开启</);
  assert.match(html, />开启后显示实时视频与姿态叠加</);
  assert.match(html, />当前摄像头与麦克风均未启用</);
  assert.doesNotMatch(html, />客厅日常</);
  assert.doesNotMatch(html, /has-scene-background/);
});

test("Debug 保留原有场景标题与演示布景", () => {
  const html = renderPanel({ surface: "debug", started: false });

  assert.match(html, /aria-label="家中实时画面"/);
  assert.match(html, />家中实时画面</);
  assert.match(html, />客厅日常</);
  assert.match(html, /has-scene-background/);
});
