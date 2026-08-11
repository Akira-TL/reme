const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_REPORT_INTERVAL_MS = 1_000;

function requirePositiveNumber(value, label) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive number`);
  }
  return value;
}

export function createCaptureRateTracker({
  windowMs = DEFAULT_WINDOW_MS,
  reportIntervalMs = DEFAULT_REPORT_INTERVAL_MS,
} = {}) {
  const acceptedWindowMs = requirePositiveNumber(windowMs, "windowMs");
  const acceptedReportIntervalMs = requirePositiveNumber(reportIntervalMs, "reportIntervalMs");
  let timestamps = [];
  let sentInputFrames = 0;
  let lastTimestampMs = null;
  let lastReportAtMs = null;

  return Object.freeze({
    record(timestampMs) {
      if (!Number.isFinite(timestampMs)) return null;
      if (lastTimestampMs !== null && timestampMs < lastTimestampMs) {
        timestamps = [];
        lastReportAtMs = null;
      }
      lastTimestampMs = timestampMs;
      sentInputFrames += 1;
      timestamps.push(timestampMs);
      const cutoff = timestampMs - acceptedWindowMs;
      while (timestamps.length > 1 && timestamps[0] < cutoff) timestamps.shift();

      if (
        lastReportAtMs !== null
        && timestampMs - lastReportAtMs < acceptedReportIntervalMs
      ) {
        return null;
      }
      lastReportAtMs = timestampMs;
      const observationWindowMs = timestamps.at(-1) - timestamps[0];
      const observedInputFps = observationWindowMs > 0
        ? ((timestamps.length - 1) * 1_000) / observationWindowMs
        : null;
      return Object.freeze({
        sentInputFrames,
        observedInputFps,
        captureObservationWindowMs: observationWindowMs,
      });
    },
  });
}
