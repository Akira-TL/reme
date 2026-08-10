const WORKER_SOURCE = `
let stopped = false;

self.onmessage = async (event) => {
  if (event.data?.type !== "start") return;
  const { readable, width, quality, intervalMs, mainClockMs } = event.data;
  const reader = readable.getReader();
  let canvas = null;
  let context = null;
  let lastOutputAt = -Infinity;
  const workerClockStartedAt = performance.now();
  try {
    while (!stopped) {
      const item = await reader.read();
      if (item.done) break;
      const frame = item.value;
      try {
        const now = performance.now();
        if (now - lastOutputAt < intervalMs - 1) continue;
        const sourceWidth = frame.displayWidth || frame.codedWidth || width;
        const sourceHeight = frame.displayHeight || frame.codedHeight || width;
        const targetWidth = Math.min(width, sourceWidth);
        const targetHeight = Math.max(1, Math.round(targetWidth * sourceHeight / sourceWidth));
        if (!canvas || canvas.width !== targetWidth || canvas.height !== targetHeight) {
          canvas = new OffscreenCanvas(targetWidth, targetHeight);
          context = canvas.getContext("2d", { alpha: false });
        }
        context.drawImage(frame, 0, 0, targetWidth, targetHeight);
        const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
        lastOutputAt = now;
        postMessage({
          type: "frame",
          blob,
          timestampMs: mainClockMs + (now - workerClockStartedAt),
        });
      } finally {
        frame.close();
      }
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error?.message || error) });
  } finally {
    try { await reader.cancel(); } catch {}
  }
};
`;

export function createCameraFrameEncoder({
  videoElement,
  onFrame,
  onError = null,
  width = 384,
  quality = 0.65,
  fps = 10,
  WorkerImpl = globalThis.Worker,
  BlobImpl = globalThis.Blob,
  urlApi = globalThis.URL,
  TrackProcessorImpl = globalThis.MediaStreamTrackProcessor,
  OffscreenCanvasImpl = globalThis.OffscreenCanvas,
  now = () => globalThis.performance?.now?.() ?? Date.now(),
} = {}) {
  if (typeof onFrame !== "function") throw new TypeError("onFrame must be a function");
  const track = videoElement?.srcObject?.getVideoTracks?.()[0] || null;
  if (
    !track
    || track.readyState === "ended"
    || typeof WorkerImpl !== "function"
    || typeof BlobImpl !== "function"
    || typeof TrackProcessorImpl !== "function"
    || typeof OffscreenCanvasImpl !== "function"
    || typeof urlApi?.createObjectURL !== "function"
    || typeof urlApi?.revokeObjectURL !== "function"
  ) return null;

  let worker = null;
  let objectUrl = null;
  try {
    const processor = new TrackProcessorImpl({ track });
    const readable = processor?.readable;
    if (!readable || typeof readable.getReader !== "function") return null;
    objectUrl = urlApi.createObjectURL(new BlobImpl([WORKER_SOURCE], { type: "text/javascript" }));
    worker = new WorkerImpl(objectUrl);
    urlApi.revokeObjectURL(objectUrl);
    objectUrl = null;
    let stopped = false;
    worker.onmessage = (event) => {
      if (stopped) return;
      if (event.data?.type === "frame" && event.data.blob) {
        onFrame(event.data.blob, event.data.timestampMs);
      } else if (event.data?.type === "error") {
        onError?.(new Error(event.data.message || "camera frame worker failed"));
      }
    };
    worker.onerror = (event) => {
      if (!stopped) onError?.(new Error(event?.message || "camera frame worker failed"));
    };
    worker.postMessage({
      type: "start",
      readable,
      width,
      quality,
      intervalMs: 1000 / fps,
      mainClockMs: now(),
    }, [readable]);
    return Object.freeze({
      mode: "track-worker",
      stop() {
        if (stopped) return;
        stopped = true;
        worker?.terminate?.();
        worker = null;
      },
    });
  } catch {
    worker?.terminate?.();
    if (objectUrl !== null) urlApi.revokeObjectURL(objectUrl);
    return null;
  }
}
