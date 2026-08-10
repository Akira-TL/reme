import assert from "node:assert/strict";
import test from "node:test";

import { createCameraFrameEncoder } from "./cameraFrameEncoder.js";

class FakeBlob {
  constructor(parts) {
    this.parts = parts;
  }
}

class FakeWorker {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.posted = [];
    FakeWorker.instances.push(this);
  }

  postMessage(value, transfer) {
    this.posted.push({ value, transfer });
  }

  terminate() {
    this.terminated = true;
  }
}

class FakeTrackProcessor {
  constructor({ track }) {
    this.track = track;
    this.readable = {
      getReader() {
        return {};
      },
    };
  }
}

function videoWithTrack(track = { readyState: "live" }) {
  return {
    srcObject: {
      getVideoTracks() {
        return [track];
      },
    },
  };
}

test("camera frame encoder transfers the processor stream to a worker", () => {
  FakeWorker.instances = [];
  const frames = [];
  const revoked = [];
  const encoder = createCameraFrameEncoder({
    videoElement: videoWithTrack(),
    onFrame(blob, timestampMs) {
      frames.push({ blob, timestampMs });
    },
    WorkerImpl: FakeWorker,
    BlobImpl: FakeBlob,
    TrackProcessorImpl: FakeTrackProcessor,
    OffscreenCanvasImpl: function FakeOffscreenCanvas() {},
    urlApi: {
      createObjectURL(blob) {
        assert.match(blob.parts[0], /MediaStreamTrackProcessor|OffscreenCanvas|convertToBlob/);
        return "blob:frame-encoder";
      },
      revokeObjectURL(url) {
        revoked.push(url);
      },
    },
    now: () => 1234,
  });

  assert.equal(encoder.mode, "track-worker");
  assert.deepEqual(revoked, ["blob:frame-encoder"]);
  const worker = FakeWorker.instances[0];
  assert.equal(worker.posted.length, 1);
  assert.equal(worker.posted[0].value.type, "start");
  assert.equal(worker.posted[0].value.width, 384);
  assert.equal(worker.posted[0].value.quality, 0.65);
  assert.equal(worker.posted[0].value.intervalMs, 100);
  assert.equal(worker.posted[0].value.mainClockMs, 1234);
  assert.equal(worker.posted[0].transfer[0], worker.posted[0].value.readable);

  const blob = { size: 321 };
  worker.onmessage({ data: { type: "frame", blob, timestampMs: 1300 } });
  assert.deepEqual(frames, [{ blob, timestampMs: 1300 }]);

  encoder.stop();
  assert.equal(worker.terminated, true);
});

test("camera frame encoder fails closed when no live video track exists", () => {
  const encoder = createCameraFrameEncoder({
    videoElement: videoWithTrack({ readyState: "ended" }),
    onFrame() {},
    WorkerImpl: FakeWorker,
    BlobImpl: FakeBlob,
    TrackProcessorImpl: FakeTrackProcessor,
    OffscreenCanvasImpl: function FakeOffscreenCanvas() {},
    urlApi: {
      createObjectURL() {
        return "blob:unused";
      },
      revokeObjectURL() {},
    },
  });

  assert.equal(encoder, null);
});
