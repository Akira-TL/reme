import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS,
  recognizeScene,
  recordAutomaticSceneSample,
  selectAutomaticSceneAction,
} from "./automaticSceneRecognition.js";

const TOKEN = "a".repeat(64);
const VIDEO_SAMPLE = Object.freeze({
  visual_kind: "video_clip",
  media_format: "mp4",
  media_b64: "AAEC",
  duration_ms: 2_000,
});
const KEYFRAME_SAMPLE = Object.freeze({
  visual_kind: "keyframe",
  media_format: "jpeg",
  media_b64: "/9j/2Q==",
  duration_ms: 0,
});

function successPayload(overrides = {}) {
  return {
    ok: true,
    scene_id: "kitchen",
    confidence: 0.82,
    reason: "人物正在灶台前处理食材",
    temporal_evidence: true,
    model: "mimo-v2.5",
    latency_ms: 740,
    ...overrides,
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("scene recognition sends the exact authenticated sample and validates the verdict", async () => {
  const controller = new AbortController();
  let request = null;
  const verdict = await recognizeScene(
    "https://relay.example/",
    TOKEN,
    VIDEO_SAMPLE,
    {
      signal: controller.signal,
      fetchImpl: async (url, init) => {
        request = { url, init };
        return jsonResponse(successPayload());
      },
    },
  );

  assert.equal(request.url, "https://relay.example/api/scene/recognize");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(request.init.headers, {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  });
  assert.deepEqual(JSON.parse(request.init.body), VIDEO_SAMPLE);
  assert.equal(request.init.signal, controller.signal);
  assert.deepEqual(verdict, {
    classification: "kitchen",
    confidence: 0.82,
    reason: "人物正在灶台前处理食材",
    latencyMs: 740,
    temporalEvidence: true,
    model: "mimo-v2.5",
  });
});

test("keyframe recognition requires temporal evidence to remain false", async () => {
  const verdict = await recognizeScene(
    "https://relay.example",
    TOKEN,
    KEYFRAME_SAMPLE,
    {
      fetchImpl: async () => jsonResponse(successPayload({
        scene_id: "living",
        temporal_evidence: false,
      })),
    },
  );
  assert.equal(verdict.classification, "living");
  assert.equal(verdict.temporalEvidence, false);

  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, KEYFRAME_SAMPLE, {
      fetchImpl: async () => jsonResponse(successPayload({ temporal_evidence: true })),
    }),
    (error) => error.code === "invalid_scene_recognition_response",
  );
});

test("scene recognition rejects invalid authorization and non-exact samples before fetch", async () => {
  let calls = 0;
  const oneBytePastKeyframeLimit = `${"A".repeat(
    MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS - 1,
  )}=`;
  assert.ok(oneBytePastKeyframeLimit.length <= MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS);
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(successPayload());
  };
  await assert.rejects(
    recognizeScene("https://relay.example", "not-a-token", VIDEO_SAMPLE, { fetchImpl }),
    (error) => error.code === "invalid_control_token",
  );
  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, { ...VIDEO_SAMPLE, extra: true }, { fetchImpl }),
    (error) => error.code === "invalid_scene_sample",
  );
  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, {
      ...VIDEO_SAMPLE,
      media_format: "jpeg",
    }, { fetchImpl }),
    (error) => error.code === "invalid_scene_sample",
  );
  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, {
      ...KEYFRAME_SAMPLE,
      media_b64: "A".repeat(MAX_AUTOMATIC_SCENE_KEYFRAME_BASE64_CHARS + 4),
    }, { fetchImpl }),
    (error) => error.code === "invalid_scene_sample",
  );
  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, {
      ...KEYFRAME_SAMPLE,
      media_b64: oneBytePastKeyframeLimit,
    }, { fetchImpl }),
    (error) => error.code === "invalid_scene_sample",
  );
  assert.equal(calls, 0);
});

