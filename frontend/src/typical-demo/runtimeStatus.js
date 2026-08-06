export const SKELETON_SOURCE_LABELS = {
  a_backend: "A 后端实时关键点",
  c_gpu: "C 本地 GPU 关键点",
  demo_fallback: "演示骨架（降级）",
  unavailable: "等待关键点",
};

export function describeSkeletonSource(source) {
  return SKELETON_SOURCE_LABELS[source] || source || SKELETON_SOURCE_LABELS.unavailable;
}

export function getCameraHealth(camera = {}) {
  if (camera.cameraReady) {
    return { state: "online", label: "摄像头已连接", detail: "现场视频流可用" };
  }
  if (camera.cameraError) {
    return { state: "degraded", label: "摄像头不可用", detail: camera.cameraError };
  }
  return { state: "loading", label: "摄像头连接中", detail: "正在请求浏览器摄像头" };
}

export function getModelHealth(camera = {}) {
  if (camera.modelReady && camera.inferenceBackend === "gpu") {
    return {
      state: "online",
      label: "GPU 姿态已就绪",
      detail: camera.gpuRenderer ? `WebGL：${camera.gpuRenderer}` : "MediaPipe GPU delegate",
    };
  }
  if (camera.modelError || camera.inferenceBackend === "unavailable") {
    return {
      state: "degraded",
      label: "GPU 姿态不可用",
      detail: camera.modelError || "GPU delegate 初始化失败",
    };
  }
  return { state: "loading", label: "GPU 姿态加载中", detail: "禁止静默回退 CPU" };
}

export function getLinkHealth(live = {}) {
  const runtime = live.runtime || {};
  const connection = live.decision?.connection || live.connection || "closed";

  if (runtime.state === "running" && connection === "open") {
    return { state: "online", label: "关怀链路运行中", detail: "感知与决策连接正常" };
  }
  if (runtime.state === "input_unavailable") {
    return {
      state: "degraded",
      label: "输入通道降级",
      detail: runtime.reason || "后端未收到实时输入",
    };
  }
  if (runtime.state === "running" && connection === "closed") {
    return {
      state: "degraded",
      label: "决策连接已断开",
      detail: live.decision?.reason || "决策 WebSocket 已关闭",
    };
  }
  if (["degraded", "stopped"].includes(runtime.state) || connection === "error") {
    return {
      state: "degraded",
      label: "关怀链路异常",
      detail: runtime.reason || live.decision?.reason || "后端连接不可用",
    };
  }
  if (runtime.state === "offline" && runtime.sessionId) {
    return {
      state: "degraded",
      label: "关怀链路离线",
      detail: runtime.reason || live.decision?.reason || "统一后端不可用",
    };
  }
  return {
    state: "loading",
    label: "关怀链路连接中",
    detail: runtime.reason || "正在建立感知与决策会话",
  };
}
