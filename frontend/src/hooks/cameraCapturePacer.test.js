import assert from "node:assert/strict";
import test from "node:test";

import { createCameraCapturePacer } from "./cameraCapturePacer.js";

class FakeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.options = options;
  }
}

class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.terminated = false;
    FakeWorker.instances.push(this);
  }

  tick() {
    this.onmessage?.({ data: "tick" });
  }

  terminate() {
    this.terminated = true;
  }
}

test("camera capture pacer prefers a Worker so background tabs are not timer-throttled", () => {
  FakeWorker.instances = [];
  let ticks = 0;
  const revoked = [];
  const pacer = createCameraCapturePacer(() => { ticks += 1; }, 100, {
    WorkerImpl: FakeWorker,
    BlobImpl: FakeBlob,
    urlApi: {
      createObjectURL(blob) {
        assert.match(blob.parts[0], /100/);
        return "blob:camera-pacer";
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
  });

  assert.equal(pacer.mode, "worker");
  assert.deepEqual(revoked, ["blob:camera-pacer"]);
  const worker = FakeWorker.instances[0];
  worker.tick();
  worker.tick();
  assert.equal(ticks, 2);

  pacer.stop();
  worker.tick();
  assert.equal(ticks, 2);
  assert.equal(worker.terminated, true);
});

test("camera capture pacer falls back to setInterval when Worker is unavailable", () => {
  let callback = null;
  let cleared = null;
  let ticks = 0;
  const pacer = createCameraCapturePacer(() => { ticks += 1; }, 125, {
    WorkerImpl: undefined,
    BlobImpl: undefined,
    urlApi: undefined,
    setIntervalImpl(fn, intervalMs) {
      assert.equal(intervalMs, 125);
      callback = fn;
      return 42;
    },
    clearIntervalImpl(timer) {
      cleared = timer;
    },
  });

  assert.equal(pacer.mode, "interval");
  callback();
  assert.equal(ticks, 1);
  pacer.stop();
  callback();
  assert.equal(ticks, 1);
  assert.equal(cleared, 42);
});
