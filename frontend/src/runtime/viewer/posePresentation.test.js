import assert from "node:assert/strict";
import test from "node:test";
import {
  advancePosePresentation,
  createPosePresentationState,
  isPoseFresh,
} from "./posePresentation.js";

function pose({
  runtimeSessionId = "runtime-1",
  sequence = 1,
  receivedAtMs = 1_000,
  personDetected = true,
  quality = "usable",
} = {}) {
  return {
    runtime_session_id: runtimeSessionId,
    frame_sequence: sequence,
    receivedAtMs,
    person_detected: personDetected,
    landmark_quality: personDetected ? quality : "unavailable",
    keypoints: personDetected ? [{ name: "nose", x: 0.5, y: 0.2, score: 0.9 }] : [],
  };
}

test("pose freshness uses local receipt time instead of producer wall clock", () => {
  const frame = { ...pose(), timestamp_ms: 999_999_999 };
  assert.equal(isPoseFresh(frame, 5_999), true);
  assert.equal(isPoseFresh(frame, 6_001), false);
});

test("temporary misses are held only as presentation and keep original identity", () => {
  const first = pose({ sequence: 4, receivedAtMs: 10_000 });
  const live = advancePosePresentation({
    previous: createPosePresentationState(),
    pose: first,
    runtimeSessionId: "runtime-1",
    localNowMs: 10_010,
  });
  const missedAuthorityFrame = pose({
    sequence: 5,
    receivedAtMs: 10_100,
    personDetected: false,
  });
  const held = advancePosePresentation({
    previous: live.state,
    pose: missedAuthorityFrame,
    runtimeSessionId: "runtime-1",
    localNowMs: 10_100,
  });

  assert.equal(held.mode, "held");
  assert.equal(held.visiblePose, first);
  assert.equal(held.visiblePose.frame_sequence, 4);
  assert.notEqual(held.visiblePose, missedAuthorityFrame);
});

test("runtime changes, unavailable authority, and stale frames clear the display", () => {
  const first = pose({ receivedAtMs: 1_000 });
  const live = advancePosePresentation({
    previous: createPosePresentationState(),
    pose: first,
    runtimeSessionId: "runtime-1",
    localNowMs: 1_000,
  });

  const changed = advancePosePresentation({
    previous: live.state,
    pose: null,
    runtimeSessionId: "runtime-2",
    localNowMs: 1_100,
  });
  assert.equal(changed.visiblePose, null);
  assert.equal(changed.state.lastGoodPose, null);

  const unavailable = advancePosePresentation({
    previous: live.state,
    pose: first,
    runtimeSessionId: "runtime-1",
    localNowMs: 1_100,
    authorityAvailable: false,
  });
  assert.equal(unavailable.visiblePose, null);

  const stale = advancePosePresentation({
    previous: live.state,
    pose: pose({ sequence: 2, receivedAtMs: 6_001, personDetected: false }),
    runtimeSessionId: "runtime-1",
    localNowMs: 6_001,
  });
  assert.equal(stale.mode, "stale");
  assert.equal(stale.visiblePose, null);
});

