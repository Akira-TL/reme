import assert from "node:assert/strict";
import test from "node:test";

import {
  VIEWER_RTC_CONFIGURATION,
  VIEWER_VIDEO_FRAME_TIMEOUT_MS,
  closeViewerMediaImmediately,
  createViewerVideoGuard,
  createViewerMediaSession,
  isRenderableViewerVideoFrame,
  isSignalForViewer,
  viewerGrantFallbackMs,
} from "./useViewerMedia.js";

class FakeTrack {
  constructor() {
    this.onended = null;
    this.onmute = null;
    this.onunmute = null;
    this.stopCount = 0;
    this.kind = "video";
    this.muted = false;
    this.enabled = true;
    this.readyState = "live";
  }

  stop() {
    this.stopCount += 1;
    this.readyState = "ended";
  }
}

class FakeStream {
  constructor(tracks = []) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === "video");
  }
}

class FakeVideo {
  constructor(stream = null) {
    this.srcObject = stream;
    this.videoWidth = 0;
    this.videoHeight = 0;
    this.readyState = 0;
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.listeners = new Map();
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name, listener) {
    this.listeners.get(name)?.delete(listener);
  }

  emit(name) {
    for (const listener of this.listeners.get(name) || []) listener({ type: name });
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
  assert.equal(states.at(-1).status, "connecting");
  assert.equal(session.confirmVideoFrame(stream), true);
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

test("viewer grant fallback never exceeds the server-issued duration on a slow clock", () => {
  assert.equal(viewerGrantFallbackMs({
    expires_at_ms: 160_000,
    received_at_ms: 10_000,
    server_ttl_ms: 60_000,
  }, 10_000), 60_000);
  assert.equal(viewerGrantFallbackMs({
    expires_at_ms: 160_000,
    received_at_ms: 10_000,
    server_ttl_ms: 60_000,
  }, 25_000), 45_000);
});

test("viewer media requires a real non-zero video frame before LIVE", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  let frameCount = 0;
  const failures = [];
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: (message) => failures.push(message),
  });

  video.paused = false;
  video.readyState = 4;
  video.emit("playing");
  assert.equal(isRenderableViewerVideoFrame(video, stream), false);
  assert.equal(frameCount, 0);

  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.emit("loadeddata");
  assert.equal(isRenderableViewerVideoFrame(video, stream), true);
  assert.equal(frameCount, 1);

  video.videoWidth = 0;
  video.emit("resize");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /画面已失效/);
  guard.dispose();
});

test("viewer media waits for the browser decoded-frame callback when available", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  video.paused = false;
  video.readyState = 4;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  let decodedFrameCallback = null;
  video.requestVideoFrameCallback = (callback) => {
    decodedFrameCallback = callback;
    return 7;
  };
  video.cancelVideoFrameCallback = () => {};
  let frameCount = 0;
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: () => assert.fail("valid decoded frame must not fail"),
  });

  assert.equal(frameCount, 0);
  assert.equal(typeof decodedFrameCallback, "function");
  decodedFrameCallback();
  assert.equal(frameCount, 1);
  guard.dispose();
});

test("viewer media fails closed when decoded frames silently freeze after LIVE", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  video.paused = false;
  video.readyState = 4;
  video.videoWidth = 1920;
  video.videoHeight = 1080;
  const decodedCallbacks = [];
  video.requestVideoFrameCallback = (callback) => {
    decodedCallbacks.push(callback);
    return decodedCallbacks.length;
  };
  video.cancelVideoFrameCallback = () => {};
  const timers = new Map();
  let nextTimerId = 1;
  const setTimeoutImpl = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeoutImpl = (id) => timers.delete(id);
  let frameCount = 0;
  const failures = [];
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: (message) => failures.push(message),
    setTimeoutImpl,
    clearTimeoutImpl,
  });

  assert.equal(decodedCallbacks.length, 1);
  decodedCallbacks.shift()();
  assert.equal(frameCount, 1);
  assert.equal(decodedCallbacks.length, 1, "freshness monitoring must continue after first frame");
  assert.equal(timers.size, 1);
  const firstTimerId = [...timers.keys()][0];
  assert.equal(timers.get(firstTimerId).delay, VIEWER_VIDEO_FRAME_TIMEOUT_MS);

  decodedCallbacks.shift()();
  assert.equal(frameCount, 1, "later frames refresh LIVE without publishing it twice");
  assert.equal(decodedCallbacks.length, 1);
  assert.equal(timers.size, 1);
  const activeTimerId = [...timers.keys()][0];
  assert.notEqual(activeTimerId, firstTimerId);
  const activeTimer = timers.get(activeTimerId);

  activeTimer.callback();
  assert.equal(failures.length, 1);
  assert.match(failures[0], /停止接收新画面/);
  assert.equal(timers.size, 0);
  guard.dispose();
});

test("viewer video guard fails closed on stalled and emptied media", async (t) => {
  for (const eventName of ["stalled", "emptied"]) {
    await t.test(eventName, () => {
      const track = new FakeTrack();
      const stream = new FakeStream([track]);
      const video = new FakeVideo(stream);
      video.paused = false;
      video.readyState = 4;
      video.videoWidth = 640;
      video.videoHeight = 480;
      const failures = [];
      const guard = createViewerVideoGuard({
        video,
        stream,
        onFrame: () => {},
        onFailure: (message) => failures.push(message),
      });
      video.emit(eventName);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /隐私骨架/);
      guard.dispose();
    });
  }
});

test("viewer media fails closed as soon as a remote track mutes or ends", async (t) => {
  for (const eventName of ["onmute", "onended"]) {
    await t.test(eventName, async () => {
      const peers = [];
      const states = [];
      const session = createViewerMediaSession({
        grant: { grant_id: "grant-1" },
        viewerId: "viewer-1",
        sendSignal: () => true,
        onState: (state) => states.push(state),
        peerConnectionFactory: (configuration) => {
          const peer = new FakePeerConnection(configuration);
          peers.push(peer);
          return peer;
        },
        mediaStreamFactory: (tracks) => new FakeStream(tracks),
      });
      await session.handleSignal(forwarded("offer", { sdp: "offer-sdp" }));
      const track = new FakeTrack();
      const stream = new FakeStream([track]);
      peers[0].receivers = [{ track }];
      peers[0].ontrack({ track, streams: [stream] });
      peers[0].connectionState = "connected";
      peers[0].onconnectionstatechange();
      session.confirmVideoFrame(stream);
      assert.equal(states.at(-1).status, "live");

      const failTrack = track[eventName];
      assert.equal(typeof failTrack, "function");
      failTrack();
      assert.equal(states.at(-1).status, "failed");
      assert.equal(states.at(-1).stream, null);
      assert.ok(track.stopCount > 0);
    });
  }
});

test("visibility fail-close detaches video and stops tracks before closing the session", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  const closes = [];
  const session = {
    close(status, error) {
      closes.push({
        error,
        status,
        srcObject: video.srcObject,
        stopCount: track.stopCount,
      });
    },
  };

  closeViewerMediaImmediately({ session, video });

  assert.equal(video.srcObject, null);
  assert.ok(track.stopCount > 0);
  assert.equal(closes.length, 1);
  assert.equal(closes[0].status, "failed");
  assert.equal(closes[0].srcObject, null);
  assert.ok(closes[0].stopCount > 0);
  assert.match(closes[0].error, /页面已隐藏/);
});
