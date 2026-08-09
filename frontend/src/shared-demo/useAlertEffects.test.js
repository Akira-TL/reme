import assert from "node:assert/strict";
import test from "node:test";
import { alertChannelPlan } from "./useAlertEffects.js";

test("alert channel plan honors only the channels in the current alarm", () => {
  assert.deepEqual(alertChannelPlan({ channels: ["flash"] }), {
    vibrate: false,
    ring: false,
    flash: true,
    key: "f",
  });
  assert.deepEqual(alertChannelPlan({ channels: ["vibrate", "ring"] }), {
    vibrate: true,
    ring: true,
    flash: false,
    key: "vr",
  });
  assert.equal(alertChannelPlan(null).key, "");
});
