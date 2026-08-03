import assert from "node:assert/strict";
import test from "node:test";
import { createDemoEvent } from "./protocol.js";
import {
  canAutomaticallyOpenInitialFallMedia,
  canStartKitchenRecognition,
  createControllerMediaBridge,
  createMediaGrantRequestTracker,
  MAX_CONTROLLER_MEDIA_ICE_CANDIDATES,
  selectAutomaticFallMediaAction,
  selectFallMediaActionAfterAlarmAck,
  selectFallMediaRegrantAction,
  selectKitchenRecognitionAction,
} from "./controllerMedia.js";

const RELIABLE_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: ["stun:stun.cloudflare.com:3478"] }),
  Object.freeze({
    urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
    username: "short-user",
    credential: "short-secret",
  }),
]);

function reliableIceResult({ iceServers = RELIABLE_ICE_SERVERS, ttlMs = 30_000 } = {}) {
  return {
    iceServers,
    expiresAtMs: Date.now() + ttlMs,
    receivedAtMs: Date.now(),
    ttlMs,
  };
}

const getReliableIceServers = async () => reliableIceResult();

const LIVE_INITIAL_FALL_MEDIA_CONTEXT = Object.freeze({
  visibilityState: "visible",
  captureActive: true,
  streamActive: true,
  sessionActive: true,
  connectionReady: true,
});

class FakePeerConnection {
  static instances = [];

  constructor(configuration) {
    this.configuration = configuration;
    this.tracks = [];
    this.candidates = [];
    this.connectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  addTrack(track, stream) {
    this.tracks.push({ track, stream });
  }

  async createOffer() {
    return { type: "offer", sdp: "v=0\r\no=fake" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate) {
    this.candidates.push(candidate);
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function grant() {
  return createDemoEvent({
    sessionId: "session-a",
    eventSequence: 4,
    timestampMs: Date.now(),
    eventType: "media_grant",
    payload: {
      grant_id: "grant-1",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_at_ms: Date.now() + 30_000,
      status: "active",
    },
  });
}

test("controller opens one video-only offer for each authorized viewer", async () => {
  FakePeerConnection.instances = [];
  const messages = [];
  const socket = { readyState: 1, send: (message) => messages.push(JSON.parse(message)) };
  const videoTrack = { kind: "video" };
  const stream = { getVideoTracks: () => [videoTrack] };
  const bridge = createControllerMediaBridge({
    getSocket: () => socket,
    getStream: () => stream,
    getIceServers: getReliableIceServers,
    PeerConnection: FakePeerConnection,
  });

  assert.equal(await bridge.startGrant(grant(), ["viewer-1", "viewer-2"]), true);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.deepEqual(FakePeerConnection.instances[0].configuration.iceServers, RELIABLE_ICE_SERVERS);
  assert.equal(FakePeerConnection.instances[0].tracks[0].track, videoTrack);
  assert.deepEqual(messages.map((message) => message.target_id).sort(), ["viewer-1", "viewer-2"]);
  assert.ok(messages.every((message) => message.signal_type === "offer"));
});

test("controller fails closed when an OPEN socket send throws", async () => {
  FakePeerConnection.instances = [];
  let shouldThrow = false;
  const statuses = [];
  const socket = {
    readyState: 1,
    send() {
      if (shouldThrow) throw new Error("socket closed between readyState and send");
    },
  };
  const bridge = createControllerMediaBridge({
    getSocket: () => socket,
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    onStatus: (status) => statuses.push(status),
    PeerConnection: FakePeerConnection,
  });

  await bridge.startGrant(grant(), ["viewer-1"]);
  const peer = FakePeerConnection.instances[0];
  shouldThrow = true;
  assert.doesNotThrow(() => peer.onicecandidate({
    candidate: { candidate: "candidate:1", sdpMid: "0", sdpMLineIndex: 0 },
  }));
  assert.equal(peer.closed, true);
  assert.equal(statuses.at(-1).state, "signal_unavailable");
});

test("controller incrementally adds viewers when the same grant audience is repeated", async () => {
  FakePeerConnection.instances = [];
  const messages = [];
  const socket = { readyState: 1, send: (message) => messages.push(JSON.parse(message)) };
  const bridge = createControllerMediaBridge({
    getSocket: () => socket,
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), true);
  const firstPeer = FakePeerConnection.instances[0];
  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), true);
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(firstPeer.closed, false);

  assert.equal(
    await bridge.startGrant(activeGrant, ["viewer-1", "viewer-2", "viewer-2"]),
    true,
  );
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(firstPeer.closed, false);
  assert.deepEqual(messages.map((message) => message.target_id), ["viewer-1", "viewer-2"]);

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-2"]), true);
  assert.equal(firstPeer.closed, true);
  assert.equal(FakePeerConnection.instances[1].closed, false);
});

test("a stale peer close callback cannot close its replacement", async () => {
  FakePeerConnection.instances = [];
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  await bridge.startGrant(activeGrant, ["viewer-1"]);
  const oldPeer = FakePeerConnection.instances[0];
  const staleCloseHandler = oldPeer.onconnectionstatechange;
  oldPeer.connectionState = "failed";
  staleCloseHandler();
  await bridge.startGrant(activeGrant, ["viewer-1"]);
  const replacement = FakePeerConnection.instances[1];

  staleCloseHandler();
  assert.equal(replacement.closed, false);
});

test("a stale createOffer rejection cannot close a replacement peer", async () => {
  FakePeerConnection.instances = [];
  let rejectOldOffer;
  class DeferredOfferPeer extends FakePeerConnection {
    createOffer() {
      if (FakePeerConnection.instances[0] === this) {
        return new Promise((_resolve, reject) => { rejectOldOffer = reject; });
      }
      return super.createOffer();
    }
  }
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: DeferredOfferPeer,
  });
  const activeGrant = grant();

  const oldStart = bridge.startGrant(activeGrant, ["viewer-1"]);
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  assert.equal(typeof rejectOldOffer, "function");
  await bridge.startGrant(activeGrant, []);
  await bridge.startGrant(activeGrant, ["viewer-1"]);
  const replacement = FakePeerConnection.instances[1];

  rejectOldOffer(new Error("stale offer failed"));
  await oldStart;
  assert.equal(replacement.closed, false);
});

