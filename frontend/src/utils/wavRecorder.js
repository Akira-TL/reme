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

function hasSpeech(samples, { peakThreshold = 0.018, rmsThreshold = 0.006 } = {}) {
  if (!samples.length) return false;
  let peak = 0;
  let sumSquares = 0;
  for (const sample of samples) {
    const absolute = Math.abs(sample);
    if (absolute > peak) peak = absolute;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return peak >= peakThreshold || rms >= rmsThreshold;
}

// 录一段单声道 WAV 并返回 base64。用 ScriptProcessorNode（兼容面最广），不要换成
// MediaRecorder：其 webm/ogg 输出 B 服务不接收。权限拒绝/环境不支持时抛错，由调用方静默处理。
export async function recordWav({
  durationMs = 4000,
  sampleRate = 16000,
  requireSpeech = false,
} = {}) {
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
    processor.onaudioprocess = (event) => {
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    processor.connect(context.destination);

    await new Promise((resolve) => window.setTimeout(resolve, durationMs));

    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();

    const recorded = mergeChunks(chunks);
    if (!recorded.length) throw new Error("未采集到音频数据");
    if (requireSpeech && !hasSpeech(recorded)) throw new Error("未检测到语音");
    const resampled = resampleLinear(recorded, context.sampleRate, sampleRate);
    return toBase64(encodeWav(resampled, sampleRate));
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    context.close().catch(() => {});
  }
}
