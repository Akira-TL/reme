import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmLocalMonitorCommand,
  executeMonitorCommand,
  switchAndCommitMonitorScene,
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
  }, 2_000);
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
  }), {}, 2_000);
  assert.deepEqual(rejected, {
    phase: "rejected",
    code: "local_confirmation_not_required",
  });
});

test("等待本机确认期间过期的命令不会执行", async () => {
  let called = false;
  const result = await confirmLocalMonitorCommand(envelope("start_capture"), {
    startCapture() {
      called = true;
      return true;
    },
  }, 10_001);
  assert.equal(called, false);
  assert.deepEqual(result, { phase: "rejected", code: "command_expired" });
});

test("等待本机确认后 revision 与安全状态变化会拒绝且不启动媒体", async () => {
  let currentContext = context;
  let called = false;
  const generation = 7;
  const pending = await executeMonitorCommand(envelope("start_capture"), {
    getContext: () => currentContext,
    getControlGeneration: () => generation,
    expectedControlGeneration: generation,
    now: () => 2_000,
    actions: {},
  });
  assert.equal(pending.phase, "awaiting_local_confirmation");

  currentContext = {
    ...context,
    stateRevision: context.stateRevision + 1,
    activeSafetyEvent: true,
  };
  const result = await confirmLocalMonitorCommand(pending.pendingCommand, {
    startCapture() {
      called = true;
      return true;
    },
  }, {
    getContext: () => currentContext,
    getControlGeneration: () => generation,
    expectedControlGeneration: generation,
    now: () => 2_001,
  });

  assert.equal(called, false);
  assert.deepEqual(result, { phase: "rejected", code: "stale_state_revision" });
});

test("动作调用前会再次复验 safety 与 control generation", async () => {
  let contextReads = 0;
  let called = false;
  const result = await executeMonitorCommand(
    envelope("select_scene", { scene_id: "kitchen" }),
    {
      getContext() {
        contextReads += 1;
        return contextReads === 1
          ? context
          : { ...context, activeSafetyEvent: true };
      },
      getControlGeneration: () => 3,
      expectedControlGeneration: 3,
      now: () => 2_000,
      actions: {
        selectScene() {
          called = true;
          return true;
        },
      },
    },
  );

  assert.equal(called, false);
  assert.deepEqual(result, { phase: "rejected", code: "safety_event_active" });
});

test("本机确认沿用入队 generation，新控制租约不能执行旧命令", async () => {
  let called = false;
  const result = await confirmLocalMonitorCommand(envelope("start_capture"), {
    startCapture() {
      called = true;
      return true;
    },
  }, {
    getContext: () => context,
    getControlGeneration: () => 9,
    expectedControlGeneration: 8,
    now: () => 2_000,
  });

  assert.equal(called, false);
  assert.deepEqual(result, { phase: "rejected", code: "controller_lease_ended" });
});

test("后端 switchScene 拒绝时保持旧场景", async () => {
  let currentScene = "living";
  const result = await switchAndCommitMonitorScene({
    nextScene: "kitchen",
    switchScene: () => Promise.reject(new Error("backend unavailable")),
    commitScene: (nextScene) => {
      currentScene = nextScene;
    },
  });

  assert.equal(currentScene, "living");
  assert.deepEqual(result, {
    ok: false,
    code: "scene_switch_failed",
    detail: "backend unavailable",
  });
});

test("后端切换成功后即使 authority 过时也提交实际场景但不假报 applied", async () => {
  let currentScene = "living";
  let currentContext = context;
  const result = await executeMonitorCommand(
    envelope("select_scene", { scene_id: "kitchen" }),
    {
      getContext: () => currentContext,
      now: () => 2_000,
      actions: {
        selectScene(nextScene, execution) {
          return switchAndCommitMonitorScene({
            nextScene,
            execution,
            async switchScene() {
              currentContext = {
                ...currentContext,
                stateRevision: currentContext.stateRevision + 1,
              };
              return { ok: true };
            },
            commitScene(committedScene) {
              currentScene = committedScene;
            },
          });
        },
      },
    },
  );

  assert.equal(currentScene, "kitchen");
  assert.deepEqual(result, {
    phase: "rejected",
    code: "stale_state_revision",
    authoritativeStateCommitted: true,
  });
});
