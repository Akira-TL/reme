import assert from "node:assert/strict";
import test from "node:test";
import { resolveChildPhoneCarePresentation } from "./childPhonePresentation.js";

const LIVING = Object.freeze({
  id: "living",
  phoneTitle: "外婆家一切正常",
  phoneBody: "暂无需要处理的情况。",
});

test("ChildPhone uses the Backend-projected care copy before perception becomes active", () => {
  const presentation = resolveChildPhoneCarePresentation({
    scene: LIVING,
    fallPhase: "attention",
    fallStateOverride: {
      status: "家属行动卡已送达",
      message: "已生成一条待家属确认的生活协助安排。",
    },
  });
  assert.equal(presentation.title, "家属行动卡已送达");
  assert.equal(presentation.body, "已生成一条待家属确认的生活协助安排。");
});

test("unknown care phases fail visibly instead of crashing the debug surface", () => {
  assert.deepEqual(resolveChildPhoneCarePresentation({
    scene: LIVING,
    fallPhase: "attention",
  }), {
    body: "等待统一后端发布当前关怀详情。",
    careState: {
      status: "关怀状态已更新",
      message: "等待统一后端发布当前关怀详情。",
    },
    hasCareState: true,
    title: "关怀状态已更新",
  });
});

test("idle kitchen presentation keeps the existing shared-moment copy", () => {
  const presentation = resolveChildPhoneCarePresentation({
    scene: { ...LIVING, id: "kitchen" },
    kitchenShared: true,
    kitchenNotification: "已获得本人同意。",
  });
  assert.equal(presentation.title, "收到奶奶分享");
  assert.equal(presentation.body, "已获得本人同意。");
});
