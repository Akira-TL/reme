import assert from "node:assert/strict";
import test from "node:test";

import { getFamilyTimelineMockDay } from "./familyTimelineMock.js";
import {
  MIMO_DIARY_REQUEST_SCHEMA,
  MIMO_DIARY_RESPONSE_SCHEMA,
  buildMimoDiarySummaryRequest,
  parseMimoDiarySummaryResponse,
} from "./familyTimelineMimoSummary.js";

test("MiMo diary request sends only structured event facts", () => {
  const request = buildMimoDiarySummaryRequest(getFamilyTimelineMockDay("2026-08-09"));
  assert.equal(request.schema_version, MIMO_DIARY_REQUEST_SCHEMA);
  assert.equal(request.date, "2026-08-09");
  assert.ok(request.events.length >= 18);
  assert.deepEqual(Object.keys(request.events[0]).sort(), ["description", "kind", "period", "time"]);
  assert.ok(request.events.some((event) => event.kind === "device" && /冰箱|灯光|空调/.test(event.description)));
  assert.equal(JSON.stringify(request).includes("video_b64"), false);
  assert.equal(JSON.stringify(request).includes("image"), false);
});

test("MiMo diary request absorbs newly received live family events", () => {
  const day = getFamilyTimelineMockDay("2026-08-09");
  const before = buildMimoDiarySummaryRequest(day);
  const after = buildMimoDiarySummaryRequest(day, [{
    id: "live:1",
    kind: "assessment",
    title: "家中端新增一条主动关怀",
    timestampMs: new Date(2026, 7, 9, 18, 20).getTime(),
  }]);
  assert.equal(after.events.length, before.events.length + 1);
  assert.ok(after.events.some((event) => event.description === "家中端新增一条主动关怀"));
});

test("MiMo diary request excludes live events from another selected day", () => {
  const day = getFamilyTimelineMockDay("2026-08-08");
  const before = buildMimoDiarySummaryRequest(day);
  const after = buildMimoDiarySummaryRequest(day, [{
    id: "live:foreign-day",
    kind: "assessment",
    title: "8 月 9 日的新关怀不能写进 8 月 8 日",
    timestampMs: new Date(2026, 7, 9, 18, 20).getTime(),
  }]);
  assert.deepEqual(after, before);
});

test("frontend accepts only the strict live MiMo response", () => {
  const payload = {
    schema_version: MIMO_DIARY_RESPONSE_SCHEMA,
    date: "2026-08-09",
    headline: "今天从起身开始，上午完成一次回应",
    summary: "07:12 记录到从床边起身；10:08 本人回应正在听广播。",
    highlights: [{ time: "10:08", text: "本人回应正在听广播" }],
    care_note: "一次主动关怀已收到回应。",
    uncertainty: "low",
    source: "mimo",
    model: "mimo-v2.5",
    generated_at_ms: 123456,
    input_event_count: 20,
    latency_ms: 812.3,
    attempts: 1,
  };
  const result = parseMimoDiarySummaryResponse(payload);
  assert.equal(result.source, "mimo");
  assert.equal(result.highlights[0].time, "10:08");
  assert.throws(
    () => parseMimoDiarySummaryResponse({ ...payload, diagnosis: "invented" }),
    /字段不符合合同/,
  );
  assert.throws(
    () => parseMimoDiarySummaryResponse({ ...payload, source: "mock" }),
    /来源或版本无效/,
  );
});
