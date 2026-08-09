import { env, exports as workerExports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  reset as resetCloudflareBindings,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ControlAck,
  type ControlCommand,
  type DemoStateEnvelope,
  type FamilyEvent,
  type PoseFrame,
} from "../src/index";
import { MOVENET_KEYPOINT_NAMES } from "../src/protocol";

const ORIGIN = "http://127.0.0.1:4173";
const ROOM_NAME = "shared-live-demo";
const MONITOR_PROTOCOL = "reme-monitor-v1";
const VIEWER_PROTOCOL = "reme-viewer-v1";
const VIEWER_PROTOCOL_V2 = "reme-viewer-v2";
const sockets: WebSocket[] = [];
const inboxes = new WeakMap<WebSocket, SocketInbox>();

interface Claim {
  room_name: typeof ROOM_NAME;
  room_session_id: string;
  producer_token: string;
  expires_at_ms: number;
}

interface SocketInbox {
  messages: Array<{ value?: unknown; error?: Error }>;
  waiters: Array<{
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1000, "test_cleanup");
  }
  await abortAllDurableObjects();
  await resetCloudflareBindings();
  await resetRoomStorage();
  await abortAllDurableObjects();
});

describe("public dual-device relay", () => {
  it("claims one passwordless 30 second producer lease and never accepts a request body", async () => {
    const emptyBodyResponse = await relayFetch("/api/monitor/claim", {
      method: "POST",
      body: new Uint8Array(0),
    });
    expect(emptyBodyResponse.status).toBe(201);
    const first = await emptyBodyResponse.json<Claim>();

    const bodyResponse = await relayFetch("/api/monitor/claim", {
      method: "POST",
      body: "{}",
    });
    expect(bodyResponse.status).toBe(400);
    await expect(bodyResponse.json()).resolves.toEqual({ error: "request_body_forbidden" });

    expect(first.room_name).toBe(ROOM_NAME);
    expect(first.room_session_id).toMatch(/^room-[a-f0-9-]+$/);
    expect(first.producer_token).toMatch(/^[a-f0-9]{64}$/);
    expect(first.expires_at_ms - Date.now()).toBeGreaterThan(29_000);

    const second = await relayFetch("/api/monitor/claim", { method: "POST" });
    expect(second.status).toBe(409);
    const busy = await second.json<Record<string, unknown>>();
    expect(busy).toMatchObject({ error: "monitor_busy" });
    expect(numberField(busy, "retry_after_ms")).toBeGreaterThan(29_000);
    expect(numberField(busy, "retry_at_ms") - numberField(busy, "server_time_ms"))
      .toBe(numberField(busy, "retry_after_ms"));

    await runInDurableObject(roomStub(), async (_instance, state) => {
      const row = state.storage.sql.exec<{
        [key: string]: SqlStorageValue;
        token_hash: string;
      }>("SELECT token_hash FROM producer_lease").one();
      expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(row.token_hash).not.toBe(first.producer_token);
    });
  });

  it("authenticates the monitor in WebSocket subprotocol and renews the producer heartbeat", async () => {
    const claim = await claimMonitor();
    const denied = await relayFetch("/ws/monitor", {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": `${MONITOR_PROTOCOL}, reme-token-${"0".repeat(64)}`,
      },
    });
    expect(denied.status).toBe(401);

    const monitor = await connectMonitor(claim);
    const ready = await nextType(monitor, "monitor_ready");
    expect(ready).toMatchObject({
      room_session_id: claim.room_session_id,
      heartbeat_interval_ms: 10_000,
      max_viewers: 5,
    });
    monitor.send(JSON.stringify({
      type: "monitor_heartbeat",
      room_session_id: claim.room_session_id,
    }));
    const heartbeat = await nextType(monitor, "monitor_heartbeat_ack");
    expect(heartbeat).toMatchObject({ room_session_id: claim.room_session_id });
    expect(numberField(heartbeat, "expires_at_ms")).toBeGreaterThan(claim.expires_at_ms - 1_000);
  });

  it("reconnects the same producer token without a delayed old close releasing the new socket", async () => {
    const claim = await claimMonitor();
    const first = await connectMonitor(claim);
    await nextType(first, "monitor_ready");
    const replacement = await connectMonitor(claim);
    await nextType(replacement, "monitor_ready");
    replacement.send(JSON.stringify({
      type: "monitor_heartbeat",
      room_session_id: claim.room_session_id,
    }));
    await expect(nextType(replacement, "monitor_heartbeat_ack")).resolves.toMatchObject({
      room_session_id: claim.room_session_id,
    });
    await expect(roomStub().getStatus()).resolves.toMatchObject({ monitor_online: true });
  });

  it("caps the public audience at five and broadcasts presence", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewers: WebSocket[] = [];
    for (let count = 1; count <= 5; count += 1) {
      const viewer = await connectViewer();
      viewers.push(viewer);
      const ready = await nextType(viewer, "viewer_ready");
      expect(ready).toMatchObject({ viewer_count: count, max_viewers: 5 });
    }
    const full = await relayFetch("/ws/viewer", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": VIEWER_PROTOCOL },
    });
    expect(full.status).toBe(503);
    await expect(full.json()).resolves.toEqual({ error: "viewer_limit_reached", max_viewers: 5 });
    const presence = await nextWhere(viewers[0]!, (value) => typeOf(value) === "viewer_presence"
      && numberField(value, "viewer_count") === 5);
    expect(presence).toMatchObject({ monitor_online: true, room_session_id: claim.room_session_id });
  });

  it("grants only one renewable viewer controller and releases it on disconnect", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewerA = await connectViewerAndReady();
    const viewerB = await connectViewerAndReady();

    viewerA.send(JSON.stringify({ type: "control_claim", room_session_id: claim.room_session_id }));
    const granted = await nextType(viewerA, "control_claim_result");
    expect(granted).toMatchObject({ status: "granted", room_session_id: claim.room_session_id });
    const lease = objectField(granted, "lease");
    const leaseId = stringField(lease, "lease_id");

    viewerB.send(JSON.stringify({ type: "control_claim", room_session_id: claim.room_session_id }));
    await expect(nextType(viewerB, "control_claim_result")).resolves.toMatchObject({ status: "busy" });

    viewerA.send(JSON.stringify({
      type: "control_heartbeat",
      room_session_id: claim.room_session_id,
      lease_id: leaseId,
    }));
    await expect(nextType(viewerA, "control_heartbeat_ack")).resolves.toMatchObject({ lease_id: leaseId });

    viewerA.close(1000, "release_controller");
    const released = await nextWhere(viewerB, (value) => (
      typeOf(value) === "controller_status" && field(value, "controller") === null
    ));
    expect(released).toMatchObject({ room_session_id: claim.room_session_id });
    viewerB.send(JSON.stringify({ type: "control_claim", room_session_id: claim.room_session_id }));
    await expect(nextType(viewerB, "control_claim_result")).resolves.toMatchObject({ status: "granted" });
  });

  it("lets only the current Monitor revoke control and terminally fails its pending commands", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewerA = await connectViewerAndReady();
    const viewerB = await connectViewerAndReady();
    monitor.send(JSON.stringify(makeState(claim, 1)));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewerA, "reme-demo-state/v1");
    await claimControl(viewerA, claim.room_session_id);

    const pending = makeCommand(claim, 1, 1, "cmd-monitor-revoke");
    viewerA.send(JSON.stringify(pending));
    await expect(nextAck(viewerA, pending.command_id)).resolves.toMatchObject({ phase: "received" });
    await nextSchema(monitor, "reme-control-command/v1");

    viewerA.send(JSON.stringify({
      type: "control_revoke",
      room_session_id: claim.room_session_id,
    }));
    await expect(nextType(viewerA, "protocol_error")).resolves.toMatchObject({
      code: "invalid_viewer_message",
    });
    monitor.send(JSON.stringify({
      type: "control_revoke",
      room_session_id: claim.room_session_id,
      lease_id: "unexpected",
    }));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({
      code: "invalid_monitor_message",
    });

    monitor.send(JSON.stringify({
      type: "control_revoke",
      room_session_id: claim.room_session_id,
    }));
    await expect(nextAck(viewerA, pending.command_id)).resolves.toMatchObject({
      phase: "failed",
      reason: "control_revoked_by_monitor",
    });
    await expect(nextWhere(viewerB, (value) => (
      typeOf(value) === "controller_status" && field(value, "controller") === null
    ))).resolves.toMatchObject({ room_session_id: claim.room_session_id });
    viewerB.send(JSON.stringify({ type: "control_claim", room_session_id: claim.room_session_id }));
    await expect(nextType(viewerB, "control_claim_result")).resolves.toMatchObject({ status: "granted" });
  });

  it("terminally fails pending commands before a Viewer controller is released, disconnected, or expired", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const controller = await connectViewerAndReady();
    const observer = await connectViewerAndReady();
    monitor.send(JSON.stringify(makeState(claim, 1)));
    await nextType(monitor, "state_accepted");
    await nextSchema(controller, "reme-demo-state/v1");
    const firstLeaseId = await claimControl(controller, claim.room_session_id);

    const releasedCommand = makeCommand(claim, 1, 1, "cmd-controller-release");
    controller.send(JSON.stringify(releasedCommand));
    await nextAck(controller, releasedCommand.command_id);
    await nextSchema(monitor, "reme-control-command/v1");
    controller.send(JSON.stringify({
      type: "control_release",
      room_session_id: claim.room_session_id,
      lease_id: firstLeaseId,
    }));
    await expect(nextAckPhase(observer, releasedCommand.command_id, "failed")).resolves.toMatchObject({
      phase: "failed",
      reason: "controller_released",
    });

    await claimControl(controller, claim.room_session_id);
    const disconnectedCommand = makeCommand(claim, 1, 1, "cmd-controller-disconnect");
    controller.send(JSON.stringify(disconnectedCommand));
    await nextAck(controller, disconnectedCommand.command_id);
    await nextSchema(monitor, "reme-control-command/v1");
    controller.close(1000, "controller_gone");
    await expect(nextAckPhase(observer, disconnectedCommand.command_id, "failed")).resolves.toMatchObject({
      phase: "failed",
      reason: "controller_disconnected",
    });

    const expiringController = observer;
    const expiryObserver = await connectViewerAndReady();
    await claimControl(expiringController, claim.room_session_id);
    const expiredCommand = {
      ...makeCommand(claim, 1, 1, "cmd-controller-expiry"),
      expires_at_ms: baseTime + 60_000,
    };
    expiringController.send(JSON.stringify(expiredCommand));
    await nextAck(expiringController, expiredCommand.command_id);
    await nextSchema(monitor, "reme-control-command/v1");

    now.mockReturnValue(baseTime + 10_000);
    monitor.send(JSON.stringify({
      type: "monitor_heartbeat",
      room_session_id: claim.room_session_id,
    }));
    await nextType(monitor, "monitor_heartbeat_ack");
    now.mockReturnValue(baseTime + 30_001);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    await expect(nextAckPhase(expiryObserver, expiredCommand.command_id, "failed")).resolves.toMatchObject({
      phase: "failed",
      reason: "controller_lease_expired",
    });
    await expect(nextWhere(expiryObserver, (value) => (
      typeOf(value) === "controller_status" && field(value, "controller") === null
    ))).resolves.toMatchObject({ room_session_id: claim.room_session_id });
  });

  it("validates and replays a fresh state and ordered 17-point pose without raw media", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const state = makeState(claim, 1);
    monitor.send(JSON.stringify(state));
    await expect(nextSchema(viewer, "reme-demo-state/v1")).resolves.toEqual(state);
    await expect(nextType(monitor, "state_accepted")).resolves.toMatchObject({ state_revision: 1 });
    monitor.send(JSON.stringify(state));
    await expect(nextSchema(viewer, "reme-demo-state/v1")).resolves.toEqual(state);
    await expect(nextType(monitor, "state_accepted")).resolves.toMatchObject({ state_revision: 1 });
    monitor.send(JSON.stringify({ ...state, timestamp_ms: state.timestamp_ms + 1 }));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({
      code: "state_revision_conflict",
    });

    const pose = makePose(claim, state.runtime_session_id, 1);
    monitor.send(JSON.stringify(pose));
    await expect(nextSchema(viewer, "reme-pose-frame-17/v1")).resolves.toEqual(pose);
    await expect(nextType(monitor, "pose_accepted")).resolves.toMatchObject({ frame_sequence: 1 });
    monitor.send(JSON.stringify(pose));
    await expect(nextType(monitor, "pose_accepted")).resolves.toMatchObject({ frame_sequence: 1 });

    const late = await connectViewerAndReady();
    await expect(nextSchema(late, "reme-demo-state/v1")).resolves.toEqual(state);
    await expect(nextSchema(late, "reme-pose-frame-17/v1")).resolves.toEqual(pose);

    monitor.send(JSON.stringify({ ...makeState(claim, 2), image: "data:image/jpeg;base64,AA==" }));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({ code: "raw_media_forbidden" });
    monitor.send(new Uint8Array([1, 2, 3]).buffer);
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({ code: "binary_frames_forbidden" });
  });

  it("accepts a revision reset when a refreshed Home starts a new runtime session", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();

    const previous = makeState(claim, 7, { runtimeSession: "runtime-before-refresh" });
    monitor.send(JSON.stringify(previous));
    await expect(nextSchema(viewer, "reme-demo-state/v1")).resolves.toEqual(previous);
    await expect(nextType(monitor, "state_accepted")).resolves.toMatchObject({ state_revision: 7 });

    const refreshed = makeState(claim, 0, { runtimeSession: "runtime-after-refresh" });
    monitor.send(JSON.stringify(refreshed));
    await expect(nextSchema(viewer, "reme-demo-state/v1")).resolves.toEqual(refreshed);
    await expect(nextType(monitor, "state_accepted")).resolves.toMatchObject({ state_revision: 0 });

    const lateViewer = await connectViewerAndReady();
    await expect(nextSchema(lateViewer, "reme-demo-state/v1")).resolves.toEqual(refreshed);
  });

  it("forwards exact commands, enforces revision and sequence, and replays idempotent ACKs", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const state = makeState(claim, 4);
    monitor.send(JSON.stringify(state));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    const leaseId = await claimControl(viewer, claim.room_session_id);
    expect(leaseId).toMatch(/^lease-/);

    const stale = makeCommand(claim, 1, 3, "cmd-stale");
    viewer.send(JSON.stringify(stale));
    await expect(nextAck(viewer, "cmd-stale")).resolves.toMatchObject({
      phase: "rejected",
      reason: "state_revision_mismatch",
    });

    const command = makeCommand(claim, 2, 4, "cmd-start");
    viewer.send(JSON.stringify(command));
    await expect(nextAck(viewer, command.command_id)).resolves.toMatchObject({ phase: "received" });
    await expect(nextSchema(monitor, "reme-control-command/v1")).resolves.toEqual(command);

    const awaiting: ControlAck = {
      type: "control_ack",
      room_session_id: claim.room_session_id,
      command_id: command.command_id,
      phase: "awaiting_local_confirmation",
      timestamp_ms: Date.now(),
      state_revision: null,
      reason: "camera_permission",
    };
    monitor.send(JSON.stringify(awaiting));
    await expect(nextAck(viewer, command.command_id)).resolves.toEqual(awaiting);

    const state5 = makeState(claim, 5);
    monitor.send(JSON.stringify(state5));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    const applied: ControlAck = {
      type: "control_ack",
      room_session_id: claim.room_session_id,
      command_id: command.command_id,
      phase: "applied",
      timestamp_ms: Date.now(),
      state_revision: 5,
      reason: null,
    };
    monitor.send(JSON.stringify(applied));
    await expect(nextAck(viewer, command.command_id)).resolves.toEqual(applied);

    viewer.send(JSON.stringify(command));
    await expect(nextAck(viewer, command.command_id)).resolves.toEqual(applied);

    const skipped = makeCommand(claim, 4, 5, "cmd-skipped");
    viewer.send(JSON.stringify(skipped));
    const skippedAck = await nextAck(viewer, skipped.command_id);
    expect(skippedAck).toMatchObject({
      phase: "rejected",
      reason: "invalid_command_sequence",
    });
    viewer.send(JSON.stringify(skipped));
    await expect(nextAck(viewer, skipped.command_id)).resolves.toEqual(skippedAck);

    const next = makeCommand(claim, 3, 5, "cmd-after-skipped");
    viewer.send(JSON.stringify(next));
    await expect(nextAck(viewer, next.command_id)).resolves.toMatchObject({ phase: "received" });
    await expect(nextSchema(monitor, "reme-control-command/v1")).resolves.toEqual(next);
  });

  it("persists a no-lease rejection so an exact command id cannot become accepted later", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    monitor.send(JSON.stringify(makeState(claim, 1)));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");

    const unauthorized = makeCommand(claim, 1, 1, "cmd-before-lease");
    viewer.send(JSON.stringify(unauthorized));
    const rejected = await nextAck(viewer, unauthorized.command_id);
    expect(rejected).toMatchObject({
      phase: "rejected",
      reason: "controller_lease_required",
    });

    await claimControl(viewer, claim.room_session_id);
    viewer.send(JSON.stringify(unauthorized));
    await expect(nextAck(viewer, unauthorized.command_id)).resolves.toEqual(rejected);

    const authorized = makeCommand(claim, 1, 1, "cmd-after-lease");
    viewer.send(JSON.stringify(authorized));
    await expect(nextAck(viewer, authorized.command_id)).resolves.toMatchObject({ phase: "received" });
    await expect(nextSchema(monitor, "reme-control-command/v1")).resolves.toEqual(authorized);
  });

  it("rejects cross-scene navigation while an authoritative emergency is active", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const emergency = makeState(claim, 1, {
      scene: "fall",
      care: {
        phase: "emergency",
        decision: "decision-locked",
        consent: "none",
        authoritative: true,
      },
    });
    monitor.send(JSON.stringify(emergency));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    await claimControl(viewer, claim.room_session_id);

    const command = {
      ...makeCommand(claim, 1, 1, "cmd-leave-emergency"),
      command: { name: "select_scene" as const, scene_id: "living" as const },
    };
    viewer.send(JSON.stringify(command));
    await expect(nextAck(viewer, command.command_id)).resolves.toMatchObject({
      phase: "rejected",
      reason: "authoritative_alarm_locked",
    });
  });

  it("turns a pending remote command into a terminal failure when the Monitor disconnects", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const state = makeState(claim, 1);
    monitor.send(JSON.stringify(state));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    await claimControl(viewer, claim.room_session_id);
    const command = makeCommand(claim, 1, 1, "cmd-pending-loss");
    viewer.send(JSON.stringify(command));
    await nextAck(viewer, command.command_id);
    await nextSchema(monitor, "reme-control-command/v1");
    monitor.close(1000, "runtime_lost");
    await expect(nextAck(viewer, command.command_id)).resolves.toMatchObject({
      phase: "failed",
      reason: "monitor_disconnected",
    });
  });

  it("expires a nonterminal command from the Durable Object alarm", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    monitor.send(JSON.stringify(makeState(claim, 1)));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    await claimControl(viewer, claim.room_session_id);
    const command = {
      ...makeCommand(claim, 1, 1, "cmd-alarm-expiry"),
      issued_at_ms: baseTime,
      expires_at_ms: baseTime + 1_000,
    };
    viewer.send(JSON.stringify(command));
    await nextAck(viewer, command.command_id);
    await nextSchema(monitor, "reme-control-command/v1");

    now.mockReturnValue(baseTime + 1_001);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    await expect(nextAck(viewer, command.command_id)).resolves.toMatchObject({
      phase: "failed",
      reason: "command_expired",
    });
  });

  it("hard-denies bathroom video and grants consented kitchen video to existing and late viewers", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewerA = await connectViewerAndReady();

    const bathroom = makeState(claim, 1, {
      scene: "bathroom",
      care: { phase: "idle", decision: null, consent: "none", authoritative: false },
    });
    monitor.send(JSON.stringify(bathroom));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewerA, "reme-demo-state/v1");
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: bathroom.runtime_session_id,
      event_id: "decision-kitchen",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    }));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({
      code: "bathroom_privacy_lock",
    });

    const kitchen = makeState(claim, 2, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-kitchen",
        consent: "granted",
        authoritative: false,
      },
    });
    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewerA, "reme-demo-state/v1");
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-kitchen",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    }));
    const grantA = await nextType(viewerA, "media_grant");
    expect(grantA).toMatchObject({
      audience: "all_viewers",
      grant: { scope: "kitchen_moment", status: "active" },
    });
    const grantId = stringField(objectField(grantA, "grant"), "grant_id");

    const late = await connectViewerAndReady();
    await nextSchema(late, "reme-demo-state/v1");
    await expect(nextWhere(late, (value) => typeOf(value) === "media_grant"
      && stringField(objectField(value, "grant"), "grant_id") === grantId)).resolves.toMatchObject({
        grant: { status: "active" },
      });
  });

  it("binds WebRTC signalling to an active grant and revokes on scene change", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const viewerReady = await latestQueuedType(viewer, "viewer_ready");
    const viewerId = stringField(viewerReady, "viewer_id");
    const kitchen = makeState(claim, 1, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-signal",
        consent: "granted",
        authoritative: false,
      },
    });
    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-signal",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    }));
    const media = await nextType(viewer, "media_grant");
    const grantId = stringField(objectField(media, "grant"), "grant_id");
    const offer = {
      schema_version: "reme-media-signal/v1",
      room_session_id: claim.room_session_id,
      grant_id: grantId,
      target_id: "monitor",
      signal_type: "offer",
      signal: { type: "offer", sdp: "v=0\r\n" },
    };
    viewer.send(JSON.stringify(offer));
    await expect(nextSchema(monitor, "reme-media-signal/v1")).resolves.toEqual({
      ...offer,
      from_id: viewerId,
    });
    const answer = {
      ...offer,
      target_id: viewerId,
      signal_type: "answer",
      signal: { type: "answer", sdp: "v=0\r\na=answer" },
    };
    monitor.send(JSON.stringify(answer));
    await expect(nextSchema(viewer, "reme-media-signal/v1")).resolves.toEqual({
      ...answer,
      from_id: "monitor",
    });

    const living = makeState(claim, 2, { scene: "living" });
    monitor.send(JSON.stringify(living));
    await nextType(monitor, "state_accepted");
    const revoked = await nextWhere(viewer, (value) => typeOf(value) === "media_grant"
      && field(objectField(value, "grant"), "status") === "revoked");
    expect(revoked).toMatchObject({ reason: "scene_changed" });
    viewer.send(JSON.stringify(offer));
    await expect(nextType(viewer, "protocol_error")).resolves.toMatchObject({
      code: "media_grant_inactive",
    });
  });

  it("revokes event video when the authoritative runtime degrades", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const kitchen = makeState(claim, 1, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-runtime-gate",
        consent: "granted",
        authoritative: false,
      },
    });
    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    const request = {
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-runtime-gate",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    };
    monitor.send(JSON.stringify(request));
    await nextType(viewer, "media_grant");

    const degraded = makeState(claim, 2, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-runtime-gate",
        consent: "granted",
        authoritative: false,
      },
    });
    degraded.state.runtime = {
      status: "degraded",
      capability: "live",
      detail: "decision transport unavailable",
    };
    monitor.send(JSON.stringify(degraded));
    await nextType(monitor, "state_accepted");
    await expect(nextWhere(viewer, (value) => typeOf(value) === "media_grant"
      && field(objectField(value, "grant"), "status") === "revoked")).resolves.toMatchObject({
        reason: "grant_authority_lost",
      });
    monitor.send(JSON.stringify(request));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({
      code: "authority_runtime_degraded",
    });
  });

  it("expires stale authority and never extends an event beyond its first grant deadline", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const kitchen = makeState(claim, 1, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-fixed-window",
        consent: "granted",
        authoritative: false,
      },
    });
    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    const leaseId = await claimControl(viewer, claim.room_session_id);
    const request = {
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-fixed-window",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    };
    monitor.send(JSON.stringify(request));
    const firstGrant = await nextType(viewer, "media_grant");
    const firstGrantValue = objectField(firstGrant, "grant");
    const firstDeadline = numberField(firstGrantValue, "expires_at_ms");
    expect(firstDeadline).toBe(baseTime + 60_000);

    now.mockReturnValue(baseTime + 20_000);
    monitor.send(JSON.stringify({
      type: "monitor_heartbeat",
      room_session_id: claim.room_session_id,
    }));
    await nextType(monitor, "monitor_heartbeat_ack");
    viewer.send(JSON.stringify({
      type: "control_heartbeat",
      room_session_id: claim.room_session_id,
      lease_id: leaseId,
    }));
    await nextType(viewer, "control_heartbeat_ack");

    now.mockReturnValue(baseTime + 30_001);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    await expect(nextWhere(viewer, (value) => typeOf(value) === "media_grant"
      && field(objectField(value, "grant"), "status") === "revoked")).resolves.toMatchObject({
        reason: "state_stale",
      });
    await expect(nextType(viewer, "state_unavailable")).resolves.toMatchObject({ reason: "stale" });

    const staleCommand = makeCommand(claim, 1, 1, "cmd-stale-authority");
    viewer.send(JSON.stringify(staleCommand));
    await expect(nextAck(viewer, staleCommand.command_id)).resolves.toMatchObject({
      phase: "rejected",
      reason: "state_stale",
    });
    monitor.send(JSON.stringify(request));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({ code: "state_stale" });

    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    monitor.send(JSON.stringify(request));
    const resumedGrant = await nextWhere(viewer, (value) => typeOf(value) === "media_grant"
      && field(objectField(value, "grant"), "status") === "active");
    expect(numberField(objectField(resumedGrant, "grant"), "expires_at_ms")).toBe(firstDeadline);

    await runInDurableObject(roomStub(), async (_instance, state) => {
      const rows = state.storage.sql.exec<{ [key: string]: SqlStorageValue; count: number }>(
        `SELECT COUNT(*) AS count FROM media_grant_audience
          WHERE grant_id = ?`,
        stringField(firstGrantValue, "grant_id"),
      ).one();
      expect(rows.count).toBe(0);
    });
  });

  it("issues at most 30 seconds for an authoritative fall and fails closed on monitor loss", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    const fall = makeState(claim, 1, {
      scene: "fall",
      care: {
        phase: "emergency",
        decision: "decision-fall",
        consent: "none",
        authoritative: true,
      },
    });
    monitor.send(JSON.stringify(fall));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: fall.runtime_session_id,
      event_id: "decision-fall",
      scope: "fall_emergency",
      expires_in_ms: 30_001,
    }));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({
      code: "invalid_media_grant_request",
    });
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: fall.runtime_session_id,
      event_id: "decision-fall",
      scope: "fall_emergency",
      expires_in_ms: 30_000,
    }));
    const active = await nextType(viewer, "media_grant");
    const grantId = stringField(objectField(active, "grant"), "grant_id");
    const late = await connectViewerAndReady();
    const lateReady = await latestQueuedType(late, "viewer_ready");
    const lateViewerId = stringField(lateReady, "viewer_id");
    const lateState = await nextSchema(late, "reme-demo-state/v1");
    expect(field(objectField(objectField(lateState, "state"), "media_grant"), "grant_id"))
      .toBe(grantId);
    await expect(nextWhere(late, (value) => typeOf(value) === "media_grant"
      && stringField(objectField(value, "grant"), "grant_id") === grantId)).resolves.toMatchObject({
        grant: { status: "active" },
      });
    late.send(JSON.stringify({
      schema_version: "reme-media-signal/v1",
      room_session_id: claim.room_session_id,
      grant_id: grantId,
      target_id: "monitor",
      signal_type: "answer",
      signal: { type: "answer", sdp: "v=0\r\n" },
    }));
    await expect(nextSchema(monitor, "reme-media-signal/v1")).resolves.toMatchObject({
      grant_id: grantId,
      from_id: lateViewerId,
    });
    monitor.close(1000, "monitor_lost");
    const revoked = await nextWhere(viewer, (value) => typeOf(value) === "media_grant"
      && field(objectField(value, "grant"), "status") === "revoked");
    expect(revoked).toMatchObject({ reason: "monitor_disconnected" });
    await expect(nextType(viewer, "state_unavailable")).resolves.toMatchObject({
      reason: "monitor_offline",
    });
  });

  it("runs expiry cleanup idempotently from the single Durable Object alarm", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const viewer = await connectViewerAndReady();
    await claimControl(viewer, claim.room_session_id);

    const kitchen = makeState(claim, 1, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-expiry",
        consent: "granted",
        authoritative: false,
      },
    });
    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");
    await nextSchema(viewer, "reme-demo-state/v1");
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-expiry",
      scope: "kitchen_moment",
      expires_in_ms: 1_000,
    }));
    await nextType(viewer, "media_grant");

    now.mockReturnValue(baseTime + 1_001);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    await expect(nextWhere(viewer, (value) => typeOf(value) === "media_grant"
      && field(objectField(value, "grant"), "status") === "expired")).resolves.toMatchObject({
        reason: "grant_expired",
      });
    await expect(roomStub().getStatus(baseTime + 1_001)).resolves.toMatchObject({
      monitor_online: true,
      active_media_grant: null,
    });

    now.mockReturnValue(baseTime + 30_001);
    expect(await runDurableObjectAlarm(roomStub())).toBe(true);
    const status = await roomStub().getStatus(baseTime + 30_001);
    expect(status.monitor_online).toBe(false);
    expect(status.controller).toBeNull();
    expect(status.active_media_grant).toBeNull();
    await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(false);
  });

  it("returns short-lived TURN REST credentials without exposing the shared secret", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    const response = await relayFetch("/api/rtc-config");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json<Record<string, unknown>>();
    expect(body.mode).toBe("turn_configured");
    expect(body.credential_expires_at_ms).toBe((Math.floor(baseTime / 1000) + 600) * 1000);
    const servers = body.iceServers as Array<Record<string, unknown>>;
    expect(servers).toHaveLength(2);
    expect(servers[0]).toEqual({ urls: ["stun:turn.test:3478"] });
    const turn = servers[1];
    if (turn === undefined) throw new Error("expected TURN server entry");
    expect(turn).toMatchObject({
      urls: [
        "turn:turn.test:3478?transport=udp",
        "turns:turn.test:5349?transport=tcp",
      ],
    });
    expect(String(turn.username)).toBe(`${Math.floor(baseTime / 1000) + 600}:reme-demo`);
    expect(String(turn.credential)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(JSON.stringify(body)).not.toContain("test-turn-shared-secret");
    now.mockRestore();
  });

  it("accepts authenticated runtime FamilyEvent ingest and rejects bad credentials", async () => {
    const event = makeFamilyEvent("runtime-ingest", 1, "decision-ingest");
    const denied = await relayFetch("/api/runtime/event", {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
    expect(denied.status).toBe(401);

    const accepted = await relayFetch("/api/runtime/event", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-runtime-ingest-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
    expect(accepted.status).toBe(202);
    await expect(accepted.json()).resolves.toMatchObject({ ok: true, revision: 1 });

    const stale = await relayFetch("/api/runtime/event", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-runtime-ingest-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ error: "stale_family_revision" });
  });

  it("stores authoritative family events and only sends them to viewer v2", async () => {
    const published = await roomStub().publishFamilyEvent(
      makeFamilyEvent("runtime-family", 1, "decision-family"),
    );
    expect(published).toMatchObject({ ok: true, revision: 1 });
    const preMonitorRoom = published.room_session_id;
    const claim = await claimMonitor();
    expect(claim.room_session_id).not.toBe(preMonitorRoom);

    const viewer = await connectViewerV2();
    await nextType(viewer, "viewer_ready");
    const event = await nextType(viewer, "family_event");
    expect(event).toMatchObject({
      schema_version: "reme-family-event/v1",
      runtime_session_id: "runtime-family",
      revision: 1,
      care: {
        decision_id: "decision-family",
        state: "family_notification_required",
      },
    });
    expect(field(event, "room_session_id")).toBe(claim.room_session_id);

    await expect(roomStub().publishFamilyEvent(
      makeFamilyEvent("runtime-family", 1, "decision-stale"),
    )).resolves.toMatchObject({ ok: false, error: "stale_family_revision", revision: 1 });
  });

  it("uses backend media authorization instead of spoofed Home consent once available", async () => {
    const claim = await claimMonitor();
    const monitor = await connectMonitor(claim);
    await nextType(monitor, "monitor_ready");
    const kitchen = makeState(claim, 1, {
      scene: "kitchen",
      care: {
        phase: "checking",
        decision: "decision-kitchen-auth",
        consent: "granted",
        authoritative: false,
      },
    });
    monitor.send(JSON.stringify(kitchen));
    await nextType(monitor, "state_accepted");

    await roomStub().publishFamilyEvent(
      makeFamilyEvent("runtime-current", 1, "decision-kitchen-auth", { authorization: null }),
    );
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-kitchen-auth",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    }));
    await expect(nextType(monitor, "protocol_error")).resolves.toMatchObject({
      code: "backend_media_authorization_required",
    });

    const now = Date.now();
    await roomStub().publishFamilyEvent(
      makeFamilyEvent("runtime-current", 2, "decision-kitchen-auth", {
        authorization: {
          schema_version: "reme-media-authorization/v1",
          authorization_id: "authorization-kitchen",
          decision_id: "decision-kitchen-auth",
          scene_id: "kitchen",
          scope: "kitchen_moment",
          status: "active",
          issued_at_ms: now,
          expires_at_ms: now + 60_000,
          event_id: null,
        },
      }),
    );
    monitor.send(JSON.stringify({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: kitchen.runtime_session_id,
      event_id: "decision-kitchen-auth",
      scope: "kitchen_moment",
      expires_in_ms: 60_000,
    }));
    await expect(nextType(monitor, "media_grant")).resolves.toMatchObject({
      grant: { scope: "kitchen_moment", status: "active" },
    });
  });
});

