import assert from "node:assert/strict";
import test from "node:test";

import { exposeDecisionRuntimeActions } from "./decisionRuntimeActions.js";

test("向 Monitor 暴露独立的行动卡确认动作", () => {
  const confirmActionCard = () => {};
  const actions = exposeDecisionRuntimeActions({
    respondConsentGranted() {},
    respondConsentDenied() {},
    startDemoConversation() {},
    switchScene() {},
    confirmActionCard,
    resetSceneState() {},
    replayVoice() {},
    startVoiceReply() {},
  });

  assert.equal(actions.confirmActionCard, confirmActionCard);
  assert.equal(Object.hasOwn(actions, "confirmAlarm"), false);
});
