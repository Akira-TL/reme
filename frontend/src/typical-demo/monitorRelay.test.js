import assert from "node:assert/strict";
import test from "node:test";
import {
  claimMonitor,
  containsForbiddenRawMedia,
  createDemoStateEnvelope,
  createExactControlAck,
  createLatestPublicationQueue,
  createMonitorRelayClient,
  createPoseFrame,
  createSessionClaimStore,
  resolveMonitorRelayEndpoints,
} from "./monitorRelay.js";

const TOKEN = "a".repeat(64);

function demoState(revision, runtimeSessionId = "runtime-1") {
  return createDemoStateEnvelope({
    roomSessionId: "room-1",
    runtimeSessionId,
    stateRevision: revision,
    timestampMs: 2_000 + revision,
    state: {
      scene_id: "living",
      source_generation: 0,
      capture: {
        status: "idle",
        source_id: null,
        source_kind: null,
        remote_video: "unavailable",
        error: null,
      },
      runtime: { status: "offline", capability: "unavailable", detail: null },
      care: {
        phase: "idle",
        decision_id: null,
        consent: "none",
        alarm_authoritative: false,
        message: null,
      },
      media_grant: null,
    },
  });
}

function pose(sequence, runtimeSessionId = "runtime-1") {
  return createPoseFrame({
    roomSessionId: "room-1",
    runtimeSessionId,
    frameSequence: sequence,
    timestampMs: 3_000 + sequence,
    sourceWidth: 1280,
    sourceHeight: 720,
    landmarks: Array.from({ length: 17 }, (_, index) => ({
      x: index / 20,
      y: index / 20,
      score: 0.9,
    })),
  });
}

function command(name = "start_capture", overrides = {}) {
  return {
    schema_version: "reme-control-command/v1",
    room_session_id: "room-1",
    command_id: "command-1",
    command_sequence: 1,
    issued_at_ms: 1_000,
    expires_at_ms: 20_000,
    expected_state_revision: 0,
    command: { name },
    ...overrides,
  };
}

class FakeSocket {
  static instances = [];

  constructor(url, protocols) {
    this.url = url;
    this.protocols = protocols;
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.({ currentTarget: this });
  }

  message(value) {
    this.onmessage?.({ currentTarget: this, data: JSON.stringify(value) });
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.onclose?.({ currentTarget: this });
  }
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    values,
  };
}

function fakeTimers() {
  const intervals = new Map();
  const timeouts = new Map();
  let nextId = 1;
  return {
    setInterval(callback, milliseconds) {
      const id = nextId++;
      intervals.set(id, { callback, milliseconds });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      timeouts.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout: (id) => timeouts.delete(id),
    runIntervals() {
      for (const { callback } of [...intervals.values()]) callback();
    },
    intervals,
    timeouts,
  };
}

test("Relay endpoints 固定映射到无密码 claim 和 monitor WebSocket", () => {
  assert.deepEqual(resolveMonitorRelayEndpoints("https://relay.example/demo/"), {
    claimUrl: "https://relay.example/demo/api/monitor/claim",
    monitorWsUrl: "wss://relay.example/demo/ws/monitor",
  });
  assert.throws(() => resolveMonitorRelayEndpoints("ftp://relay.example"));
});

test("producer claim 使用无 body POST，token 只保存到 sessionStorage 适配器", async () => {
  let request = null;
  const claim = await claimMonitor("http://127.0.0.1:8787", async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        room_name: "shared-live-demo",
        room_session_id: "room-1",
        producer_token: TOKEN,
        expires_at_ms: 31_000,
      }),
    };
  });
  assert.equal(request.options.method, "POST");
  assert.equal(Object.hasOwn(request.options, "body"), false);
  assert.equal(claim.producer_token, TOKEN);

  const storage = memoryStorage();
  const store = createSessionClaimStore(storage);
  store.save(claim);
  assert.equal(store.load("http://127.0.0.1:8787", 1_000).room_session_id, "room-1");
  assert.match([...storage.values.values()][0], /producer_token/);
  assert.equal(store.load("http://127.0.0.1:8787", 32_000), null);
});

test("control_ack 与 Relay exact shape 对齐且 applied 必须带 revision", () => {
  const ack = createExactControlAck({
    roomSessionId: "room-1",
    commandId: "command-1",
    phase: "awaiting_local_confirmation",
    timestampMs: 2_000,
    stateRevision: null,
    reason: "local_confirmation_required",
  });
  assert.deepEqual(Object.keys(ack).sort(), [
    "command_id",
    "phase",
    "reason",
    "room_session_id",
    "state_revision",
    "timestamp_ms",
    "type",
  ]);
  assert.equal(Object.hasOwn(ack, "runtime_session_id"), false);
  assert.equal(Object.hasOwn(ack, "code"), false);
  assert.throws(() => createExactControlAck({
    roomSessionId: "room-1",
    commandId: "command-1",
    phase: "applied",
  }));
});

