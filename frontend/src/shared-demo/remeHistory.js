import { useEffect, useMemo, useState } from "react";
import { relayHttpBase, resolveRelayEndpointUrl } from "./config.js";
import { FAMILY_TIMELINE_MOCK_DAYPARTS } from "./familyTimelineMock.js";

export const REME_HISTORY_DATASET_ID = "reme-aug-2026-demo-v1";
export const REME_HISTORY_TIMEZONE = "Asia/Shanghai";
export const REME_DATE_INDEX_SCHEMA = "reme-date-index/v1";
export const REME_TIMELINE_DAY_SCHEMA = "reme-timeline-day-state/v1";
export const REME_DIARY_SUMMARY_SCHEMA = "reme-diary-summary-state/v1";
export const REME_DAY_REVISION_TYPE = "reme_day_revision";

const WEEKDAY_COPY = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);
const DAY_STATUSES = new Set(["ready", "partial", "unavailable"]);
const SUMMARY_STATUSES = new Set(["generating", "ready", "unavailable"]);
const SUMMARY_ERRORS = new Set([
  "mimo_not_configured",
  "mimo_timeout",
  "mimo_upstream_error",
  "mimo_invalid_output",
  "timeline_not_ready",
]);
const CARE_STATUSES = new Set([
  "observing",
  "asked",
  "responded",
  "material_ready",
  "delivery_pending",
  "delivered",
  "closed",
  "unavailable",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isId(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isText(value, max = 2_000) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function isTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isMockSource(value) {
  return isRecord(value) && value.mode === "mock_fixture";
}

export function parseRemeDateIndex(value) {
  if (!hasExactKeys(value, [
    "schema_version",
    "dataset_id",
    "mode",
    "timezone",
    "revision",
    "dates",
  ])) throw new TypeError("Reme 日期索引字段不符合合同");
  if (value.schema_version !== REME_DATE_INDEX_SCHEMA
    || value.dataset_id !== REME_HISTORY_DATASET_ID
    || value.mode !== "mock_fixture"
    || value.timezone !== REME_HISTORY_TIMEZONE
    || !isRevision(value.revision)
    || !Array.isArray(value.dates)) throw new TypeError("Reme 日期索引无效");
  const dates = value.dates.map((entry) => {
    if (!hasExactKeys(entry, ["date", "status", "timeline_revision", "summary_revision"])
      || !isDateKey(entry.date)
      || !DAY_STATUSES.has(entry.status)
      || !isRevision(entry.timeline_revision)
      || !isRevision(entry.summary_revision)) throw new TypeError("Reme 日期项无效");
    return Object.freeze({ ...entry });
  });
  return Object.freeze({ ...value, dates: Object.freeze(dates) });
}

function parseCoverage(value) {
  if (!hasExactKeys(value, [
    "status",
    "start_at_ms",
    "end_at_ms",
    "observed_hours",
    "missing_intervals",
  ]) || !["complete", "partial", "unavailable"].includes(value.status)
    || !isTimestamp(value.start_at_ms)
    || !isTimestamp(value.end_at_ms)
    || value.end_at_ms < value.start_at_ms
    || !Number.isFinite(value.observed_hours)
    || value.observed_hours < 0
    || value.observed_hours > 24
    || !Array.isArray(value.missing_intervals)) throw new TypeError("Reme coverage 无效");
  return value;
}

function parseCounts(value) {
  if (!hasExactKeys(value, ["total", "activity", "device", "care"])
    || ![value.total, value.activity, value.device, value.care].every(isRevision)
    || value.total !== value.activity + value.device + value.care) {
    throw new TypeError("Reme 统计口径无效");
  }
  return value;
}

function parseActivity(value) {
  if (!hasExactKeys(value, [
    "event_id", "kind", "occurred_at_ms", "recorded_at_ms", "room", "fact_type",
    "fact", "detail", "occurrence_count", "related", "source",
  ]) || value.kind !== "activity"
    || !isId(value.event_id)
    || !isTimestamp(value.occurred_at_ms)
    || !isTimestamp(value.recorded_at_ms)
    || value.recorded_at_ms < value.occurred_at_ms
    || !isText(value.room, 80)
    || !isText(value.fact_type, 80)
    || !isText(value.fact, 500)
    || !isText(value.detail, 1_000)
    || !isPositiveInteger(value.occurrence_count)
    || !Array.isArray(value.related)
    || !isMockSource(value.source)) throw new TypeError("Reme activity item 无效");
  return value;
}

function parseDevice(value) {
  if (!hasExactKeys(value, [
    "event_id", "kind", "occurred_at_ms", "recorded_at_ms", "room", "device", "action",
    "value", "fact", "occurrence_count", "source",
  ]) || value.kind !== "device"
    || !isId(value.event_id)
    || !isTimestamp(value.occurred_at_ms)
    || !isTimestamp(value.recorded_at_ms)
    || value.recorded_at_ms < value.occurred_at_ms
    || !isText(value.room, 80)
    || !isRecord(value.device)
    || !isText(value.action, 80)
    || !isRecord(value.value)
    || !isText(value.fact, 500)
    || !isPositiveInteger(value.occurrence_count)
    || !isMockSource(value.source)) throw new TypeError("Reme device item 无效");
  return value;
}

function parseCareThread(value) {
  if (!hasExactKeys(value, [
    "event_id", "kind", "thread_id", "occurred_at_ms", "recorded_at_ms", "status",
    "assessment", "check_in", "response", "material", "delivery", "source",
  ]) || value.kind !== "care_thread"
    || !isId(value.event_id)
    || !isId(value.thread_id)
    || !isTimestamp(value.occurred_at_ms)
    || !isTimestamp(value.recorded_at_ms)
    || value.recorded_at_ms < value.occurred_at_ms
    || !CARE_STATUSES.has(value.status)
    || !isMockSource(value.source)) throw new TypeError("Reme CareThread 无效");
  for (const field of ["assessment", "check_in", "response", "material", "delivery"]) {
    if (value[field] !== null && !isRecord(value[field])) throw new TypeError(`Reme CareThread.${field} 无效`);
  }
  if (value.delivery !== null && value.delivery.status !== "mock_delivered") {
    throw new TypeError("P0 CareThread 送达必须明确为 mock_delivered");
  }
  if (value.material?.attachment) {
    if (value.material.attachment.status !== "metadata_only"
      || value.material.attachment.asset_id !== null) {
      throw new TypeError("P0 历史附件只能是 metadata_only");
    }
  }
  return value;
}

export function parseRemeTimelineDay(value) {
  if (!hasExactKeys(value, [
    "schema_version", "dataset_id", "mode", "date", "timezone", "revision", "updated_at_ms",
    "status", "coverage", "counts", "items",
  ])) throw new TypeError("Reme 日快照字段不符合合同");
  if (value.schema_version !== REME_TIMELINE_DAY_SCHEMA
    || value.dataset_id !== REME_HISTORY_DATASET_ID
    || value.mode !== "mock_fixture"
    || value.timezone !== REME_HISTORY_TIMEZONE
    || !isDateKey(value.date)
    || !isRevision(value.revision)
    || !isTimestamp(value.updated_at_ms)
    || !DAY_STATUSES.has(value.status)
    || !Array.isArray(value.items)) throw new TypeError("Reme 日快照无效");
  parseCoverage(value.coverage);
  parseCounts(value.counts);
  const items = value.items.map((item) => {
    if (!isRecord(item)) throw new TypeError("Reme 时间线 item 无效");
    if (item.kind === "activity") return parseActivity(item);
    if (item.kind === "device") return parseDevice(item);
    if (item.kind === "care_thread") return parseCareThread(item);
    throw new TypeError("Reme 时间线 item kind 无效");
  });
  return Object.freeze({ ...value, items: Object.freeze(items) });
}

export function parseRemeDiarySummaryState(value) {
  if (!hasExactKeys(value, [
    "schema_version", "dataset_id", "mode", "date", "revision", "input_timeline_revision",
    "status", "updated_at_ms", "error_code", "summary",
  ])) throw new TypeError("Reme MiMo 摘要字段不符合合同");
  if (value.schema_version !== REME_DIARY_SUMMARY_SCHEMA
    || value.dataset_id !== REME_HISTORY_DATASET_ID
    || value.mode !== "mock_fixture"
    || !isDateKey(value.date)
    || !isRevision(value.revision)
    || !isRevision(value.input_timeline_revision)
    || !SUMMARY_STATUSES.has(value.status)
    || !isTimestamp(value.updated_at_ms)) throw new TypeError("Reme MiMo 摘要状态无效");
  if (value.status === "ready") {
    if (value.error_code !== null || !isRecord(value.summary)) throw new TypeError("ready 摘要缺少 summary");
  } else if (value.summary !== null
    || (value.error_code !== null && !SUMMARY_ERRORS.has(value.error_code))) {
    throw new TypeError("Reme MiMo 摘要 unavailable 状态无效");
  }
  return Object.freeze({ ...value });
}

async function fetchJson(url, signal) {
  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Preserve the HTTP status below when an upstream proxy returns non-JSON.
  }
  if (!response.ok) {
    const error = new Error(body?.error || `HTTP ${response.status}`);
    error.code = body?.error || `http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return body;
}

function historyUrl(pathname, params = {}) {
  const url = resolveRelayEndpointUrl(relayHttpBase(), pathname);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

export async function fetchRemeDateIndex({ signal, from = "2026-08-04", to = "2026-08-11" } = {}) {
  const value = await fetchJson(historyUrl("api/family/reme/dates", {
    dataset_id: REME_HISTORY_DATASET_ID,
    from,
    to,
  }), signal);
  return parseRemeDateIndex(value);
}

export async function fetchRemeTimelineDay(date, { signal } = {}) {
  const value = await fetchJson(historyUrl("api/family/reme/day", {
    dataset_id: REME_HISTORY_DATASET_ID,
    date,
  }), signal);
  return parseRemeTimelineDay(value);
}

export async function fetchRemeDiarySummary(date, { signal } = {}) {
  const value = await fetchJson(historyUrl("api/family/diary-summary", {
    dataset_id: REME_HISTORY_DATASET_ID,
    date,
  }), signal);
  return parseRemeDiarySummaryState(value);
}

function shanghaiDaypartId(timestampMs) {
  const hour = new Date(timestampMs + 8 * 60 * 60 * 1000).getUTCHours();
  if (hour < 6) return "night";
  if (hour < 10) return "early";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function deviceIcon(deviceType) {
  return ({
    air_conditioner: "aircon",
    aircon: "aircon",
    door_lock: "door",
    refrigerator: "fridge",
    cooktop: "kitchen",
    range_hood: "kitchen",
    washing_machine: "laundry",
    light: "light",
    water_heater: "shower",
    speaker: "speaker",
    robot_vacuum: "cleaning",
  })[deviceType] || "light";
}

function activityIcon(room, factType) {
  if (room === "kitchen") return "kitchen";
  if (/lying|卧/.test(factType)) return "bed";
  if (/sit|坐/.test(factType)) return "seat";
  return "walk";
}

function relatedActivity(item) {
  return (item.related || []).map((entry) => ({
    timestampMs: entry.occurred_at_ms,
    title: entry.fact,
  })).filter((entry) => isTimestamp(entry.timestampMs) && isText(entry.title, 500));
}

function projectActivity(item, dateKey) {
  return {
    id: item.event_id,
    kind: "activity",
    label: "Backend Mock 生活片段",
    title: item.fact,
    detail: item.detail,
    icon: activityIcon(item.room, item.fact_type),
    related: relatedActivity(item),
    timestampMs: item.occurred_at_ms,
    dateKey,
    daypartId: shanghaiDaypartId(item.occurred_at_ms),
    count: item.occurrence_count,
    tone: "neutral",
    source: "mock_fixture",
  };
}

function projectDevice(item, dateKey) {
  return {
    id: item.event_id,
    kind: "device",
    label: "Backend Mock 设备事实",
    title: item.fact,
    detail: `结构化设备事实 · ${item.device.capability || item.action}`,
    icon: deviceIcon(item.device.device_type),
    related: [],
    timestampMs: item.occurred_at_ms,
    dateKey,
    daypartId: shanghaiDaypartId(item.occurred_at_ms),
    count: item.occurrence_count,
    tone: "neutral",
    source: "mock_fixture",
  };
}

function careProgress(status) {
  return ({
    observing: "安静观察",
    asked: "已发问",
    responded: "本人已回应",
    material_ready: "材料已整理",
    delivery_pending: "等待演示送达",
    delivered: "Mock 已送达",
    closed: "已结束",
    unavailable: "当前不可用",
  })[status] || status;
}

function projectCare(item, dateKey) {
  const assessment = item.assessment || {};
  const response = item.response;
  const material = item.material;
  const delivery = item.delivery;
  const attachment = material?.attachment;
  return {
    id: item.event_id,
    kind: "assessment",
    label: "Backend Mock 主动关怀",
    title: assessment.title || "主动关怀记录",
    detail: assessment.basis || "Backend 结构化关怀线程",
    timestampMs: item.occurred_at_ms,
    dateKey,
    daypartId: shanghaiDaypartId(item.occurred_at_ms),
    count: 1,
    tone: assessment.uncertainty === "high" ? "warning" : "neutral",
    statusLabel: careProgress(item.status),
    suggestedAction: assessment.suggested_action || "继续观察",
    progress: careProgress(item.status),
    linkedResponse: response ? {
      id: `${item.event_id}:response`,
      kind: "response",
      label: "本人回应摘要",
      title: response.summary,
      timestampMs: response.received_at_ms,
      dateKey,
      source: "mock_fixture",
    } : null,
    assessmentSource: assessment.source || "mock",
    uncertainty: assessment.uncertainty || "unknown",
    visualContext: assessment.visual_context ? {
      sentToMimo: Boolean(assessment.visual_context.sent_to_mimo),
      type: assessment.visual_context.type,
      sampleCount: assessment.visual_context.sample_count,
    } : null,
    source: "mock_fixture",
    stateRevision: null,
    sceneId: null,
    sceneLabel: null,
    captureStatus: null,
    captureLabel: null,
    runtimeStatus: null,
    runtimeLabel: null,
    priority: 90,
    batchOrder: 0,
    checkIn: item.check_in ? {
      timestampMs: item.check_in.asked_at_ms,
      prompt: item.check_in.prompt,
    } : null,
    familyMaterial: material && delivery ? {
      label: material.label,
      summary: material.summary,
      deliveryStatus: delivery.status === "mock_delivered" ? "Mock 已送达" : careProgress(item.status),
      deliveredAtMs: delivery.delivered_at_ms,
      attachment: {
        durationSeconds: attachment?.duration_seconds || 0,
        label: attachment?.type === "skeleton_clip" ? "匿名骨架片段元数据" : "隐私附件元数据",
      },
      modelLabel: material.generated_by === "mimo" ? "MiMo 整理" : material.generated_by,
      recipient: delivery.recipient_label,
      facts: (material.facts || []).map((fact) => fact.text),
      evidence: assessment.basis || "结构化事件",
    } : null,
  };
}

export function projectRemeTimelineDay(dayState) {
  const entries = dayState.items.map((item) => {
    if (item.kind === "activity") return projectActivity(item, dayState.date);
    if (item.kind === "device") return projectDevice(item, dayState.date);
    return projectCare(item, dayState.date);
  });
  const sections = FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => {
    const dayEntries = entries
      .filter((entry) => entry.daypartId === daypart.id)
      .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
    const activityCount = dayEntries.filter((entry) => entry.kind === "activity")
      .reduce((total, entry) => total + (entry.count || 1), 0);
    const deviceCount = dayEntries.filter((entry) => entry.kind === "device")
      .reduce((total, entry) => total + (entry.count || 1), 0);
    const careCount = dayEntries.filter((entry) => entry.kind === "assessment").length;
    return {
      ...daypart,
      count: activityCount + deviceCount + careCount,
      activityCount,
      deviceCount,
      careCount,
      entries: dayEntries,
    };
  });
  return Object.freeze({
    dateKey: dayState.date,
    day: Number.parseInt(dayState.date.slice(-2), 10),
    weekday: WEEKDAY_COPY[new Date(`${dayState.date}T12:00:00+08:00`).getUTCDay()],
    source: "mock_fixture",
    sourceMode: "mock",
    coverageHours: dayState.coverage.observed_hours,
    coverageStatus: dayState.coverage.status,
    status: dayState.status,
    revision: dayState.revision,
    totalCount: dayState.counts.total,
    activityCount: dayState.counts.activity,
    deviceCount: dayState.counts.device,
    careCount: dayState.counts.care,
    realtimeCount: 0,
    sections: Object.freeze(sections),
  });
}

export function projectRemeDateDescriptors(index) {
  return Object.freeze(index.dates.map((entry) => Object.freeze({
    dateKey: entry.date,
    day: Number.parseInt(entry.date.slice(-2), 10),
    weekday: WEEKDAY_COPY[new Date(`${entry.date}T12:00:00+08:00`).getUTCDay()],
    sourceMode: "mock",
    status: entry.status,
    timelineRevision: entry.timeline_revision,
    summaryRevision: entry.summary_revision,
  })));
}

export function projectRemeDiarySummary(state) {
  if (state.status !== "ready" || !state.summary) return null;
  return Object.freeze({
    schema_version: state.schema_version,
    date: state.date,
    ...state.summary,
  });
}

export function useRemeHistory({ selectedDateKey, revisionHint = null, enabled = true }) {
  const [dateIndex, setDateIndex] = useState(null);
  const [dayState, setDayState] = useState(null);
  const [summaryState, setSummaryState] = useState(null);
  const [error, setError] = useState(null);
  const revisionKey = revisionHint
    ? `${revisionHint.timeline_revision}:${revisionHint.summary_revision}:${revisionHint.summary_status}`
    : "none";

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    let active = true;
    fetchRemeDateIndex({ signal: controller.signal })
      .then((value) => { if (active) setDateIndex(value); })
      .catch((reason) => { if (active && reason?.name !== "AbortError") setError(reason); });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, revisionKey]);

  useEffect(() => {
    if (!enabled || !isDateKey(selectedDateKey)) return undefined;
    const controller = new AbortController();
    let active = true;
    Promise.allSettled([
      fetchRemeTimelineDay(selectedDateKey, { signal: controller.signal }),
      fetchRemeDiarySummary(selectedDateKey, { signal: controller.signal }),
    ]).then(([dayResult, summaryResult]) => {
      if (!active) return;
      if (dayResult.status === "fulfilled") {
        setDayState(dayResult.value);
        setError(null);
      } else if (dayResult.reason?.name !== "AbortError") {
        setDayState(null);
        setError(dayResult.reason);
      }
      if (summaryResult.status === "fulfilled") setSummaryState(summaryResult.value);
      else if (summaryResult.reason?.name !== "AbortError") setSummaryState(null);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [enabled, selectedDateKey, revisionKey]);

  const dates = useMemo(
    () => dateIndex ? projectRemeDateDescriptors(dateIndex) : Object.freeze([]),
    [dateIndex],
  );
  const day = useMemo(() => dayState ? projectRemeTimelineDay(dayState) : null, [dayState]);
  const summary = useMemo(
    () => summaryState ? projectRemeDiarySummary(summaryState) : null,
    [summaryState],
  );
  return { dateIndex, dates, dayState, day, summaryState, summary, error };
}