test("a stale answer rejection cannot close a replacement peer", async () => {
  FakePeerConnection.instances = [];
  let rejectOldAnswer;
  class DeferredAnswerPeer extends FakePeerConnection {
    setRemoteDescription(description) {
      if (FakePeerConnection.instances[0] === this) {
        return new Promise((_resolve, reject) => { rejectOldAnswer = reject; });
      }
      return super.setRemoteDescription(description);
    }
  }
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: DeferredAnswerPeer,
  });
  const activeGrant = grant();
  await bridge.startGrant(activeGrant, ["viewer-1"]);
  const oldAnswer = bridge.handleSignal({
    schema_version: "reme-media-signal/v1",
    grant_id: "grant-1",
    target_id: "controller",
    from_id: "viewer-1",
    signal_type: "answer",
    signal: { sdp: "v=0\r\na=old-answer" },
  });
  await Promise.resolve();
  assert.equal(typeof rejectOldAnswer, "function");
  await bridge.startGrant(activeGrant, []);
  await bridge.startGrant(activeGrant, ["viewer-1"]);
  const replacement = FakePeerConnection.instances[1];

  rejectOldAnswer(new Error("stale answer failed"));
  assert.equal(await oldAnswer, false);
  assert.equal(replacement.closed, false);
});

test("pending grant acknowledgements fail closed after hide, scene switch, or capture restart", () => {
  const scenarios = [
    { name: "hidden", current: { visibilityState: "hidden" } },
    { name: "scene switched", current: { sceneId: "bathroom", kitchenEventId: null } },
    { name: "capture stopped", current: { captureActive: false } },
    { name: "capture restarted", current: { captureGeneration: 8 } },
  ];
  const kitchenGrant = {
    ...grant(),
    payload: {
      ...grant().payload,
      event_id: "activity-3",
      scope: "kitchen_moment",
    },
  };

  for (const scenario of scenarios) {
    const tracker = createMediaGrantRequestTracker();
    tracker.begin({
      eventId: "activity-3",
      scope: "kitchen_moment",
      sceneId: "kitchen",
      captureGeneration: 7,
      visibilityState: "visible",
    });
    const current = {
      sceneId: "kitchen",
      captureActive: true,
      captureGeneration: 7,
      visibilityState: "visible",
      kitchenEventId: "activity-3",
      fall: null,
      ...scenario.current,
    };
    assert.equal(tracker.classify(kitchenGrant, { current }), "revoke", scenario.name);
  }
});

