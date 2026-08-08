import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCameraConstraints,
  buildSourceCatalog,
  createSourceGenerationBarrier,
  detectVideoSourceCapabilities,
  oppositeFacingMode,
  PERMISSION_STATES,
  releaseVideoSourceResource,
  REMOTE_VIDEO_STATES,
  classifyVideoSourceError,
} from "./videoSource.js";

test("camera constraints select front/back by facing mode until an exact device is chosen", () => {
  const front = buildCameraConstraints({ facingMode: "user" });
  const back = buildCameraConstraints({ facingMode: "environment" });
  const exactDevice = buildCameraConstraints({
    deviceId: "browser-private-device-id",
    facingMode: "environment",
  });

  assert.deepEqual(front.video.facingMode, { ideal: "user" });
  assert.deepEqual(back.video.facingMode, { ideal: "environment" });
  assert.equal(oppositeFacingMode("user"), "environment");
  assert.equal(oppositeFacingMode("environment"), "user");
  assert.deepEqual(exactDevice.video.deviceId, { exact: "browser-private-device-id" });
  assert.equal("facingMode" in exactDevice.video, false);
  assert.deepEqual(exactDevice.video.frameRate, { ideal: 30, max: 30 });
});

test("capability detection keeps local file playback when remote capture is unavailable", () => {
  const capabilities = detectVideoSourceCapabilities({
    mediaDevices: { getUserMedia() {} },
    videoPrototype: {},
    urlApi: { createObjectURL() {}, revokeObjectURL() {} },
  });

  assert.equal(capabilities.camera.available, true);
  assert.equal(capabilities.display.available, false);
  assert.equal(capabilities.display.remote_video, REMOTE_VIDEO_STATES.UNAVAILABLE);
  assert.match(capabilities.display.disabled_reason, /不支持屏幕/);
  assert.equal(capabilities.file.available, true);
  assert.equal(capabilities.file.remote_video, REMOTE_VIDEO_STATES.LOCAL_ONLY);
  assert.equal(capabilities.file.capture_stream_method, null);
});

test("webkit captureStream is accepted and source catalog exposes opaque camera descriptors", () => {
  const capabilities = detectVideoSourceCapabilities({
    mediaDevices: { getUserMedia() {}, getDisplayMedia() {} },
    videoPrototype: { webkitCaptureStream() {} },
    urlApi: { createObjectURL() {}, revokeObjectURL() {} },
  });
  const catalog = buildSourceCatalog({
    capabilities,
    devices: [
      { kind: "videoinput", deviceId: "secret-front-id", label: "Front Camera" },
      { kind: "videoinput", deviceId: "secret-rear-id", label: "Back Camera" },
      { kind: "audioinput", deviceId: "microphone", label: "Mic" },
    ],
  });

  assert.equal(capabilities.file.capture_stream_method, "webkitCaptureStream");
  assert.equal(capabilities.file.remote_video, REMOTE_VIDEO_STATES.AVAILABLE);
  assert.deepEqual(catalog.slice(0, 4).map((source) => ({
    id: source.id,
    facing: source.facing_mode,
  })), [
    { id: "camera-user", facing: "user" },
    { id: "camera-environment", facing: "environment" },
    { id: "camera-device-1", facing: "user" },
    { id: "camera-device-2", facing: "environment" },
  ]);
  assert.equal(JSON.stringify(catalog).includes("secret-front-id"), false);
  assert.equal(catalog.at(-2).kind, "display");
  assert.equal(catalog.at(-1).kind, "file");
});

test("generation barrier rejects asynchronous work from an older source", () => {
  const generations = createSourceGenerationBarrier(7);
  const cameraGeneration = generations.next();
  const displayGeneration = generations.next();

  assert.equal(cameraGeneration, 8);
  assert.equal(displayGeneration, 9);
  assert.equal(generations.isCurrent(cameraGeneration), false);
  assert.equal(generations.isCurrent(displayGeneration), true);
  assert.equal(generations.invalidate(), 10);
  assert.equal(generations.isCurrent(displayGeneration), false);
});

test("resource release removes listeners, stops unique tracks, clears video, and revokes file URL", () => {
  const calls = [];
  const stream = {
    getTracks() {
      return [
        { stop() { calls.push("stop-video"); } },
        { stop() { calls.push("stop-audio"); } },
      ];
    },
  };
  const remoteStream = {
    getTracks() {
      return [{ stop() { calls.push("stop-remote"); } }];
    },
  };
  const video = {
    srcObject: stream,
    src: "",
    pause() { calls.push("pause"); },
    load() { calls.push("load"); },
  };
  const resource = {
    stream,
    remoteStream,
    objectUrl: "blob:local-video",
    cleanup: [() => calls.push("cleanup")],
    released: false,
  };

  releaseVideoSourceResource(resource, {
    video,
    urlApi: { revokeObjectURL(url) { calls.push(`revoke:${url}`); } },
  });
  releaseVideoSourceResource(resource, {
    video,
    urlApi: { revokeObjectURL() { calls.push("unexpected-second-release"); } },
  });

  assert.deepEqual(calls, [
    "cleanup",
    "stop-video",
    "stop-audio",
    "stop-remote",
    "pause",
    "load",
    "revoke:blob:local-video",
  ]);
  assert.equal(video.srcObject, null);
  assert.equal(resource.released, true);
});

test("stale resource release never clears a newer video attachment", () => {
  const staleStream = { getTracks: () => [{ stop() {} }] };
  const currentStream = { getTracks: () => [] };
  const video = {
    srcObject: currentStream,
    pause() { throw new Error("must not clear current video"); },
  };

  releaseVideoSourceResource({
    stream: staleStream,
    remoteStream: staleStream,
    objectUrl: null,
    cleanup: [],
    released: false,
  }, { video });

  assert.equal(video.srcObject, currentStream);
});

test("permission failures are explicit and source-specific", () => {
  const denied = new Error("denied");
  denied.name = "NotAllowedError";
  const failure = classifyVideoSourceError(denied, "display");

  assert.equal(failure.code, "permission_denied");
  assert.equal(failure.permission, PERMISSION_STATES.DENIED);
  assert.match(failure.message, /屏幕共享/);
});