async function relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Origin", ORIGIN);
  return workerExports.default.fetch(
    new Request(`https://relay.example${path}`, { ...init, headers }),
  );
}

function roomStub(): DurableObjectStub<import("../src/index").DemoRoom> {
  return env.DEMO_ROOM.getByName(ROOM_NAME);
}

async function resetRoomStorage(): Promise<void> {
  await runInDurableObject(roomStub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.transactionSync(() => {
      state.storage.sql.exec("DELETE FROM media_grant_audience");
      state.storage.sql.exec("DELETE FROM media_grants");
      state.storage.sql.exec("DELETE FROM commands");
      state.storage.sql.exec("DELETE FROM controller_lease");
      state.storage.sql.exec("DELETE FROM latest_pose");
      state.storage.sql.exec("DELETE FROM latest_family_event");
      state.storage.sql.exec("DELETE FROM latest_state");
      state.storage.sql.exec("DELETE FROM producer_lease");
      state.storage.sql.exec("DELETE FROM room");
    });
  });
}

async function claimMonitor(): Promise<Claim> {
  const response = await relayFetch("/api/monitor/claim", { method: "POST" });
  expect(response.status).toBe(201);
  return response.json<Claim>();
}

async function connectMonitor(claim: Claim): Promise<WebSocket> {
  const response = await relayFetch("/ws/monitor", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `${MONITOR_PROTOCOL}, reme-token-${claim.producer_token}`,
    },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(MONITOR_PROTOCOL);
  return acceptSocket(response);
}