test("grant request generation rejects a late acknowledgement after invalidation", () => {
  const tracker = createMediaGrantRequestTracker();
  const kitchenGrant = {
    ...grant(),
    payload: {
      ...grant().payload,
      event_id: "activity-3",
      scope: "kitchen_moment",
    },
  };
  const current = {
    sceneId: "kitchen",
    captureActive: true,
    captureGeneration: 3,
    visibilityState: "visible",
    kitchenEventId: "activity-3",
    fall: null,
  };
  tracker.begin({
    eventId: "activity-3",
    scope: "kitchen_moment",
    sceneId: "kitchen",
    captureGeneration: 3,
    visibilityState: "visible",
  });
  assert.equal(tracker.classify(kitchenGrant, { current }), "accept_initial");
  tracker.invalidate();
  assert.equal(tracker.classify(kitchenGrant, { current }), "revoke");
});

test("fall grant acknowledgements require the authoritative accepted fall context", () => {
  const tracker = createMediaGrantRequestTracker();
  tracker.begin({
    eventId: "fall-1",
    scope: "fall_emergency",
    sceneId: "fall",
    captureGeneration: 4,
    visibilityState: "visible",
  });
  const current = {
    sceneId: "fall",
    captureActive: true,
    captureGeneration: 4,
    visibilityState: "visible",
    kitchenEventId: null,
    fall: { eventId: "fall-1", phase: "escalated", delivery: "accepted" },
  };
  assert.equal(tracker.classify(grant(), { current }), "accept_initial");
  assert.equal(tracker.classify(grant(), {
    current: { ...current, sceneId: "living" },
  }), "revoke");
  assert.equal(tracker.classify(grant(), {
    current: { ...current, fall: { ...current.fall, delivery: "pending" } },
  }), "revoke");
});

test("controller queues viewer ICE until the answer and closes on revoke", async () => {
  FakePeerConnection.instances = [];
  const socket = { readyState: 1, send() {} };
  const bridge = createControllerMediaBridge({
    getSocket: () => socket,
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: FakePeerConnection,
  });
  await bridge.startGrant(grant(), ["viewer-1"]);
  const peer = FakePeerConnection.instances[0];
  const base = {
    schema_version: "reme-media-signal/v1",
    grant_id: "grant-1",
    target_id: "controller",
    from_id: "viewer-1",
  };
  assert.equal(await bridge.handleSignal({
    ...base,
    signal_type: "ice_candidate",
    signal: { candidate: "candidate:1", sdp_mid: "0", sdp_mline_index: 0 },
  }), true);
  assert.equal(peer.candidates.length, 0);
  assert.equal(await bridge.handleSignal({
    ...base,
    signal_type: "answer",
    signal: { sdp: "v=0\r\na=answer" },
  }), true);
  assert.equal(peer.remoteDescription.type, "answer");
  assert.equal(peer.candidates.length, 1);
  assert.equal(bridge.stopGrant("grant-1"), true);
  assert.equal(peer.closed, true);
  assert.equal(bridge.activeGrantId(), null);
});

