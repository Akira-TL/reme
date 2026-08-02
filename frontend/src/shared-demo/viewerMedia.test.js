import assert from "node:assert/strict";
import test from "node:test";

import {
  VIEWER_RTC_CONFIGURATION,
  createViewerMediaSession,
  isSignalForViewer,
} from "./useViewerMedia.js";

class FakeTrack {
  constructor() {
    this.onended = null;
    this.stopCount = 0;
  }

  stop() {
    this.stopCount += 1;
  }
}

class FakeStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }
}

class FakePeerConnection {
  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.remoteDescription = null;
    this.localDescription = null;
    this.addedIce = [];
    this.receivers = [];
    this.closed = false;
    this.onicecandidate = null;
    this.ontrack = null;
    this.onconnectionstatechange = null;
    this.oniceconnectionstatechange = null;
  }

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async createAnswer() {
    return { type: "answer", sdp: "answer-sdp" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  async addIceCandidate(candidate) {
    this.addedIce.push(candidate);
  }

  getReceivers() {
    return this.receivers;
  }

  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

function forwarded(signalType, signal, overrides = {}) {
  return {
    schema_version: "reme-media-signal/v1",
    grant_id: "grant-1",
    target_id: "viewer-1",
    from_id: "controller-1",
    signal_type: signalType,
    signal,
    ...overrides,
  };
}

test("viewer media accepts only signals for its active grant and viewer id", () => {
  const offer = forwarded("offer", { sdp: "v=0" });
  assert.equal(isSignalForViewer(offer, { grantId: "grant-1", viewerId: "viewer-1" }), true);
  assert.equal(isSignalForViewer({ ...offer, grant_id: "grant-2" }, {
    grantId: "grant-1",
    viewerId: "viewer-1",
  }), false);
  assert.equal(isSignalForViewer({ ...offer, target_id: "viewer-2" }, {
    grantId: "grant-1",
    viewerId: "viewer-1",
  }), false);
});

test("viewer media answers offers, flushes queued ICE, and stops all resources", async () => {
  const peers = [];
  const sent = [];
  const states = [];
  const session = createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    sendSignal: (message) => {
      sent.push(message);
      return true;
    },
    onState: (state) => states.push(state),
    peerConnectionFactory: (configuration) => {
      const peer = new FakePeerConnection(configuration);
      peers.push(peer);
      return peer;
    },
    mediaStreamFactory: (tracks) => new FakeStream(tracks),
  });

  await session.handleSignal(forwarded("ice_candidate", {
    candidate: "candidate:1",
    sdp_mid: "0",
    sdp_mline_index: 0,
  }));
  await session.handleSignal(forwarded("offer", { sdp: "offer-sdp" }));

  assert.equal(peers.length, 1);
  assert.equal(peers[0].configuration.iceServers[0].urls, "stun:stun.cloudflare.com:3478");
  assert.equal(VIEWER_RTC_CONFIGURATION.iceServers[0].urls, "stun:stun.cloudflare.com:3478");
  assert.deepEqual(peers[0].addedIce, [{
    candidate: "candidate:1",
    sdpMid: "0",
    sdpMLineIndex: 0,
  }]);
  assert.equal(sent[0].signal_type, "answer");
  assert.equal(sent[0].target_id, "controller-1");
  assert.deepEqual(sent[0].signal, { sdp: "answer-sdp" });

  peers[0].onicecandidate({
    candidate: { candidate: "candidate:2", sdpMid: "0", sdpMLineIndex: 0 },
  });
  assert.equal(sent[1].signal_type, "ice_candidate");
  assert.deepEqual(sent[1].signal, {
    candidate: "candidate:2",
    sdp_mid: "0",
    sdp_mline_index: 0,
  });

  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  peers[0].receivers = [{ track }];
  peers[0].ontrack({ track, streams: [stream] });
  peers[0].connectionState = "connected";
  peers[0].onconnectionstatechange();
  assert.equal(states.at(-1).status, "live");
  assert.equal(states.at(-1).stream, stream);

  session.close("expired");
  assert.equal(peers[0].closed, true);
  assert.ok(track.stopCount > 0);
  assert.deepEqual(states.at(-1), { status: "expired", error: null, stream: null });
});

test("viewer media failure is local and remains explicit", async () => {
  const states = [];
  const session = createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    sendSignal: () => false,
    onState: (state) => states.push(state),
    peerConnectionFactory: (configuration) => new FakePeerConnection(configuration),
    mediaStreamFactory: (tracks) => new FakeStream(tracks),
  });
  await session.handleSignal(forwarded("offer", { sdp: "offer-sdp" }));
  assert.equal(states.at(-1).status, "failed");
  assert.match(states.at(-1).error, /告警与结构化信息仍然有效/);
});

test("unsupported WebRTC becomes an explicit media-only failure", async () => {
  const states = [];
  const session = createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    sendSignal: () => true,
    onState: (state) => states.push(state),
    peerConnectionFactory: () => {
      throw new Error("RTCPeerConnection unavailable");
    },
  });
  await session.handleSignal(forwarded("offer", { sdp: "offer-sdp" }));
  assert.equal(states.at(-1).status, "failed");
  assert.match(states.at(-1).error, /RTCPeerConnection unavailable/);
});