async function connectViewer(): Promise<WebSocket> {
  const response = await relayFetch("/ws/viewer", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": VIEWER_PROTOCOL },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(VIEWER_PROTOCOL);
  return acceptSocket(response);
}

async function connectViewerV2(): Promise<WebSocket> {
  const response = await relayFetch("/ws/viewer", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": VIEWER_PROTOCOL_V2 },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(VIEWER_PROTOCOL_V2);
  return acceptSocket(response);
}

async function connectViewerAndReady(): Promise<WebSocket> {
  const socket = await connectViewer();
  const ready = await nextType(socket, "viewer_ready");
  ensureInbox(socket).messages.unshift({ value: ready });
  return socket;
}

function acceptSocket(response: Response): WebSocket {
  if (response.webSocket === null) throw new Error("expected WebSocket response");
  const socket = response.webSocket;
  ensureInbox(socket);
  socket.accept();
  sockets.push(socket);
  return socket;
}

async function claimControl(viewer: WebSocket, roomSessionId: string): Promise<string> {
  viewer.send(JSON.stringify({ type: "control_claim", room_session_id: roomSessionId }));
  const result = await nextType(viewer, "control_claim_result");
  expect(result).toMatchObject({ status: "granted" });
  return stringField(objectField(result, "lease"), "lease_id");
}

function makeState(
  claim: Claim,
  revision: number,
  options: {
    scene?: "living" | "kitchen" | "bathroom" | "fall";
    runtimeSession?: string;
    sourceGeneration?: number;
    care?: {
      phase: "idle" | "checking" | "emergency" | "resolved";
      decision: string | null;
      consent: "none" | "pending" | "granted" | "denied";
      authoritative: boolean;
    };
  } = {},
): DemoStateEnvelope {
  const care = options.care ?? {
    phase: "idle" as const,
    decision: null,
    consent: "none" as const,
    authoritative: false,
  };
  return {
    schema_version: "reme-demo-state/v1",
    room_session_id: claim.room_session_id,
    runtime_session_id: options.runtimeSession ?? "runtime-current",
    state_revision: revision,
    timestamp_ms: Date.now(),
    state: {
      scene_id: options.scene ?? "living",
      source_generation: options.sourceGeneration ?? 1,
      capture: {
        status: "active",
        source_id: "camera-front",
        source_kind: "camera",
        remote_video: "available",
        error: null,
      },
      runtime: { status: "ready", capability: "live", detail: null },
      care: {
        phase: care.phase,
        decision_id: care.decision,
        consent: care.consent,
        alarm_authoritative: care.authoritative,
        message: care.phase === "idle" ? null : "演示状态",
      },
      media_grant: null,
    },
  };
}

function makeFamilyEvent(
  runtimeSessionId: string,
  revision: number,
  decisionId: string,
  options: {
    authorization?: FamilyEvent["care"]["media_authorization"];
  } = {},
): FamilyEvent {
  return {
    schema_version: "reme-family-event/v1",
    runtime_session_id: runtimeSessionId,
    revision,
    decision_timestamp_ms: 13_000,
    published_at_ms: Date.now(),
    care: {
      decision_id: decisionId,
      state: "family_notification_required",
      action: "notify_family",
      risk_level: 3,
      family_notification: "请尽快联系或前往查看。",
      privacy_mode: "blurred",
      alarm: {
        channels: ["vibrate", "ring", "flash"],
        trigger: "check_in_timeout",
      },
      action_card: null,
      media_authorization: options.authorization ?? null,
    },
  };
}

function makePose(claim: Claim, runtimeSessionId: string, sequence: number): PoseFrame {
  return {
    schema_version: "reme-pose-frame-17/v1",
    room_session_id: claim.room_session_id,
    runtime_session_id: runtimeSessionId,
    frame_sequence: sequence,
    timestamp_ms: Date.now(),
    source_width: 1280,
    source_height: 720,
    person_detected: true,
    landmark_quality: "usable",
    keypoints: MOVENET_KEYPOINT_NAMES.map((name, index) => ({
      name,
      x: index / 20,
      y: index / 20,
      score: 0.9,
    })),
  };
}

function makeCommand(
  claim: Claim,
  sequence: number,
  revision: number,
  commandId: string,
): ControlCommand {
  return {
    schema_version: "reme-control-command/v1",
    room_session_id: claim.room_session_id,
    command_id: commandId,
    command_sequence: sequence,
    issued_at_ms: Date.now(),
    expires_at_ms: Date.now() + 30_000,
    expected_state_revision: revision,
    command: { name: "start_capture" },
  };
}

function nextType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return nextWhere(socket, (value) => typeOf(value) === type);
}

function nextSchema(socket: WebSocket, schema: string): Promise<Record<string, unknown>> {
  return nextWhere(socket, (value) => field(value, "schema_version") === schema);
}

function nextAck(socket: WebSocket, commandId: string): Promise<Record<string, unknown>> {
  return nextWhere(socket, (value) => typeOf(value) === "control_ack"
    && field(value, "command_id") === commandId);
}

function nextAckPhase(
  socket: WebSocket,
  commandId: string,
  phase: string,
): Promise<Record<string, unknown>> {
  return nextWhere(socket, (value) => typeOf(value) === "control_ack"
    && field(value, "command_id") === commandId
    && field(value, "phase") === phase);
}

async function latestQueuedType(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  const inbox = ensureInbox(socket);
  const index = inbox.messages.findIndex((message) => typeOf(message.value) === type);
  if (index >= 0) {
    const [message] = inbox.messages.splice(index, 1);
    if (message?.error !== undefined) throw message.error;
    return objectValue(message?.value);
  }
  return nextType(socket, type);
}

async function nextWhere(
  socket: WebSocket,
  predicate: (value: unknown) => boolean,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await nextJson(socket);
    if (predicate(value)) return objectValue(value);
  }
  throw new Error("matching WebSocket message not found");
}

