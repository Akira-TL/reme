import assert from "node:assert/strict";
import test from "node:test";
import {
  createBoundedMediaSignalDispatcher,
  createMediaSignal,
  createMonitorMediaProducer,
  describeMediaConnectivity,
  hasTurnServer,
  validateActiveGrantContext,
} from "./monitorMedia.js";

function track(id = "track-1") {
  const listeners = new Map();
  return {
    id,
    kind: "video",
    readyState: "live",
    addEventListener(name, listener) {
      listeners.set(name, listener);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
    end() {
      this.readyState = "ended";
      listeners.get("ended")?.();
    },
  };
}

function stream(videoTrack = track()) {
  return {
    id: "stream-1",
    getTracks: () => [videoTrack],
  };
}

function grant({
  status = "active",
  scope = "kitchen_moment",
  expiresAtMs = 20_000,
  reason = null,
} = {}) {
  return {
    type: "media_grant",
    room_session_id: "room-1",
    grant: {
      grant_id: "grant-1",
      event_id: "decision-1",
      scope,
      expires_at_ms: expiresAtMs,
      status,
    },
    audience: "all_viewers",
    reason,
  };
}

function context(overrides = {}) {
  return {
    connected: true,
    roomSessionId: "room-1",
    runtimeSessionId: "runtime-1",
    sourceGeneration: 2,
    sceneId: "kitchen",
    stream: stream(),
    authorized: true,
    authorityKey: "kitchen_moment:decision-1",
    ...overrides,
  };
}

function forwardedSignal(fromId, signalType, signal) {
  return {
    schema_version: "reme-media-signal/v1",
    room_session_id: "room-1",
    grant_id: "grant-1",
    target_id: "monitor",
    signal_type: signalType,
    signal,
    from_id: fromId,
  };
}

class FakePeerConnection {
  static instances = [];

  constructor(configuration) {
    this.configuration = configuration;
    this.tracks = [];
    this.candidates = [];
    this.connectionState = "new";
    this.remoteDescription = null;
    this.localDescription = null;
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  addTrack(mediaTrack, mediaStream) {
    this.tracks.push({ mediaTrack, mediaStream });
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
  }

  async createAnswer() {
    return { type: "answer", sdp: `answer-${FakePeerConnection.instances.length}` };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

class FakeSessionDescription {
  constructor(value) {
    Object.assign(this, value);
  }
}

class FakeIceCandidate {
  constructor(value) {
    Object.assign(this, value);
  }
}

function fakeTimers() {
  const timeouts = new Map();
  let nextId = 1;
  return {
    setTimeout(callback, milliseconds) {
      const id = nextId++;
      timeouts.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    runAll() {
      for (const { callback } of [...timeouts.values()]) callback();
      timeouts.clear();
    },
    timeouts,
  };
}

test("缺 TURN 时明确标为局域网能力，STUN 不能冒充 TURN", () => {
  assert.equal(hasTurnServer({ iceServers: [{ urls: "stun:stun.example" }] }), false);
  assert.equal(describeMediaConnectivity({}).mode, "local_network_only");
  assert.equal(describeMediaConnectivity({ mode: "unavailable" }).mode, "unavailable");
  assert.equal(describeMediaConnectivity({
    mode: "stun_only",
    iceServers: [{ urls: ["stun:stun.example"] }],
  }).mode, "stun_only");
  assert.equal(hasTurnServer({ iceServers: [{ urls: ["stun:x", "turns:turn.example"] }] }), true);
  assert.equal(describeMediaConnectivity({
    iceServers: [{ urls: "turn:turn.example" }],
  }).mode, "turn_configured");
});

test("浴室、错误场景、断线与不可远传媒体源无法激活 grant", () => {
  assert.equal(validateActiveGrantContext({
    grantMessage: grant(),
    ...context({ sceneId: "bathroom" }),
    nowMs: 1_000,
  }).reason, "bathroom_privacy_lock");
  assert.equal(validateActiveGrantContext({
    grantMessage: grant(),
    ...context({ sceneId: "living" }),
    nowMs: 1_000,
  }).reason, "grant_scene_mismatch");
  assert.equal(validateActiveGrantContext({
    grantMessage: grant(),
    ...context({ connected: false }),
    nowMs: 1_000,
  }).reason, "relay_disconnected");
  assert.equal(validateActiveGrantContext({
    grantMessage: grant(),
    ...context({ stream: null }),
    nowMs: 1_000,
  }).reason, "remote_stream_unavailable");
  assert.equal(validateActiveGrantContext({
    grantMessage: grant(),
    ...context({ authorized: false }),
    nowMs: 1_000,
  }).reason, "media_authority_unavailable");
});

test("Monitor 媒体信令在 handler 就绪前有界缓存并按序交付", async () => {
  const dispatcher = createBoundedMediaSignalDispatcher({ limit: 3 });
  const delivered = [];
  dispatcher.dispatch({ signal_type: "offer", from_id: "viewer-1" });
  dispatcher.dispatch({ signal_type: "ice_candidate", from_id: "viewer-1" });
  dispatcher.dispatch({ signal_type: "offer", from_id: "viewer-2" });
  dispatcher.dispatch({ signal_type: "ice_candidate", from_id: "viewer-2" });
  assert.equal(dispatcher.pendingCount, 3);
  dispatcher.setHandler(async (value) => delivered.push(value));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(delivered.map((value) => value.from_id), ["viewer-1", "viewer-2", "viewer-2"]);
  assert.deepEqual(delivered.map((value) => value.signal_type), ["offer", "offer", "ice_candidate"]);
});

test("每个 Viewer 建独立 PC，候选有界等待 offer 后再回答", async () => {
  FakePeerConnection.instances = [];
  const sent = [];
  const timers = fakeTimers();
  const videoTrack = track("video-track");
  const audioTrack = { ...track("audio-track"), kind: "audio" };
  const localStream = {
    id: "stream-with-audio",
    getTracks: () => [videoTrack, audioTrack],
  };
  const producer = createMonitorMediaProducer({
    RTCPeerConnectionImpl: FakePeerConnection,
    RTCSessionDescriptionImpl: FakeSessionDescription,
    RTCIceCandidateImpl: FakeIceCandidate,
    rtcConfiguration: { iceServers: [{ urls: "stun:stun.example" }] },
    sendSignal(value) {
      sent.push(value);
      return true;
    },
    timerApi: timers,
    now: () => 1_000,
  });
  assert.equal(producer.activate({
    grantMessage: grant(),
    ...context({ stream: localStream }),
  }).ok, true);

  const pending = await producer.handleSignal(forwardedSignal("viewer-1", "ice_candidate", {
    candidate: "candidate:1",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "ufrag-1",
  }));
  assert.equal(pending.pending, true);

  assert.equal((await producer.handleSignal(forwardedSignal("viewer-1", "offer", {
    type: "offer",
    sdp: "offer-viewer-1",
  }))).ok, true);
  assert.equal((await producer.handleSignal(forwardedSignal("viewer-2", "offer", {
    type: "offer",
    sdp: "offer-viewer-2",
  }))).ok, true);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(FakePeerConnection.instances[0].tracks.length, 1);
  assert.equal(FakePeerConnection.instances[0].tracks[0].mediaTrack.kind, "video");
  assert.equal(FakePeerConnection.instances[0].tracks[0].mediaStream, localStream);
  assert.equal(FakePeerConnection.instances[0].candidates.length, 1);
  assert.deepEqual(sent.map((value) => value.target_id), ["viewer-1", "viewer-2"]);
  assert.ok(sent.every((value) => value.signal_type === "answer"));
  assert.deepEqual(sent[0].signal, { type: "answer", sdp: "answer-1" });

  FakePeerConnection.instances[0].onicecandidate({
    candidate: {
      toJSON: () => ({
        candidate: "candidate:monitor",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "monitor-ufrag",
      }),
    },
  });
  assert.deepEqual(sent.at(-1).signal, {
    candidate: "candidate:monitor",
    sdpMid: "0",
    sdpMLineIndex: 0,
    usernameFragment: "monitor-ufrag",
  });
  assert.equal(sent.at(-1).signal_type, "ice_candidate");
  assert.equal(producer.getSnapshot().peerCount, 2);
  assert.equal(producer.getSnapshot().connectivity, "local_network_only");
});

test("Monitor 发送 answer 返回 false 时关闭对应 peer 并显式失败", async () => {
  FakePeerConnection.instances = [];
  const producer = createMonitorMediaProducer({
    RTCPeerConnectionImpl: FakePeerConnection,
    sendSignal: () => false,
    timerApi: fakeTimers(),
    now: () => 1_000,
  });
  producer.activate({ grantMessage: grant(), ...context() });

  const result = await producer.handleSignal(forwardedSignal("viewer-1", "offer", {
    type: "offer",
    sdp: "viewer-offer",
  }));

  assert.deepEqual(result, { ok: false, reason: "answer_signal_failed" });
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.equal(producer.getSnapshot().peerCount, 0);
  assert.equal(producer.getSnapshot().lastReason, "answer_signal_failed");
  assert.match(producer.getSnapshot().error, /媒体回答/);
});

test("媒体源、场景、runtime session 或 Relay 状态变化立即关闭所有 PC", async () => {
  FakePeerConnection.instances = [];
  const localStream = stream();
  const producer = createMonitorMediaProducer({
    RTCPeerConnectionImpl: FakePeerConnection,
    sendSignal: () => true,
    timerApi: fakeTimers(),
    now: () => 1_000,
  });
  producer.activate({ grantMessage: grant(), ...context({ stream: localStream }) });
  await producer.handleSignal(forwardedSignal("viewer-1", "offer", {
    type: "offer",
    sdp: "offer",
  }));
  assert.equal(FakePeerConnection.instances[0].closed, false);

  const reason = producer.reconcile(context({
    stream: localStream,
    runtimeSessionId: "runtime-2",
  }));
  assert.equal(reason, "runtime_session_changed");
  assert.equal(FakePeerConnection.instances[0].closed, true);
  assert.equal(producer.getSnapshot().peerCount, 0);
  assert.equal(producer.getSnapshot().activeGrant, null);

  producer.activate({ grantMessage: grant(), ...context({ stream: localStream }) });
  assert.equal(
    producer.reconcile(context({ stream: localStream, authorized: false })),
    "media_authority_changed",
  );
  assert.equal(producer.getSnapshot().activeGrant, null);
});

test("grant revoke/expiry 关闭 peer，过期 signal 不会复活连接", async () => {
  FakePeerConnection.instances = [];
  const timers = fakeTimers();
  let currentNow = 1_000;
  const producer = createMonitorMediaProducer({
    RTCPeerConnectionImpl: FakePeerConnection,
    sendSignal: () => true,
    timerApi: timers,
    now: () => currentNow,
  });
  producer.handleGrantMessage(grant({ expiresAtMs: 2_000 }), context());
  await producer.handleSignal(forwardedSignal("viewer-1", "offer", {
    type: "offer",
    sdp: "offer",
  }));
  currentNow = 2_000;
  timers.runAll();
  assert.equal(producer.getSnapshot().lastReason, "grant_expired");
  assert.equal((await producer.handleSignal(
    forwardedSignal("viewer-1", "offer", { type: "offer", sdp: "late" }),
  )).reason, "media_grant_inactive");

  producer.handleGrantMessage(grant({ expiresAtMs: 4_000 }), context());
  producer.handleGrantMessage(grant({ status: "revoked", expiresAtMs: 4_000 }), context());
  assert.equal(producer.getSnapshot().lastReason, "grant_revoked");
});

test("Relay signal builder 只包含 SDP/ICE，不接受原始媒体字段", () => {
  const signal = createMediaSignal({
    roomSessionId: "room-1",
    grantId: "grant-1",
    targetId: "viewer-1",
    signalType: "answer",
    signal: { type: "answer", sdp: "v=0" },
  });
  assert.deepEqual(Object.keys(signal).sort(), [
    "grant_id",
    "room_session_id",
    "schema_version",
    "signal",
    "signal_type",
    "target_id",
  ]);
  assert.throws(() => createMediaSignal({
    roomSessionId: "room-1",
    grantId: "grant-1",
    targetId: "viewer-1",
    signalType: "answer",
    signal: { type: "answer", sdp: "v=0", jpeg: "AAAA" },
  }));
});
