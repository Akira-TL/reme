import assert from "node:assert/strict";
import test from "node:test";
import { createPoseCanvasRuntime } from "./poseCanvasRuntime.js";

function frame(sequence, x) {
  return {
    runtime_session_id: "runtime-1",
    frame_sequence: sequence,
    person_detected: true,
    keypoints: Array.from({ length: 17 }, (_, index) => ({
      name: `point-${index}`,
      x,
      y: 0.5,
      score: 0.9,
    })),
  };
}

test("pose canvas runtime interpolates display frames and redraws on resize", () => {
  const draws = [];
  const callbacks = new Map();
  let nextFrameId = 1;
  let resizeCallback = null;
  const observer = {
    observe() {},
    disconnect() {},
  };
  class FakeResizeObserver {
    constructor(callback) {
      resizeCallback = callback;
      return observer;
    }
  }
  const runtime = createPoseCanvasRuntime({
    canvas: {},
    draw: (_canvas, value) => draws.push(value),
    requestFrame: (callback) => {
      const id = nextFrameId;
      nextFrameId += 1;
      callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id) => callbacks.delete(id),
    ResizeObserverImpl: FakeResizeObserver,
    now: () => 100,
    interpolationMs: 100,
  });

  const first = frame(1, 0.2);
  const second = frame(2, 0.8);
  runtime.render(first);
  runtime.render(second);
  const callback = callbacks.values().next().value;
  callback(150);

  assert.equal(draws[0], first);
  assert.equal(draws.at(-1).frame_sequence, 2);
  assert.equal(draws.at(-1).keypoints[0].x, 0.5);
  resizeCallback();
  assert.equal(draws.at(-1).keypoints[0].x, 0.5);
});

test("dispose cancels animation, disconnects resize observation, and clears canvas", () => {
  const draws = [];
  const cancelled = [];
  let disconnected = false;
  class FakeResizeObserver {
    observe() {}
    disconnect() { disconnected = true; }
  }
  const runtime = createPoseCanvasRuntime({
    canvas: {},
    draw: (_canvas, value) => draws.push(value),
    requestFrame: () => 42,
    cancelFrame: (id) => cancelled.push(id),
    ResizeObserverImpl: FakeResizeObserver,
    now: () => 0,
  });

  runtime.render(frame(1, 0.2));
  runtime.render(frame(2, 0.8));
  runtime.dispose();

  assert.deepEqual(cancelled, [42]);
  assert.equal(disconnected, true);
  assert.equal(draws.at(-1), null);
  assert.equal(runtime.snapshot().disposed, true);
});