function nextJson(socket: WebSocket): Promise<unknown> {
  const inbox = ensureInbox(socket);
  const queued = inbox.messages.shift();
  if (queued !== undefined) {
    return queued.error === undefined
      ? Promise.resolve(queued.value)
      : Promise.reject(queued.error);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        const index = inbox.waiters.indexOf(waiter);
        if (index >= 0) inbox.waiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket message"));
      }, 2_000),
    };
    inbox.waiters.push(waiter);
  });
}

function ensureInbox(socket: WebSocket): SocketInbox {
  const existing = inboxes.get(socket);
  if (existing !== undefined) return existing;
  const inbox: SocketInbox = { messages: [], waiters: [] };
  inboxes.set(socket, inbox);
  socket.addEventListener("message", (event) => {
    let message: { value?: unknown; error?: Error };
    if (typeof event.data !== "string") {
      message = { error: new Error("expected text WebSocket message") };
    } else {
      try {
        message = { value: JSON.parse(event.data) as unknown };
      } catch {
        message = { error: new Error("expected valid JSON WebSocket message") };
      }
    }
    const waiter = inbox.waiters.shift();
    if (waiter === undefined) {
      inbox.messages.push(message);
      return;
    }
    clearTimeout(waiter.timeout);
    if (message.error === undefined) waiter.resolve(message.value);
    else waiter.reject(message.error);
  });
  return inbox;
}

function typeOf(value: unknown): unknown {
  return field(value, "type");
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && !Array.isArray(value) && key in value
    ? value[key as keyof typeof value]
    : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("expected object value");
  }
  return value as Record<string, unknown>;
}

function objectField(value: unknown, key: string): Record<string, unknown> {
  return objectValue(field(value, key));
}

function stringField(value: unknown, key: string): string {
  const result = field(value, key);
  if (typeof result !== "string") throw new Error(`expected string field ${key}`);
  return result;
}

function numberField(value: unknown, key: string): number {
  const result = field(value, key);
  if (typeof result !== "number") throw new Error(`expected number field ${key}`);
  return result;
}
