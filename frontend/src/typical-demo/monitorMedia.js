import {
  containsForbiddenRawMedia,
  monitorRelayProtocol,
  validateForwardedMediaSignal,
} from "./monitorRelay.js";

const MAX_PENDING_ICE_PER_VIEWER = 16;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function isId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[A-Za-z0-9_-]+$/.test(value);
}

function iceServerUrls(server) {
  if (Array.isArray(server?.urls)) return server.urls;
  return typeof server?.urls === "string" ? [server.urls] : [];
}

export function hasTurnServer(rtcConfiguration = {}) {
  return Array.isArray(rtcConfiguration?.iceServers)
    && rtcConfiguration.iceServers.some((server) => (
      iceServerUrls(server).some((url) => /^turns?:/i.test(url))
    ));
}

export function describeMediaConnectivity(rtcConfiguration = {}) {
  return hasTurnServer(rtcConfiguration)
    ? Object.freeze({ mode: "turn_configured", detail: "已配置 TURN 中继" })
    : Object.freeze({ mode: "local_network_only", detail: "未配置 TURN，仅保证局域网连通" });
}

function activeTracks(stream) {
  if (!stream || typeof stream.getTracks !== "function") return [];
  return stream.getTracks().filter((track) => (
    track?.kind === "video" && track.readyState !== "ended"
  ));
}

export function validateActiveGrantContext({
  grantMessage,
  roomSessionId,
  runtimeSessionId,
  sourceGeneration,
  sceneId,
  stream,
  connected = true,
  nowMs = Date.now(),
}) {
  if (!connected) return { ok: false, reason: "relay_disconnected" };
  if (!isId(roomSessionId) || !isId(runtimeSessionId)) {
    return { ok: false, reason: "session_unavailable" };
  }
  if (!Number.isSafeInteger(sourceGeneration) || sourceGeneration < 0) {
    return { ok: false, reason: "source_generation_unavailable" };
  }
  if (sceneId === "bathroom") return { ok: false, reason: "bathroom_privacy_lock" };
  if (!exactKeys(grantMessage, ["type", "room_session_id", "grant", "audience", "reason"])) {
    return { ok: false, reason: "invalid_media_grant" };
  }
  const grant = grantMessage.grant;
  if (
    grantMessage.type !== "media_grant"
    || grantMessage.room_session_id !== roomSessionId
    || grantMessage.audience !== "all_viewers"
    || !exactKeys(grant, ["grant_id", "event_id", "scope", "expires_at_ms", "status"])
    || !isId(grant.grant_id)
    || !isId(grant.event_id)
    || grant.status !== "active"
    || !Number.isFinite(grant.expires_at_ms)
    || grant.expires_at_ms <= nowMs
  ) return { ok: false, reason: "invalid_media_grant" };
  if (grant.scope === "kitchen_moment" && sceneId !== "kitchen") {
    return { ok: false, reason: "grant_scene_mismatch" };
  }
  if (grant.scope === "fall_emergency" && sceneId !== "fall") {
    return { ok: false, reason: "grant_scene_mismatch" };
  }
  if (grant.scope !== "kitchen_moment" && grant.scope !== "fall_emergency") {
    return { ok: false, reason: "invalid_media_grant" };
  }
  if (activeTracks(stream).length === 0) return { ok: false, reason: "remote_stream_unavailable" };
  return { ok: true, grant };
}

