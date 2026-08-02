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
  try {
    track.stop();
  } catch {
    // The remote track may already have ended; resource cleanup remains idempotent.
  }
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
      publish("connecting");
    };
    nextPeer.onconnectionstatechange = () => {
      if (closed || peer !== nextPeer) return;
      if (nextPeer.connectionState === "connected") publish("live");
      if (["failed", "disconnected"].includes(nextPeer.connectionState)) {
        fail("授权视频连接失败，告警与结构化信息仍然有效。");
      }
    };
    nextPeer.oniceconnectionstatechange = () => {
      if (closed || peer !== nextPeer || nextPeer.connectionState) return;
      if (["connected", "completed"].includes(nextPeer.iceConnectionState)) publish("live");
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

  const close = (status = "idle") => {
    if (closed) return;
    clearPeer();
    pendingIce = [];
    onState({ status, error: null, stream: null });
    closed = true;
  };

  publish("waiting");
  return { close, handleSignal };
}

export function useViewerMedia({ socket, sendSignal, viewerId, grant }) {
  const videoRef = useRef(null);
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
          if (active) setMedia(next);
        },
      });
    } catch (error) {
      const message = `无法初始化授权视频：${errorCopy(error, "WebRTC 不可用")}`;
      queueMicrotask(() => {
        if (active) setMedia({ status: "failed", error: message, stream: null });
      });
      return () => {
        active = false;
      };
    }

    const onMessage = (event) => {
      const message = parseForwardedMediaSignal(event.data);
      if (message) void session.handleSignal(message);
    };
    socket.addEventListener("message", onMessage);
    const expiresInMs = Math.max(0, grant.expires_at_ms - Date.now());
    const expiryTimer = window.setTimeout(() => session.close("expired"), expiresInMs);

    return () => {
      active = false;
      window.clearTimeout(expiryTimer);
      socket.removeEventListener("message", onMessage);
      session.close();
    };
  }, [grant, sendSignal, socket, viewerId]);

  const exposedMedia = enabled ? media : INITIAL_MEDIA_STATE;

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    if (!exposedMedia.stream) {
      video.srcObject = null;
      return undefined;
    }
    video.srcObject = exposedMedia.stream;
    const playPromise = video.play();
    if (playPromise) {
      playPromise.catch(() => {
        setMedia((current) => current.stream === exposedMedia.stream
          ? {
            ...current,
            status: "failed",
            error: "浏览器阻止了授权视频播放；告警与结构化信息仍然有效。",
          }
          : current);
      });
    }
    return () => {
      if (video.srcObject === exposedMedia.stream) video.srcObject = null;
    };
  }, [exposedMedia.stream]);

  const retryPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video?.srcObject) return false;
    try {
      await video.play();
      setMedia((current) => ({ ...current, status: "live", error: null }));
      return true;
    } catch {
      return false;
    }
  }, []);

  return { ...exposedMedia, retryPlayback, videoRef };
}
