import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeekDays,
  dateKeyFromTimestamp,
  filterTimelineEventsByDate,
  shiftDateKey,
  timelineDateHeading,
} from "./timelineDates.js";

test("week model starts on Monday and disables future days", () => {
  const now = new Date(2026, 7, 9, 12, 0).getTime();
  const todayKey = dateKeyFromTimestamp(now);
  const days = buildWeekDays(todayKey, now);

  assert.deepEqual(days.map((day) => day.weekday), ["一", "二", "三", "四", "五", "六", "日"]);
  assert.equal(days[6].today, true);
  assert.equal(days.some((day) => day.disabled), false);
  assert.equal(shiftDateKey(todayKey, -7), "2026-08-02");
  assert.equal(timelineDateHeading(todayKey, now), "今天 · 星期日");
});

test("date filtering accepts projected events with timestamps", () => {
  const today = new Date(2026, 7, 9, 10, 0).getTime();
  const events = [
    { id: "today", timestampMs: today },
    { id: "past", timestampMs: new Date(2026, 7, 8, 10, 0).getTime() },
  ];

  assert.deepEqual(filterTimelineEventsByDate(events, "2026-08-09"), [events[0]]);
});

test("a bounded demo range can expose dates after the local today", () => {
  const now = new Date(2026, 7, 9, 12, 0).getTime();
  const days = buildWeekDays("2026-08-11", now, "2026-08-11");

  assert.equal(days.find((day) => day.key === "2026-08-10")?.disabled, false);
  assert.equal(days.find((day) => day.key === "2026-08-11")?.disabled, false);
  assert.equal(days.find((day) => day.key === "2026-08-12")?.disabled, true);
});
