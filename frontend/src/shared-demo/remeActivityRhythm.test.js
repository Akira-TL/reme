import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRemeActivityRhythm,
  formatRemeTime,
  remeDayPosition,
} from "./remeActivityRhythm.js";

const DATE_KEY = "2026-08-11";

function timestamp(time) {
  return Date.parse(`${DATE_KEY}T${time}:00+08:00`);
}

test("Reme activity rhythm uses fixed Shanghai time and exact day positions", () => {
  const at0810 = timestamp("08:10");
  assert.equal(formatRemeTime(at0810), "08:10");
  assert.equal(remeDayPosition(at0810, DATE_KEY), 34.028);
  assert.equal(remeDayPosition(timestamp("23:59"), DATE_KEY), 99.931);
});

test("Reme recording rhythm only plots clips with real playback URLs", () => {
  const day = {
    dateKey: DATE_KEY,
    sourceMode: "mock",
  };
  const rhythm = buildRemeActivityRhythm(day, [
    {
      id: "clip-1",
      startedAtMs: timestamp("08:10"),
      endedAtMs: timestamp("08:11"),
      sceneLabel: "客厅录像",
      playbackUrl: "blob:clip-1",
    },
    {
      id: "metadata-only",
      startedAtMs: timestamp("11:30"),
      endedAtMs: timestamp("11:31"),
      sceneLabel: "只有元数据",
      playbackUrl: "",
    },
  ]);
  assert.equal(rhythm.sourceLabel, "本机录像");
  assert.match(rhythm.sourceNote, /不经 Relay 或 MiMo/);
  assert.equal(rhythm.coverageLabel, "本机可回看");
  assert.equal(rhythm.recordingLabel, "1 段录像");
  assert.equal(rhythm.markers[0].timeLabel, "08:10");
  assert.equal(rhythm.markers[0].endTimeLabel, "08:11");
  assert.equal(rhythm.markers[0].playbackUrl, "blob:clip-1");
  assert.ok(rhythm.markers[0].width > 0);
});

test("Reme recording rhythm does not invent out-of-day or missing clips", () => {
  const day = {
    dateKey: DATE_KEY,
    sourceMode: "live",
  };
  const rhythm = buildRemeActivityRhythm(day, [{
    id: "outside",
    startedAtMs: Date.parse("2026-08-12T00:00:00+08:00"),
    endedAtMs: Date.parse("2026-08-12T00:00:10+08:00"),
    sceneLabel: "不属于当天",
    playbackUrl: "blob:outside",
  }]);
  assert.equal(rhythm.sourceLabel, "本机录像");
  assert.equal(rhythm.coverageLabel, "暂无录像");
  assert.equal(rhythm.recordingLabel, "0 段录像");
  assert.deepEqual(rhythm.markers, []);
});

test("Reme recording rhythm labels packaged mock video without presenting it as local history", () => {
  const day = { dateKey: DATE_KEY, sourceMode: "mock" };
  const rhythm = buildRemeActivityRhythm(day, [{
    id: "mock-clip",
    startedAtMs: timestamp("11:36"),
    endedAtMs: timestamp("11:37"),
    sceneLabel: "厨房时光",
    title: "餐桌前的厨房时光",
    playbackUrl: "/mock-recordings/kitchen-sharing.mp4",
    source: "mock_fixture",
    isDemo: true,
  }]);
  assert.equal(rhythm.sourceLabel, "演示录像");
  assert.equal(rhythm.playbackLabel, "演示素材 · 可播放");
  assert.equal(rhythm.recordingLabel, "1 段演示录像");
  assert.equal(rhythm.coverageLabel, "演示可回看");
  assert.equal(rhythm.hasDemoRecordings, true);
  assert.equal(rhythm.markers[0].isDemo, true);
  assert.equal(rhythm.markers[0].title, "餐桌前的厨房时光");
  assert.match(rhythm.sourceNote, /不代表真实家庭记录/);
});
