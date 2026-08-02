import { useCallback, useEffect, useRef, useState } from "react";
import {
  createMediaSignal,
  parseForwardedMediaSignal,
} from "./protocol.js";

export const VIEWER_RTC_CONFIGURATION = Object.freeze({
  iceServers: Object.freeze([
    Object.freeze({ urls: "stun:stun.cloudflare.com:3478" }),
  ]),
});

const ID_PATTERN = /^[a-z0-9_-]{1,128}$/i;
export const VIEWER_VIDEO_FRAME_TIMEOUT_MS = 3_000;
const INITIAL_MEDIA_STATE = Object.freeze({
  status: "idle",
  error: null,
  stream: null,
});

function errorCopy(error, fallback) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function protocolIceCandidate(candidate) {
  return {
    candidate: candidate.candidate,
    sdp_mid: candidate.sdpMid ?? null,
    sdp_mline_index: candidate.sdpMLineIndex ?? null,
  };
}

function browserIceCandidate(signal) {
  return {
    candidate: signal.candidate,
    sdpMid: signal.sdp_mid,
    sdpMLineIndex: signal.sdp_mline_index,
  };
}

export function isSignalForViewer(message, { grantId, viewerId }) {
  return Boolean(
    message
    && message.grant_id === grantId
    && message.target_id === viewerId
    && message.from_id !== viewerId,
  );
}

function stopTrack(track) {
  if (!track) return;
  track.onended = null;
  track.onmute = null;
  track.onunmute = null;
  try {
    track.stop();
  } catch {
    // The remote track may already have ended; resource cleanup remains idempotent.
  }
}

function videoTracks(stream) {
  if (!stream) return [];
  if (typeof stream.getVideoTracks === "function") return stream.getVideoTracks();
  return (stream.getTracks?.() || []).filter((track) => !track.kind || track.kind === "video");
}

export function isRenderableViewerVideoFrame(video, stream) {
  if (!video || !stream || video.srcObject !== stream) return false;
  const tracks = videoTracks(stream);
  return Boolean(
    Number.isFinite(video.videoWidth)
    && video.videoWidth > 0
    && Number.isFinite(video.videoHeight)
    && video.videoHeight > 0
    && Number.isFinite(video.readyState)
    && video.readyState >= 2
    && video.paused !== true
    && video.ended !== true
    && !video.error
    && tracks.length > 0
    && tracks.every((track) => (
      track.readyState !== "ended"
      && track.muted !== true
      && track.enabled !== false
    )),
  );
}

export function detachViewerVideo(video, { stopTracks = false } = {}) {
  if (!video) return null;
  const stream = video.srcObject || null;
  video.srcObject = null;
  if (stopTracks) {
    for (const track of stream?.getTracks?.() || []) stopTrack(track);
  }
  return stream;
}

export function closeViewerMediaImmediately({
  session,
  video,
  status = "failed",
  error = "评委页面已隐藏，授权视频已立即关闭；告警与结构化信息仍然有效。",
}) {
  detachViewerVideo(video, { stopTracks: true });
  session?.close(status, error);
}

export function viewerGrantFallbackMs(grant, nowMs = Date.now()) {
  const absoluteMs = Number.isFinite(grant?.expires_at_ms)
    ? grant.expires_at_ms - nowMs
    : 0;
  const relativeMs = Number.isFinite(grant?.received_at_ms)
    && Number.isFinite(grant?.server_ttl_ms)
    ? grant.server_ttl_ms - Math.max(0, nowMs - grant.received_at_ms)
    : absoluteMs;
  return Math.max(0, Math.min(absoluteMs, relativeMs));
}

