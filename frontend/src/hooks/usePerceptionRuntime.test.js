import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CAMERA_INPUT_BUFFER_BYTES,
  sendBoundedCameraFrame,
} from "./cameraInputBuffer.js";

class FakeSocket {
  constructor(bufferedAmount = 0) {
    this.readyState = 1;
    this.bufferedAmount = bufferedAmount;
    this.sent = [];
  }

  send(value) {
    this.sent.push(value);
  }
}

function metadata() {
  return {
    type: "frame_meta",
    session_id: "session-1",
    scene_id: "living",
    frame_index: 1,
    timestamp_ms: 2_000,
  };
}

function metadataBytes(value = metadata()) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

test("camera input drops a frame without sending when the WebSocket buffer is saturated", () => {
  const socket = new FakeSocket(MAX_CAMERA_INPUT_BUFFER_BYTES);
  const result = sendBoundedCameraFrame(socket, metadata(), { size: 1 });

  assert.equal(result.sent, false);
  assert.equal(result.reason, "backpressure");
  assert.equal(socket.sent.length, 0);
});

test("camera input resumes with the next frame after WebSocket backpressure drains", () => {
  const socket = new FakeSocket(MAX_CAMERA_INPUT_BUFFER_BYTES);
  const jpeg = { size: 128 };

  assert.equal(sendBoundedCameraFrame(socket, metadata(), jpeg).sent, false);
  socket.bufferedAmount = 0;
  const recovered = sendBoundedCameraFrame(socket, metadata(), jpeg);

  assert.equal(recovered.sent, true);
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.sent[0], JSON.stringify(metadata()));
  assert.equal(socket.sent[1], jpeg);
});

test("camera input permits the exact buffer threshold and rejects one byte beyond it", () => {
  const meta = metadata();
  const jpeg = { size: 256 };
  const exactBufferedAmount = MAX_CAMERA_INPUT_BUFFER_BYTES - metadataBytes(meta) - jpeg.size;
  const exact = new FakeSocket(exactBufferedAmount);
  const over = new FakeSocket(exactBufferedAmount + 1);

  assert.equal(sendBoundedCameraFrame(exact, meta, jpeg).sent, true);
  assert.equal(exact.sent.length, 2);
  assert.equal(sendBoundedCameraFrame(over, meta, jpeg).sent, false);
  assert.equal(over.sent.length, 0);
});
