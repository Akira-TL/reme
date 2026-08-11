const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayStartMs(dateKey) {
  if (typeof dateKey !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return null;
  const value = Date.parse(`${dateKey}T00:00:00+08:00`);
  return Number.isFinite(value) ? value : null;
}

export function formatRemeTime(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "—";
  const shifted = new Date(timestampMs + SHANGHAI_OFFSET_MS);
  if (Number.isNaN(shifted.getTime())) return "—";
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

export function remeDayPosition(timestampMs, dateKey) {
  const startMs = dayStartMs(dateKey);
  if (startMs === null || !Number.isFinite(timestampMs)) return null;
  const elapsedMs = timestampMs - startMs;
  if (elapsedMs < 0 || elapsedMs >= DAY_MS) return null;
  return Math.round((elapsedMs / DAY_MS) * 100_000) / 1_000;
}

function recordingMarkers(day, recordings) {
  const markers = [];
  for (const recording of recordings || []) {
    if (!recording
      || typeof recording.id !== "string"
      || typeof recording.playbackUrl !== "string"
      || !recording.playbackUrl
      || !Number.isFinite(recording.startedAtMs)
      || !Number.isFinite(recording.endedAtMs)
      || recording.endedAtMs <= recording.startedAtMs) continue;
    const position = remeDayPosition(recording.startedAtMs, day?.dateKey);
    if (position === null) continue;
    const endPosition = remeDayPosition(recording.endedAtMs, day.dateKey);
    const unclampedWidth = endPosition === null ? 100 - position : endPosition - position;
    markers.push({
      id: recording.id,
      timestampMs: recording.startedAtMs,
      endedAtMs: recording.endedAtMs,
      durationMs: recording.endedAtMs - recording.startedAtMs,
      timeLabel: formatRemeTime(recording.startedAtMs),
      endTimeLabel: formatRemeTime(recording.endedAtMs),
      position,
      width: Math.max(0.2, Math.min(100 - position, unclampedWidth)),
      title: recording.sceneLabel || "家中录像",
      playbackUrl: recording.playbackUrl,
      recording,
    });
  }
  return markers
    .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id))
    .map((marker) => Object.freeze(marker));
}

export function buildRemeActivityRhythm(day, recordings = []) {
  const markers = recordingMarkers(day, recordings);
  const recordingCount = markers.length;
  return Object.freeze({
    recordingCount,
    recordingLabel: recordingCount === 1 ? "1 段录像" : `${recordingCount} 段录像`,
    coverageLabel: recordingCount > 0 ? "本机可回看" : "暂无录像",
    coverageStatus: recordingCount > 0 ? "complete" : "unavailable",
    markers: Object.freeze(markers),
    sourceLabel: "本机录像",
    sourceNote: "只保存在启动采集的这台浏览器，不经 Relay 或 MiMo。",
  });
}
