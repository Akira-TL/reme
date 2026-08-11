import assert from "node:assert/strict";
import test from "node:test";

import { createCaptureRateTracker } from "./captureRateTracker.js";

test("reports measured successful uploads independently of the 10 FPS target", () => {
  const tracker = createCaptureRateTracker();
  let report = null;
  for (let timestampMs = 0; timestampMs <= 5_000; timestampMs += 100) {
    report = tracker.record(timestampMs) || report;
  }
  assert.equal(report.sentInputFrames, 51);
  assert.equal(report.observedInputFps, 10);
  assert.equal(report.captureObservationWindowMs, 5_000);
});

test("slow delivery is measured rather than being presented as the target rate", () => {
  const tracker = createCaptureRateTracker({ windowMs: 5_000, reportIntervalMs: 1_000 });
  let report = null;
  for (let timestampMs = 0; timestampMs <= 5_000; timestampMs += 250) {
    report = tracker.record(timestampMs) || report;
  }
  assert.equal(report.sentInputFrames, 21);
  assert.equal(report.observedInputFps, 4);
});

test("a long capture pause clears the stale rate on the next successful frame", () => {
  const tracker = createCaptureRateTracker();
  tracker.record(0);
  tracker.record(1_000);
  const report = tracker.record(10_000);
  assert.equal(report.sentInputFrames, 3);
  assert.equal(report.observedInputFps, null);
  assert.equal(report.captureObservationWindowMs, 0);
});
