import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmLocalMonitorCommand,
  executeMonitorCommand,
} from "./monitorCommandExecutor.js";

function envelope(name, payload = {}) {
  return {
    schema_version: "reme-control-command/v1",
    room_session_id: "room-1",
    command_id: `command-${name}`,
    command_sequence: 1,
    issued_at_ms: 1_000,
    expires_at_ms: 10_000,
    expected_state_revision: 4,
    command: { name, ...payload },
  };
}

const context = {
  roomSessionId: "room-1",
  stateRevision: 4,
  sceneId: "living",
  decisionId: "decision-1",
  activeSafetyEvent: false,
  sources: [{ id: "front-camera", disabled_reason: null }],
};

test("普通控制只在底层 Promise 完成后返回 applied", async () => {
  let completed = false;
  const result = await executeMonitorCommand(
    envelope("select_scene", { scene_id: "kitchen" }),
    {
      context,
      now: 2_000,
      actions: {
        async selectScene(sceneId) {
          await Promise.resolve();
          completed = sceneId === "kitchen";
          return { ok: true };
        },
      },
    },
  );
  assert.equal(completed, true);
  assert.deepEqual(result, { phase: "applied", code: "scene_selected" });
});

test("需要浏览器手势的动作先进入确认队列，不直接调用底层 API", async () => {
  let called = false;
  const pending = await executeMonitorCommand(envelope("start_capture"), {
    context,
    now: 2_000,
    actions: { startCapture: () => { called = true; } },
  });
  assert.equal(pending.phase, "awaiting_local_confirmation");
  assert.equal(called, false);

  const applied = await confirmLocalMonitorCommand(pending.pendingCommand, {
    async startCapture() {
      called = true;
      return { ok: true };
    },
  });
  assert.equal(called, true);
  assert.equal(applied.phase, "applied");
});

test("底层真实失败不能 ACK 为 applied", async () => {
  const failed = await executeMonitorCommand(envelope("run_demo_scenario", { scenario: "fall" }), {
    context,
    now: 2_000,
    actions: { runDemoScenario: () => false },
  });
  assert.deepEqual(failed, { phase: "failed", code: "scenario_unavailable" });
});

test("响应动作携带当前 decision_id 且传播 stale 结果", async () => {
  const stale = await executeMonitorCommand(
    envelope("submit_response", { decision_id: "decision-1", response: "safe" }),
    {
      context,
      now: 2_000,
      actions: {
        submitResponse(decisionId, response) {
          assert.equal(decisionId, "decision-1");
          assert.equal(response, "safe");
          return { ok: false, code: "stale_decision" };
        },
      },
    },
  );
  assert.deepEqual(stale, { phase: "rejected", code: "stale_decision" });
});

test("本机拒绝确认不会触发任何采集动作", async () => {
  const rejected = await confirmLocalMonitorCommand(envelope("select_scene", {
    scene_id: "kitchen",
  }), {});
  assert.deepEqual(rejected, {
    phase: "rejected",
    code: "local_confirmation_not_required",
  });
});
