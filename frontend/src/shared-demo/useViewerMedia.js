import { useCallback, useEffect, useRef, useState } from "react";
import { createMediaSignal } from "./protocol.js";

export function normalizeIceCandidate(candidate) {
  const value = candidate?.toJSON?.() || candidate || {};
  return {
    candidate: typeof value.candidate === "string" ? value.candidate : "",
    sdpMid: typeof value.sdpMid === "string" ? value.sdpMid : null,
    sdpMLineIndex: Number.isSafeInteger(value.sdpMLineIndex) ? value.sdpMLineIndex : null,
    usernameFragment: typeof value.usernameFragment === "string" ? value.usernameFragment : null,
  };
}

export function useViewerMedia({
  grant,
  authorityKey,
  roomSessionId,
  viewerId,
  subscribeMediaSignals,
  sendMediaSignal,
}) {
  const [status, setStatus] = useState(grant ? "authorized" : "idle");
  const [error, setError] = useState(null);
  const [stream, setStream] = useState(null);
  const peerRef = useRef(null);
  const pendingIceRef = useRef([]);
  const videoRef = useRef(null);
  const generationRef = useRef(0);
  const streamRef = useRef(null);

  const stopTransport = useCallback(() => {
    generationRef.current += 1;
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

  useEffect(() => {
    stopTransport();
    const resetTimer = window.setTimeout(() => {
      setStream(null);
      setError(null);
      setStatus(grant ? "authorized" : "idle");
    }, 0);
    if (!grant || !roomSessionId || !viewerId || typeof RTCPeerConnection === "undefined") {
      if (grant && typeof RTCPeerConnection === "undefined") {
        window.clearTimeout(resetTimer);
        window.setTimeout(() => {
          setStream(null);
          setStatus("failed");
          setError("此浏览器不支持 WebRTC，已保持骨架模式");
        }, 0);
      }
      return () => window.clearTimeout(resetTimer);
    }

    const generation = generationRef.current;

    function fail(message) {
      if (generation !== generationRef.current) return;
      setError(message);
      setStatus("failed");
      stopTransport();
      setStream(null);
    }

    function createPeer() {
      if (peerRef.current) return peerRef.current;
      const peer = new RTCPeerConnection({ iceServers: [] });
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
        const nextStream = event.streams[0] || new MediaStream([event.track]);
        streamRef.current = nextStream;
        setStream(nextStream);
        setStatus("connecting");
      };
      peer.onconnectionstatechange = () => {
        if (generation !== generationRef.current) return;
        if (peer.connectionState === "connected") setStatus("live");
        if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
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
        const peer = createPeer();
        if (message.signal_type === "offer") {
          setStatus("connecting");
          await peer.setRemoteDescription(message.signal);
          await drainIce(peer);
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          const sent = sendMediaSignal(createMediaSignal({
            roomSessionId,
            grantId: grant.grant_id,
            targetId: "monitor",
            signalType: "answer",
            signal: { type: "answer", sdp: answer.sdp || "" },
          }));
          if (!sent) fail("Relay 已断开，媒体回答未发送");
          return;
        }
        if (message.signal_type === "ice_candidate") {
          if (!peer.remoteDescription) pendingIceRef.current.push(message.signal);
          else await peer.addIceCandidate(message.signal);
          return;
        }
        fail("Viewer 收到了非预期的媒体回答");
      } catch {
        fail("媒体协商失败，已保持骨架模式");
      }
    }

    const unsubscribe = subscribeMediaSignals(handleSignal);
    return () => {
      window.clearTimeout(resetTimer);
      unsubscribe();
      stopTransport();
    };
  }, [authorityKey, grant, roomSessionId, sendMediaSignal, stopTransport, subscribeMediaSignals, viewerId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return undefined;
    video.srcObject = stream;
    let active = true;
    void video.play().then(() => {
      if (active) setStatus("live");
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
  }, [stream]);

  const retryPlayback = useCallback(async () => {
    try {
      await videoRef.current?.play();
      setStatus("live");
      setError(null);
      return true;
    } catch {
      setStatus("failed");
      setError("浏览器仍未允许播放，骨架模式保持可用");
      return false;
    }
  }, []);

  return { error, retryPlayback, status, stream, videoRef };
}