export function createViewerVideoGuard({
  video,
  stream,
  onFrame,
  onFailure,
  frameTimeoutMs = VIEWER_VIDEO_FRAME_TIMEOUT_MS,
  setTimeoutImpl = globalThis.setTimeout,
  clearTimeoutImpl = globalThis.clearTimeout,
}) {
  if (!video || !stream || typeof onFrame !== "function" || typeof onFailure !== "function") {
    throw new TypeError("viewer video guard requires video, stream, and callbacks");
  }
  if (
    !Number.isFinite(frameTimeoutMs)
    || frameTimeoutMs <= 0
    || typeof setTimeoutImpl !== "function"
    || typeof clearTimeoutImpl !== "function"
  ) {
    throw new TypeError("viewer video guard requires a bounded frame timeout");
  }

  let disposed = false;
  let frameConfirmed = false;
  let frameCallbackId = null;
  let frameTimeoutId = null;

  const cancelFrameCallback = () => {
    if (frameCallbackId != null && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(frameCallbackId);
    }
    frameCallbackId = null;
  };

  const clearFrameTimeout = () => {
    if (frameTimeoutId != null) clearTimeoutImpl(frameTimeoutId);
    frameTimeoutId = null;
  };

  const fail = (message) => {
    if (disposed) return;
    disposed = true;
    cancelFrameCallback();
    clearFrameTimeout();
    onFailure(message);
  };

  const failStalled = () => fail(
    "授权视频已停止接收新画面，已立即回到隐私骨架；告警与结构化信息仍然有效。",
  );

  const armFrameTimeout = () => {
    clearFrameTimeout();
    frameTimeoutId = setTimeoutImpl(failStalled, frameTimeoutMs);
  };

  const confirmFrame = ({ fresh = false } = {}) => {
    if (disposed) return;
    if (!isRenderableViewerVideoFrame(video, stream)) {
      if (frameConfirmed) {
        fail("授权视频画面已失效，已立即回到隐私骨架；告警与结构化信息仍然有效。");
      }
      return;
    }
    if (!frameConfirmed) {
      frameConfirmed = true;
      onFrame();
    }
    if (fresh) armFrameTimeout();
  };

  const scheduleDecodedFrame = () => {
    if (
      disposed
      || typeof video.requestVideoFrameCallback !== "function"
      || frameCallbackId != null
    ) return;
    frameCallbackId = video.requestVideoFrameCallback(() => {
      frameCallbackId = null;
      if (disposed) return;
      if (!isRenderableViewerVideoFrame(video, stream)) {
        fail(frameConfirmed
          ? "授权视频画面已失效，已立即回到隐私骨架；告警与结构化信息仍然有效。"
          : "授权视频首帧无效，已继续显示隐私骨架；告警与结构化信息仍然有效。");
        return;
      }
      confirmFrame({ fresh: true });
      scheduleDecodedFrame();
    });
  };

  const scheduleFrameCheck = () => {
    if (disposed) return;
    if (typeof video.requestVideoFrameCallback === "function") {
      scheduleDecodedFrame();
      return;
    }
    confirmFrame({ fresh: !frameConfirmed });
  };

  const confirmFallbackFrame = () => {
    if (typeof video.requestVideoFrameCallback === "function") return;
    confirmFrame({ fresh: true });
  };
  const failEmptied = () => fail(
    "授权视频帧已清空，已立即回到隐私骨架；告警与结构化信息仍然有效。",
  );
  const failPlayback = () => fail(
    "授权视频播放失败，已立即回到隐私骨架；告警与结构化信息仍然有效。",
  );
  const failPaused = () => {
    if (frameConfirmed) fail(
      "授权视频已暂停，已立即回到隐私骨架；告警与结构化信息仍然有效。",
    );
  };
  const failWaiting = () => {
    if (frameConfirmed) failStalled();
  };

  for (const eventName of ["loadeddata", "canplay", "playing", "resize"]) {
    video.addEventListener(eventName, scheduleFrameCheck);
  }
  video.addEventListener("timeupdate", confirmFallbackFrame);
  video.addEventListener("stalled", failStalled);
  video.addEventListener("emptied", failEmptied);
  video.addEventListener("error", failPlayback);
  video.addEventListener("pause", failPaused);
  video.addEventListener("waiting", failWaiting);
  armFrameTimeout();
  scheduleFrameCheck();

  return {
    check: scheduleFrameCheck,
    dispose() {
      cancelFrameCallback();
      clearFrameTimeout();
      for (const eventName of ["loadeddata", "canplay", "playing", "resize"]) {
        video.removeEventListener(eventName, scheduleFrameCheck);
      }
      video.removeEventListener("timeupdate", confirmFallbackFrame);
      video.removeEventListener("stalled", failStalled);
      video.removeEventListener("emptied", failEmptied);
      video.removeEventListener("error", failPlayback);
      video.removeEventListener("pause", failPaused);
      video.removeEventListener("waiting", failWaiting);
      disposed = true;
    },
  };
}

