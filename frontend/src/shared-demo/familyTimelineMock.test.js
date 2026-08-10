import assert from "node:assert/strict";
import test from "node:test";
import {
  FAMILY_TIMELINE_DISPLAY_DAYS,
  FAMILY_TIMELINE_DISPLAY_END_DATE,
  FAMILY_TIMELINE_MOCK_DAYS,
  FAMILY_TIMELINE_MOCK_DAYPARTS,
  FAMILY_TIMELINE_MOCK_END_DATE,
  FAMILY_TIMELINE_MOCK_EVENTS,
  FAMILY_TIMELINE_REALTIME_CUTOFF,
  FAMILY_TIMELINE_MOCK_START_DATE,
  getFamilyTimelineMockDay,
  isFamilyTimelineDisplayDate,
  isFamilyTimelineMockDate,
} from "./familyTimelineMock.js";

test("mock care history stops after the morning of August 10", () => {
  const dates = [...new Set(FAMILY_TIMELINE_MOCK_EVENTS.map((event) => event.dateKey))];
  assert.deepEqual(dates, [
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
    "2026-08-10",
  ]);
  assert.equal(FAMILY_TIMELINE_MOCK_START_DATE, dates[0]);
  assert.equal(FAMILY_TIMELINE_MOCK_END_DATE, dates.at(-1));
  for (const date of dates) {
    const count = FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => event.dateKey === date).length;
    assert.ok(count >= 1 && count <= 3);
  }
  const august10Events = FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => event.dateKey === "2026-08-10");
  assert.ok(august10Events.every((event) => new Date(event.timestampMs).getHours() < 12));
});

test("every mock care card is explicit, bounded, and privacy safe", () => {
  for (const event of FAMILY_TIMELINE_MOCK_EVENTS) {
    assert.equal(event.source, "mock_fixture");
    assert.equal(event.assessmentSource, "mock");
    assert.match(event.label, /Mock/);
    assert.doesNotMatch(event.label, /判词/);
    assert.ok(["low", "medium", "high", "unknown"].includes(event.uncertainty));
    assert.doesNotMatch(event.title, /确诊|保证安全|已经睡着|已经吃完/);
    if (event.linkedResponse) {
      assert.equal(event.linkedResponse.source, "mock_fixture");
      assert.equal(event.linkedResponse.kind, "response");
      assert.ok(event.linkedResponse.timestampMs > event.timestampMs);
      assert.equal(event.checkIn?.source, "mimo_mock");
      assert.ok(event.checkIn?.prompt);
      assert.equal(event.familyMaterial?.source, "mock_fixture");
      assert.equal(event.familyMaterial?.dialogueTurns, 2);
      assert.equal(event.familyMaterial?.attachment?.privacyMode, "skeleton");
      assert.ok(event.familyMaterial?.attachment?.durationSeconds >= 12);
      assert.ok(event.familyMaterial?.deliveredAtMs > event.linkedResponse.timestampMs);
      assert.ok(event.familyMaterial?.recipient);
    } else {
      assert.equal(event.checkIn, null);
      assert.equal(event.familyMaterial, null);
    }
  }
});

test("full mock days cover 24 hours and August 10 stops at noon", () => {
  assert.equal(FAMILY_TIMELINE_MOCK_DAYS.length, 7);
  assert.deepEqual(FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => daypart.id), [
    "night",
    "early",
    "morning",
    "afternoon",
    "evening",
  ]);

  const totals = new Set();
  const daypartHours = {
    night: [0, 6],
    early: [6, 10],
    morning: [10, 12],
    afternoon: [12, 18],
    evening: [18, 24],
  };
  for (const day of FAMILY_TIMELINE_MOCK_DAYS) {
    assert.equal(day.source, "mock_fixture");
    if (day.dateKey < "2026-08-10") {
      assert.equal(day.sourceMode, "mock");
      assert.equal(day.coverageHours, 24);
      assert.ok(day.totalCount >= 27);
      assert.ok(day.activityCount >= 11);
      assert.ok(day.deviceCount >= 13);
      assert.ok(day.careCount >= 2);
      assert.ok(day.sections.every((section) => section.count > 0));
    } else {
      assert.equal(day.sourceMode, "hybrid");
      assert.equal(day.coverageHours, 12);
      assert.ok(day.totalCount > 0);
      assert.equal(day.sections.find((section) => section.id === "afternoon")?.count, 0);
      assert.equal(day.sections.find((section) => section.id === "evening")?.count, 0);
    }
    assert.equal(day.totalCount, day.activityCount + day.deviceCount + day.careCount);
    assert.equal(day.sections.length, 5);
    totals.add(day.totalCount);

    for (const entry of day.sections.flatMap((section) => section.entries)) {
      assert.equal(entry.source, "mock_fixture");
      assert.match(entry.label, /Mock/);
      const section = day.sections.find((candidate) => candidate.entries.includes(entry));
      const [startHour, endHour] = daypartHours[section.id];
      const hour = new Date(entry.timestampMs).getHours();
      assert.ok(hour >= startHour && hour < endHour, `${entry.id} should be inside ${section.id}`);
      if (entry.kind === "device") {
        assert.equal(entry.sourceChannel, "mock_device_event");
        assert.match(entry.label, /全屋设备/);
      }
    }
  }
  assert.ok(totals.size >= 5, "daily counts should not look copied from one template");
});

