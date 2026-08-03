import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  ensureAudioContextRunning,
  recordVoiceReply,
} from "./wavRecorder.js";

function audioTrack() {
  return {
    kind: "audio",
    readyState: "live",
    stopCalls: 0,
    stop() {
      this.stopCalls += 1;
      this.readyState = "ended";
    },
  };
}

function audioStream(track = audioTrack()) {
  return {
    track,
    getAudioTracks: () => [track],
    getTracks: () => [track],
  };
}

class FakeAudioContext {
  constructor({ state = "running", resume, order } = {}) {
    this.state = state;
    this.sampleRate = 16_000;
    this.destination = {};
    this.resumeImpl = resume;
    this.order = order;
    this.processor = null;
    this.closeCalls = 0;
  }

  async resume() {
    this.order?.push("resume");
    if (this.resumeImpl) return this.resumeImpl(this);
    this.state = "running";
    return undefined;
  }

  createMediaStreamSource() {
    return {
      connect() {},
      disconnect() {},
    };
  }

  createScriptProcessor() {
    this.processor = {
      onaudioprocess: null,
      connect() {},
      disconnect() {},
    };
    return this.processor;
  }

  async close() {
    this.closeCalls += 1;
    this.state = "closed";
  }

  emit(samples) {
    assert.equal(typeof this.processor?.onaudioprocess, "function");
    this.processor.onaudioprocess({
      inputBuffer: {
        getChannelData: () => samples,
      },
    });
  }
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("test condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("recorder resumes AudioContext before requesting microphone access", async () => {
  const order = [];
  const context = new FakeAudioContext({ state: "suspended", order });
  const stream = audioStream();
  const recorder = recordVoiceReply({
    audioContext: context,
    mediaDevices: {
      async getUserMedia() {
        order.push("getUserMedia");
        return stream;
      },
    },
    maxDurationMs: 100,
  });

  await waitFor(() => context.processor);
  recorder.cancel();
  assert.equal(await recorder.promise, null);
  assert.deepEqual(order, ["resume", "getUserMedia"]);
  assert.equal(stream.track.stopCalls, 1);
});

test("AudioContext resume timeout fails before microphone acquisition", async () => {
  const context = new FakeAudioContext({
    state: "suspended",
    resume: () => new Promise(() => {}),
  });
  let microphoneRequests = 0;
  const recorder = recordVoiceReply({
    audioContext: context,
    audioContextResumeTimeoutMs: 5,
    mediaDevices: {
      async getUserMedia() {
        microphoneRequests += 1;
        return audioStream();
      },
    },
  });

  await assert.rejects(
    recorder.promise,
    (error) => error?.code === "audio_context_suspended",
  );
  assert.equal(microphoneRequests, 0);
});

test("ensureAudioContextRunning rejects a context that remains suspended", async () => {
  const context = new FakeAudioContext({
    state: "suspended",
    resume: async () => undefined,
  });
  await assert.rejects(
    ensureAudioContextRunning(context, { timeoutMs: 20 }),
    (error) => error?.code === "audio_context_suspended",
  );
});

test("cancel discards audio and releases an on-demand microphone track", async () => {
  const context = new FakeAudioContext();
  const stream = audioStream();
  const recorder = recordVoiceReply({
    audioContext: context,
    mediaDevices: { getUserMedia: async () => stream },
    maxDurationMs: 100,
  });

  await waitFor(() => context.processor);
  context.emit(new Float32Array(4_096).fill(0.2));
  assert.equal(recorder.speechActive(), true);
  recorder.cancel();
  assert.equal(await recorder.promise, null);
  assert.equal(stream.track.stopCalls, 1);
});

test("cancel while getUserMedia is pending stops the late owned track", async () => {
  const context = new FakeAudioContext();
  const stream = audioStream();
  let resolveMicrophone;
  const microphone = new Promise((resolve) => {
    resolveMicrophone = resolve;
  });
  const recorder = recordVoiceReply({
    audioContext: context,
    mediaDevices: { getUserMedia: () => microphone },
    maxDurationMs: 100,
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  recorder.cancel();
  resolveMicrophone(stream);
  assert.equal(await recorder.promise, null);
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(context.processor, null);
});

test("permission denial maps to microphone_denied and closes an owned context", async () => {
  class OwnedAudioContext extends FakeAudioContext {
    static instance = null;

    constructor() {
      super();
      OwnedAudioContext.instance = this;
    }
  }
  const denied = new Error("denied");
  denied.name = "NotAllowedError";
  const recorder = recordVoiceReply({
    AudioContextClass: OwnedAudioContext,
    mediaDevices: { getUserMedia: async () => { throw denied; } },
  });

  await assert.rejects(
    recorder.promise,
    (error) => error?.code === "microphone_denied",
  );
  assert.equal(OwnedAudioContext.instance.closeCalls, 1);
  assert.equal(OwnedAudioContext.instance.state, "closed");
});

test("hard duration limit settles silent capture and releases its track", async () => {
  const context = new FakeAudioContext();
  const stream = audioStream();
  const recorder = recordVoiceReply({
    audioContext: context,
    mediaDevices: { getUserMedia: async () => stream },
    maxDurationMs: 8,
    maxLeadinSilenceMs: 5_000,
  });

  assert.equal(await recorder.promise, null);
  assert.equal(stream.track.stopCalls, 1);
  assert.equal(context.processor.onaudioprocess, null);
});

test("requireSpeech false keeps low-volume capture uploadable", async () => {
  const context = new FakeAudioContext();
  const stream = audioStream();
  const recorder = recordVoiceReply({
    audioContext: context,
    mediaDevices: { getUserMedia: async () => stream },
    requireSpeech: false,
    speechRms: 1,
    maxDurationMs: 1_000,
  });
  await waitFor(() => context.processor);

  context.emit(new Float32Array(4_096).fill(0.002));
  assert.equal(recorder.speechActive(), false);
  recorder.stop();

  const audioB64 = await recorder.promise;
  assert.equal(typeof audioB64, "string");
  const bytes = Buffer.from(audioB64, "base64");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(stream.track.stopCalls, 1);
});

test("1.4 seconds of trailing silence finalizes a valid mono WAV", async () => {
  const context = new FakeAudioContext();
  const stream = audioStream();
  const recorder = recordVoiceReply({
    audioContext: context,
    mediaDevices: { getUserMedia: async () => stream },
    silenceMs: 1_400,
    maxDurationMs: 1_000,
  });
  await waitFor(() => context.processor);

  context.emit(new Float32Array(4_096).fill(0.2));
  for (let index = 0; index < 5; index += 1) {
    context.emit(new Float32Array(4_096));
  }
  assert.equal(stream.track.stopCalls, 0);
  context.emit(new Float32Array(4_096));

  const audioB64 = await recorder.promise;
  assert.equal(typeof audioB64, "string");
  const bytes = Buffer.from(audioB64, "base64");
  assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(bytes.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(bytes.readUInt16LE(22), 1);
  assert.equal(bytes.readUInt32LE(24), 16_000);
  assert.equal(stream.track.stopCalls, 1);
});

test("cancelling an external stream never stops caller-owned tracks", async () => {
  const context = new FakeAudioContext();
  const stream = audioStream();
  const recorder = recordVoiceReply({
    audioContext: context,
    stream,
    requestOnDemand: false,
    maxDurationMs: 100,
  });

  await waitFor(() => context.processor);
  recorder.cancel();
  assert.equal(await recorder.promise, null);
  assert.equal(stream.track.stopCalls, 0);
});
