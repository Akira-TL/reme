import assert from "node:assert/strict";
import test from "node:test";
import {
  createMicrophoneConstraints,
  inspectMicrophoneProcessing,
} from "./wavRecorder.js";

test("麦克风默认开启回声消除与降噪约束", () => {
  assert.deepEqual(createMicrophoneConstraints(), {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
});

test("浏览器支持 voiceIsolation 时主动请求语音隔离", () => {
  assert.equal(createMicrophoneConstraints({ voiceIsolation: true }).audio.voiceIsolation, true);
});

test("调试状态读取浏览器实际启用的音频处理能力", () => {
  const stream = {
    getAudioTracks() {
      return [{
        getSettings() {
          return {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            voiceIsolation: true,
          };
        },
      }];
    },
  };
  assert.deepEqual(inspectMicrophoneProcessing(stream), {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
    voiceIsolation: true,
  });
});
