function mergeChunks(chunks) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate || !samples.length) return samples;
  const ratio = fromRate / toRate;
  const length = Math.max(1, Math.floor(samples.length / ratio));
  const output = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(samples.length - 1, left + 1);
    const weight = position - left;
    output[i] = samples[left] * (1 - weight) + samples[right] * weight;
  }
  return output;
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

function encodeWav(samples, sampleRate) {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataLength, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1, offset += 2) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

function toBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

export class VoiceCaptureError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "VoiceCaptureError";
    this.code = code;
  }
}

function normalizeCaptureError(error) {
  if (error instanceof VoiceCaptureError) return error;
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return new VoiceCaptureError("microphone_denied", "麦克风权限未开启", { cause: error });
  }
  if (error?.name === "NotFoundError" || error?.name === "OverconstrainedError") {
    return new VoiceCaptureError("microphone_unavailable", "没有可用的麦克风", { cause: error });
  }
  if (error?.name === "NotReadableError" || error?.name === "AbortError") {
    return new VoiceCaptureError("microphone_busy", "麦克风暂时无法使用", { cause: error });
  }
  return new VoiceCaptureError(
    "microphone_capture_failed",
    error instanceof Error ? error.message : "麦克风采集失败",
    { cause: error },
  );
}

function hasLiveAudioTrack(stream) {
  return Boolean(stream?.getAudioTracks?.().some((track) => track.readyState !== "ended"));
}

export async function ensureAudioContextRunning(context, { timeoutMs = 1_200 } = {}) {
  if (!context || typeof context.resume !== "function") {
    throw new VoiceCaptureError("audio_context_unavailable", "浏览器语音处理不可用");
  }
  if (context.state === "running") return;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }
  let timeout = 0;
  try {
    await Promise.race([
      Promise.resolve(context.resume()),
      new Promise((_, reject) => {
        timeout = globalThis.setTimeout(() => reject(new VoiceCaptureError(
          "audio_context_suspended",
          "浏览器尚未允许启动语音处理，请点按页面后重试",
        )), timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof VoiceCaptureError) throw error;
    throw new VoiceCaptureError(
      "audio_context_suspended",
      "浏览器尚未允许启动语音处理，请点按页面后重试",
      { cause: error },
    );
  } finally {
    globalThis.clearTimeout(timeout);
  }
  if (typeof context.state === "string" && context.state !== "running") {
    throw new VoiceCaptureError(
      "audio_context_suspended",
      "浏览器尚未允许启动语音处理，请点按页面后重试",
    );
  }
}

// 录单声道 WAV 并返回 base64。用 ScriptProcessorNode（兼容现有演示端），不要换成
// MediaRecorder：其 webm/ogg 输出 MiMo 不接收。调用方可以传入已经取得权限的
// MediaStream；否则按需申请麦克风。外部 stream 的轨道永远不会由本函数停止。
//
// 默认仍允许由尾部静音自然收尾；公网危险链路会显式传 maxDurationMs，形成
// 独立于 audioprocess 回调的硬 watchdog。一直没人说话，或 cancel/stop 于开口前，
// 默认 resolve null 表示没有可上传的内容。requireSpeech=false 用于危险确认链路：
// 前端本地音量阈值不能成为“没事”无法送达 MiMo 的理由。
export function recordVoiceReply({
  sampleRate = 16000,
  silenceMs = 1400,
  speechRms = 0.012,
  maxLeadinSilenceMs = 15000,
  maxDurationMs = null,
  requireSpeech = true,
  stream: externalStream = null,
  requestOnDemand = true,
  mediaDevices = globalThis.navigator?.mediaDevices,
  AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext,
  audioContext: externalAudioContext = null,
  audioContextResumeTimeoutMs = 1_200,
} = {}) {
  let speechDetected = false;
  let stopRequested = false;
  let cancelled = false;
  let finish = null;

  const promise = (async () => {
    if (!externalAudioContext && !AudioContextClass) {
      throw new VoiceCaptureError("microphone_unsupported", "当前浏览器不支持 WebAudio 录音");
    }
    let stream = externalStream;
    let ownsStream = false;
    let context = externalAudioContext;
    let ownsContext = false;
    let source = null;
    let processor = null;
    let watchdog = 0;
    try {
      if (!context) {
        context = new AudioContextClass();
        ownsContext = true;
      }
      await ensureAudioContextRunning(context, { timeoutMs: audioContextResumeTimeoutMs });
      if (cancelled) return null;
      if (!hasLiveAudioTrack(stream)) {
        if (!requestOnDemand) {
          throw new VoiceCaptureError("microphone_unavailable", "没有已授权的麦克风轨道");
        }
        if (!mediaDevices?.getUserMedia) {
          throw new VoiceCaptureError("microphone_unsupported", "当前浏览器不支持麦克风采集");
        }
        stream = await mediaDevices.getUserMedia({
          audio: {
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true,
          },
          video: false,
        });
        ownsStream = true;
      }
      if (cancelled) return null;
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      const chunkMs = (4096 / context.sampleRate) * 1000;
      let trailingSilenceMs = 0;
      let leadinMs = 0;
      let recordedMs = 0;

      await new Promise((resolve) => {
        let finished = false;
        finish = () => {
          if (finished) return;
          finished = true;
          resolve();
        };
        if (stopRequested || cancelled) finish();
        if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) {
          watchdog = globalThis.setTimeout(finish, maxDurationMs);
        }
        processor.onaudioprocess = (event) => {
          if (stopRequested || cancelled) {
            finish();
            return;
          }
          const data = new Float32Array(event.inputBuffer.getChannelData(0));
          chunks.push(data);
          recordedMs += chunkMs;
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);
          if (rms >= speechRms) {
            speechDetected = true;
            trailingSilenceMs = 0;
          } else if (speechDetected) {
            trailingSilenceMs += chunkMs;
            if (trailingSilenceMs >= silenceMs) finish();
          } else {
            leadinMs += chunkMs;
            if (leadinMs >= maxLeadinSilenceMs) finish();
          }
          if (Number.isFinite(maxDurationMs) && recordedMs >= maxDurationMs) finish();
        };
        source.connect(processor);
        processor.connect(context.destination);
      });

      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();

      if (cancelled || (requireSpeech && !speechDetected)) return null;
      const recorded = mergeChunks(chunks);
      if (!recorded.length) return null;
      const resampled = resampleLinear(recorded, context.sampleRate, sampleRate);
      return toBase64(encodeWav(resampled, sampleRate));
    } finally {
      finish = null;
      globalThis.clearTimeout(watchdog);
      if (processor) processor.onaudioprocess = null;
      try {
        source?.disconnect();
      } catch {
        // 录音节点可能已在正常收尾时断开。
      }
      try {
        processor?.disconnect();
      } catch {
        // 同上。
      }
      if (ownsStream) stream?.getTracks?.().forEach((track) => track.stop());
      if (ownsContext) await context?.close?.().catch(() => {});
    }
  })().catch((error) => {
    if (cancelled) return null;
    throw normalizeCaptureError(error);
  });

  return {
    promise,
    stop() {
      stopRequested = true;
      if (finish) finish();
    },
    cancel() {
      cancelled = true;
      stopRequested = true;
      if (finish) finish();
    },
    // 已听到人声（用于倒计时豁免判断：说话中不触发本地超时上报）。
    speechActive: () => speechDetected,
  };
}