export function createMediaSignal({
  roomSessionId,
  grantId,
  targetId,
  signalType,
  signal,
}) {
  const value = {
    schema_version: monitorRelayProtocol.mediaSignalSchema,
    room_session_id: roomSessionId,
    grant_id: grantId,
    target_id: targetId,
    signal_type: signalType,
    signal,
  };
  if (
    !isId(roomSessionId)
    || !isId(grantId)
    || !isId(targetId)
    || containsForbiddenRawMedia(value)
  ) throw new TypeError("无效的 WebRTC Relay signal");
  if (signalType === "offer" || signalType === "answer") {
    if (!exactKeys(signal, ["type", "sdp"]) || signal.type !== signalType
      || typeof signal.sdp !== "string"
      || signal.sdp.length === 0 || signal.sdp.length > 12_000) {
      throw new TypeError("无效的 SDP signal");
    }
    return value;
  }
  if (
    signalType !== "ice_candidate"
    || !exactKeys(signal, ["candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"])
    || typeof signal.candidate !== "string"
    || signal.candidate.length > 4_096
    || (signal.sdpMid !== null && (
      typeof signal.sdpMid !== "string" || signal.sdpMid.length > 128
    ))
    || (signal.sdpMLineIndex !== null
      && (!Number.isSafeInteger(signal.sdpMLineIndex) || signal.sdpMLineIndex < 0))
    || (signal.usernameFragment !== null && (
      typeof signal.usernameFragment !== "string" || signal.usernameFragment.length > 256
    ))
  ) throw new TypeError("无效的 ICE candidate signal");
  return value;
}

function normalizeCandidate(candidate) {
  const source = typeof candidate?.toJSON === "function" ? candidate.toJSON() : candidate;
  return {
    candidate: String(source?.candidate || ""),
    sdpMid: source?.sdpMid ?? null,
    sdpMLineIndex: source?.sdpMLineIndex ?? null,
    usernameFragment: source?.usernameFragment ?? null,
  };
}

function initialSnapshot(rtcConfiguration) {
  const connectivity = describeMediaConnectivity(rtcConfiguration);
  return Object.freeze({
    status: "idle",
    activeGrant: null,
    peerCount: 0,
    connectivity: connectivity.mode,
    connectivityDetail: connectivity.detail,
    lastReason: null,
    error: null,
  });
}

