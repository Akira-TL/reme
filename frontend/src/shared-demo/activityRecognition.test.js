import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCookingConfirmationAck,
  createCookingConfirmationTracker,
  isCookingRecognitionContextCurrent,
  recognizeCooking,
  recordLocalMoment,
} from "./activityRecognition.js";

function cookingContext(overrides = {}) {
  const stream = overrides.stream || {};
  return {
    generation: 3,
    captureGeneration: 7,
    stream,
    sessionId: "session-a",
    token: "token-a",
    ...overrides,
  };
}

function currentCookingContext(context, overrides = {}) {
  return {
    ...context,
    captureActive: true,
    sceneId: "kitchen",
    visibilityState: "visible",
    ...overrides,
  };
}

class FakeMediaStream {
  constructor(tracks) {
    this.tracks = tracks;
  }

  getVideoTracks() {
    return this.tracks;
  }
}

function createRecorderClass({ emitStop = false, startThrows = false, stopThrows = false } = {}) {
  return class FakeMediaRecorder {
    static instances = [];

    static isTypeSupported() {
      return true;
    }

    constructor() {
      this.listeners = new Map();
      this.mimeType = "video/webm";
      this.state = "inactive";
      this.constructor.instances.push(this);
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

    start() {
      if (startThrows) throw new Error("start failed");
      this.state = "recording";
    }

    stop() {
      if (stopThrows) throw new Error("stop failed");
      this.state = "inactive";
      if (emitStop) this.emit("stop");
    }
  };
}

function localMomentOptions(MediaRecorderImpl, overrides = {}) {
  return {
    MediaRecorderImpl,
    MediaStreamImpl: FakeMediaStream,
    durationMs: 2,
    settlementTimeoutMs: 2,
    ...overrides,
  };
}

test("cooking needs two consecutive confident visual verdicts", () => {
  const tracker = createCookingConfirmationTracker();
  assert.deepEqual(tracker.push({ classification: "cooking", confidence: 0.8 }), {
    phase: "candidate",
    consecutive: 1,
    confirmed: false,
  });
  assert.deepEqual(tracker.push({ classification: "cooking", confidence: 0.72 }), {
    phase: "confirmed",
    consecutive: 2,
    confirmed: true,
  });
});

test("uncertain, negative, or low-confidence verdicts reset cooking evidence", () => {
  const tracker = createCookingConfirmationTracker();
  tracker.push({ classification: "cooking", confidence: 0.9 });
  assert.equal(tracker.push({ classification: "uncertain", confidence: 0.9 }).consecutive, 0);
  tracker.push({ classification: "cooking", confidence: 0.9 });
  assert.equal(tracker.push({ classification: "not_cooking", confidence: 0.9 }).confirmed, false);
  tracker.push({ classification: "cooking", confidence: 0.9 });
  assert.equal(tracker.push({ classification: "cooking", confidence: 0.4 }).consecutive, 0);
});

test("activity recognition sends one exact JPEG request and validates the result", async () => {
  let request = null;
  const result = await recognizeCooking(
    "https://relay.example",
    "token-a",
    "jpeg-base64",
    async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        ok: true,
        classification: "cooking",
        confidence: 0.8,
        reason: "正在使用锅具",
        model: "mimo-v2.5",
        latency_ms: 850,
        receipt_id: "activity-receipt-0123456789abcdef0123456789abcdef",
        consecutive: 2,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );
  assert.equal(request.url, "https://relay.example/api/activity/recognize");
  assert.equal(request.init.headers.Authorization, "Bearer token-a");
  assert.deepEqual(JSON.parse(request.init.body), { image_b64: "jpeg-base64" });
  assert.equal(result.classification, "cooking");
  assert.equal(result.latencyMs, 850);
  assert.equal(result.receiptId, "activity-receipt-0123456789abcdef0123456789abcdef");
  assert.equal(result.consecutive, 2);
});

test("activity recognition exposes relay errors and rejects malformed successes", async () => {
  await assert.rejects(
    recognizeCooking("https://relay.example", "token", "jpeg", async () => (
      new Response(JSON.stringify({ ok: false, error: "mimo_unavailable" }), { status: 503 })
    )),
    (error) => error.code === "mimo_unavailable",
  );
  await assert.rejects(
    recognizeCooking("https://relay.example", "token", "jpeg", async () => (
      new Response(JSON.stringify({
        ok: true,
        classification: "probably",
        confidence: 4,
        reason: "",
        model: "mimo",
        receipt_id: null,
        consecutive: 0,
      }), { status: 200 })
    )),
    /不符合合同/,
  );
  await assert.rejects(
    recognizeCooking("https://relay.example", "token", "jpeg", async () => (
      new Response(JSON.stringify({
        ok: true,
        classification: "cooking",
        confidence: 0.9,
        reason: "正在备菜",
        model: "mimo",
        receipt_id: "client-forged",
        consecutive: 2,
      }), { status: 200 })
    )),
    /不符合合同/,
  );
});

test("activity recognition forwards cancellation to the visual request", async () => {
  const controller = new AbortController();
  const request = recognizeCooking(
    "https://relay.example",
    "token",
    "jpeg",
    async (_url, init) => new Promise((_resolve, reject) => {
      assert.equal(init.signal, controller.signal);
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("cancelled", "AbortError"));
      }, { once: true });
    }),
    { signal: controller.signal },
  );
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
});

