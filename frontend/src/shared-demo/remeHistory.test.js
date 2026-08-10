import assert from "node:assert/strict";
import test from "node:test";

import { parseViewerMessage } from "./protocol.js";
import {
  parseRemeDateIndex,
  parseRemeDiarySummaryState,
  parseRemeTimelineDay,
  projectRemeDiarySummary,
  projectRemeTimelineDay,
} from "./remeHistory.js";
import { createViewerState, reduceViewerState } from "./viewerState.js";

const DATASET = "reme-aug-2026-demo-v1";

function source(type = "pose_observation") {
  return { type, mode: "mock_fixture" };
}

function dayPayload() {
  return {
    schema_version: "reme-timeline-day-state/v1",
    dataset_id: DATASET,
    mode: "mock_fixture",
    date: "2026-08-09",
    timezone: "Asia/Shanghai",
    revision: 3,
    updated_at_ms: 1_786_334_000_000,
    status: "ready",
    coverage: {
      status: "complete",
      start_at_ms: 1_786_291_200_000,
      end_at_ms: 1_786_377_599_999,
      observed_hours: 24,
      missing_intervals: [],
    },
    counts: { total: 4, activity: 2, device: 1, care: 1 },
    items: [
      {
        event_id: "evt-activity",
        kind: "activity",
        occurred_at_ms: 1_786_330_920_000,
        recorded_at_ms: 1_786_330_921_000,
        room: "kitchen",
        fact_type: "posture_activity",
        fact: "灶台与水槽之间出现站立和短距离移动",
        detail: "只描述姿态和空间变化。",
        occurrence_count: 2,
        related: [],
        source: source(),
      },
      {
        event_id: "evt-device",
        kind: "device",
        occurred_at_ms: 1_786_329_720_000,
        recorded_at_ms: 1_786_329_720_400,
        room: "kitchen",
        device: {
          device_id: "demo-fridge-1",
          device_type: "refrigerator",
          capability: "inventory_event",
        },
        action: "items_removed",
        value: { items: ["番茄", "鸡蛋"] },
        fact: "冰箱取出番茄和鸡蛋",
        occurrence_count: 1,
        source: { ...source("smart_home_event"), adapter: "demo_fixture" },
      },
      {
        event_id: "care-20260809-1136",
        kind: "care_thread",
        thread_id: "thread-20260809-1136",
        occurred_at_ms: 1_786_332_960_000,
        recorded_at_ms: 1_786_333_200_000,
        status: "delivered",
        assessment: {
          title: "午饭准备形成多源记录，MiMo 邀请本人确认是否分享",
          basis: "冰箱、烟机/灶具和匿名姿态形成多源记录；菜名只采用本人确认。",
          suggested_action: "先询问本人是否愿意分享",
          uncertainty: "low",
          source: "mimo",
          baseline: { version: "mock-baseline-v1", comparison_period: "same_daypart", sample_count: 7 },
          visual_context: { sent_to_mimo: false, type: null, sample_count: null },
        },
        check_in: { asked_at_ms: 1_786_332_960_000, prompt: "午饭做好了吗？要不要告诉女儿？" },
        response: {
          received_at_ms: 1_786_333_140_000,
          status: "received",
          summary: "本人确认菜品并同意分享给女儿。",
          consent_scope: "family_material_share",
        },
        material: {
          material_id: "material-lunch",
          status: "ready",
          label: "今日午饭 · 家庭分享",
          summary: "本人确认今天准备了两道菜，并同意与女儿分享。",
          facts: [{ event_id: "evt-device", text: "10:42 冰箱取出番茄和鸡蛋" }],
          attachment: {
            type: "skeleton_clip",
            status: "metadata_only",
            duration_seconds: 18,
            privacy_mode: "skeleton",
            asset_id: null,
          },
          generated_by: "mimo",
        },
        delivery: {
          recipient_label: "女儿",
          status: "mock_delivered",
          delivered_at_ms: 1_786_333_200_000,
          transport_receipt_id: null,
        },
        source: { mode: "mock_fixture" },
      },
    ],
  };
}

test("Reme history parses Backend snapshots and preserves stable counts", () => {
  const parsed = parseRemeTimelineDay(dayPayload());
  const projected = projectRemeTimelineDay(parsed);

  assert.equal(projected.dateKey, "2026-08-09");
  assert.equal(projected.totalCount, 4);
  assert.equal(projected.activityCount, 2);
  assert.equal(projected.deviceCount, 1);
  assert.equal(projected.careCount, 1);
  const care = projected.sections.flatMap((section) => section.entries)
    .find((entry) => entry.kind === "assessment");
  assert.equal(care.familyMaterial.attachment.durationSeconds, 18);
  assert.equal(care.familyMaterial.deliveryStatus, "Mock 已送达");
  assert.equal(care.familyMaterial.recipient, "女儿");
});

test("P0 history refuses fake real delivery and non-metadata assets", () => {
  const delivered = dayPayload();
  delivered.items[2].delivery.status = "delivered";
  assert.throws(() => parseRemeTimelineDay(delivered), /mock_delivered/);

  const asset = dayPayload();
  asset.items[2].material.attachment.asset_id = "video-1";
  assert.throws(() => parseRemeTimelineDay(asset), /metadata_only/);
});

test("date index and Backend diary summary use the frozen P0 schemas", () => {
  const index = parseRemeDateIndex({
    schema_version: "reme-date-index/v1",
    dataset_id: DATASET,
    mode: "mock_fixture",
    timezone: "Asia/Shanghai",
    revision: 1,
    dates: [{ date: "2026-08-09", status: "ready", timeline_revision: 3, summary_revision: 2 }],
  });
  assert.equal(index.dates[0].summary_revision, 2);

  const state = parseRemeDiarySummaryState({
    schema_version: "reme-diary-summary-state/v1",
    dataset_id: DATASET,
    mode: "mock_fixture",
    date: "2026-08-09",
    revision: 2,
    input_timeline_revision: 3,
    status: "ready",
    updated_at_ms: 1_786_333_200_000,
    error_code: null,
    summary: {
      headline: "上午完成午饭准备与一次家庭分享",
      summary: "结构化记录形成一次家庭分享。",
      highlights: [{ time: "10:42", text: "冰箱结构化事件" }],
      care_note: "一次主动关怀已收到回应。",
      uncertainty: "medium",
      source: "mimo",
      model: "mimo-v2.5",
      generated_at_ms: 1_786_333_197_000,
      input_event_count: 4,
      latency_ms: 9080.4,
      attempts: 1,
    },
  });
  const summary = projectRemeDiarySummary(state);
  assert.equal(summary.schema_version, "reme-diary-summary-state/v1");
  assert.equal(summary.headline, "上午完成午饭准备与一次家庭分享");
});

test("viewer v2 accepts reme_day_revision independently from room authority", () => {
  const wire = {
    type: "reme_day_revision",
    dataset_id: DATASET,
    date: "2026-08-09",
    timeline_revision: 4,
    summary_revision: 3,
    summary_status: "ready",
  };
  const parsed = parseViewerMessage(JSON.stringify(wire));
  assert.equal(parsed.kind, "reme_day_revision");
  const state = reduceViewerState(createViewerState(), {
    type: "message",
    message: parsed,
    receivedAtMs: Date.now(),
  });
  assert.deepEqual(state.remeDayRevisions["2026-08-09"], wire);
});