test("the bounded mock story includes sleep, bathing, movement, and Xiaomi whole-home events", () => {
  const titles = FAMILY_TIMELINE_MOCK_DAYS
    .flatMap((day) => day.sections)
    .flatMap((section) => section.entries)
    .map((entry) => entry.title)
    .join("\n");
  for (const expected of [
    /就寝/,
    /沐浴/,
    /外出|离家/,
    /回家/,
    /空调/,
    /灯光/,
    /音响/,
    /冰箱/,
    /做饭/,
  ]) assert.match(titles, expected);
});

test("August 9 keeps the approved care thread and adds the cooking share-to-daughter case", () => {
  const day = getFamilyTimelineMockDay("2026-08-09");
  assert.ok(day);
  const entries = day.sections.flatMap((section) => section.entries);
  const care = entries.find((entry) => entry.id === "mock:2026-08-09:1006");
  assert.equal(care?.title, "坐得有些久，已经轻声问候");
  assert.equal(care?.linkedResponse?.title, "本人回应：在听广播");

  const cookingShare = entries.find((entry) => entry.id === "mock:2026-08-09:1136");
  assert.ok(cookingShare);
  assert.match(cookingShare.checkIn?.prompt || "", /女儿/);
  assert.match(cookingShare.linkedResponse?.title || "", /番茄炒蛋和蒜蓉生菜/);
  assert.equal(cookingShare.familyMaterial?.label, "今日午饭 · 家庭分享");
  assert.equal(cookingShare.familyMaterial?.recipient, "女儿");
  assert.equal(cookingShare.familyMaterial?.deliveryStatus, "已发给女儿");
  assert.equal(cookingShare.familyMaterial?.attachment?.durationSeconds, 18);
  assert.equal(cookingShare.familyMaterial?.facts.length, 3);
  assert.equal(getFamilyTimelineMockDay("2026-08-12"), null);
});

test("mock range detection is inclusive and bounded", () => {
  assert.equal(isFamilyTimelineMockDate("2026-08-03"), false);
  assert.equal(isFamilyTimelineMockDate("2026-08-04"), true);
  assert.equal(isFamilyTimelineMockDate("2026-08-10"), true);
  assert.equal(isFamilyTimelineMockDate("2026-08-11"), false);
  assert.equal(isFamilyTimelineMockDate("2026-08-12"), false);
});

test("the eight display dates expose the Mock to realtime source boundary", () => {
  assert.equal(FAMILY_TIMELINE_REALTIME_CUTOFF, "2026-08-10T12:00:00+08:00");
  assert.equal(FAMILY_TIMELINE_DISPLAY_END_DATE, "2026-08-11");
  assert.deepEqual(
    FAMILY_TIMELINE_DISPLAY_DAYS.map(({ dateKey, sourceMode }) => [dateKey, sourceMode]),
    [
      ["2026-08-04", "mock"],
      ["2026-08-05", "mock"],
      ["2026-08-06", "mock"],
      ["2026-08-07", "mock"],
      ["2026-08-08", "mock"],
      ["2026-08-09", "mock"],
      ["2026-08-10", "hybrid"],
      ["2026-08-11", "live"],
    ],
  );
  assert.equal(isFamilyTimelineDisplayDate("2026-08-03"), false);
  assert.equal(isFamilyTimelineDisplayDate("2026-08-10"), true);
  assert.equal(isFamilyTimelineDisplayDate("2026-08-11"), true);
  assert.equal(isFamilyTimelineDisplayDate("2026-08-12"), false);
  assert.equal(getFamilyTimelineMockDay("2026-08-11"), null);
});
