import { useCallback, useEffect, useRef, useState } from "react";

export const REME_LOCAL_RECORDING_SCHEMA = "reme-local-recording/v0-experiment";
export const REME_LOCAL_RECORDING_TIMEZONE = "Asia/Shanghai";
export const REME_LOCAL_RECORDING_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const REME_LOCAL_RECORDING_MAX_CLIPS = 48;

const DATABASE_NAME = "reme-local-recordings-v0";
const DATABASE_VERSION = 1;
const STORE_NAME = "clips";
const DATE_INDEX = "date_key";
const UPDATE_EVENT = "reme-local-recordings-updated";
const UPDATE_CHANNEL = "reme-local-recordings-v0";

function recordingStorageError(message, cause = null) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = "reme_recording_storage_unavailable";
  return error;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || recordingStorageError("本机录像存储失败"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || recordingStorageError("本机录像写入失败"));
    transaction.onabort = () => reject(transaction.error || recordingStorageError("本机录像写入已中止"));
  });
}

function openRecordingDatabase() {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(recordingStorageError("当前浏览器不支持本机录像存储"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const store = database.objectStoreNames.contains(STORE_NAME)
        ? request.transaction.objectStore(STORE_NAME)
        : database.createObjectStore(STORE_NAME, { keyPath: "id" });
      if (!store.indexNames.contains(DATE_INDEX)) {
        store.createIndex(DATE_INDEX, DATE_INDEX, { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || recordingStorageError("无法打开本机录像存储"));
    request.onblocked = () => reject(recordingStorageError("本机录像存储正在被其他页面升级"));
  });
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function remeRecordingDateKey(timestampMs) {
  if (!Number.isFinite(timestampMs)) return null;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: REME_LOCAL_RECORDING_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const key = `${values.year}-${values.month}-${values.day}`;
  return isDateKey(key) ? key : null;
}

function localRecordingId(startedAtMs) {
  const suffix = globalThis.crypto?.randomUUID?.()
    || Math.random().toString(36).slice(2, 12);
  return `local-recording-${startedAtMs}-${suffix}`;
}

export function buildRemeLocalRecordingRecord({
  blob,
  startedAtMs,
  endedAtMs,
  sceneId,
  sceneLabel,
  runtimeSessionId,
  sourceGeneration,
  nowMs = Date.now(),
}) {
  if (!(blob instanceof Blob) || blob.size <= 0) {
    throw new TypeError("本机录像必须包含非空 Blob");
  }
  if (!Number.isFinite(startedAtMs)
    || !Number.isFinite(endedAtMs)
    || endedAtMs <= startedAtMs) {
    throw new TypeError("本机录像起止时间无效");
  }
  const dateKey = remeRecordingDateKey(startedAtMs);
  if (!dateKey) throw new TypeError("本机录像日期无效");
  return Object.freeze({
    id: localRecordingId(startedAtMs),
    schema_version: REME_LOCAL_RECORDING_SCHEMA,
    date_key: dateKey,
    started_at_ms: Math.round(startedAtMs),
    ended_at_ms: Math.round(endedAtMs),
    duration_ms: Math.round(endedAtMs - startedAtMs),
    mime_type: blob.type || "video/webm",
    size_bytes: blob.size,
    scene_id: typeof sceneId === "string" && sceneId ? sceneId : "unknown",
    scene_label: typeof sceneLabel === "string" && sceneLabel ? sceneLabel : "家中录像",
    runtime_session_id: typeof runtimeSessionId === "string" && runtimeSessionId
      ? runtimeSessionId
      : null,
    source_generation: Number.isSafeInteger(sourceGeneration) ? sourceGeneration : null,
    created_at_ms: Math.round(nowMs),
    blob,
  });
}

export function planRemeRecordingRetention(
  records,
  nowMs = Date.now(),
  { maxClips = REME_LOCAL_RECORDING_MAX_CLIPS, retentionMs = REME_LOCAL_RECORDING_RETENTION_MS } = {},
) {
  const ordered = [...records].sort((left, right) => (
    right.started_at_ms - left.started_at_ms || right.id.localeCompare(left.id)
  ));
  const cutoff = nowMs - retentionMs;
  const keep = [];
  const remove = [];
  for (const record of ordered) {
    if (record.started_at_ms < cutoff || keep.length >= maxClips) remove.push(record.id);
    else keep.push(record.id);
  }
  return Object.freeze({ keep: Object.freeze(keep), remove: Object.freeze(remove) });
}

async function pruneRemeLocalRecordings(database, nowMs) {
  const readTransaction = database.transaction(STORE_NAME, "readonly");
  const readDone = transactionDone(readTransaction);
  const records = await requestResult(readTransaction.objectStore(STORE_NAME).getAll());
  await readDone;
  const plan = planRemeRecordingRetention(records, nowMs);
  if (plan.remove.length === 0) return plan;
  const writeTransaction = database.transaction(STORE_NAME, "readwrite");
  const writeDone = transactionDone(writeTransaction);
  const store = writeTransaction.objectStore(STORE_NAME);
  for (const id of plan.remove) store.delete(id);
  await writeDone;
  return plan;
}

function announceRecordingUpdate(dateKey) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(UPDATE_EVENT, { detail: { dateKey } }));
  }
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(UPDATE_CHANNEL);
    channel.postMessage({ dateKey });
    channel.close();
  }
}