test("scene recognition rejects every malformed success field", async () => {
  const malformed = [
    { ...successPayload(), extra: true },
    successPayload({ scene_id: "bedroom" }),
    successPayload({ confidence: 1.1 }),
    successPayload({ reason: "" }),
    successPayload({ temporal_evidence: "yes" }),
    successPayload({ model: "" }),
    successPayload({ latency_ms: -1 }),
  ];
  for (const payload of malformed) {
    await assert.rejects(
      recognizeScene("https://relay.example", TOKEN, VIDEO_SAMPLE, {
        fetchImpl: async () => jsonResponse(payload),
      }),
      (error) => error.code === "invalid_scene_recognition_response",
    );
  }
});

test("scene recognition preserves bounded relay errors and aborts without a request", async () => {
  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, VIDEO_SAMPLE, {
      fetchImpl: async () => jsonResponse({ ok: false, error: "mimo_timeout" }, 504),
    }),
    (error) => error.code === "mimo_timeout",
  );

  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, VIDEO_SAMPLE, {
      signal: controller.signal,
      fetchImpl: async () => {
        called = true;
        return jsonResponse(successPayload());
      },
    }),
    (error) => error.name === "AbortError",
  );
  assert.equal(called, false);

  await assert.rejects(
    recognizeScene("https://relay.example", TOKEN, VIDEO_SAMPLE, {
      fetchImpl: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    }),
    (error) => error.name === "AbortError",
  );
});

class FakeMediaStream {
  constructor(tracks) {
    this.tracks = tracks;
  }
}

class FakeMediaRecorder {
  static instances = [];

  static isTypeSupported(type) {
    return type === "video/mp4;codecs=h264" || type === "video/mp4";
  }

  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = "inactive";
    this.listeners = new Map();
    this.stopCalls = 0;
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, event = {}) {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  start(timeslice) {
    this.timeslice = timeslice;
    this.state = "recording";
  }

  stop() {
    this.stopCalls += 1;
    this.state = "inactive";
    this.emit("dataavailable", {
      data: new Blob([new Uint8Array([0, 1, 2])], { type: "video/mp4" }),
    });
    this.emit("stop");
  }
}

function sharedCamera() {
  const track = {
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
    },
  };
  return {
    track,
    stream: { getVideoTracks: () => [track] },
  };
}

test("automatic sampling records a two-second video-only MP4 without stopping camera tracks", async () => {
  FakeMediaRecorder.instances = [];
  const { stream, track } = sharedCamera();
  const sample = await recordAutomaticSceneSample(stream, {}, {
    MediaRecorderImpl: FakeMediaRecorder,
    MediaStreamImpl: FakeMediaStream,
    setTimeoutImpl(callback) {
      queueMicrotask(callback);
      return 7;
    },
    clearTimeoutImpl() {},
    captureJpegImpl: () => {
      throw new Error("MP4 should not fall back");
    },
  });

  const recorder = FakeMediaRecorder.instances[0];
  assert.equal(recorder.stream.tracks.length, 1);
  assert.equal(recorder.stream.tracks[0], track);
  assert.equal(recorder.options.mimeType, "video/mp4;codecs=h264");
  assert.equal(recorder.options.videoBitsPerSecond, 600_000);
  assert.equal(recorder.timeslice, 250);
  assert.deepEqual(sample, {
    visual_kind: "video_clip",
    media_format: "mp4",
    media_b64: "AAEC",
    duration_ms: 2_000,
  });
  assert.equal(track.stopCalls, 0);
});

test("automatic sampling transparently falls back when MP4 is unsupported or construction fails", async () => {
  class UnsupportedRecorder {
    static isTypeSupported() {
      return false;
    }
  }
  class BrokenRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor() {
      throw new Error("unsupported encoder");
    }
  }
  const { stream, track } = sharedCamera();
  for (const MediaRecorderImpl of [UnsupportedRecorder, BrokenRecorder]) {
    const sample = await recordAutomaticSceneSample(stream, {}, {
      MediaRecorderImpl,
      MediaStreamImpl: FakeMediaStream,
      captureJpegImpl: () => KEYFRAME_SAMPLE.media_b64,
    });
    assert.deepEqual(sample, KEYFRAME_SAMPLE);
  }
  assert.equal(track.stopCalls, 0);
});

