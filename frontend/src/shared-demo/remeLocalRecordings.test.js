import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemeLocalRecordingRecord,
  planRemeRecordingRetention,
  remeRecordingDateKey,
  REME_LOCAL_RECORDING_SCHEMA,
} from "./remeLocalRecordings.js";

test("local recording records use Shanghai dates and preserve real Blob metadata", () => {
  const startedAtMs = Date.parse("2026-08-11T23:59:58+08:00");
  const record = buildRemeLocalRecordingRecord({
    blob: new Blob(["recording-bytes"], { type: "video/webm" }),
    startedAtMs,
    endedAtMs: startedAtMs + 2_000,
    sceneId: "living",
    sceneLabel: "客厅录像",
    runtimeSessionId: "runtime-1",
    sourceGeneration: 4,
    nowMs: startedAtMs + 2_010,
  });
  assert.equal(remeRecordingDateKey(startedAtMs), "2026-08-11");
  assert.equal(record.schema_version, REME_LOCAL_RECORDING_SCHEMA);
  assert.equal(record.date_key, "2026-08-11");
  assert.equal(record.duration_ms, 2_000);
  assert.equal(record.mime_type, "video/webm");
  assert.equal(record.size_bytes, 15);
});

test("recording retention removes expired and oldest excess clips deterministically", () => {
  const nowMs = Date.parse("2026-08-11T12:00:00+08:00");
  const records = [
    { id: "newest", started_at_ms: nowMs - 1_000 },
    { id: "middle", started_at_ms: nowMs - 2_000 },
    { id: "oldest-in-window", started_at_ms: nowMs - 3_000 },
    { id: "expired", started_at_ms: nowMs - 20_000 },
  ];
  const plan = planRemeRecordingRetention(records, nowMs, { maxClips: 2, retentionMs: 10_000 });
  assert.deepEqual(plan.keep, ["newest", "middle"]);
  assert.deepEqual(plan.remove, ["oldest-in-window", "expired"]);
});
