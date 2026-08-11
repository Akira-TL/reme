import assert from "node:assert/strict";
import test from "node:test";
import {
  getRemeMockRecordings,
  REME_MOCK_RECORDING_DATES,
} from "./remeMockRecordings.js";

test("mock recordings provide explicit playable demo clips across the bounded history", () => {
  assert.deepEqual(REME_MOCK_RECORDING_DATES, [
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
    "2026-08-10",
    "2026-08-11",
  ]);
  const recordings = REME_MOCK_RECORDING_DATES.flatMap(getRemeMockRecordings);
  assert.equal(recordings.length, 13);
  assert.equal(new Set(recordings.map((item) => item.playbackUrl)).size, 3);
  for (const recording of recordings) {
    assert.equal(recording.source, "mock_fixture");
    assert.equal(recording.isDemo, true);
    assert.match(recording.playbackUrl, /^\/mock-recordings\/.+\.mp4$/);
    assert.ok(recording.endedAtMs > recording.startedAtMs);
    assert.ok(recording.durationMs >= 9_000 && recording.durationMs <= 21_000);
    assert.notEqual(recording.sceneId, "bathroom");
    assert.equal(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(recording.startedAtMs),
      recording.dateKey,
    );
  }
});

test("August 9 contains living, kitchen and night safety demo recordings", () => {
  const recordings = getRemeMockRecordings("2026-08-09");
  assert.deepEqual(recordings.map((item) => item.sceneId), ["living", "kitchen", "fall"]);
  assert.deepEqual(recordings.map((item) => item.sourceLabel), [
    "演示录像",
    "演示录像",
    "演示录像",
  ]);
  assert.equal(getRemeMockRecordings("2026-08-11").length, 2);
  assert.deepEqual(getRemeMockRecordings("2026-08-12"), []);
});
