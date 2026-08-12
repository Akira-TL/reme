import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCalendarMonth,
  buildWeekDays,
  dateKeyFromTimestamp,
  filterTimelineEventsByDate,
  shiftDateKey,
  shiftMonthKey,
  timelineDateHeading,
  timelineDateLongHeading,
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
  assert.equal(timelineDateLongHeading(todayKey), "2026年8月9日 · 星期日");
  assert.equal(timelineDateLongHeading("not-a-date"), "选择日期");
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

test("month calendar exposes earlier dates and disables only future dates", () => {
  const now = new Date(2026, 7, 11, 12, 0).getTime();
  const calendar = buildCalendarMonth(
    "2026-08",
    "2026-08-11",
    now,
    ["2026-08-04", "2026-08-11"],
  );

  assert.equal(calendar.label, "2026年8月");
  assert.deepEqual(calendar.weekdays, ["一", "二", "三", "四", "五", "六", "日"]);
  assert.equal(calendar.days.length, 42);
  assert.equal(calendar.days[0].key, "2026-07-27");
  assert.equal(calendar.days.at(-1).key, "2026-09-06");
  assert.equal(calendar.days.find((day) => day.key === "2026-08-11")?.selected, true);
  assert.equal(calendar.days.find((day) => day.key === "2026-08-04")?.marked, true);
  assert.equal(calendar.days.find((day) => day.key === "2026-07-31")?.disabled, false);
  assert.equal(calendar.days.find((day) => day.key === "2026-08-12")?.disabled, true);
  assert.equal(calendar.canGoNext, false);
});

test("month navigation crosses years and can return toward the real current month", () => {
  assert.equal(shiftMonthKey("2026-08", -1), "2026-07");
  assert.equal(shiftMonthKey("2026-01", -1), "2025-12");
  assert.equal(shiftMonthKey("2025-12", 1), "2026-01");
  assert.equal(shiftMonthKey("not-a-month", 1), "");

  const now = new Date(2026, 7, 11, 12, 0).getTime();
  assert.equal(buildCalendarMonth("2026-07", "2026-07-18", now).canGoNext, true);
});
