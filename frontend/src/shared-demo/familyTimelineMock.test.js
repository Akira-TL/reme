import assert from "node:assert/strict";
import test from "node:test";
import {
  FAMILY_TIMELINE_MOCK_END_DATE,
  FAMILY_TIMELINE_MOCK_EVENTS,
  FAMILY_TIMELINE_MOCK_START_DATE,
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
  for (const date of dates) {
    assert.ok(FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => event.dateKey === date).length >= 2);
  }
});

test("every mock card is unmistakably labeled and avoids unsupported certainty", () => {
  for (const event of FAMILY_TIMELINE_MOCK_EVENTS) {
    assert.equal(event.source, "mock_fixture");
    assert.equal(event.assessmentSource, "mock");
    assert.match(event.label, /Mock/);
    assert.ok(["low", "medium", "high", "unknown"].includes(event.uncertainty));
    assert.doesNotMatch(event.title, /确诊|保证安全|已经睡着|已经吃完/);
  }
});

test("mock range detection is inclusive and bounded", () => {
  assert.equal(isFamilyTimelineMockDate("2026-08-03"), false);
  assert.equal(isFamilyTimelineMockDate("2026-08-04"), true);
  assert.equal(isFamilyTimelineMockDate("2026-08-11"), true);
  assert.equal(isFamilyTimelineMockDate("2026-08-12"), false);
});
