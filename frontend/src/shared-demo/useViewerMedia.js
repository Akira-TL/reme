import { useCallback, useEffect, useRef, useState } from "react";
import { createMediaSignal } from "./protocol.js";

export const VIEWER_NEGOTIATION_TIMEOUT_MS = 7_000;
export const VIEWER_DISCONNECT_GRACE_MS = 2_000;
const LOCAL_RTC_CONFIGURATION = Object.freeze({ iceServers: Object.freeze([]) });

export function hasLiveVideoTrack(stream) {
  const tracks = typeof stream?.getVideoTracks === "function"
    ? stream.getVideoTracks()
    : typeof stream?.getTracks === "function"
      ? stream.getTracks().filter((track) => track?.kind === "video")
      : [];
  return Array.isArray(tracks)
    && tracks.some((track) => track && track.readyState !== "ended");
}

export function canViewerMediaBecomeLive(peer, stream) {
  return peer?.connectionState === "connected" && hasLiveVideoTrack(stream);
}

export function classifyViewerConnectionState(connectionState) {
  if (connectionState === "connected") return "connected";
  if (connectionState === "disconnected") return "grace";
  if (connectionState === "failed" || connectionState === "closed") return "failed";
  return "waiting";
}

export function bindViewerVideoTrackEnded(track, onEnded) {
  if (typeof track?.addEventListener !== "function"
    || typeof track?.removeEventListener !== "function"
    || typeof onEnded !== "function") return () => {};
  track.addEventListener("ended", onEnded, { once: true });
  return () => track.removeEventListener("ended", onEnded);
}

export function createNegotiationWatchdog({
  timerApi = globalThis,
  timeoutMs = VIEWER_NEGOTIATION_TIMEOUT_MS,
  onTimeout,
} = {}) {
  if (typeof timerApi?.setTimeout !== "function"
    || typeof timerApi?.clearTimeout !== "function"
    || !Number.isFinite(timeoutMs)
    || timeoutMs <= 0
    || typeof onTimeout !== "function") {
    throw new TypeError("无效的 Viewer 媒体协商看门狗配置");
  }
  let timerId = null;
  let finished = false;

  function clear() {
    if (timerId === null) return;
    timerApi.clearTimeout(timerId);
    timerId = null;
  }

  return Object.freeze({
    start() {
      if (finished || timerId !== null) return false;
      timerId = timerApi.setTimeout(() => {
        timerId = null;
        if (finished) return;
        finished = true;
        onTimeout();
      }, timeoutMs);
      return true;
    },
    complete() {
      if (finished) return false;
      finished = true;
      clear();
      return true;
    },
    cancel() {
      if (finished) return false;
      finished = true;
      clear();
      return true;
    },
  });
}

export function normalizeIceCandidate(candidate) {
  const value = candidate?.toJSON?.() || candidate || {};
  return {
    candidate: typeof value.candidate === "string" ? value.candidate : "",
    sdpMid: typeof value.sdpMid === "string" ? value.sdpMid : null,
    sdpMLineIndex: Number.isSafeInteger(value.sdpMLineIndex) ? value.sdpMLineIndex : null,
    usernameFragment: typeof value.usernameFragment === "string" ? value.usernameFragment : null,
  };
}

export async function createRecvOnlyOffer(peer) {
  if (!peer || typeof peer.addTransceiver !== "function") {
    throw new TypeError("RTCPeerConnection 缺少 recvonly transceiver 能力");
  }
  peer.addTransceiver("video", { direction: "recvonly" });
  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  const local = peer.localDescription || offer;
  if (local?.type !== "offer" || typeof local.sdp !== "string" || !local.sdp) {
    throw new TypeError("Viewer 未生成有效的 WebRTC offer");
  }
  return { type: "offer", sdp: local.sdp };
}

