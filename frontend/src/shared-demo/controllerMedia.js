import {
  createMediaSignal,
  isDemoEvent,
  isForwardedMediaSignal,
} from "./protocol.js";

export const DEFAULT_MEDIA_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: ["stun:stun.cloudflare.com:3478"] }),
]);

function sendJson(socket, value) {
  if (!socket || socket.readyState !== 1 || !value) return false;
  socket.send(JSON.stringify(value));
  return true;
}

function toIceSignal(candidate) {
  const value = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
  if (!value?.candidate) return null;
  return {
    candidate: value.candidate,
    sdp_mid: value.sdpMid ?? null,
    sdp_mline_index: value.sdpMLineIndex ?? null,
  };
}

export function createControllerMediaBridge({
  getSocket,
  getStream,
  onStatus = () => {},
  iceServers = DEFAULT_MEDIA_ICE_SERVERS,
  PeerConnection = globalThis.RTCPeerConnection,
} = {}) {
  const peers = new Map();
  let activeGrant = null;

  function closePeer(viewerId, reason = "closed") {
    const record = peers.get(viewerId);
    if (!record) return;
    peers.delete(viewerId);
    try {
      record.peer.close();
    } catch {
      // Closing is best-effort; the grant remains the authority.
    }
    onStatus({ state: reason, viewerId, grantId: record.grantId });
  }

  function stopGrant(grantId = null, reason = "revoked") {
    if (grantId !== null && activeGrant?.payload.grant_id !== grantId) return false;
    for (const viewerId of [...peers.keys()]) closePeer(viewerId, reason);
    activeGrant = null;
    return true;
  }

  async function startPeer(viewerId, grantEvent, stream) {
    closePeer(viewerId, "replaced");
    const peer = new PeerConnection({ iceServers });
    const record = {
      peer,
      grantId: grantEvent.payload.grant_id,
      remoteReady: false,
      pendingIce: [],
    };
    peers.set(viewerId, record);
    for (const track of stream.getVideoTracks()) peer.addTrack(track, stream);
    peer.onicecandidate = (event) => {
      const signal = event.candidate ? toIceSignal(event.candidate) : null;
      if (!signal || peers.get(viewerId) !== record) return;
      sendJson(getSocket?.(), createMediaSignal({
        grantId: record.grantId,
        targetId: viewerId,
        signalType: "ice_candidate",
        signal,
      }));
    };
    peer.onconnectionstatechange = () => {
      const state = peer.connectionState;
      onStatus({ state, viewerId, grantId: record.grantId });
      if (["failed", "closed"].includes(state)) closePeer(viewerId, state);
    };
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peers.get(viewerId) !== record) return;
      const sent = sendJson(getSocket?.(), createMediaSignal({
        grantId: record.grantId,
        targetId: viewerId,
        signalType: "offer",
        signal: { sdp: peer.localDescription?.sdp || offer.sdp || "" },
      }));
      if (!sent) closePeer(viewerId, "signal_unavailable");
    } catch {
      closePeer(viewerId, "offer_failed");
    }
  }

  async function startGrant(grantEvent, viewerIds) {
    if (
      !isDemoEvent(grantEvent)
      || grantEvent.event_type !== "media_grant"
      || grantEvent.payload.status !== "active"
      || grantEvent.payload.expires_at_ms <= Date.now()
      || !Array.isArray(viewerIds)
      || !viewerIds.every((viewerId) => typeof viewerId === "string")
    ) return false;
    if (typeof PeerConnection !== "function") {
      onStatus({ state: "unsupported", viewerId: null, grantId: grantEvent.payload.grant_id });
      return false;
    }
    const stream = getStream?.();
    if (!stream?.getVideoTracks?.().length) {
      onStatus({ state: "stream_unavailable", viewerId: null, grantId: grantEvent.payload.grant_id });
      return false;
    }
    stopGrant(null, "replaced");
    activeGrant = grantEvent;
    await Promise.all(viewerIds.map((viewerId) => startPeer(viewerId, grantEvent, stream)));
    return true;
  }

  async function handleSignal(value) {
    if (!isForwardedMediaSignal(value) || !activeGrant) return false;
    if (value.target_id !== "controller" || value.grant_id !== activeGrant.payload.grant_id) {
      return false;
    }
    const record = peers.get(value.from_id);
    if (!record || record.grantId !== value.grant_id) return false;
    try {
      if (value.signal_type === "answer") {
        await record.peer.setRemoteDescription({ type: "answer", sdp: value.signal.sdp });
        record.remoteReady = true;
        for (const candidate of record.pendingIce.splice(0)) {
          await record.peer.addIceCandidate(candidate);
        }
        return true;
      }
      if (value.signal_type === "ice_candidate") {
        const candidate = {
          candidate: value.signal.candidate,
          sdpMid: value.signal.sdp_mid,
          sdpMLineIndex: value.signal.sdp_mline_index,
        };
        if (!record.remoteReady) record.pendingIce.push(candidate);
        else await record.peer.addIceCandidate(candidate);
        return true;
      }
    } catch {
      closePeer(value.from_id, "signal_failed");
    }
    return false;
  }

  return {
    startGrant,
    stopGrant,
    handleSignal,
    dispose() {
      stopGrant(null, "disposed");
    },
    activeGrantId() {
      return activeGrant?.payload.grant_id ?? null;
    },
  };
}
