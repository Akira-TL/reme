import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runnerImport } from "vite";

const frontendRoot = fileURLToPath(new URL("../../", import.meta.url));
const componentPath = fileURLToPath(new URL("./HomeCarePrompt.jsx", import.meta.url));
const { module: {
  HomeCarePrompt,
  deriveHomeCarePrompt,
  responseCountdownSeconds,
} } = await runnerImport(componentPath, {
  root: frontendRoot,
  logLevel: "silent",
});

const FALL_SCENE = Object.freeze({
  id: "fall",
  room: "深夜客厅",
  privacy: "异常时主动关怀",
  title: "夜间安全守护",
  status: "静默守护中",
  summary: "系统正在安静守护。",
});

function liveWith(decision, overrides = {}) {
  return {
    active: true,
    voice: { stage: "idle", transcript: "", error: "", microphoneError: "" },
    decision: { decision },
    ...overrides,
  };
}

test("链路就绪但没有当前决策时不虚构人物活动", () => {
  const prompt = deriveHomeCarePrompt(FALL_SCENE, liveWith(null));

  assert.equal(prompt.title, "关怀已就绪");
  assert.equal(prompt.message, "系统正在安静等待可靠事件，需要时才会出现。");
  assert.equal(prompt.responseKind, null);
  assert.equal(prompt.canRespond, false);
  assert.equal(prompt.canReplay, false);
  assert.equal(prompt.source, "");
});

test("未开始或链路离线时不把静态场景文案当作实时事实", () => {
  const notStarted = deriveHomeCarePrompt(FALL_SCENE, liveWith(null, { active: false }), false);
  const unavailable = deriveHomeCarePrompt(FALL_SCENE, liveWith(null, { active: false }), true);

  assert.equal(notStarted.title, "可靠事件才触发关怀");
  assert.equal(notStarted.kicker, "下游 · 事件关怀");
  assert.equal(notStarted.message, "视频数据先在本地转为姿态和事件；只有可靠事件才进入问询与家庭同步。");
  assert.equal(unavailable.title, "关怀能力暂不可用");
  assert.equal(unavailable.message, "当前没有可靠的实时关怀结果，请检查本机媒体源和运行时连接。");
});

test("媒体权限未就绪时即使服务连接正常也不宣称关怀已就绪", () => {
  const prompt = deriveHomeCarePrompt(FALL_SCENE, liveWith(null), true, false);

  assert.equal(prompt.title, "关怀能力暂不可用");
  assert.equal(prompt.message, "当前没有可靠的实时关怀结果，请检查本机媒体源和运行时连接。");
  assert.equal(prompt.canRespond, false);
  assert.equal(prompt.canReplay, false);
});

test("真实安全询问仅启用我没事和我需要帮助这一组回答", () => {
  const prompt = deriveHomeCarePrompt(FALL_SCENE, liveWith({
    scene_id: "fall",
    decision_id: "decision-fall-1",
    state: "check_in_required",
    consent_required: false,
    elder_message: "王奶奶，刚才的动作有点突然，您还好吗？",
    source: "rule",
  }));

  assert.equal(prompt.title, "想问您一句");
  assert.equal(prompt.message, "王奶奶，刚才的动作有点突然，您还好吗？");
  assert.equal(prompt.responseKind, "safety");
  assert.equal(prompt.decisionId, "decision-fall-1");
  assert.equal(prompt.canRespond, true);
  assert.equal(prompt.canReplay, true);
  assert.equal(prompt.source, "本地安全规则");
});

test("安全询问只有需要帮助使用实心危险色", () => {
  const live = liveWith({
    scene_id: "fall",
    decision_id: "decision-fall-colors",
    state: "check_in_required",
    consent_required: false,
    elder_message: "您还好吗？",
  }, {
    replayVoice() {},
    respondSafe() {},
    respondNeedHelp() {},
  });
  const html = renderToStaticMarkup(createElement(HomeCarePrompt, {
    scene: FALL_SCENE,
    live,
    started: true,
    available: true,
  }));

  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.match(html, /class="home-care-safe">我没事<\/button>/);
  assert.match(html, /class="home-care-danger">我需要帮助<\/button>/);
  assert.doesNotMatch(html, /home-care-primary[^>]*>我没事/);
});

test("分享同意询问只有同意动作使用品牌主色", () => {
  const live = liveWith({
    scene_id: "fall",
    decision_id: "decision-consent-colors",
    state: "consent_required",
    consent_required: true,
    elder_message: "是否同意分享？",
  }, {
    replayVoice() {},
    respondConsentGranted() {},
    respondConsentDenied() {},
  });
  const html = renderToStaticMarkup(createElement(HomeCarePrompt, {
    scene: FALL_SCENE,
    live,
    started: true,
    available: true,
  }));

  assert.equal((html.match(/<button/g) || []).length, 3);
  assert.match(html, /class="home-care-primary">同意分享<\/button>/);
  assert.match(html, /class="home-care-secondary">这次不分享<\/button>/);
});

test("真实同意询问只启用分享回答且离线时不继续冒充当前问题", () => {
  const kitchen = {
    id: "kitchen",
    room: "厨房",
    privacy: "本人同意后分享",
    status: "安静陪伴中",
    summary: "正在陪伴您的厨房时光。",
  };
  const prompt = deriveHomeCarePrompt(kitchen, liveWith({
    scene_id: "kitchen",
    decision_id: "decision-share-1",
    state: "consent_required",
    consent_required: true,
    elder_message: "王奶奶，要不要把包包子的这一刻分享给家人？",
    source: "mimo",
  }, { active: false }), true, false);

  assert.equal(prompt.title, "关怀能力暂不可用");
  assert.equal(prompt.message, "当前没有可靠的实时关怀结果，请检查本机媒体源和运行时连接。");
  assert.equal(prompt.responseKind, null);
  assert.equal(prompt.canRespond, false);
  assert.equal(prompt.canReplay, false);
  assert.equal(prompt.source, "");
});