test("state 与 17 点 pose 各自只有一个 in-flight 和一个 latest slot", () => {
  const sent = [];
  const queue = createLatestPublicationQueue((value) => sent.push(value));
  queue.reset("room-1", "runtime-1");
  assert.equal(queue.offerState(demoState(1)), true);
  assert.equal(queue.offerState(demoState(2)), true);
  assert.equal(queue.offerState(demoState(3)), true);
  assert.deepEqual(sent.map((value) => value.state_revision), [1]);

  assert.equal(queue.offerPose(pose(1)), true);
  assert.equal(queue.offerPose(pose(2)), true);
  assert.equal(sent.length, 1);
  queue.acceptState(1);
  assert.deepEqual(sent.map((value) => value.state_revision), [1, 3]);
  queue.acceptState(3);
  assert.equal(sent[2].frame_sequence, 2);
  assert.equal(queue.snapshot().latestPoseSequence, 2);

  queue.acceptPose(2);
  assert.equal(queue.offerState(demoState(4, "runtime-2")), true);
  assert.equal(queue.offerPose(pose(3, "runtime-1")), false);
  queue.acceptState(4);
  assert.equal(queue.offerPose(pose(1, "runtime-2")), true);
  assert.equal(queue.snapshot().runtimeSessionId, "runtime-2");
});

test("Relay 永不接受 JPEG、Blob 或 data URL 进入 JSON 通道", () => {
  assert.equal(containsForbiddenRawMedia({ jpeg: "bytes" }), true);
  assert.equal(containsForbiddenRawMedia({ nested: { video: "data:video/mp4;base64,AAAA" } }), true);
  assert.equal(containsForbiddenRawMedia({ signal: { sdp: "v=0" } }), false);
});

test("Monitor client 使用 generation 隔离迟到消息、10 秒 heartbeat 和命令 callback", async () => {
  FakeSocket.instances = [];
  const timers = fakeTimers();
  const storage = memoryStorage();
  let currentNow = 2_000;
  let receivedCommand = null;
  const client = createMonitorRelayClient({
    relayUrl: "http://127.0.0.1:8787",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        room_name: "shared-live-demo",
        room_session_id: "room-1",
        producer_token: TOKEN,
        expires_at_ms: 31_000,
      }),
    }),
    WebSocketImpl: FakeSocket,
    claimStore: createSessionClaimStore(storage),
    timerApi: timers,
    now: () => currentNow,
    onCommand(value) {
      receivedCommand = value;
      return {
        phase: "awaiting_local_confirmation",
        stateRevision: null,
        reason: "local_confirmation_required",
      };
    },
  });

  const startPromise = client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const socket = FakeSocket.instances[0];
  assert.deepEqual(socket.protocols, ["reme-monitor-v1", `reme-token-${TOKEN}`]);
  socket.open();
  assert.equal(await startPromise, true);
  socket.message({
    type: "monitor_ready",
    room_name: "shared-live-demo",
    room_session_id: "room-1",
    expires_at_ms: 32_000,
    viewer_count: 1,
    max_viewers: 5,
    controller: null,
    heartbeat_interval_ms: 10_000,
    server_time_ms: 2_000,
  });
  assert.equal(client.getSnapshot().status, "connected");
  assert.equal(client.getSnapshot().viewerCount, 1);
  assert.equal(Object.hasOwn(client.getSnapshot(), "producerToken"), false);
  assert.equal([...timers.intervals.values()][0].milliseconds, 10_000);

  timers.runIntervals();
  assert.deepEqual(socket.sent.at(-1), {
    type: "monitor_heartbeat",
    room_session_id: "room-1",
  });

  socket.message(command());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(receivedCommand.command_id, "command-1");
  assert.deepEqual(socket.sent.at(-1), {
    type: "control_ack",
    room_session_id: "room-1",
    command_id: "command-1",
    phase: "awaiting_local_confirmation",
    timestamp_ms: 2_000,
    state_revision: null,
    reason: "local_confirmation_required",
  });

  client.stop();
  currentNow = 4_000;
  socket.message({
    type: "viewer_presence",
    room_session_id: "room-1",
    viewer_count: 5,
    max_viewers: 5,
    monitor_online: true,
    server_time_ms: 4_000,
  });
  assert.equal(client.getSnapshot().viewerCount, 0);
  assert.equal(client.getSnapshot().status, "idle");
});

test("applied ACK 等待对应权威 state revision 被 Relay 接收", async () => {
  FakeSocket.instances = [];
  const client = createMonitorRelayClient({
    relayUrl: "http://127.0.0.1:8787",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        room_name: "shared-live-demo",
        room_session_id: "room-1",
        producer_token: TOKEN,
        expires_at_ms: 31_000,
      }),
    }),
    WebSocketImpl: FakeSocket,
    claimStore: createSessionClaimStore(memoryStorage()),
    timerApi: fakeTimers(),
    now: () => 2_000,
    onCommand: () => ({ phase: "applied", stateRevision: 1, reason: null }),
  });
  const startPromise = client.start();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const socket = FakeSocket.instances[0];
  socket.open();
  await startPromise;
  socket.message({
    type: "monitor_ready",
    room_name: "shared-live-demo",
    room_session_id: "room-1",
    expires_at_ms: 32_000,
    viewer_count: 1,
    max_viewers: 5,
    controller: null,
    heartbeat_interval_ms: 10_000,
    server_time_ms: 2_000,
  });
  client.publishState(demoState(0));
  socket.message({ type: "state_accepted", room_session_id: "room-1", state_revision: 0 });
  socket.message(command("reset_demo", { command_id: "command-applied" }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(socket.sent.some((value) => value.command_id === "command-applied"), false);

  client.publishState(demoState(1));
  socket.message({ type: "state_accepted", room_session_id: "room-1", state_revision: 1 });
  assert.deepEqual(socket.sent.at(-1), {
    type: "control_ack",
    room_session_id: "room-1",
    command_id: "command-applied",
    phase: "applied",
    timestamp_ms: 2_000,
    state_revision: 1,
    reason: null,
  });
  client.stop();
});
