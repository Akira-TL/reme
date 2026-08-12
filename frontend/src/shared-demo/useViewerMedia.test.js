import assert from "node:assert/strict";
import test from "node:test";
import {
  bindViewerVideoTrackEnded,
  canViewerMediaBecomeLive,
  classifyViewerConnectionState,
  createNegotiationWatchdog,
  createRecvOnlyOffer,
  hasLiveVideoTrack,
  normalizeIceCandidate,
  summarizeViewerMediaStats,
  VIEWER_DISCONNECT_GRACE_MS,
  VIEWER_NEGOTIATION_TIMEOUT_MS,
} from "./useViewerMedia.js";

test("Viewer stats expose the selected TURN pair and non-zero inbound video", () => {
  const report = new Map([
    ["transport-1", {
      id: "transport-1",
      type: "transport",
      selectedCandidatePairId: "pair-1",
    }],
    ["pair-1", {
      id: "pair-1",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "local-1",
      remoteCandidateId: "remote-1",
      bytesReceived: 9123,
      bytesSent: 456,
      currentRoundTripTime: 0.042,
    }],
    ["local-1", {
      id: "local-1",
      type: "local-candidate",
      candidateType: "relay",
      protocol: "udp",
      relayProtocol: "udp",
    }],
    ["remote-1", {
      id: "remote-1",
      type: "remote-candidate",
      candidateType: "srflx",
      protocol: "udp",
    }],
    ["video-1", {
      id: "video-1",
      type: "inbound-rtp",
      kind: "video",
      bytesReceived: 8192,
      framesReceived: 63,
      framesDecoded: 61,
      framesDropped: 2,
      packetsReceived: 128,
      packetsLost: 1,
      jitter: 0.003,
    }],
    ["audio-1", {
      id: "audio-1",
      type: "inbound-rtp",
      kind: "audio",
      bytesReceived: 999,
    }],
  ]);

  assert.deepEqual(summarizeViewerMediaStats(report, 1234), {
    status: "sampled",
    sampledAtMs: 1234,
    selectedCandidatePair: {
      id: "pair-1",
      state: "succeeded",
      transport: "turn",
      protocol: "udp",
      relayProtocol: "udp",
      localCandidateType: "relay",
      remoteCandidateType: "srflx",
      bytesReceived: 9123,
      bytesSent: 456,
      currentRoundTripTime: 0.042,
    },
    inboundVideo: {
      bytesReceived: 8192,
      framesReceived: 63,
      framesDecoded: 61,
      framesDropped: 2,
      packetsReceived: 128,
      packetsLost: 1,
      jitter: 0.003,
    },
    error: null,
  });
});

test("Viewer stats combine multiple video SSRCs and leave absent metrics explicit", () => {
  const summary = summarizeViewerMediaStats([
    {
      id: "pair-legacy",
      type: "candidate-pair",
      selected: true,
      state: "succeeded",
      localCandidateId: "host",
      remoteCandidateId: "remote",
    },
    { id: "host", type: "local-candidate", candidateType: "host", protocol: "tcp" },
    { id: "remote", type: "remote-candidate", candidateType: "host", protocol: "tcp" },
    { id: "video-a", type: "inbound-rtp", mediaType: "video", bytesReceived: 4, framesDecoded: 1 },
    { id: "video-b", type: "inbound-rtp", kind: "video", bytesReceived: 6, framesDecoded: 2 },
  ], 2000);

  assert.equal(summary.selectedCandidatePair.transport, "direct");
  assert.equal(summary.selectedCandidatePair.protocol, "tcp");
  assert.equal(summary.selectedCandidatePair.bytesReceived, null);
  assert.deepEqual(summary.inboundVideo, {
    bytesReceived: 10,
    framesReceived: null,
    framesDecoded: 3,
    framesDropped: null,
    packetsReceived: null,
    packetsLost: null,
    jitter: null,
  });
});

test("Viewer removes the remote track listener on cleanup and fails closed on ended", () => {
  const listeners = new Map();
  const track = {
    addEventListener(name, listener, options) {
      listeners.set(name, { listener, options });
    },
    removeEventListener(name, listener) {
      if (listeners.get(name)?.listener === listener) listeners.delete(name);
    },
  };
  let ended = 0;
  const cleanup = bindViewerVideoTrackEnded(track, () => { ended += 1; });
  assert.deepEqual(listeners.get("ended")?.options, { once: true });
  listeners.get("ended").listener();
  assert.equal(ended, 1);
  cleanup();
  assert.equal(listeners.has("ended"), false);
});

class FakeViewerPeer {
  constructor() {
    this.transceivers = [];
    this.localDescription = null;
  }

  addTransceiver(kind, options) {
    this.transceivers.push({ kind, options });
  }