test("controller closes a viewer that exceeds the per-grant ICE candidate limit", async () => {
  FakePeerConnection.instances = [];
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: FakePeerConnection,
  });
  await bridge.startGrant(grant(), ["viewer-1"]);
  const peer = FakePeerConnection.instances[0];
  const base = {
    schema_version: "reme-media-signal/v1",
    grant_id: "grant-1",
    target_id: "controller",
    from_id: "viewer-1",
    signal_type: "ice_candidate",
  };

  for (let index = 0; index < MAX_CONTROLLER_MEDIA_ICE_CANDIDATES; index += 1) {
    assert.equal(await bridge.handleSignal({
      ...base,
      signal: {
        candidate: `candidate:${index}`,
        sdp_mid: "0",
        sdp_mline_index: 0,
      },
    }), true);
  }
  assert.equal(peer.closed, false);
  assert.equal(await bridge.handleSignal({
    ...base,
    signal: {
      candidate: "candidate:overflow",
      sdp_mid: "0",
      sdp_mline_index: 0,
    },
  }), false);
  assert.equal(peer.closed, true);
});

test("controller refuses expired grants and signals from unauthorized viewers", async () => {
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: getReliableIceServers,
    PeerConnection: FakePeerConnection,
  });
  const expired = {
    ...grant(),
    payload: { ...grant().payload, expires_at_ms: Date.now() - 1 },
  };
  assert.equal(await bridge.startGrant(expired, ["viewer-1"]), false);
  await bridge.startGrant(grant(), ["viewer-1"]);
  assert.equal(await bridge.handleSignal({
    schema_version: "reme-media-signal/v1",
    grant_id: "grant-1",
    target_id: "controller",
    from_id: "viewer-unknown",
    signal_type: "answer",
    signal: { sdp: "v=0" },
  }), false);
});

test("controller obtains short-lived reliable ICE before creating any peer", async () => {
  FakePeerConnection.instances = [];
  let resolveIce;
  const iceRequest = new Promise((resolve) => { resolveIce = resolve; });
  const statuses = [];
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: () => iceRequest,
    onStatus: (status) => statuses.push(status),
    PeerConnection: FakePeerConnection,
  });

  const started = bridge.startGrant(grant(), ["viewer-1"]);
  await Promise.resolve();
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(statuses.at(-1).state, "credentialing");

  resolveIce(reliableIceResult());
  assert.equal(await started, true);
  assert.equal(FakePeerConnection.instances.length, 1);
  assert.equal(statuses.some((status) => status.state === "connecting"), true);
});

test("controller fails closed when reliable ICE is unavailable and never creates STUN-only peer", async () => {
  FakePeerConnection.instances = [];
  const statuses = [];
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: async () => {
      throw new Error("可靠实景中继尚未配置；已保持隐私骨架。");
    },
    onStatus: (status) => statuses.push(status),
    PeerConnection: FakePeerConnection,
  });

  assert.equal(await bridge.startGrant(grant(), ["viewer-1"]), false);
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(statuses.at(-1).state, "ice_unavailable");
  assert.match(statuses.at(-1).error, /尚未配置/);
});

test("controller cancels an in-flight ICE request when the grant is revoked", async () => {
  FakePeerConnection.instances = [];
  let observedSignal = null;
  let settleRequest;
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: (_grant, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve) => { settleRequest = resolve; });
    },
    PeerConnection: FakePeerConnection,
  });

  const started = bridge.startGrant(grant(), ["viewer-1"]);
  await Promise.resolve();
  bridge.stopGrant("grant-1", "revoked");
  assert.equal(observedSignal.aborted, true);
  settleRequest(reliableIceResult());
  assert.equal(await started, false);
  assert.equal(FakePeerConnection.instances.length, 0);
});

