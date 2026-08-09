import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runnerImport } from "vite";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const componentPath = fileURLToPath(new URL("./MonitorControlPanel.jsx", import.meta.url));
const { module: { MonitorControlPanel } } = await runnerImport(componentPath, {
  root: frontendRoot,
  logLevel: "silent",
});

function renderControl(surface, started = false) {
  return renderToStaticMarkup(createElement(MonitorControlPanel, {
    surface,
    started,
    starting: false,
    onStart() {},
    onStop() {},
    media: {
      source: null,
      sourceStatus: "idle",
      sourceError: null,
      ready: false,
      remoteVideoState: "unavailable",
      availableSources: [
        { id: "camera-front", kind: "camera", label: "前置摄像头" },
      ],
      selectSource() {},
      selectFile() {},
      switchCameraFacing() {},
      sourceGeneration: 0,
      permissionState: "prompt",
    },
    room: {
      roomSessionId: null,
      connectionLabel: "尚未连接",
      viewerCount: 0,
      maxViewers: 5,
      monitorOnline: false,
      controllerActive: false,
      controllerLabel: null,
      stateRevision: 0,
      mediaGrantLabel: "未开放",
    },
    pendingCommands: [],
    confirmingCommands: [],
    onConfirmCommand() {},
    onRejectCommand() {},
    onRevokeControl() {},
    nowMs: 0,
  }));
}

test("home 未启动时只有开启视频采集一个按钮且不渲染禁用工具", () => {
  const html = renderControl("home", false);

  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /home-primary-action/);
  assert.match(html, />开启视频采集<\/button>/);
  assert.doesNotMatch(html, /选择相机或视频/);
  assert.doesNotMatch(html, /前后切换/);
  assert.doesNotMatch(html, /本机权限确认/);
});

test("home 启动后恢复真实媒体与连接事实但不恢复冗余摄像头按钮", () => {
  const html = renderControl("home", true);

  assert.match(html, />停止视频采集<\/button>/);
  assert.match(html, /选择相机或视频/);
  assert.match(html, /公开演示连接/);
  assert.match(html, /Viewer 处理/);
  assert.doesNotMatch(html, /家属处理/);
  assert.doesNotMatch(html, /前后切换/);
  assert.doesNotMatch(html, /远程命令与本机确认/);
});

test("debug 保留全量工程媒体与本机确认界面", () => {
  const html = renderControl("debug", false);

  assert.match(html, />开始演示<\/button>/);
  assert.match(html, /选择媒体源/);
  assert.match(html, /前后切换/);
  assert.match(html, /远程命令与本机确认/);
  assert.match(html, /当前没有等待确认的权限操作/);
});
