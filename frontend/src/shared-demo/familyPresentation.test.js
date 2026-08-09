import assert from "node:assert/strict";
import test from "node:test";
import { deriveFamilyTruth } from "./familyPresentation.js";

function snapshot({ runtime = "ready", capture = "active", scene = "living" } = {}) {
  return {
    state: {
      scene_id: scene,
      runtime: { status: runtime },
      capture: { status: capture },
    },
  };
}

test("missing or unavailable authority never supplies a current room or quiet-state claim", () => {
  const missing = deriveFamilyTruth(null, {
    unavailableReason: "not_published",
    monitorOnline: false,
  });
  const stale = deriveFamilyTruth(snapshot(), {
    unavailableReason: "stale",
    monitorOnline: true,
  });

  assert.deepEqual(missing, {
    authoritative: false,
    sceneId: null,
    quietStateReady: false,
  });
  assert.deepEqual(stale, {
    authoritative: false,
    sceneId: null,
    quietStateReady: false,
  });
});

test("a room can be current before capture is ready but cannot become a quiet-state claim", () => {
  const waiting = deriveFamilyTruth(snapshot({ capture: "idle" }), {
    unavailableReason: null,
    monitorOnline: true,
  });
  const ready = deriveFamilyTruth(snapshot(), {
    unavailableReason: null,
    monitorOnline: true,
  });

  assert.deepEqual(waiting, {
    authoritative: true,
    sceneId: "living",
    quietStateReady: false,
  });
  assert.deepEqual(ready, {
    authoritative: true,
    sceneId: "living",
    quietStateReady: true,
  });
});