export function createViewerMediaSession({
  grant,
  viewerId,
  sendSignal,
  onState,
  peerConnectionFactory = (configuration) => new RTCPeerConnection(configuration),
  mediaStreamFactory = (tracks) => new MediaStream(tracks),
}) {
  if (!grant?.grant_id || !ID_PATTERN.test(grant.grant_id)) {
    throw new TypeError("an active media grant is required");
  }
  if (!viewerId || !ID_PATTERN.test(viewerId)) {
    throw new TypeError("a valid viewer id is required");
  }
  if (typeof sendSignal !== "function" || typeof onState !== "function") {
    throw new TypeError("media session callbacks are required");
  }

  let closed = false;
  let generation = 0;
  let peer = null;
  let remoteStream = null;
  let remoteId = null;
  let pendingIce = [];
  let transportConnected = false;
  let videoFrameConfirmed = false;
  let livePublished = false;

  const publish = (status, error = null) => {
    if (!closed) onState({ status, error, stream: remoteStream });
  };

  const clearPeer = () => {
    generation += 1;
    const activePeer = peer;
    const activeStream = remoteStream;
    peer = null;
    remoteStream = null;
    remoteId = null;
    transportConnected = false;
    videoFrameConfirmed = false;
    livePublished = false;

    if (activePeer) {
      activePeer.onicecandidate = null;
      activePeer.ontrack = null;
      activePeer.onconnectionstatechange = null;
      activePeer.oniceconnectionstatechange = null;
      for (const receiver of activePeer.getReceivers?.() || []) stopTrack(receiver.track);
      try {
        activePeer.close();
      } catch {
        // Closing an already-closed peer is harmless.
      }
    }
    for (const track of activeStream?.getTracks?.() || []) stopTrack(track);
  };

  const fail = (message) => {
    if (closed) return;
    clearPeer();
    publish("failed", message);
  };

  const publishLiveIfReady = () => {
    if (
      closed
      || livePublished
      || !transportConnected
      || !videoFrameConfirmed
      || !remoteStream
    ) {
      return false;
    }
    livePublished = true;
    publish("live");
    return true;
  };

  const send = (targetId, signalType, signal) => {
    const message = createMediaSignal({
      grantId: grant.grant_id,
      targetId,
      signalType,
      signal,
    });
    if (!message || !sendSignal(message)) {
      fail("视频信令已中断，告警与结构化信息仍然有效。");
      return false;
    }
    return true;
  };

  const createPeer = () => {
    const nextPeer = peerConnectionFactory({
      iceServers: VIEWER_RTC_CONFIGURATION.iceServers.map((server) => ({ ...server })),
    });
    peer = nextPeer;

    nextPeer.onicecandidate = (event) => {
      if (closed || peer !== nextPeer || !event.candidate || !remoteId) return;
      send(remoteId, "ice_candidate", protocolIceCandidate(event.candidate));
    };
    nextPeer.ontrack = (event) => {
      if (closed || peer !== nextPeer) return;
      if (event.track?.kind && event.track.kind !== "video") return;
      try {
        remoteStream = event.streams?.[0] || mediaStreamFactory([event.track]);
      } catch (error) {
        fail(`无法接收授权视频：${errorCopy(error, "媒体流不可用")}`);
        return;
      }
      event.track.onended = () => {
        if (!closed && peer === nextPeer) {
          fail("授权视频轨道已结束，告警与结构化信息仍然有效。");
        }
      };
      event.track.onmute = () => {
        if (!closed && peer === nextPeer) {
          fail("授权视频轨道已静默，已立即回到隐私骨架；告警与结构化信息仍然有效。");
        }
      };
      videoFrameConfirmed = false;
      livePublished = false;
      publish("connecting");
    };
    nextPeer.onconnectionstatechange = () => {
      if (closed || peer !== nextPeer) return;
      if (nextPeer.connectionState === "connected") {
        transportConnected = true;
        if (!publishLiveIfReady()) publish("connecting");
      }
      if (["failed", "disconnected"].includes(nextPeer.connectionState)) {
        fail("授权视频连接失败，告警与结构化信息仍然有效。");
      }
    };
    nextPeer.oniceconnectionstatechange = () => {
      if (closed || peer !== nextPeer || nextPeer.connectionState) return;
      if (["connected", "completed"].includes(nextPeer.iceConnectionState)) {
        transportConnected = true;
        if (!publishLiveIfReady()) publish("connecting");
      }
      if (["failed", "disconnected"].includes(nextPeer.iceConnectionState)) {
        fail("授权视频网络协商失败，告警与结构化信息仍然有效。");
      }
    };
    return nextPeer;
  };

  const addIce = async (activePeer, signal, operationGeneration) => {
    await activePeer.addIceCandidate(browserIceCandidate(signal));
    return !closed && peer === activePeer && generation === operationGeneration;
  };

  const handleOffer = async (message) => {
    const queuedIce = pendingIce;
    pendingIce = [];
    clearPeer();
    remoteId = message.from_id;
    try {
      const activePeer = createPeer();
      const operationGeneration = generation;
      publish("connecting");
      await activePeer.setRemoteDescription({ type: "offer", sdp: message.signal.sdp });
      if (closed || peer !== activePeer || generation !== operationGeneration) return;
      const candidates = [...queuedIce, ...pendingIce]
        .filter((entry) => entry.fromId === remoteId);
      pendingIce = [];
      for (const entry of candidates) {
        const current = await addIce(activePeer, entry.signal, operationGeneration);
        if (!current) return;
      }
      const answer = await activePeer.createAnswer();
      if (closed || peer !== activePeer || generation !== operationGeneration) return;
      await activePeer.setLocalDescription(answer);
      if (closed || peer !== activePeer || generation !== operationGeneration) return;
      const sdp = activePeer.localDescription?.sdp || answer.sdp;
      if (!sdp || !send(remoteId, "answer", { sdp })) return;
      publish("connecting");
    } catch (error) {
      fail(`授权视频协商失败：${errorCopy(error, "WebRTC 不可用")}`);
    }
  };

  const handleIce = async (message) => {
    if (remoteId && message.from_id !== remoteId) return;
    if (!peer || !peer.remoteDescription) {
      pendingIce.push({ fromId: message.from_id, signal: message.signal });
      return;
    }
    const activePeer = peer;
    const operationGeneration = generation;
    try {
      await addIce(activePeer, message.signal, operationGeneration);
    } catch (error) {
      fail(`视频网络候选不可用：${errorCopy(error, "ICE 协商失败")}`);
    }
  };

  const handleSignal = async (message) => {
    if (closed || !isSignalForViewer(message, { grantId: grant.grant_id, viewerId })) {
      return false;
    }
    if (message.signal_type === "offer") {
      await handleOffer(message);
      return true;
    }
    if (message.signal_type === "ice_candidate") {
      await handleIce(message);
      return true;
    }
    return false;
  };

  const confirmVideoFrame = (stream) => {
    if (closed || !stream || stream !== remoteStream) return false;
    videoFrameConfirmed = true;
    publishLiveIfReady();
    return true;
  };

  const failVideo = (message) => {
    if (closed) return false;
    fail(message || "授权视频已失效，告警与结构化信息仍然有效。");
    return true;
  };

  const close = (status = "idle", error = null) => {
    if (closed) return;
    clearPeer();
    pendingIce = [];
    onState({ status, error, stream: null });
    closed = true;
  };

  publish("waiting");
  return { close, confirmVideoFrame, failVideo, handleSignal };
}

