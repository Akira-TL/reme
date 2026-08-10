const DEFAULT_INTERVAL_MS = 100;

function positiveInterval(value) {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_INTERVAL_MS;
}

export function createCameraCapturePacer(
  onTick,
  intervalMs = DEFAULT_INTERVAL_MS,
  {
    WorkerImpl = globalThis.Worker,
    BlobImpl = globalThis.Blob,
    urlApi = globalThis.URL,
    setIntervalImpl = globalThis.setInterval?.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval?.bind(globalThis),
  } = {},
) {
  if (typeof onTick !== "function") throw new TypeError("onTick must be a function");
  const cadenceMs = positiveInterval(intervalMs);

  if (
    typeof WorkerImpl === "function"
    && typeof BlobImpl === "function"
    && typeof urlApi?.createObjectURL === "function"
    && typeof urlApi?.revokeObjectURL === "function"
  ) {
    let worker = null;
    let objectUrl = null;
    try {
      const workerSource = `setInterval(() => postMessage("tick"), ${JSON.stringify(cadenceMs)});`;
      objectUrl = urlApi.createObjectURL(new BlobImpl([workerSource], { type: "text/javascript" }));
      worker = new WorkerImpl(objectUrl);
      urlApi.revokeObjectURL(objectUrl);
      objectUrl = null;
      let stopped = false;
      worker.onmessage = () => {
        if (!stopped) onTick();
      };
      return Object.freeze({
        mode: "worker",
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
    }
  }

  if (typeof setIntervalImpl !== "function" || typeof clearIntervalImpl !== "function") {
    throw new Error("camera capture pacing is unavailable");
  }
  let stopped = false;
  const timer = setIntervalImpl(() => {
    if (!stopped) onTick();
  }, cadenceMs);
  return Object.freeze({
    mode: "interval",
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalImpl(timer);
    },
  });
}