test("controller does not create a peer when the audience empties during ICE fetch", async () => {
  FakePeerConnection.instances = [];
  const messages = [];
  let observedSignal = null;
  let settleRequest;
  const bridge = createControllerMediaBridge({
    getSocket: () => ({
      readyState: 1,
      send: (message) => messages.push(JSON.parse(message)),
    }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: (_grant, { signal }) => {
      observedSignal = signal;
      return new Promise((resolve) => { settleRequest = resolve; });
    },
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  const started = bridge.startGrant(activeGrant, ["viewer-removed"]);
  await Promise.resolve();
  assert.equal(await bridge.startGrant(activeGrant, []), true);
  assert.equal(observedSignal.aborted, true);

  settleRequest(reliableIceResult());
  assert.equal(await started, false);
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(messages.length, 0);
});

test("controller defers ICE credentials for an empty grant and fetches when a late viewer joins", async () => {
  FakePeerConnection.instances = [];
  let iceRequests = 0;
  const statuses = [];
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: async () => {
      iceRequests += 1;
      return reliableIceResult();
    },
    onStatus: (status) => statuses.push(status),
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  assert.equal(await bridge.startGrant(activeGrant, []), true);
  assert.equal(iceRequests, 0);
  assert.equal(statuses.at(-1).state, "waiting_viewer");

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-late"]), true);
  assert.equal(iceRequests, 1);
  assert.equal(FakePeerConnection.instances.length, 1);
});

test("controller refetches expired ICE before adding a late viewer to the same grant", async () => {
  FakePeerConnection.instances = [];
  let monotonicMs = 100;
  let iceRequests = 0;
  const firstServers = RELIABLE_ICE_SERVERS.map((server) => ({ ...server }));
  firstServers[1] = { ...firstServers[1], credential: "expired-secret" };
  const freshServers = RELIABLE_ICE_SERVERS.map((server) => ({ ...server }));
  freshServers[1] = { ...freshServers[1], credential: "fresh-secret" };
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: async () => {
      iceRequests += 1;
      return reliableIceResult({
        iceServers: iceRequests === 1 ? firstServers : freshServers,
        ttlMs: 2_000,
      });
    },
    monotonicNow: () => monotonicMs,
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), true);
  const firstPeer = FakePeerConnection.instances[0];
  assert.equal(firstPeer.configuration.iceServers[1].credential, "expired-secret");
  monotonicMs += 2_001;

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1", "viewer-2"]), true);
  assert.equal(iceRequests, 2);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(firstPeer.closed, false, "an established peer remains until grant revocation");
  assert.equal(
    FakePeerConnection.instances[1].configuration.iceServers[1].credential,
    "fresh-secret",
  );
});

test("controller refetches ICE when the cached lifetime is too short for a new handshake", async () => {
  FakePeerConnection.instances = [];
  let monotonicMs = 50;
  let iceRequests = 0;
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: async () => {
      iceRequests += 1;
      return reliableIceResult({ ttlMs: 2_000 });
    },
    monotonicNow: () => monotonicMs,
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), true);
  monotonicMs += 1_001;
  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1", "viewer-2"]), true);
  assert.equal(iceRequests, 2);
  assert.equal(FakePeerConnection.instances.length, 2);
});

test("controller aborts an expired-cache refetch when the same grant is revoked", async () => {
  FakePeerConnection.instances = [];
  let monotonicMs = 100;
  let iceRequests = 0;
  let refreshSignal = null;
  let settleRefresh;
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: (_grant, { signal }) => {
      iceRequests += 1;
      if (iceRequests === 1) return Promise.resolve(reliableIceResult({ ttlMs: 2_000 }));
      refreshSignal = signal;
      return new Promise((resolve) => { settleRefresh = resolve; });
    },
    monotonicNow: () => monotonicMs,
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), true);
  const firstPeer = FakePeerConnection.instances[0];
  monotonicMs += 2_001;
  const lateViewer = bridge.startGrant(activeGrant, ["viewer-1", "viewer-2"]);
  await Promise.resolve();
  assert.equal(iceRequests, 2);
  assert.equal(refreshSignal.aborted, false);

  assert.equal(bridge.stopGrant("grant-1", "revoked"), true);
  assert.equal(refreshSignal.aborted, true);
  assert.equal(firstPeer.closed, true);
  settleRefresh(reliableIceResult({ ttlMs: 2_000 }));
  assert.equal(await lateViewer, false);
  assert.equal(FakePeerConnection.instances.length, 1);
});

