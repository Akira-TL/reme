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

// 录单声道 WAV 并返回 base64。用 ScriptProcessorNode（兼容面最广），不要换成
// MediaRecorder：其 webm/ogg 输出 B 服务不接收。权限拒绝/环境不支持时 promise
// reject，由调用方静默处理。
//
// 录音没有固定时长上限（老人的回话不被时钟掐断）：检测到说话后靠尾部静音
// （silenceMs）收尾；一直没人说话时由 maxLeadinSilenceMs 或调用方 stop() 兜底，
// 此时（以及 stop 于开口前）resolve null 表示没有可上传的内容。
export function recordVoiceReply({
  sampleRate = 16000,
  silenceMs = 1400,
  speechRms = 0.012,
  maxLeadinSilenceMs = 15000,
} = {}) {
  let speechDetected = false;
  let stopRequested = false;
  let finish = null;

  const promise = (async () => {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风采集");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("当前浏览器不支持 WebAudio 录音");

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContextCtor();
    try {
      await context.resume().catch(() => {});
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const chunks = [];
      const chunkMs = (4096 / context.sampleRate) * 1000;
      let trailingSilenceMs = 0;
      let leadinMs = 0;

      await new Promise((resolve) => {
        finish = resolve;
        if (stopRequested) resolve();
        processor.onaudioprocess = (event) => {
          const data = new Float32Array(event.inputBuffer.getChannelData(0));
          chunks.push(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);
          if (rms >= speechRms) {
            speechDetected = true;
            trailingSilenceMs = 0;
          } else if (speechDetected) {
            trailingSilenceMs += chunkMs;
            if (trailingSilenceMs >= silenceMs) resolve();
          } else {
            leadinMs += chunkMs;
            if (leadinMs >= maxLeadinSilenceMs) resolve();
          }
          if (stopRequested) resolve();
        };
        source.connect(processor);
        processor.connect(context.destination);
      });

      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();

      if (!speechDetected) return null;
      const recorded = mergeChunks(chunks);
      if (!recorded.length) return null;
      const resampled = resampleLinear(recorded, context.sampleRate, sampleRate);
      return toBase64(encodeWav(resampled, sampleRate));
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      context.close().catch(() => {});
    }
  })();

  return {
    promise,
    stop() {
      stopRequested = true;
      if (finish) finish();
    },
    // 已听到人声（用于倒计时豁免判断：说话中不触发本地超时上报）。
    speechActive: () => speechDetected,
  };
}