test("automatic sampling falls back after a recorder error", async () => {
  class ErrorRecorder extends FakeMediaRecorder {
    start(timeslice) {
      super.start(timeslice);
      queueMicrotask(() => this.emit("error", { error: new Error("encoder failed") }));
    }

    stop() {
      this.stopCalls += 1;
      this.state = "inactive";
    }
  }
  const { stream, track } = sharedCamera();
  const sample = await recordAutomaticSceneSample(stream, {}, {
    MediaRecorderImpl: ErrorRecorder,
    MediaStreamImpl: FakeMediaStream,
    setTimeoutImpl: () => 11,
    clearTimeoutImpl() {},
    captureJpegImpl: () => KEYFRAME_SAMPLE.media_b64,
  });
  assert.deepEqual(sample, KEYFRAME_SAMPLE);
  assert.equal(track.stopCalls, 0);
});

test("aborting automatic sampling clears its timer and recorder but preserves shared tracks", async () => {
  class HangingRecorder extends FakeMediaRecorder {
    stop() {
      this.stopCalls += 1;
      this.state = "inactive";
    }
  }
  const { stream, track } = sharedCamera();
  const controller = new AbortController();
  const cleared = [];
  const promise = recordAutomaticSceneSample(stream, {}, {
    signal: controller.signal,
    MediaRecorderImpl: HangingRecorder,
    MediaStreamImpl: FakeMediaStream,
    setTimeoutImpl: () => 29,
    clearTimeoutImpl: (timer) => cleared.push(timer),
    captureJpegImpl: () => KEYFRAME_SAMPLE.media_b64,
  });
  const recorder = FakeMediaRecorder.instances.at(-1);
  controller.abort();

  await assert.rejects(promise, (error) => error.name === "AbortError");
  assert.equal(recorder.stopCalls, 1);
  assert.deepEqual(cleared, [29]);
  assert.equal(track.stopCalls, 0);
});

test("automatic sampling rejects an unusable JPEG fallback and invalid duration", async () => {
  class UnsupportedRecorder {
    static isTypeSupported() {
      return false;
    }
  }
  const { stream } = sharedCamera();
  await assert.rejects(
    recordAutomaticSceneSample(stream, {}, {
      MediaRecorderImpl: UnsupportedRecorder,
      MediaStreamImpl: FakeMediaStream,
      captureJpegImpl: () => null,
    }),
    (error) => error.code === "automatic_scene_sample_unavailable",
  );
  await assert.rejects(
    recordAutomaticSceneSample(stream, {}, { durationMs: 200 }),
    (error) => error.code === "invalid_scene_sample_duration",
  );
});

test("automatic scene decisions switch only for confident supported scenes", () => {
  for (const classification of ["living", "kitchen", "bathroom", "fall"]) {
    const currentSceneId = classification === "living" ? "kitchen" : "living";
    assert.deepEqual(
      selectAutomaticSceneAction(currentSceneId, { classification, confidence: 0.65 }),
      { type: "switch", sceneId: classification, reason: "confident_scene" },
    );
  }
});

test("automatic scene decisions retain the current scene for uncertainty and weak evidence", () => {
  assert.deepEqual(
    selectAutomaticSceneAction("living", { classification: "uncertain", confidence: 0.99 }),
    { type: "retain", sceneId: "living", reason: "uncertain" },
  );
  assert.deepEqual(
    selectAutomaticSceneAction("kitchen", { classification: "bathroom", confidence: 0.649 }),
    { type: "retain", sceneId: "kitchen", reason: "low_confidence" },
  );
  assert.deepEqual(
    selectAutomaticSceneAction("fall", { classification: "fall", confidence: 0.9 }),
    { type: "retain", sceneId: "fall", reason: "already_active" },
  );
  assert.deepEqual(
    selectAutomaticSceneAction("bathroom", { classification: "other", confidence: 0.9 }),
    { type: "retain", sceneId: "bathroom", reason: "invalid_verdict" },
  );
});