test("controller can retry a failed bounded ICE request only when the audience is delivered again", async () => {
  FakePeerConnection.instances = [];
  let iceRequests = 0;
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
    getIceServers: async () => {
      iceRequests += 1;
      if (iceRequests === 1) throw new Error("temporary TURN outage");
      return reliableIceResult();
    },
    PeerConnection: FakePeerConnection,
  });
  const activeGrant = grant();

  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), false);
  assert.equal(iceRequests, 1);
  assert.equal(FakePeerConnection.instances.length, 0);
  assert.equal(await bridge.startGrant(activeGrant, ["viewer-1"]), true);
  assert.equal(iceRequests, 2);
  assert.equal(FakePeerConnection.instances.length, 1);
});

test("automatic kitchen scene offers an explicit independent cooking gate without auto-starting it", () => {
  assert.equal(selectKitchenRecognitionAction({
    sceneId: "kitchen",
    recognitionEnabled: false,
    activityPhase: "candidate",
    kitchenEventId: null,
  }), "start");
  assert.equal(selectKitchenRecognitionAction({
    sceneId: "kitchen",
    recognitionEnabled: true,
    activityPhase: "candidate",
    kitchenEventId: null,
  }), null);
  assert.equal(selectKitchenRecognitionAction({
    sceneId: "kitchen",
    recognitionEnabled: true,
    activityPhase: "unavailable",
    kitchenEventId: null,
  }), "retry");
  assert.equal(canStartKitchenRecognition({
    sceneId: "kitchen",
    captureActive: true,
    connectionReady: true,
    visibilityState: "visible",
    automaticScenePhase: "result",
    kitchenEventId: null,
    pendingKitchenGrant: null,
  }), true);
  assert.equal(canStartKitchenRecognition({
    sceneId: "kitchen",
    captureActive: true,
    connectionReady: true,
    visibilityState: "visible",
    automaticScenePhase: "analyzing",
    kitchenEventId: null,
    pendingKitchenGrant: null,
  }), false, "the automatic scene request must settle before a separate cooking request starts");
});

test("fall regrant is available only for authoritative accepted escalation after the prior grant ends", () => {
  const base = {
    fall: {
      phase: "escalated",
      delivery: "accepted",
      eventId: "fall-1",
    },
    sceneId: "fall",
    captureActive: true,
    connectionReady: true,
    visibilityState: "visible",
    mediaStatus: "expired",
    activeGrant: null,
  };
  assert.deepEqual(selectFallMediaRegrantAction(base), {
    action: "request",
    eventId: "fall-1",
  });
  assert.deepEqual(selectFallMediaRegrantAction({
    ...base,
    mediaStatus: "connected",
    activeGrant: grant(),
  }), {
    action: "block",
    eventId: null,
  });

  for (const overrides of [
    { fall: { ...base.fall, phase: "checking" } },
    { fall: { ...base.fall, delivery: "pending" } },
    { sceneId: "kitchen" },
    { captureActive: false },
    { connectionReady: false },
    { visibilityState: "hidden" },
    { mediaStatus: "authorizing" },
  ]) {
    assert.equal(selectFallMediaRegrantAction({ ...base, ...overrides }).action, "block");
  }
});

