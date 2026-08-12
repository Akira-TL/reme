const MOCK_RECORDING_ASSETS = Object.freeze({
  living: Object.freeze({
    assetId: "living-routine",
    playbackUrl: "/mock-recordings/living-routine.mp4",
    durationMs: 9_917,
    sceneId: "living",
    sceneLabel: "客厅日常",
    title: "客厅走动与站立",
  }),
  kitchen: Object.freeze({
    assetId: "kitchen-sharing",
    playbackUrl: "/mock-recordings/kitchen-sharing.mp4",
    durationMs: 18_833,
    sceneId: "kitchen",
    sceneLabel: "厨房时光",
    title: "餐桌前的厨房时光",
  }),
  fall: Object.freeze({
    assetId: "night-safety-check",
    playbackUrl: "/mock-recordings/night-safety-check.mp4",
    durationMs: 21_000,
    sceneId: "fall",
    sceneLabel: "夜间安全确认",
    title: "夜间快速姿态变化",
  }),
});

const MOCK_RECORDING_SCHEDULE = Object.freeze({
  "2026-08-04": Object.freeze([
    Object.freeze({ asset: "living", time: "10:26" }),
    Object.freeze({ asset: "kitchen", time: "18:30" }),
  ]),
  "2026-08-05": Object.freeze([
    Object.freeze({ asset: "living", time: "10:58" }),
  ]),
  "2026-08-06": Object.freeze([
    Object.freeze({ asset: "kitchen", time: "17:20" }),
  ]),
  "2026-08-07": Object.freeze([
    Object.freeze({ asset: "living", time: "10:35" }),
  ]),
  "2026-08-08": Object.freeze([
    Object.freeze({ asset: "living", time: "10:05" }),
    Object.freeze({ asset: "kitchen", time: "18:18" }),
  ]),
  "2026-08-09": Object.freeze([
    Object.freeze({ asset: "living", time: "10:06" }),
    Object.freeze({ asset: "kitchen", time: "11:36" }),
    Object.freeze({ asset: "fall", time: "23:47" }),
  ]),
  "2026-08-10": Object.freeze([
    Object.freeze({ asset: "living", time: "10:30" }),
  ]),
  "2026-08-11": Object.freeze([
    Object.freeze({ asset: "living", time: "10:05" }),
    Object.freeze({ asset: "kitchen", time: "16:20" }),
  ]),
});

function mockTimestamp(dateKey, time) {
  const timestampMs = Date.parse(`${dateKey}T${time}:00+08:00`);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function projectMockRecording(dateKey, item, index) {
  const asset = MOCK_RECORDING_ASSETS[item.asset];
  const startedAtMs = mockTimestamp(dateKey, item.time);
  if (!asset || startedAtMs === null) return null;
  return Object.freeze({
    id: `mock-recording:${dateKey}:${item.time.replace(":", "")}:${asset.assetId}`,
    dateKey,
    startedAtMs,
    endedAtMs: startedAtMs + asset.durationMs,
    durationMs: asset.durationMs,
    mimeType: "video/mp4",
    sizeBytes: null,
    sceneId: asset.sceneId,
    sceneLabel: asset.sceneLabel,
    title: asset.title,
    playbackUrl: asset.playbackUrl,
    source: "mock_fixture",
    sourceLabel: "演示录像",
    isDemo: true,
    fixtureOrder: index,
  });
}

export function getRemeMockRecordings(dateKey) {
  const schedule = MOCK_RECORDING_SCHEDULE[dateKey] || [];
  return Object.freeze(schedule
    .map((item, index) => projectMockRecording(dateKey, item, index))
    .filter(Boolean));
}

export const REME_MOCK_RECORDING_DATES = Object.freeze(Object.keys(MOCK_RECORDING_SCHEDULE));

export function defaultRemeRecordingDateKey(currentDateKey) {
  if (getRemeMockRecordings(currentDateKey).length > 0) return currentDateKey;
  return REME_MOCK_RECORDING_DATES.at(-1) || currentDateKey;
}

export function buildRemeRecordingDateOptions(currentDateKey) {
  const dateKeys = new Set(REME_MOCK_RECORDING_DATES);
  if (/^\d{4}-\d{2}-\d{2}$/.test(currentDateKey || "")) dateKeys.add(currentDateKey);
  return Object.freeze([...dateKeys]
    .sort((left, right) => right.localeCompare(left))
    .map((dateKey) => Object.freeze({
      dateKey,
      isToday: dateKey === currentDateKey,
      mockRecordingCount: getRemeMockRecordings(dateKey).length,
    })));
}
