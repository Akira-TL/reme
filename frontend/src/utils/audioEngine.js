// 手势解锁的共享 AudioContext：浏览器自动播放策略下，无手势的
// new Audio().play() 与 speechSynthesis 都会被拒。这里在用户第一次
// 点击/按键/触摸时解锁一次 AudioContext，之后问询语音与告警响铃
// 全程经它播放，不再依赖每次播放时的瞬时手势。
let sharedContext = null;
let listenersInstalled = false;
const bufferCache = new Map();

function resumeContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) return;
  if (!sharedContext) sharedContext = new AudioContextCtor();
  if (sharedContext.state === "suspended") {
    sharedContext.resume().catch(() => {});
  }
}

export function ensureAudioUnlock() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const unlock = () => {
    resumeContext();
    if (sharedContext && sharedContext.state === "running") {
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", unlock, true);
      window.removeEventListener("touchend", unlock, true);
    }
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
  window.addEventListener("touchend", unlock, true);
}

export function getSharedAudioContext() {
  resumeContext();
  return sharedContext;
}

export function audioUnlocked() {
  return Boolean(sharedContext && sharedContext.state === "running");
}

// 经共享上下文播放一段音频资产；上下文未解锁或加载失败时 reject，
// 由调用方决定回退（HTMLAudio / speechSynthesis）。
export async function playAssetUrl(url) {
  resumeContext();
  if (!sharedContext || sharedContext.state !== "running") {
    throw new Error("audio context locked");
  }
  let buffer = bufferCache.get(url);
  if (!buffer) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`asset ${response.status}`);
    const raw = await response.arrayBuffer();
    buffer = await sharedContext.decodeAudioData(raw);
    bufferCache.set(url, buffer);
  }
  return new Promise((resolve) => {
    const source = sharedContext.createBufferSource();
    source.buffer = buffer;
    source.connect(sharedContext.destination);
    source.onended = resolve;
    source.start();
  });
}
