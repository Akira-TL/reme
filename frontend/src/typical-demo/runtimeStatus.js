export const SKELETON_SOURCE_LABELS = {
  a_backend: "后端实时关键点",
  unavailable: "等待后端关键点",
};

export function describeSkeletonSource(source) {
  return SKELETON_SOURCE_LABELS[source] || source || SKELETON_SOURCE_LABELS.unavailable;
}

export function getCameraHealth(camera = {}) {
  if (camera.cameraReady) {
    return { state: "online", label: "摄像头已连接", detail: "浏览器现场视频流可用" };
  }
  if (camera.cameraError) {
    return { state: "degraded", label: "摄像头不可用", detail: camera.cameraError };
  }
  return { state: "loading", label: "摄像头连接中", detail: "正在请求浏览器摄像头" };
}

export function getModelHealth(camera = {}) {
  const perceptionState = camera.perceptionState || "offline";
  const inputMode = camera.inputMode || null;

  if (perceptionState === "running" && inputMode === "jpeg") {
    return {
      state: "online",
      label: "后端姿态已就绪",
      detail: "浏览器上传 JPEG 帧，姿态提取与分类由统一后端执行",
    };
  }
  if (inputMode && inputMode !== "jpeg") {
    return {
      state: "degraded",
      label: "输入模式不兼容",
      detail: `当前后端输入模式为 ${inputMode}，前端仅支持 JPEG 帧上传`,
    };
  }
  if (["input_unavailable", "degraded", "stopped"].includes(perceptionState)) {
    return {
      state: "degraded",
      label: "后端姿态不可用",
      detail: camera.perceptionReason || "统一后端感知链路不可用",
    };
  }
  if (perceptionState === "offline" && camera.perceptionReason) {
    return {
      state: "degraded",
      label: "后端姿态离线",
      detail: camera.perceptionReason,
    };
  }
  return {
    state: "loading",
    label: "后端姿态连接中",
    detail: "等待统一后端 JPEG 推理会话启动",
  };
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
