export const SKELETON_SOURCE_LABELS = {
  a_backend: "后端实时关键点",
  unavailable: "等待后端关键点",
};

export function describeSkeletonSource(source) {
  return SKELETON_SOURCE_LABELS[source] || source || SKELETON_SOURCE_LABELS.unavailable;
}

export function getCameraHealth(camera = {}) {
  if (camera.cameraReady) {
    const labels = {
      camera: "摄像头已连接",
      display: "屏幕采集已连接",
      file: "本地视频已载入",
    };
    return {
      state: "online",
      label: labels[camera.sourceKind] || "媒体源已连接",
      detail: camera.sourceLabel || "浏览器本地视频源可用",
    };
  }
  if (camera.cameraError) {
    return { state: "degraded", label: "媒体源不可用", detail: camera.cameraError };
  }
  if (["stopped", "idle"].includes(camera.sourceStatus)) {
    return { state: "loading", label: "媒体源未启动", detail: "请在 Monitor 本机开始演示并选择媒体源" };
  }
  return { state: "loading", label: "媒体源连接中", detail: "正在等待本机权限或视频就绪" };
}

export function getModelHealth(camera = {}) {
  const perceptionState = camera.perceptionState || "offline";
  const inputMode = camera.inputMode || null;
  const configuredModels = camera.modelCapabilities;
  const effectiveModels = camera.effectiveModels;
  const pose = effectiveModels?.pose_extractor;
  const posture = effectiveModels?.posture_classifier;
  const fallTemporal = effectiveModels?.fall_temporal;

  if (perceptionState === "running" && inputMode === "jpeg") {
    if (!effectiveModels) {
      return {
        state: "degraded",
        label: "模型有效状态未报告",
        detail: "后端仅报告了配置，未逐项确认 MoveNet、姿态分类与连续模型的实际加载状态",
      };
    }
    if (!pose?.loaded || !posture?.loaded) {
      return {
        state: "degraded",
        label: "后端模型链路不完整",
        detail: pose?.error || posture?.error || "MoveNet 或姿态分类器未确认加载",
      };
    }
    if (fallTemporal?.fallback && !fallTemporal.loaded) {
      return {
        state: "degraded",
        label: "姿态已就绪 · 连续增强降级",
        detail: "MoveNet 与姿态分类已运行；MIL v3 不可用，跌倒转变仅使用确定性门禁",
      };
    }
    if (!fallTemporal?.loaded) {
      return {
        state: "degraded",
        label: "连续模型状态未知",
        detail: fallTemporal?.error || "MIL v3 未确认加载，界面不会假定连续增强可用",
      };
    }
    return {
      state: "online",
      label: "后端模型链路已就绪",
      detail: "MoveNet、姿态分类与 MIL v3 连续增强已由当前统一后端会话逐项确认加载",
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
    detail: configuredModels
      ? "模型已配置，等待统一后端 JPEG 会话逐项确认实际加载"
      : "等待统一后端 JPEG 推理会话启动",
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
