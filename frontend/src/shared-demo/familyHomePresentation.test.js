import assert from "node:assert/strict";
import test from "node:test";
import {
  familyGrantBannerCopy,
  familyUnavailableCardCopy,
  familyUpdateCopy,
  latestFamilyUpdateMs,
  selectFamilyHomeEvents,
  shouldShowFamilyStage,
} from "./familyHomePresentation.js";

function readySnapshot(overrides = {}) {
  return {
    timestamp_ms: 1_000,
    state: {
      runtime: { status: "ready" },
      capture: { status: "active" },
      ...overrides,
    },
  };
}

const connectedRelay = Object.freeze({
  connection: "connected",
  monitorOnline: true,
  unavailableReason: null,
  stateStale: false,
});

test("family update prefers the latest family-facing publication", () => {
  assert.equal(latestFamilyUpdateMs(
    { timestamp_ms: 1_000 },
    { published_at_ms: 1_500 },
  ), 1_500);
  assert.match(familyUpdateCopy({
    snapshot: { timestamp_ms: 1_000 },
    familyEvent: { published_at_ms: 1_500 },
    relay: connectedRelay,
    nowMs: 31_500,
  }), /刚刚更新/);
});

test("family update describes unavailable state as the last known update", () => {
  const copy = familyUpdateCopy({
    snapshot: { timestamp_ms: 1_000 },
    familyEvent: null,
    relay: { ...connectedRelay, monitorOnline: false, unavailableReason: "monitor_offline" },
    nowMs: 90_000,
  });
  assert.match(copy, /^上次更新 /);
  assert.doesNotMatch(copy, /Relay|revision|Monitor/);
});

test("family update does not label an older date as today", () => {
  const copy = familyUpdateCopy({
    snapshot: { timestamp_ms: new Date(2026, 7, 10, 20, 15).getTime() },
    familyEvent: null,
    relay: connectedRelay,
    nowMs: new Date(2026, 7, 11, 8, 0).getTime(),
  });
  assert.match(copy, /^8 月 10 日 /);
  assert.doesNotMatch(copy, /^今天 /);
});

test("family unavailable copy distinguishes waiting from a disconnected device", () => {
  assert.deepEqual(familyUnavailableCardCopy("not_published"), {
    title: "正在等待家中设备",
    body: "家中设备尚未提供本次关怀状态，准备好后会自动更新。",
  });
  assert.match(familyUnavailableCardCopy("monitor_offline").body, /暂时离线/);
  assert.doesNotMatch(
    Object.values(familyUnavailableCardCopy("protocol_invalid")).join(" "),
    /Relay|revision|protocol|Monitor/,
  );
});

test("family grant banner exposes only the required countdown and audience", () => {
  assert.equal(familyGrantBannerCopy({ grant: null, viewerCount: 3, nowMs: 1_000 }), null);
  assert.deepEqual(familyGrantBannerCopy({
    grant: { expires_at_ms: 26_000 },
    viewerCount: 3,
    nowMs: 1_000,
    highPrivacyEnabled: false,
  }), {
    title: "清晰画面临时开放",
    expiry: "25 秒后自动关闭",
    audience: "3 个访问端可见",
  });
  assert.equal(familyGrantBannerCopy({
    grant: { expires_at_ms: 26_000 },
    viewerCount: 3,
    nowMs: 1_000,
    highPrivacyEnabled: true,
  }).title, "事件画面授权中，本页已隐藏");
});

test("family stage only appears for reliable live input or an active grant", () => {
  assert.equal(shouldShowFamilyStage({
    snapshot: readySnapshot(), relay: connectedRelay, activeGrant: null,
  }), true);
  assert.equal(shouldShowFamilyStage({
    snapshot: readySnapshot(),
    relay: { ...connectedRelay, unavailableReason: "stale" },
    activeGrant: null,
  }), false);
  assert.equal(shouldShowFamilyStage({
    snapshot: readySnapshot({ capture: { status: "idle" } }),
    relay: connectedRelay,
    activeGrant: null,
  }), false);
  assert.equal(shouldShowFamilyStage({
    snapshot: null,
    relay: { ...connectedRelay, monitorOnline: false },
    activeGrant: { grant_id: "grant-1" },
  }), true);
});

test("family home recent updates exclude demo diagnostics", () => {
  const events = [
    { id: "debug", source: "demo_state", title: "本地运行时离线" },
    { id: "care", source: "family_event", title: "今天需要家属协助" },
    { id: "ack", source: "command_ack", title: "家属已经确认收到行动卡" },
    { id: "empty", source: "family_event", title: "" },
  ];
  assert.deepEqual(
    selectFamilyHomeEvents(events).map((event) => event.id),
    ["care", "ack"],
  );
  assert.deepEqual(selectFamilyHomeEvents(events, 1).map((event) => event.id), ["care"]);
});