test("离线时不把上一条安全提醒继续冒充当前权威状态", () => {
  const prompt = deriveHomeCarePrompt(FALL_SCENE, liveWith({
    scene_id: "fall",
    decision_id: "decision-alert-1",
    state: "urgent_attention",
    elder_message: "家人已经收到提醒，请先不要起身。",
    source: "rule",
  }, { active: false }), true);

  assert.equal(prompt.title, "关怀能力暂不可用");
  assert.equal(prompt.message, "当前没有可靠的实时关怀结果，请检查本机媒体源和运行时连接。");
  assert.equal(prompt.progress, "");
  assert.equal(prompt.responseKind, null);
  assert.equal(prompt.canRespond, false);
});

test("跌倒确认窗口明确显示单帧送 MiMo 的成功或失败状态", () => {
  const decision = {
    scene_id: "fall",
    decision_id: "decision-visual-1",
    state: "check_in_required",
    consent_required: false,
    elder_message: "您还好吗？",
  };
  const sent = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    decision: {
      decision,
      visualContext: {
        status: "sent",
        decisionId: "decision-visual-1",
        sceneId: "fall",
        frameCount: 1,
      },
    },
  }));
  const failed = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    decision: {
      decision,
      visualContext: {
        status: "failed",
        decisionId: "decision-visual-1",
        sceneId: "fall",
        frameCount: 0,
      },
    },
  }));

  assert.equal(sent.visualContext, "本次已提交 1 帧用于 MiMo 跌倒确认；确认结果将异步返回。");
  assert.equal(sent.visualContextTone, "complete");
  assert.equal(failed.visualContext, "本次视觉确认未发送成功；等待后端发布下一条权威状态。");
  assert.equal(failed.visualContextTone, "error");
});

test("同场景的新决策不会继承上一轮视觉发送状态", () => {
  const decision = {
    scene_id: "fall",
    decision_id: "decision-new-round",
    state: "check_in_required",
    consent_required: false,
    elder_message: "这一轮您还好吗？",
  };
  const prompt = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    decision: {
      decision,
      visualContext: {
        status: "sent",
        decisionId: "decision-previous-round",
        sceneId: "fall",
        frameCount: 1,
      },
    },
  }));

  assert.equal(prompt.visualContext, "");
  assert.equal(prompt.visualContextTone, "idle");
});

test("旧场景决策与非询问状态不会开放按钮", () => {
  const stale = deriveHomeCarePrompt(FALL_SCENE, liveWith({
    scene_id: "kitchen",
    decision_id: "decision-old",
    state: "consent_required",
    consent_required: true,
    elder_message: "要分享吗？",
  }));
  const resolved = deriveHomeCarePrompt(FALL_SCENE, liveWith({
    scene_id: "fall",
    decision_id: "decision-resolved",
    state: "resolved",
    consent_required: false,
    elder_message: "好的，这件事已经处理好了。",
  }));

  assert.equal(stale.responseKind, null);
  assert.equal(stale.decisionId, null);
  assert.equal(resolved.responseKind, null);
  assert.equal(resolved.canRespond, false);
  assert.equal(resolved.message, "好的，这件事已经处理好了。");
});

test("语音进度只来自真实 stage、transcript 或错误", () => {
  const decision = {
    scene_id: "fall",
    decision_id: "decision-voice-1",
    state: "check_in_required",
    consent_required: false,
    elder_message: "您还好吗？",
  };
  const listening = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    voice: { stage: "recording", transcript: "", error: "", microphoneError: "" },
  }));
  const heard = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    voice: { stage: "complete", transcript: "我没事", error: "", microphoneError: "" },
  }));
  const failed = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    voice: { stage: "failed", transcript: "", error: "", microphoneError: "未允许麦克风" },
  }));

  assert.equal(listening.progress, "正在听您说话…");
  assert.equal(listening.progressTone, "active");
  assert.equal(heard.progress, "听到您说：“我没事”");
  assert.equal(heard.progressTone, "complete");
  assert.equal(failed.progress, "语音暂时不可用：未允许麦克风");
  assert.equal(failed.progressTone, "error");
});

test("回应倒计时只呈现当前 decision 的后端时限", () => {
  const decision = {
    scene_id: "fall",
    decision_id: "decision-deadline-1",
    state: "check_in_required",
    consent_required: false,
    elder_message: "您还好吗？",
  };
  const prompt = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    decision: {
      decision,
      deadline: { decisionId: "decision-deadline-1", expiresAt: 9_000 },
    },
  }));
  assert.equal(prompt.responseDeadlineMs, 9_000);
  assert.equal(responseCountdownSeconds(prompt.responseDeadlineMs, 5_001), 4);
  assert.equal(responseCountdownSeconds(prompt.responseDeadlineMs, 9_001), 0);

  const staleDeadline = deriveHomeCarePrompt(FALL_SCENE, liveWith(decision, {
    decision: {
      decision,
      deadline: { decisionId: "decision-old", expiresAt: 9_000 },
    },
  }));
  assert.equal(staleDeadline.responseDeadlineMs, null);
});