export function useViewerMedia({
  grant,
  authorityKey,
  roomSessionId,
  viewerId,
  subscribeMediaSignals,
  sendMediaSignal,
  rtcConfiguration = LOCAL_RTC_CONFIGURATION,
}) {
  const [status, setStatus] = useState(grant ? "authorized" : "idle");
  const [error, setError] = useState(null);
  const [stream, setStream] = useState(null);
  const peerRef = useRef(null);
  const pendingIceRef = useRef([]);
  const videoRef = useRef(null);
  const generationRef = useRef(0);
  const streamRef = useRef(null);
  const negotiationRef = useRef(null);
  const trackEndedCleanupRef = useRef(null);

  const stopTransport = useCallback(() => {
    generationRef.current += 1;
    negotiationRef.current?.watchdog.cancel();
    negotiationRef.current = null;
    trackEndedCleanupRef.current?.();
    trackEndedCleanupRef.current = null;
    pendingIceRef.current = [];
    const peer = peerRef.current;
    peerRef.current = null;
    if (peer) {
      peer.onicecandidate = null;
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.close();
    }
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const markLive = useCallback((generation) => {
    if (generation !== generationRef.current) return false;
    if (!canViewerMediaBecomeLive(peerRef.current, streamRef.current)) return false;
    const negotiation = negotiationRef.current;
    if (negotiation?.generation === generation) {
      negotiation.watchdog.complete();
      negotiationRef.current = null;
    }
    setStatus("live");
    return true;
  }, []);

  useEffect(() => {
    stopTransport();
    let resetTimer = 0;
    if (!grant || !roomSessionId || !viewerId || typeof RTCPeerConnection === "undefined") {
      resetTimer = window.setTimeout(() => {
        setStream(null);
        setStatus(grant && typeof RTCPeerConnection === "undefined" ? "failed" : "idle");
        setError(grant && typeof RTCPeerConnection === "undefined"
          ? "此浏览器不支持 WebRTC，已保持骨架模式"
          : null);
      }, 0);
      return () => window.clearTimeout(resetTimer);
    }

    const generation = generationRef.current;
    let offerStarted = false;
    let answerReceived = false;
    let disconnectWatchdog = null;

    function clearDisconnectWatchdog() {
      disconnectWatchdog?.cancel();
      disconnectWatchdog = null;
    }

    function startDisconnectWatchdog(message) {
      if (disconnectWatchdog) return;
      disconnectWatchdog = createNegotiationWatchdog({
        timerApi: window,
        timeoutMs: VIEWER_DISCONNECT_GRACE_MS,
        onTimeout() {
          disconnectWatchdog = null;
          fail(message);
        },
      });
      disconnectWatchdog.start();
    }

    function fail(message) {
      if (generation !== generationRef.current) return;
      clearDisconnectWatchdog();
      setError(message);
      setStatus("failed");
      stopTransport();
      setStream(null);
    }

    const watchdog = createNegotiationWatchdog({
      timerApi: window,
      onTimeout() {
        fail(answerReceived
          ? "媒体回答已收到但连接超时，已回退到骨架"
          : "未收到有效媒体回答，已回退到骨架");
      },
    });
    negotiationRef.current = { generation, watchdog };
    watchdog.start();

    function createPeer() {
      if (peerRef.current) return peerRef.current;
      const peer = new RTCPeerConnection({ iceServers: rtcConfiguration.iceServers || [] });
      peerRef.current = peer;
      peer.onicecandidate = (event) => {
        if (!event.candidate || generation !== generationRef.current) return;
        try {
          const message = createMediaSignal({
            roomSessionId,
            grantId: grant.grant_id,
            targetId: "monitor",
            signalType: "ice_candidate",
            signal: normalizeIceCandidate(event.candidate),
          });
          if (!sendMediaSignal(message)) fail("Relay 已断开，媒体协商被安全关闭");
        } catch {
          fail("本地 ICE 候选不符合媒体协议");
        }
      };
      peer.ontrack = (event) => {
        if (generation !== generationRef.current || event.track.kind !== "video") return;
        trackEndedCleanupRef.current?.();
        trackEndedCleanupRef.current = bindViewerVideoTrackEnded(event.track, () => {
          fail("远程视频轨道已结束，已回退到骨架");
        });
        const nextStream = event.streams[0] || new MediaStream([event.track]);
        streamRef.current = nextStream;
        setStream(nextStream);
        setStatus("connecting");
        if (peer.connectionState === "connected") {
          clearDisconnectWatchdog();
          markLive(generation);
        }
      };
      peer.onconnectionstatechange = () => {
        if (generation !== generationRef.current) return;
        const disposition = classifyViewerConnectionState(peer.connectionState);
        if (disposition === "connected") {
          clearDisconnectWatchdog();
          if (!markLive(generation)) {
            setStatus("connecting");
            if (!negotiationRef.current) {
              startDisconnectWatchdog("媒体连接恢复但没有可用视频轨道，已回退到骨架");
            }
          }
          return;
        }
        if (disposition === "grace") {
          setStatus("connecting");
          startDisconnectWatchdog("短时媒体连接持续中断，已回退到骨架");
          return;
        }
        if (disposition === "failed") {
          fail("短时媒体连接已中断，已回退到骨架");
        }
      };
      return peer;
    }

    async function drainIce(peer) {
      const pending = pendingIceRef.current;
      pendingIceRef.current = [];
      for (const candidate of pending) await peer.addIceCandidate(candidate);
    }

    async function handleSignal(message) {
      if (generation !== generationRef.current
        || message.room_session_id !== roomSessionId
        || message.grant_id !== grant.grant_id
        || message.target_id !== viewerId
        || message.from_id !== "monitor") return;
      try {
        const peer = peerRef.current;
        if (!peer) return;
        if (message.signal_type === "answer") {
          if (!offerStarted || peer.localDescription?.type !== "offer") {
            fail("Viewer 收到了没有对应 offer 的媒体回答");
            return;
          }
          await peer.setRemoteDescription(message.signal);
          answerReceived = true;
          await drainIce(peer);
          return;
        }
        if (message.signal_type === "ice_candidate") {
          if (!peer.remoteDescription) pendingIceRef.current.push(message.signal);
          else await peer.addIceCandidate(message.signal);
          return;
        }
        fail("Viewer 收到了非预期的媒体 offer");
      } catch {
        fail("媒体协商失败，已保持骨架模式");
      }
    }

    const peer = createPeer();
    resetTimer = window.setTimeout(() => {
      if (generation !== generationRef.current) return;
      setStream(null);
      setError(null);
      setStatus("connecting");
      offerStarted = true;
      void createRecvOnlyOffer(peer).then((offer) => {
        if (generation !== generationRef.current) return;
        const sent = sendMediaSignal(createMediaSignal({
          roomSessionId,
          grantId: grant.grant_id,
          targetId: "monitor",
          signalType: "offer",
          signal: offer,
        }));
        if (!sent) fail("Relay 已断开，媒体 offer 未发送");
      }).catch(() => fail("媒体 offer 创建失败，已保持骨架模式"));
    }, 0);
    const unsubscribe = subscribeMediaSignals(handleSignal);
    return () => {
      window.clearTimeout(resetTimer);
      clearDisconnectWatchdog();
      unsubscribe();
      stopTransport();
    };
  }, [authorityKey, grant, markLive, roomSessionId, rtcConfiguration, sendMediaSignal, stopTransport, subscribeMediaSignals, viewerId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return undefined;
    const generation = generationRef.current;
    video.srcObject = stream;
    let active = true;
    void video.play().then(() => {
      if (active) markLive(generation);
    }).catch(() => {
      if (active) {
        setStatus("failed");
        setError("浏览器阻止自动播放，请点击画面重试");
      }
    });
    return () => {
      active = false;
      if (video.srcObject === stream) video.srcObject = null;
    };
  }, [markLive, stream]);

  const retryPlayback = useCallback(async () => {
    try {
      const video = videoRef.current;
      const activeStream = streamRef.current;
      if (!video || !activeStream || video.srcObject !== activeStream) {
        throw new Error("媒体流已关闭");
      }
      await video.play();
      if (!markLive(generationRef.current)) throw new Error("媒体会话已变化");
      setError(null);
      return true;
    } catch {
      setStatus("failed");
      setError("浏览器仍未允许播放，骨架模式保持可用");
      return false;
    }
  }, [markLive]);

  return { error, retryPlayback, status, stream, videoRef };
}
