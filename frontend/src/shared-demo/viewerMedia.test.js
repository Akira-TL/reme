import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VIEWER_MEDIA_ICE_CANDIDATES,
  VIEWER_VIDEO_FRAME_TIMEOUT_MS,
  closeViewerMediaImmediately,
  createViewerVideoGuard,
  createViewerMediaSession,
  detachViewerVideo,
  isRenderableViewerVideoFrame,
  isSignalForViewer,
  selectViewerMediaForOwner,
  suspendViewerMediaImmediately,
  viewerGrantFallbackMs,
} from "./useViewerMedia.js";

const RELIABLE_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: ["stun:stun.cloudflare.com:3478"] }),
  Object.freeze({
    urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
    username: "short-user",
    credential: "short-secret",
  }),
]);

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
    iceServers: RELIABLE_ICE_SERVERS,
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
  assert.deepEqual(peers[0].configuration.iceServers, RELIABLE_ICE_SERVERS);
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
  const receivedStream = states.at(-1).stream;
  assert.notEqual(receivedStream, stream);
  assert.deepEqual(receivedStream.getTracks(), [track]);
  peers[0].connectionState = "connected";
  peers[0].onconnectionstatechange();
  assert.equal(states.at(-1).status, "connecting");
  assert.equal(session.confirmVideoFrame(receivedStream), true);
  assert.equal(states.at(-1).status, "live");
  assert.equal(states.at(-1).stream, receivedStream);

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
    iceServers: RELIABLE_ICE_SERVERS,
    sendSignal: () => false,
    onState: (state) => states.push(state),
    peerConnectionFactory: (configuration) => new FakePeerConnection(configuration),
    mediaStreamFactory: (tracks) => new FakeStream(tracks),
  });
  await session.handleSignal(forwarded("offer", { sdp: "offer-sdp" }));
  assert.equal(states.at(-1).status, "failed");
  assert.match(states.at(-1).error, /告警与结构化信息仍然有效/);
});

test("viewer media bounds all incoming ICE candidates for one grant", async () => {
  const states = [];
  const session = createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    iceServers: RELIABLE_ICE_SERVERS,
    sendSignal: () => true,
    onState: (state) => states.push(state),
    peerConnectionFactory: (configuration) => new FakePeerConnection(configuration),
  });

  for (let index = 0; index < MAX_VIEWER_MEDIA_ICE_CANDIDATES; index += 1) {
    assert.equal(await session.handleSignal(forwarded("ice_candidate", {
      candidate: `candidate:${index}`,
      sdp_mid: "0",
      sdp_mline_index: 0,
    })), true);
  }
  assert.equal(await session.handleSignal(forwarded("ice_candidate", {
    candidate: "candidate:overflow",
    sdp_mid: "0",
    sdp_mline_index: 0,
  })), false);
  assert.equal(states.at(-1).status, "failed");
  assert.match(states.at(-1).error, /安全上限/);
});

test("viewer media stops non-video tracks without admitting them into the live stream", async () => {
  const peers = [];
  const states = [];
  const session = createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    iceServers: RELIABLE_ICE_SERVERS,
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

  const audioTrack = new FakeTrack();
  audioTrack.kind = "audio";
  peers[0].ontrack({ track: audioTrack, streams: [new FakeStream([audioTrack])] });
  assert.equal(audioTrack.stopCount, 1);
  assert.equal(states.some((state) => state.stream?.getTracks?.().includes(audioTrack)), false);
  assert.notEqual(states.at(-1).status, "live");

  const videoTrack = new FakeTrack();
  peers[0].ontrack({ track: videoTrack, streams: [new FakeStream([audioTrack, videoTrack])] });
  const videoOnlyStream = states.at(-1).stream;
  assert.deepEqual(videoOnlyStream.getTracks(), [videoTrack]);
  peers[0].connectionState = "connected";
  peers[0].onconnectionstatechange();
  assert.equal(session.confirmVideoFrame(videoOnlyStream), true);
  assert.equal(states.at(-1).status, "live");
});

test("a new grant never exposes the previous grant's LIVE stream before a new first frame", () => {
  const socket = {};
  const oldStream = new FakeStream([new FakeTrack()]);
  const oldLive = {
    owner: {
      socket,
      viewerId: "viewer-1",
      grantId: "grant-old",
      capabilityToken: "old-token",
    },
    status: "live",
    error: null,
    stream: oldStream,
  };
  assert.equal(selectViewerMediaForOwner(oldLive, oldLive.owner).status, "live");
  assert.deepEqual(selectViewerMediaForOwner(oldLive, {
    socket,
    viewerId: "viewer-1",
    grantId: null,
    capabilityToken: null,
  }), { status: "idle", error: null, stream: null });
  assert.deepEqual(selectViewerMediaForOwner(oldLive, {
    socket,
    viewerId: "viewer-1",
    grantId: "grant-new",
    capabilityToken: "new-token",
  }), { status: "idle", error: null, stream: null });
  assert.deepEqual(selectViewerMediaForOwner({
    owner: {
      socket,
      viewerId: "viewer-1",
      grantId: "grant-new",
      capabilityToken: "new-token",
    },
    status: "authorized",
    error: null,
    stream: null,
  }, {
    socket,
    viewerId: "viewer-1",
    grantId: "grant-new",
    capabilityToken: "new-token",
  }), { status: "authorized", error: null, stream: null });
});

test("unsupported WebRTC becomes an explicit media-only failure", async () => {
  const states = [];
  const session = createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    iceServers: RELIABLE_ICE_SERVERS,
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
  let decodedFrames = 0;
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: decodedFrames });
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
  decodedFrames = 1;
  video.emit("loadeddata");
  assert.equal(isRenderableViewerVideoFrame(video, stream), true);
  assert.equal(frameCount, 1);

  video.videoWidth = 0;
  video.emit("resize");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /画面已失效/);
  guard.dispose();
});

