import { FALL_PHASES } from "./scenes.js";

const UNAVAILABLE_CARE_STATE = Object.freeze({
  status: "关怀状态已更新",
  message: "等待统一后端发布当前关怀详情。",
});

export function resolveChildPhoneCarePresentation({
  scene,
  fallPhase = "idle",
  fallStateOverride = null,
  kitchenShared = false,
  kitchenNotification = "",
}) {
  const hasCareState = fallPhase !== "idle";
  const careState = fallStateOverride
    || FALL_PHASES[fallPhase]
    || UNAVAILABLE_CARE_STATE;
  const title = hasCareState
    ? careState.status
    : scene.id === "kitchen"
      ? kitchenShared ? "收到奶奶分享" : "外婆家一切正常"
      : scene.phoneTitle;
  const body = hasCareState
    ? careState.message
    : scene.id === "kitchen"
      ? kitchenShared ? kitchenNotification : "暂无新的家庭动态"
      : scene.phoneBody;
  return Object.freeze({ body, careState, hasCareState, title });
}