export async function saveRemeLocalRecording(input) {
  const record = buildRemeLocalRecordingRecord(input);
  const database = await openRecordingDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(STORE_NAME).put(record);
    await done;
    await pruneRemeLocalRecordings(database, input.nowMs || Date.now());
  } finally {
    database.close();
  }
  announceRecordingUpdate(record.date_key);
  return record;
}

function projectRecording(record) {
  if (record?.schema_version !== REME_LOCAL_RECORDING_SCHEMA
    || !isDateKey(record.date_key)
    || !(record.blob instanceof Blob)
    || record.blob.size <= 0
    || !Number.isFinite(record.started_at_ms)
    || !Number.isFinite(record.ended_at_ms)
    || record.ended_at_ms <= record.started_at_ms) return null;
  return Object.freeze({
    id: record.id,
    dateKey: record.date_key,
    startedAtMs: record.started_at_ms,
    endedAtMs: record.ended_at_ms,
    durationMs: record.duration_ms,
    mimeType: record.mime_type,
    sizeBytes: record.size_bytes,
    sceneId: record.scene_id,
    sceneLabel: record.scene_label,
    blob: record.blob,
    source: "local_recording",
    sourceLabel: "本机录像",
    isDemo: false,
  });
}

export async function listRemeLocalRecordings(dateKey) {
  if (!isDateKey(dateKey)) return Object.freeze([]);
  const database = await openRecordingDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const done = transactionDone(transaction);
    const index = transaction.objectStore(STORE_NAME).index(DATE_INDEX);
    const range = IDBKeyRange.only(dateKey);
    const records = await requestResult(index.getAll(range));
    await done;
    return Object.freeze(records
      .map(projectRecording)
      .filter(Boolean)
      .sort((left, right) => left.startedAtMs - right.startedAtMs || left.id.localeCompare(right.id)));
  } finally {
    database.close();
  }
}

export function useRemeLocalRecordings(dateKey, enabled = true) {
  const [state, setState] = useState({ recordings: [], loading: enabled, error: null });
  const objectUrlsRef = useRef([]);
  const revokeObjectUrls = useCallback(() => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current = [];
  }, []);

  useEffect(() => {
    if (!enabled || !isDateKey(dateKey)) {
      revokeObjectUrls();
      const resetTimer = window.setTimeout(() => {
        setState({ recordings: [], loading: false, error: null });
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }
    let active = true;
    let channel = null;
    const refresh = async () => {
      try {
        const records = await listRemeLocalRecordings(dateKey);
        if (!active) return;
        const nextUrls = records.map((record) => URL.createObjectURL(record.blob));
        revokeObjectUrls();
        objectUrlsRef.current = nextUrls;
        setState({
          recordings: records.map((record, index) => Object.freeze({
            ...record,
            playbackUrl: nextUrls[index],
          })),
          loading: false,
          error: null,
        });
      } catch (error) {
        if (active) setState({ recordings: [], loading: false, error });
      }
    };
    const onWindowUpdate = (event) => {
      if (!event.detail?.dateKey || event.detail.dateKey === dateKey) void refresh();
    };
    window.addEventListener(UPDATE_EVENT, onWindowUpdate);
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(UPDATE_CHANNEL);
      channel.addEventListener("message", (event) => {
        if (!event.data?.dateKey || event.data.dateKey === dateKey) void refresh();
      });
    }
    void refresh();
    return () => {
      active = false;
      window.removeEventListener(UPDATE_EVENT, onWindowUpdate);
      channel?.close();
      revokeObjectUrls();
    };
  }, [dateKey, enabled, revokeObjectUrls]);

  return state;
}