export function useViewerMedia({
  socket,
  sendSignal,
  drainSignals,
  viewerId,
  grant,
}) {
  const videoRef = useRef(null);
  const sessionRef = useRef(null);
  const [media, setMedia] = useState(INITIAL_MEDIA_STATE);
  const enabled = Boolean(socket && viewerId && grant);

  useEffect(() => {
    if (!socket || !viewerId || !grant) return undefined;

    let active = true;
    let session;
    try {
      session = createViewerMediaSession({
        grant,
        viewerId,
        sendSignal,
        onState: (next) => {
          if (["failed", "expired"].includes(next.status)) {
            detachViewerVideo(videoRef.current, { stopTracks: true });
          }
          if (active) setMedia(next);
        },
      });
      sessionRef.current = session;
    } catch (error) {
      const message = `无法初始化授权视频：${errorCopy(error, "WebRTC 不可用")}`;
      queueMicrotask(() => {
        if (active) setMedia({ status: "failed", error: message, stream: null });
      });
      return () => {
        active = false;
      };
    }

    let signalWork = Promise.resolve();
    const queueSignals = (messages) => {
      if (!messages.length) return;
      signalWork = signalWork.then(async () => {
        for (const message of messages) await session.handleSignal(message);
      });
    };
    const drainBufferedSignals = () => {
      if (typeof drainSignals !== "function") return;
      const messages = drainSignals((message) => isSignalForViewer(message, {
        grantId: grant.grant_id,
        viewerId,
      }));
      queueSignals(Array.isArray(messages) ? messages : []);
    };
    const onMessage = (event) => {
      if (typeof drainSignals === "function") {
        // useViewerRelay receives this event first and puts valid forwarded
        // signals in the bounded buffer. Draining here closes the gap between
        // socket creation and this grant-specific media session.
        drainBufferedSignals();
        return;
      }
      const message = parseForwardedMediaSignal(event.data);
      if (message) queueSignals([message]);
    };
    socket.addEventListener("message", onMessage);
    drainBufferedSignals();
    const expiresInMs = viewerGrantFallbackMs(grant);
    const expiryTimer = window.setTimeout(() => session.close("expired"), expiresInMs);
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") return;
      closeViewerMediaImmediately({ session, video: videoRef.current });
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();

    return () => {
      active = false;
      window.clearTimeout(expiryTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      socket.removeEventListener("message", onMessage);
      if (sessionRef.current === session) sessionRef.current = null;
      session.close();
    };
  }, [drainSignals, grant, sendSignal, socket, viewerId]);

  const exposedMedia = enabled ? media : INITIAL_MEDIA_STATE;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (!exposedMedia.stream) {
      detachViewerVideo(video);
      return undefined;
    }
    const stream = exposedMedia.stream;
    const session = sessionRef.current;
    video.srcObject = stream;
    const failPlayback = (message) => {
      if (video.srcObject === stream) detachViewerVideo(video, { stopTracks: true });
      session?.failVideo(message);
    };
    const guard = createViewerVideoGuard({
      video,
      stream,
      onFrame: () => session?.confirmVideoFrame(stream),
      onFailure: failPlayback,
    });
    const playPromise = video.play();
    if (playPromise) {
      playPromise.catch(() => {
        failPlayback("浏览器阻止了授权视频播放，已立即回到隐私骨架；告警与结构化信息仍然有效。");
      });
    }
    return () => {
      guard.dispose();
      if (video.srcObject === stream) detachViewerVideo(video, { stopTracks: true });
    };
  }, [exposedMedia.stream]);

  const retryPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video?.srcObject) return false;
    try {
      await video.play();
      video.dispatchEvent(new Event("playing"));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { ...exposedMedia, retryPlayback, videoRef };
}