test("cooking results and Relay acknowledgements bind to one active capture generation", () => {
  const context = cookingContext();
  const current = currentCookingContext(context);
  assert.equal(isCookingRecognitionContextCurrent(context, current), true);
  for (const stale of [
    { captureActive: false },
    { generation: context.generation + 1 },
    { captureGeneration: context.captureGeneration + 1 },
    { stream: {} },
    { sessionId: "session-b" },
    { token: "token-b" },
    { sceneId: "living" },
    { visibilityState: "hidden" },
    { visibilityState: "prerender" },
    { visibilityState: undefined },
  ]) {
    assert.equal(isCookingRecognitionContextCurrent(
      context,
      { ...current, ...stale },
    ), false);
  }

  const pending = { eventSequence: 12, context };
  assert.equal(classifyCookingConfirmationAck(pending, {
    type: "event_accepted",
    event_type: "activity_state",
    event_sequence: 12,
    activity_verified: true,
  }, current), "verified");
  assert.equal(classifyCookingConfirmationAck(pending, {
    type: "event_accepted",
    event_type: "activity_state",
    event_sequence: 12,
  }, current), "rejected");
  assert.equal(classifyCookingConfirmationAck(pending, {
    type: "event_accepted",
    event_type: "activity_state",
    event_sequence: 12,
    activity_verified: false,
  }, current), "rejected");
  assert.equal(classifyCookingConfirmationAck(pending, {
    type: "error",
    error: "activity_evidence_not_verified",
    event_type: "activity_state",
    event_sequence: 12,
  }, current), "rejected");
  assert.equal(classifyCookingConfirmationAck(pending, {
    type: "error",
    error: "activity_evidence_not_verified",
    event_type: "activity_state",
    event_sequence: 11,
  }, current), "ignore");
  for (const stale of [
    { captureActive: false },
    { generation: context.generation + 1 },
    { captureGeneration: context.captureGeneration + 1 },
    { stream: {} },
    { sessionId: "session-b" },
    { token: "token-b" },
    { sceneId: "living" },
    { visibilityState: "hidden" },
  ]) {
    assert.equal(classifyCookingConfirmationAck(pending, {
      type: "event_accepted",
      event_type: "activity_state",
      event_sequence: 12,
      activity_verified: true,
    }, { ...current, ...stale }), "stale");
  }
  assert.equal(classifyCookingConfirmationAck(pending, {
    type: "event_accepted",
    event_type: "care_card",
    event_sequence: 12,
  }, current), "ignore");
});

test("local moment fails closed when recorder stop never settles", async () => {
  const MediaRecorderImpl = createRecorderClass();
  let trackStops = 0;
  const track = { stop: () => { trackStops += 1; } };
  const recorder = recordLocalMoment(
    new FakeMediaStream([track]),
    localMomentOptions(MediaRecorderImpl),
  );
  await assert.doesNotReject(recorder.promise);
  assert.equal(await recorder.promise, null);
  assert.equal(trackStops, 0);
});

test("local moment settles null when stop throws or error arrives first", async () => {
  const ThrowingRecorder = createRecorderClass({ stopThrows: true });
  const track = { stop: () => assert.fail("shared camera track must stay active") };
  const throwing = recordLocalMoment(
    new FakeMediaStream([track]),
    localMomentOptions(ThrowingRecorder),
  );
  assert.equal(await throwing.promise, null);

  const ErrorRecorder = createRecorderClass();
  const errored = recordLocalMoment(
    new FakeMediaStream([track]),
    localMomentOptions(ErrorRecorder, { durationMs: 100 }),
  );
  ErrorRecorder.instances[0].emit("error");
  assert.equal(await errored.promise, null);
});

test("local moment settles null when recorder start throws", async () => {
  const StartThrowingRecorder = createRecorderClass({ startThrows: true });
  const track = { stop: () => assert.fail("shared camera track must stay active") };
  const recording = recordLocalMoment(
    new FakeMediaStream([track]),
    localMomentOptions(StartThrowingRecorder),
  );
  assert.equal(await recording.promise, null);
});

test("local moment resolves a local blob after a successful stop", async () => {
  const MediaRecorderImpl = createRecorderClass();
  let trackStops = 0;
  const track = { stop: () => { trackStops += 1; } };
  const recording = recordLocalMoment(
    new FakeMediaStream([track]),
    localMomentOptions(MediaRecorderImpl, { durationMs: 100 }),
  );
  const recorder = MediaRecorderImpl.instances[0];
  recorder.emit("dataavailable", { data: new Blob(["moment"]) });
  recorder.state = "inactive";
  recorder.emit("stop");
  const result = await recording.promise;
  assert.equal(result?.blob.size, 6);
  assert.equal(result?.mimeType, "video/webm");
  assert.equal(trackStops, 0);
});

test("cancelling a local moment is immediate, idempotent, and keeps camera tracks", async () => {
  const MediaRecorderImpl = createRecorderClass();
  let trackStops = 0;
  const track = { stop: () => { trackStops += 1; } };
  const recorder = recordLocalMoment(
    new FakeMediaStream([track]),
    localMomentOptions(MediaRecorderImpl, { durationMs: 100 }),
  );
  const first = recorder.cancel();
  const second = recorder.cancel();
  assert.equal(first, recorder.promise);
  assert.equal(second, recorder.promise);
  assert.equal(await recorder.promise, null);
  assert.equal(trackStops, 0);
});
