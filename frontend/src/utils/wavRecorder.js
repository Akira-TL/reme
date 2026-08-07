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

function abortError() {
  return new DOMException("录音已取消", "AbortError");
}

function wait(durationMs, signal) {
  return new Promise((resolve, reject) => {
    let timer = window.setTimeout(finish, durationMs);

    function cleanup() {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      signal?.removeEventListener("abort", cancel);
    }

    function finish() {
      cleanup();
      resolve();
    }

    function cancel() {
      cleanup();
      reject(abortError());
    }

    if (signal?.aborted) cancel();
    else signal?.addEventListener("abort", cancel, { once: true });
  });
}

export function createMicrophoneConstraints(supported = {}) {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (supported.voiceIsolation) audio.voiceIsolation = true;
  return { audio };
}

export function inspectMicrophoneProcessing(stream) {
  const settings = stream?.getAudioTracks?.()[0]?.getSettings?.() || {};
  return {
    echoCancellation: settings.echoCancellation ?? null,
    noiseSuppression: settings.noiseSuppression ?? null,
    autoGainControl: settings.autoGainControl ?? null,
    voiceIsolation: settings.voiceIsolation ?? null,
  };
}

export function setMicrophoneEnabled(stream, enabled) {
  stream?.getAudioTracks?.().forEach((track) => {
    track.enabled = Boolean(enabled);
  });
}

export function stopMicrophone(stream) {
  stream?.getTracks?.().forEach((track) => track.stop());
}

export async function openMicrophone({ signal = null } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风采集");
  if (signal?.aborted) throw abortError();
  const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
  const stream = await navigator.mediaDevices.getUserMedia(createMicrophoneConstraints(supported));
  if (signal?.aborted) {
    stopMicrophone(stream);
    throw abortError();
  }
  return stream;
}

// 在已经授权的麦克风 stream 上开始采集，直到调用 stop()。输入轨道应由调用方在
// AI 播放询问前启用，这样浏览器的 AEC 可以利用扬声器回放参考抑制自身 TTS 回灌。
export async function startWavCapture({
  stream,
  sampleRate = 16000,
  signal = null,
} = {}) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) throw new Error("当前浏览器不支持 WebAudio 录音");
  if (signal?.aborted) throw abortError();
  const audioTrack = stream?.getAudioTracks?.().find((track) => track.readyState === "live");
  if (!audioTrack) throw new Error("麦克风连接不可用");

  const context = new AudioContextCtor();
  await context.resume().catch(() => {});
  const source = context.createMediaStreamSource(stream);
  const highPass = context.createBiquadFilter();
  highPass.type = "highpass";
  highPass.frequency.value = 100;
  const processor = context.createScriptProcessor(4096, 1, 1);
  const mute = context.createGain();
  mute.gain.value = 0;
  const chunks = [];
  let stopped = false;
  let aborted = false;
  let stopPromise = null;

  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(highPass);
  highPass.connect(processor);
  processor.connect(mute);
  mute.connect(context.destination);

  function disconnect() {
    processor.onaudioprocess = null;
    for (const node of [source, highPass, processor, mute]) {
      try {
        node.disconnect();
      } catch {
        // 节点可能已断开。
      }
    }
  }

  function cancel() {
    aborted = true;
    disconnect();
    context.close().catch(() => {});
  }

  signal?.addEventListener("abort", cancel, { once: true });

  return {
    stop() {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (!stopped) {
          stopped = true;
          signal?.removeEventListener("abort", cancel);
          disconnect();
          await context.close().catch(() => {});
        }
        if (aborted || signal?.aborted) throw abortError();
        const recorded = mergeChunks(chunks);
        if (!recorded.length) throw new Error("未采集到音频数据");
        const resampled = resampleLinear(recorded, context.sampleRate, sampleRate);
        return toBase64(encodeWav(resampled, sampleRate));
      })();
      return stopPromise;
    },
  };
}

// 兼容单次录音调用；新对话链路优先复用 openMicrophone() 获得的会话级 stream。
export async function recordWav({
  durationMs = 4000,
  sampleRate = 16000,
  signal = null,
  stream = null,
} = {}) {
  const ownsStream = !stream;
  const inputStream = stream || await openMicrophone({ signal });
  if (ownsStream) setMicrophoneEnabled(inputStream, true);
  try {
    const capture = await startWavCapture({ stream: inputStream, sampleRate, signal });
    await wait(durationMs, signal);
    return await capture.stop();
  } finally {
    if (ownsStream) stopMicrophone(inputStream);
  }
}
