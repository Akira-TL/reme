import assert from "node:assert/strict";
import test from "node:test";
import { shouldSubmitDangerFrame } from "./dangerFramePolicy.js";

const decision = { decision_id: "decision-1", confirm_channels: ["frame", "voice"] };

test("danger frame authority is gated behind completed prompt playback", () => {
  assert.equal(shouldSubmitDangerFrame(decision, { promptPlaybackCompleted: false }), false);
  assert.equal(shouldSubmitDangerFrame(decision, { promptPlaybackCompleted: true }), true);
  assert.equal(shouldSubmitDangerFrame(decision, {
    promptPlaybackCompleted: true,
    alreadySubmitted: true,
  }), false);
});