function defaultTimerApi() {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

/**
 * Viewer peers initiate an offer after receiving a grant. The Monitor answers
 * with the local MediaStream; no MediaStream, frame, JPEG, Blob, or base64 value
 * is ever serialized through Relay.
 */
export function createMonitorMediaProducer({
  RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
  RTCSessionDescriptionImpl = globalThis.RTCSessionDescription,
  RTCIceCandidateImpl = globalThis.RTCIceCandidate,
  rtcConfiguration = {},
  sendSignal,
  timerApi = defaultTimerApi(),
  now = () => Date.now(),
  onEvent = null,
} = {}) {
  let snapshot = initialSnapshot(rtcConfiguration);
  let active = null;
  let expiryTimer = null;
  let generation = 0;
  let callbacks = { sendSignal, onEvent };
  const peers = new Map();
  const pendingCandidates = new Map();
  const trackCleanups = [];
  const listeners = new Set();

  function update(values) {
    snapshot = Object.freeze({ ...snapshot, ...values });
    for (const listener of listeners) listener(snapshot);
  }

  function closePeer(viewerId, reason = "peer_closed") {
    const peer = peers.get(viewerId);
    if (!peer) return;
    peers.delete(viewerId);
    pendingCandidates.delete(viewerId);
    peer.pc.onicecandidate = null;
    peer.pc.onconnectionstatechange = null;
    try {
      peer.pc.close();
    } catch {
      // Continue closing every viewer peer.
    }
    update({ peerCount: peers.size, lastReason: reason });
  }

  function clearTrackListeners() {
    for (const cleanup of trackCleanups.splice(0)) cleanup();
  }

  function deactivate(reason = "grant_revoked") {
    generation += 1;
    if (expiryTimer !== null) timerApi.clearTimeout(expiryTimer);
    expiryTimer = null;
    for (const viewerId of [...peers.keys()]) closePeer(viewerId, reason);
    pendingCandidates.clear();
    clearTrackListeners();
    const previous = active;
    active = null;
    update({
      status: "idle",
      activeGrant: null,
      peerCount: 0,
      lastReason: reason,
      error: null,
    });
    if (previous) callbacks.onEvent?.({
      type: "media_producer_stopped",
      reason,
      grantId: previous.grantId,
    });
    return previous?.grantId || null;
  }

  function activate(context) {
    const validation = validateActiveGrantContext({ ...context, nowMs: now() });
    if (!validation.ok) {
      deactivate(validation.reason);
      return validation;
    }
    const grant = validation.grant;
    if (
      active?.grantId === grant.grant_id
      && active.roomSessionId === context.roomSessionId
      && active.runtimeSessionId === context.runtimeSessionId
      && active.sourceGeneration === context.sourceGeneration
      && active.sceneId === context.sceneId
      && active.stream === context.stream
    ) return { ok: true, grant, unchanged: true };

    deactivate("grant_replaced");
    generation += 1;
    active = {
      grantId: grant.grant_id,
      eventId: grant.event_id,
      scope: grant.scope,
      expiresAtMs: grant.expires_at_ms,
      roomSessionId: context.roomSessionId,
      runtimeSessionId: context.runtimeSessionId,
      sourceGeneration: context.sourceGeneration,
      sceneId: context.sceneId,
      stream: context.stream,
      generation,
    };
    for (const track of activeTracks(context.stream)) {
      if (typeof track.addEventListener !== "function") continue;
      const handleEnded = () => deactivate("media_track_ended");
      track.addEventListener("ended", handleEnded, { once: true });
      trackCleanups.push(() => track.removeEventListener?.("ended", handleEnded));
    }
    expiryTimer = timerApi.setTimeout(
      () => deactivate("grant_expired"),
      Math.max(0, grant.expires_at_ms - now()),
    );
    update({
      status: "active",
      activeGrant: Object.freeze({ ...grant }),
      peerCount: 0,
      lastReason: null,
      error: null,
    });
    callbacks.onEvent?.({ type: "media_producer_started", grantId: grant.grant_id });
    return { ok: true, grant };
  }

  function contextRejection(next) {
    if (!active) return null;
    if (!next.connected) return "relay_disconnected";
    if (next.roomSessionId !== active.roomSessionId) return "room_session_changed";
    if (next.runtimeSessionId !== active.runtimeSessionId) return "runtime_session_changed";
    if (next.sourceGeneration !== active.sourceGeneration) return "media_source_changed";
    if (next.sceneId === "bathroom") return "bathroom_privacy_lock";
    if (next.sceneId !== active.sceneId) return "scene_changed";
    if (next.stream !== active.stream || activeTracks(next.stream).length === 0) {
      return "remote_stream_unavailable";
    }
    if (active.expiresAtMs <= now()) return "grant_expired";
    return null;
  }

  function reconcile(next) {
    const rejection = contextRejection(next);
    if (rejection) deactivate(rejection);
    return rejection;
  }

  function sendForActive(viewerId, signalType, signal, expectedGeneration) {
    if (!active || active.generation !== expectedGeneration) return false;
    const value = createMediaSignal({
      roomSessionId: active.roomSessionId,
      grantId: active.grantId,
      targetId: viewerId,
      signalType,
      signal,
    });
    return callbacks.sendSignal?.(value) !== false;
  }

  function createPeer(viewerId, expectedGeneration) {
    if (typeof RTCPeerConnectionImpl !== "function") {
      throw new Error("RTCPeerConnection 不可用");
    }
    closePeer(viewerId, "viewer_peer_replaced");
    const pc = new RTCPeerConnectionImpl(rtcConfiguration);
    const peer = { pc, generation: expectedGeneration };
    peers.set(viewerId, peer);
    for (const track of activeTracks(active.stream)) pc.addTrack(track, active.stream);
    pc.onicecandidate = (event) => {
      if (!event.candidate || active?.generation !== expectedGeneration) return;
      const candidate = normalizeCandidate(event.candidate);
      if (!candidate.candidate) return;
      try {
        sendForActive(viewerId, "ice_candidate", candidate, expectedGeneration);
      } catch (error) {
        update({ error: error?.message || "ICE signal 发送失败" });
      }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        closePeer(viewerId, `peer_${pc.connectionState}`);
      }
    };
    update({ peerCount: peers.size });
    return peer;
  }

  async function applyCandidate(viewerId, signal, expectedGeneration) {
    const peer = peers.get(viewerId);
    if (!peer || peer.generation !== expectedGeneration || !peer.pc.remoteDescription) {
      const queue = pendingCandidates.get(viewerId) || [];
      if (queue.length >= MAX_PENDING_ICE_PER_VIEWER) queue.shift();
      queue.push(signal);
      pendingCandidates.set(viewerId, queue);
      return { ok: true, pending: true };
    }
      const candidate = RTCIceCandidateImpl ? new RTCIceCandidateImpl({
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
        usernameFragment: signal.usernameFragment,
      }) : {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
        usernameFragment: signal.usernameFragment,
    };
    await peer.pc.addIceCandidate(candidate);
    return { ok: true };
  }

  async function flushCandidates(viewerId, expectedGeneration) {
    const queued = pendingCandidates.get(viewerId) || [];
    pendingCandidates.delete(viewerId);
    for (const candidate of queued) {
      if (active?.generation !== expectedGeneration) return;
      await applyCandidate(viewerId, candidate, expectedGeneration);
    }
  }

  async function handleSignal(value) {
    if (!validateForwardedMediaSignal(value)) return { ok: false, reason: "invalid_media_signal" };
    if (!active) return { ok: false, reason: "media_grant_inactive" };
    if (
      value.room_session_id !== active.roomSessionId
      || value.grant_id !== active.grantId
      || value.target_id !== "monitor"
    ) return { ok: false, reason: "stale_media_signal" };
    if (active.expiresAtMs <= now()) {
      deactivate("grant_expired");
      return { ok: false, reason: "grant_expired" };
    }
    const viewerId = value.from_id;
    const expectedGeneration = active.generation;
    try {
      if (value.signal_type === "ice_candidate") {
        return await applyCandidate(viewerId, value.signal, expectedGeneration);
      }
      if (value.signal_type !== "offer") {
        return { ok: false, reason: "unexpected_media_answer" };
      }
      const peer = createPeer(viewerId, expectedGeneration);
      const description = RTCSessionDescriptionImpl
        ? new RTCSessionDescriptionImpl({ type: "offer", sdp: value.signal.sdp })
        : { type: "offer", sdp: value.signal.sdp };
      await peer.pc.setRemoteDescription(description);
      if (!active || active.generation !== expectedGeneration) {
        closePeer(viewerId, "grant_changed_during_offer");
        return { ok: false, reason: "grant_changed_during_offer" };
      }
      await flushCandidates(viewerId, expectedGeneration);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      if (!active || active.generation !== expectedGeneration) {
        closePeer(viewerId, "grant_changed_during_answer");
        return { ok: false, reason: "grant_changed_during_answer" };
      }
      const sdp = peer.pc.localDescription?.sdp || answer?.sdp;
      sendForActive(viewerId, "answer", { type: "answer", sdp }, expectedGeneration);
      return { ok: true, viewerId };
    } catch (error) {
      closePeer(viewerId, "peer_negotiation_failed");
      update({ error: error?.message || "WebRTC 协商失败" });
      return { ok: false, reason: "peer_negotiation_failed" };
    }
  }

  function handleGrantMessage(value, context) {
    if (value === null || value?.grant?.status === "revoked" || value?.grant?.status === "expired") {
      const reason = value?.reason || (value?.grant?.status === "expired" ? "grant_expired" : "grant_revoked");
      deactivate(reason);
      return { ok: true, active: false };
    }
    return activate({ ...context, grantMessage: value });
  }

  return Object.freeze({
    activate,
    deactivate,
    reconcile,
    handleGrantMessage,
    handleSignal,
    disconnectViewer: closePeer,
    setCallbacks(next = {}) {
      callbacks = {
        sendSignal: next.sendSignal ?? null,
        onEvent: next.onEvent ?? null,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  });
}
