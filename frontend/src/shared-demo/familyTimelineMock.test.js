import assert from "node:assert/strict";
import test from "node:test";
import {
  FAMILY_TIMELINE_MOCK_DAYS,
  FAMILY_TIMELINE_MOCK_DAYPARTS,
  FAMILY_TIMELINE_MOCK_END_DATE,
  FAMILY_TIMELINE_MOCK_EVENTS,
  FAMILY_TIMELINE_MOCK_START_DATE,
  getFamilyTimelineMockDay,
  isFamilyTimelineMockDate,
} from "./familyTimelineMock.js";

test("mock care history covers every date from August 4 through August 11", () => {
  const dates = [...new Set(FAMILY_TIMELINE_MOCK_EVENTS.map((event) => event.dateKey))];
  assert.deepEqual(dates, [
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
    "2026-08-10",
    "2026-08-11",
  ]);
  assert.equal(FAMILY_TIMELINE_MOCK_START_DATE, dates[0]);
  assert.equal(FAMILY_TIMELINE_MOCK_END_DATE, dates.at(-1));
  for (const date of dates) assert.equal(
    FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => event.dateKey === date).length,
    2,
  );
});

test("every mock card is unmistakably labeled and avoids unsupported certainty", () => {
  for (const event of FAMILY_TIMELINE_MOCK_EVENTS) {
    assert.equal(event.source, "mock_fixture");
    assert.equal(event.assessmentSource, "mock");
    assert.match(event.label, /Mock/);
    assert.ok(["low", "medium", "high", "unknown"].includes(event.uncertainty));
    assert.doesNotMatch(event.title, /确诊|保证安全|已经睡着|已经吃完/);
    if (event.linkedResponse) {
      assert.equal(event.linkedResponse.source, "mock_fixture");
      assert.equal(event.linkedResponse.kind, "response");
      assert.ok(event.linkedResponse.timestampMs > event.timestampMs);
    }
  }
});

test("dense mock days expose eighteen moments with two care pauses", () => {
  assert.equal(FAMILY_TIMELINE_MOCK_DAYS.length, 8);
  assert.deepEqual(FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => daypart.id), [
    "early",
    "morning",
    "afternoon",
  ]);

  for (const day of FAMILY_TIMELINE_MOCK_DAYS) {
    assert.equal(day.source, "mock_fixture");
    assert.equal(day.totalCount, 18);
    assert.equal(day.careCount, 2);
    assert.deepEqual(day.sections.map((section) => section.count), [7, 6, 5]);
    assert.equal(day.sections.flatMap((section) => section.entries)
      .filter((entry) => entry.kind === "activity")
      .reduce((total, entry) => total + entry.count, 0), 16);
    assert.equal(day.sections.flatMap((section) => section.entries)
      .filter((entry) => entry.kind === "assessment").length, 2);
    for (const entry of day.sections.flatMap((section) => section.entries)) {
      assert.equal(entry.source, "mock_fixture");
      assert.match(entry.label, /Mock/);
    }
  }
});

test("August 9 keeps the approved care judgment and response thread", () => {
  const day = getFamilyTimelineMockDay("2026-08-09");
  assert.ok(day);
  const care = day.sections.flatMap((section) => section.entries)
    .find((entry) => entry.id === "mock:2026-08-09:1006");
  assert.ok(care);
  assert.equal(care.title, "坐得有些久，已经轻声问候");
  assert.equal(care.linkedResponse?.title, "本人回应：在听广播");
  assert.equal(care.linkedResponse?.id, "mock-response:2026-08-09:1008");
  assert.equal(day.sections.find((section) => section.id === "early")?.entries.length, 6);
  assert.equal(day.sections.find((section) => section.id === "morning")?.entries.length, 4);
  assert.equal(getFamilyTimelineMockDay("2026-08-12"), null);
});

test("mock range detection is inclusive and bounded", () => {
  assert.equal(isFamilyTimelineMockDate("2026-08-03"), false);
  assert.equal(isFamilyTimelineMockDate("2026-08-04"), true);
  assert.equal(isFamilyTimelineMockDate("2026-08-11"), true);
  assert.equal(isFamilyTimelineMockDate("2026-08-12"), false);
});
