import assert from "node:assert/strict";
import test from "node:test";
import { createDemoEvent } from "./protocol.js";
import {
  createControllerMediaBridge,
  createMediaGrantRequestTracker,
} from "./controllerMedia.js";

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
    PeerConnection: FakePeerConnection,
  });

  assert.equal(await bridge.startGrant(grant(), ["viewer-1", "viewer-2"]), true);
  assert.equal(FakePeerConnection.instances.length, 2);
  assert.equal(FakePeerConnection.instances[0].tracks[0].track, videoTrack);
  assert.deepEqual(messages.map((message) => message.target_id).sort(), ["viewer-1", "viewer-2"]);
  assert.ok(messages.every((message) => message.signal_type === "offer"));
});

test("controller incrementally adds viewers when the same grant audience is repeated", async () => {
  FakePeerConnection.instances = [];
  const messages = [];
  const socket = { readyState: 1, send: (message) => messages.push(JSON.parse(message)) };
  const bridge = createControllerMediaBridge({
    getSocket: () => socket,
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
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

test("controller refuses expired grants and signals from unauthorized viewers", async () => {
  const bridge = createControllerMediaBridge({
    getSocket: () => ({ readyState: 1, send() {} }),
    getStream: () => ({ getVideoTracks: () => [{ kind: "video" }] }),
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