test("only a first online escalation may auto-open fall media", () => {
  const acceptedFall = {
    phase: "escalated",
    delivery: "accepted",
    eventId: "fall-1",
  };
  assert.deepEqual(selectAutomaticFallMediaAction({
    fall: acceptedFall,
    allowInitialMedia: true,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), {
    action: "request",
    eventId: "fall-1",
  });
  assert.deepEqual(selectAutomaticFallMediaAction({
    fall: acceptedFall,
    allowInitialMedia: false,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), {
    action: "wait_explicit",
    eventId: "fall-1",
  }, "controller_ready and alarm replay must wait for the explicit reopen button");
  assert.deepEqual(selectAutomaticFallMediaAction({
    fall: acceptedFall,
    allowInitialMedia: true,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
    visibilityState: "hidden",
  }), {
    action: "wait_explicit",
    eventId: "fall-1",
  }, "a hidden page cannot auto-open a live grant even after an accepted escalation");
  assert.deepEqual(selectAutomaticFallMediaAction({
    fall: { ...acceptedFall, delivery: "pending" },
    allowInitialMedia: true,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), {
    action: "none",
    eventId: null,
  });
});

test("hidden fall starts and deadline races cannot retain initial media eligibility", () => {
  assert.equal(canAutomaticallyOpenInitialFallMedia({
    eligibleEventId: "fall-1",
    eventId: "fall-1",
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), true);
  assert.equal(canAutomaticallyOpenInitialFallMedia({
    eligibleEventId: "fall-1",
    eventId: "fall-1",
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
    visibilityState: "hidden",
  }), false);
  assert.equal(canAutomaticallyOpenInitialFallMedia({
    eligibleEventId: null,
    eventId: "fall-1",
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), false);
  assert.deepEqual(selectFallMediaActionAfterAlarmAck({
    fall: {
      phase: "escalated",
      delivery: "accepted",
      eventId: "fall-1",
    },
    pending: {
      eventId: "fall-1",
      phase: "escalated",
      eventSequence: 20,
      allowInitialMedia: true,
    },
    eventSequence: 20,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
    visibilityState: "hidden",
  }), {
    action: "wait_explicit",
    eventId: "fall-1",
  });
});

test("reconnect alarm acknowledgements cannot reuse the initial media ACK path", () => {
  const fall = {
    phase: "escalated",
    delivery: "accepted",
    eventId: "fall-1",
  };
  const pending = {
    eventId: "fall-1",
    phase: "escalated",
    eventSequence: 12,
    allowInitialMedia: true,
  };
  assert.deepEqual(selectFallMediaActionAfterAlarmAck({
    fall,
    pending,
    eventSequence: 12,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), {
    action: "request",
    eventId: "fall-1",
  });
  assert.deepEqual(selectFallMediaActionAfterAlarmAck({
    fall,
    pending: { ...pending, allowInitialMedia: false },
    eventSequence: 12,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), {
    action: "wait_explicit",
    eventId: "fall-1",
  }, "republish_escalated ACK must not auto-request media");
  assert.deepEqual(selectFallMediaActionAfterAlarmAck({
    fall,
    pending,
    eventSequence: 13,
    ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
  }), {
    action: "wait_explicit",
    eventId: "fall-1",
  });
});

test("checking interruption alarm ACKs never request initial real media", () => {
  const fall = {
    phase: "escalated",
    delivery: "accepted",
    eventId: "fall-1",
  };
  const pending = {
    eventId: "fall-1",
    phase: "escalated",
    eventSequence: 21,
    allowInitialMedia: true,
  };
  const cases = [
    {
      name: "stopCapture",
      context: { captureActive: false, streamActive: false },
    },
    {
      name: "releaseControl",
      context: {},
      pending: { ...pending, allowInitialMedia: false },
    },
    {
      name: "pagehide",
      context: { visibilityState: "hidden" },
    },
    {
      name: "invalidateControllerSession",
      context: { sessionActive: false, connectionReady: false },
    },
    {
      name: "controller disconnect",
      context: { connectionReady: false },
    },
  ];

  for (const entry of cases) {
    const action = selectFallMediaActionAfterAlarmAck({
      fall,
      pending: entry.pending || pending,
      eventSequence: 21,
      ...LIVE_INITIAL_FALL_MEDIA_CONTEXT,
      ...entry.context,
    });
    assert.deepEqual(action, {
      action: "wait_explicit",
      eventId: "fall-1",
    }, `${entry.name} must produce zero media_grant_request commands`);
  }
});