  async createOffer() {
    return { type: "offer", sdp: "viewer-recvonly-offer" };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
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

test("ICE normalization always emits the exact nullable wire shape", () => {
  assert.deepEqual(normalizeIceCandidate({
    candidate: "candidate:1",
    sdpMid: undefined,
    sdpMLineIndex: 0,
  }), {
    candidate: "candidate:1",
    sdpMid: null,
    sdpMLineIndex: 0,
    usernameFragment: null,
  });
});

test("ICE normalization uses toJSON without leaking extension keys", () => {
  assert.deepEqual(normalizeIceCandidate({
    toJSON() {
      return {
        candidate: "candidate:2",
        sdpMid: "0",
        sdpMLineIndex: 1,
        usernameFragment: "ufrag",
        address: "private",
      };
    },
  }), {
    candidate: "candidate:2",
    sdpMid: "0",
    sdpMLineIndex: 1,
    usernameFragment: "ufrag",
  });
});

test("Viewer creates the offer with one recvonly video transceiver", async () => {
  const peer = new FakeViewerPeer();
  const offer = await createRecvOnlyOffer(peer);
  assert.deepEqual(peer.transceivers, [{
    kind: "video",
    options: { direction: "recvonly" },
  }]);
  assert.deepEqual(offer, { type: "offer", sdp: "viewer-recvonly-offer" });
  assert.deepEqual(peer.localDescription, offer);
});

test("Viewer fails closed when recvonly negotiation is unavailable", async () => {
  await assert.rejects(
    createRecvOnlyOffer({ createOffer() {} }),
    /recvonly transceiver/,
  );
});

test("Viewer negotiation timeout closes the peer and falls back to skeleton", () => {
  const timers = fakeTimers();
  const peer = { closed: false, close() { this.closed = true; } };
  let status = "connecting";
  let mode = "video";
  const watchdog = createNegotiationWatchdog({
    timerApi: timers,
    onTimeout() {
      peer.close();
      status = "failed";
      mode = "skeleton";
    },
  });

  assert.equal(watchdog.start(), true);
  assert.equal(timers.timeouts.size, 1);
  assert.equal([...timers.timeouts.values()][0].milliseconds, VIEWER_NEGOTIATION_TIMEOUT_MS);
  assert.ok(VIEWER_NEGOTIATION_TIMEOUT_MS >= 5_000);
  assert.ok(VIEWER_NEGOTIATION_TIMEOUT_MS <= 8_000);

  timers.runAll();
  assert.equal(peer.closed, true);
  assert.equal(status, "failed");
  assert.equal(mode, "skeleton");
});

test("Viewer live success clears the generation negotiation timeout", () => {
  const timers = fakeTimers();
  let timeoutCount = 0;
  const watchdog = createNegotiationWatchdog({
    timerApi: timers,
    onTimeout() { timeoutCount += 1; },
  });

  watchdog.start();
  assert.equal(watchdog.complete(), true);
  assert.equal(timers.timeouts.size, 0);
  timers.runAll();
  assert.equal(timeoutCount, 0);
  assert.equal(watchdog.complete(), false);
});

test("connected is live only when a non-ended video track exists", () => {
  const connected = { connectionState: "connected" };
  assert.equal(canViewerMediaBecomeLive(connected, null), false);
  assert.equal(canViewerMediaBecomeLive(connected, {
    getTracks: () => [{ kind: "audio", readyState: "live" }],
  }), false);
  assert.equal(canViewerMediaBecomeLive(connected, {
    getVideoTracks: () => [{ kind: "video", readyState: "ended" }],
  }), false);
  const stream = {
    getVideoTracks: () => [{ kind: "video", readyState: "live" }],
  };
  assert.equal(hasLiveVideoTrack(stream), true);
  assert.equal(canViewerMediaBecomeLive(connected, stream), true);
  assert.equal(canViewerMediaBecomeLive({ connectionState: "connecting" }, stream), false);
});

test("transient disconnected uses grace while failed and closed fail immediately", () => {
  assert.equal(classifyViewerConnectionState("disconnected"), "grace");
  assert.equal(classifyViewerConnectionState("connected"), "connected");
  assert.equal(classifyViewerConnectionState("failed"), "failed");
  assert.equal(classifyViewerConnectionState("closed"), "failed");
  assert.equal(classifyViewerConnectionState("connecting"), "waiting");

  const recoveredTimers = fakeTimers();
  let failureCount = 0;
  const recovered = createNegotiationWatchdog({
    timerApi: recoveredTimers,
    timeoutMs: VIEWER_DISCONNECT_GRACE_MS,
    onTimeout() { failureCount += 1; },
  });
  recovered.start();
  recovered.complete();
  recoveredTimers.runAll();
  assert.equal(failureCount, 0);

  const sustainedTimers = fakeTimers();
  const sustained = createNegotiationWatchdog({
    timerApi: sustainedTimers,
    timeoutMs: VIEWER_DISCONNECT_GRACE_MS,
    onTimeout() { failureCount += 1; },
  });
  sustained.start();
  assert.equal([...sustainedTimers.timeouts.values()][0].milliseconds, 2_000);
  sustainedTimers.runAll();
  assert.equal(failureCount, 1);
});