test("viewer media confirms fallback LIVE only after decoded frame count grows", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  video.paused = false;
  video.readyState = 4;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  let decodedFrames = 4;
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: decodedFrames });
  let frameCount = 0;
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: () => assert.fail("growing decoded frame count must remain live"),
  });

  video.emit("timeupdate");
  assert.equal(frameCount, 0, "the initial counter value is only a baseline");
  decodedFrames = 5;
  video.emit("timeupdate");
  assert.equal(frameCount, 1);
  guard.dispose();
});

test("viewer media accepts the monotonic WebKit decoded frame counter fallback", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  video.paused = false;
  video.readyState = 4;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  video.webkitDecodedFrameCount = 8;
  let frameCount = 0;
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: () => assert.fail("growing WebKit decoded frame count must remain live"),
  });

  video.webkitDecodedFrameCount = 9;
  video.emit("timeupdate");
  assert.equal(frameCount, 1);
  guard.dispose();
});

test("viewer media fallback does not refresh the watchdog for a repeated frame count", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  video.paused = false;
  video.readyState = 4;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  let decodedFrames = 0;
  video.getVideoPlaybackQuality = () => ({ totalVideoFrames: decodedFrames });
  const timers = new Map();
  let nextTimerId = 1;
  const setTimeoutImpl = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  const failures = [];
  let frameCount = 0;
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: (message) => {
      detachViewerVideo(video, { stopTracks: true });
      failures.push(message);
    },
    setTimeoutImpl,
    clearTimeoutImpl: (id) => timers.delete(id),
  });

  decodedFrames = 1;
  video.emit("timeupdate");
  assert.equal(frameCount, 1);
  assert.equal(timers.size, 1);
  const activeTimerId = [...timers.keys()][0];
  assert.equal(timers.get(activeTimerId).delay, VIEWER_VIDEO_FRAME_TIMEOUT_MS);

  video.emit("timeupdate");
  video.emit("timeupdate");
  assert.deepEqual([...timers.keys()], [activeTimerId]);

  timers.get(activeTimerId).callback();
  assert.equal(failures.length, 1);
  assert.match(failures[0], /停止接收新画面/);
  assert.equal(video.srcObject, null);
  assert.ok(track.stopCount > 0);
  guard.dispose();
});

test("viewer media fallback without a reliable decoded frame counter fails closed", () => {
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  const video = new FakeVideo(stream);
  video.paused = false;
  video.readyState = 4;
  video.videoWidth = 1280;
  video.videoHeight = 720;
  const timers = new Map();
  let nextTimerId = 1;
  const failures = [];
  let frameCount = 0;
  const guard = createViewerVideoGuard({
    video,
    stream,
    onFrame: () => { frameCount += 1; },
    onFailure: (message) => {
      detachViewerVideo(video, { stopTracks: true });
      failures.push(message);
    },
    setTimeoutImpl: (callback, delay) => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeoutImpl: (id) => timers.delete(id),
  });

  video.emit("playing");
  video.emit("loadeddata");
  video.emit("timeupdate");
  assert.equal(frameCount, 0);
  assert.equal(timers.size, 1);
  const activeTimer = [...timers.values()][0];
  assert.equal(activeTimer.delay, VIEWER_VIDEO_FRAME_TIMEOUT_MS);

  activeTimer.callback();
  assert.equal(failures.length, 1);
  assert.equal(video.srcObject, null);
  assert.ok(track.stopCount > 0);
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
        iceServers: RELIABLE_ICE_SERVERS,
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
      const receivedStream = states.at(-1).stream;
      peers[0].connectionState = "connected";
      peers[0].onconnectionstatechange();
      session.confirmVideoFrame(receivedStream);
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

test("viewer media refuses to create a peer without reliable ICE servers", () => {
  assert.throws(() => createViewerMediaSession({
    grant: { grant_id: "grant-1" },
    viewerId: "viewer-1",
    iceServers: [],
    sendSignal: () => true,
    onState: () => {},
  }), /reliable ICE servers are required/);
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

test("pagehide aborts pending media and synchronously detaches the remote track", () => {
  const track = new FakeTrack();
  const video = new FakeVideo(new FakeStream([track]));
  const abortController = new AbortController();
  const closes = [];
  const session = {
    close(status, error) {
      closes.push({ status, error, srcObject: video.srcObject });
    },
  };

  suspendViewerMediaImmediately({
    session,
    video,
    abortController,
    reason: "viewer_pagehide",
    error: "评委页面已离开，授权视频已立即关闭。",
  });

  assert.equal(abortController.signal.aborted, true);
  assert.equal(abortController.signal.reason, "viewer_pagehide");
  assert.equal(video.srcObject, null);
  assert.ok(track.stopCount > 0);
  assert.deepEqual(closes, [{
    status: "failed",
    error: "评委页面已离开，授权视频已立即关闭。",
    srcObject: null,
  }]);
});

test("viewer socket close and error use the same synchronous media fail-close", async (t) => {
  for (const reason of ["viewer_socket_closed", "viewer_socket_error"]) {
    await t.test(reason, () => {
      const track = new FakeTrack();
      const video = new FakeVideo(new FakeStream([track]));
      const abortController = new AbortController();
      let closed = false;
      suspendViewerMediaImmediately({
        session: { close: () => { closed = true; } },
        video,
        abortController,
        reason,
      });
      assert.equal(abortController.signal.reason, reason);
      assert.equal(video.srcObject, null);
      assert.ok(track.stopCount > 0);
      assert.equal(closed, true);
    });
  }
});
