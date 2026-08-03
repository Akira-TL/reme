import {
  createMediaSignal,
  isDemoEvent,
  isForwardedMediaSignal,
} from "./protocol.js";

function grantPayload(event) {
  return isDemoEvent(event) && event.event_type === "media_grant"
    ? event.payload
    : null;
}

function matchesGrant(left, right) {
  const a = grantPayload(left);
  const b = grantPayload(right);
  return Boolean(
    a && b
    && a.grant_id === b.grant_id
    && a.event_id === b.event_id
    && a.scope === b.scope,
  );
}

function contextAllowsGrant(grant, context) {
  const payload = grantPayload(grant);
  if (
    !payload
    || payload.status !== "active"
    || payload.expires_at_ms <= Date.now()
    || !context?.captureActive
    || context.visibilityState !== "visible"
  ) return false;
  if (payload.scope === "kitchen_moment") {
    return context.sceneId === "kitchen"
      && context.kitchenEventId === payload.event_id;
  }
  if (payload.scope === "fall_emergency") {
    return context.sceneId === "fall"
      && context.fall?.eventId === payload.event_id
      && context.fall.phase === "escalated"
      && context.fall.delivery === "accepted";
  }
  return false;
}

export function selectKitchenRecognitionAction({
  sceneId,
  recognitionEnabled,
  activityPhase,
  kitchenEventId,
} = {}) {
  if (
    sceneId !== "kitchen"
    || kitchenEventId
    || (recognitionEnabled && activityPhase !== "unavailable")
  ) return null;
  return activityPhase === "unavailable" ? "retry" : "start";
}

export function canStartKitchenRecognition({
  sceneId,
  captureActive,
  connectionReady,
  visibilityState,
  automaticScenePhase,
  kitchenEventId,
  pendingKitchenGrant,
} = {}) {
  return sceneId === "kitchen"
    && captureActive === true
    && connectionReady === true
    && visibilityState === "visible"
    && !["capturing", "analyzing"].includes(automaticScenePhase)
    && !kitchenEventId
    && !pendingKitchenGrant;
}

export function selectFallMediaRegrantAction({
  fall,
  sceneId,
  captureActive,
  connectionReady,
  visibilityState,
  mediaStatus,
  activeGrant,
} = {}) {
  if (
    fall?.phase !== "escalated"
    || fall.delivery !== "accepted"
    || !fall.eventId
    || sceneId !== "fall"
    || captureActive !== true
    || connectionReady !== true
    || visibilityState !== "visible"
    || ["authorizing", "credentialing", "connecting"].includes(mediaStatus)
  ) return { action: "block", eventId: null };

  const payload = grantPayload(activeGrant);
  if (payload?.status === "active") return { action: "block", eventId: null };
  return {
    action: "request",
    eventId: fall.eventId,
  };
}

export function canAutomaticallyOpenInitialFallMedia({
  eligibleEventId,
  eventId,
  visibilityState,
  allowInitialMedia = null,
  captureActive,
  streamActive,
  sessionActive,
  connectionReady,
} = {}) {
  return Boolean(
    eventId
    && eligibleEventId === eventId
    && visibilityState === "visible"
    && allowInitialMedia !== false
    && captureActive === true
    && streamActive === true
    && sessionActive === true
    && connectionReady === true,
  );
}

export function selectAutomaticFallMediaAction({
  fall,
  allowInitialMedia = false,
  visibilityState,
  captureActive,
  streamActive,
  sessionActive,
  connectionReady,
} = {}) {
  if (
    fall?.phase !== "escalated"
    || fall.delivery !== "accepted"
    || !fall.eventId
  ) return { action: "none", eventId: null };

  return canAutomaticallyOpenInitialFallMedia({
    eligibleEventId: allowInitialMedia === true ? fall.eventId : null,
    eventId: fall.eventId,
    visibilityState,
    captureActive,
    streamActive,
    sessionActive,
    connectionReady,
  })
    ? { action: "request", eventId: fall.eventId }
    : { action: "wait_explicit", eventId: fall.eventId };
}

export function selectFallMediaActionAfterAlarmAck({
  fall,
  pending,
  eventSequence,
  visibilityState,
  captureActive,
  streamActive,
  sessionActive,
  connectionReady,
} = {}) {
  const context = {
    visibilityState,
    captureActive,
    streamActive,
    sessionActive,
    connectionReady,
  };
  const base = selectAutomaticFallMediaAction({ fall, ...context });
  if (base.action === "none") return base;

  const isMatchingInitialEscalation = pending?.allowInitialMedia === true
    && pending.eventId === fall.eventId
    && pending.phase === "escalated"
    && pending.eventSequence === eventSequence;
  return selectAutomaticFallMediaAction({
    fall,
    allowInitialMedia: isMatchingInitialEscalation,
    ...context,
  });
}

export function createMediaGrantRequestTracker() {
  let generation = 0;
  let pending = null;

  return {
    begin({ eventId, scope, sceneId, captureGeneration, visibilityState }) {
      generation += 1;
      pending = {
        generation,
        eventId,
        scope,
        sceneId,
        captureGeneration,
        visibilityState,
      };
      return pending;
    },
    invalidate() {
      generation += 1;
      pending = null;
    },
    classify(grant, { activeGrant = null, activeContext = null, current } = {}) {
      if (!contextAllowsGrant(grant, current)) return "revoke";
      if (matchesGrant(grant, activeGrant)) {
        return activeContext?.captureGeneration === current.captureGeneration
          ? "accept_repeat"
          : "revoke";
      }
      const payload = grantPayload(grant);
      if (
        !payload
        || !pending
        || pending.generation !== generation
        || pending.eventId !== payload.event_id
        || pending.scope !== payload.scope
        || pending.sceneId !== current.sceneId
        || pending.captureGeneration !== current.captureGeneration
        || pending.visibilityState !== "visible"
      ) return "revoke";
      return "accept_initial";
    },
    accept() {
      const accepted = pending;
      pending = null;
      return accepted;
    },
    pending() {
      return pending;
    },
  };
}

function sendJson(socket, value) {
  if (!socket || socket.readyState !== 1 || !value) return false;
  try {
    socket.send(JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
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

export const CONTROLLER_ICE_MIN_HANDSHAKE_MS = 1_000;
export const MAX_CONTROLLER_MEDIA_ICE_CANDIDATES = 64;

function defaultMonotonicNow() {
  if (typeof globalThis.performance?.now === "function") {
    return globalThis.performance.now();
  }
  return Date.now();
}

function cloneIceServers(iceServers) {
  return iceServers.map((server) => ({
    ...server,
    urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
  }));
}

function isValidIceResult(result) {
  return result
    && Array.isArray(result.iceServers)
    && result.iceServers.length > 0
    && Number.isSafeInteger(result.expiresAtMs)
    && result.expiresAtMs >= 0
    && Number.isSafeInteger(result.ttlMs)
    && result.ttlMs >= CONTROLLER_ICE_MIN_HANDSHAKE_MS
    && result.ttlMs <= 60_000;
}

export function createControllerMediaBridge({
  getSocket,
  getStream,
  getIceServers,
  onStatus = () => {},
  PeerConnection = globalThis.RTCPeerConnection,
  monotonicNow = defaultMonotonicNow,
} = {}) {
  const peers = new Map();
  let activeGrant = null;
  let activeAudience = new Set();
  let activeIceConfiguration = null;
  let activeIceRequest = null;
  let activeIceAbort = null;
  let generation = 0;

  function currentMonotonicTime() {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError("a monotonic clock is required for reliable ICE");
    }
    return value;
  }

  function cachedIceServers() {
    if (!activeIceConfiguration) return null;
    if (
      activeIceConfiguration.deadlineMs - currentMonotonicTime()
      < CONTROLLER_ICE_MIN_HANDSHAKE_MS
    ) {
      activeIceConfiguration = null;
      return null;
    }
    return activeIceConfiguration.iceServers;
  }

  function requestIceServers(grantEvent) {
    const cached = cachedIceServers();
    if (cached) return Promise.resolve(cached);
    if (activeIceRequest) return activeIceRequest;
    if (activeAudience.size === 0) return Promise.resolve(null);

    const grantId = grantEvent.payload.grant_id;
    const operationGeneration = generation;
    const requestStartedAtMs = currentMonotonicTime();
    const abortController = new AbortController();
    activeIceAbort = abortController;
    onStatus({ state: "credentialing", viewerId: null, grantId });
    const request = Promise.resolve(getIceServers(grantEvent, {
      signal: abortController.signal,
    })).then((result) => {
      if (
        abortController.signal.aborted
        || activeGrant?.payload.grant_id !== grantId
        || generation !== operationGeneration
      ) return null;
      if (!isValidIceResult(result)) {
        throw new TypeError("reliable ICE servers are unavailable");
      }
      const nextIceServers = cloneIceServers(result.iceServers);
      activeIceConfiguration = {
        iceServers: nextIceServers,
        expiresAtMs: result.expiresAtMs,
        ttlMs: result.ttlMs,
        deadlineMs: requestStartedAtMs + result.ttlMs,
      };
      activeIceAbort = null;
      const usableIceServers = cachedIceServers();
      if (!usableIceServers) {
        throw new TypeError("reliable ICE lifetime is insufficient for a new handshake");
      }
      return usableIceServers;
    }).catch((error) => {
      if (
        abortController.signal.aborted
        || activeGrant?.payload.grant_id !== grantId
        || generation !== operationGeneration
      ) return null;
      activeIceAbort = null;
      activeIceConfiguration = null;
      onStatus({
        state: "ice_unavailable",
        viewerId: null,
        grantId,
        error: error instanceof Error ? error.message : "可靠实景网络配置不可用",
      });
      return null;
    }).finally(() => {
      if (activeIceRequest === request) activeIceRequest = null;
    });
    activeIceRequest = request;
    return request;
  }

  function closePeer(viewerId, reason = "closed", expectedRecord = null) {
    const record = peers.get(viewerId);
    if (!record || (expectedRecord && record !== expectedRecord)) return false;
    peers.delete(viewerId);
    record.peer.onicecandidate = null;
    record.peer.onconnectionstatechange = null;
    try {
      record.peer.close();
    } catch {
      // Closing is best-effort; the grant remains the authority.
    }
    onStatus({ state: reason, viewerId, grantId: record.grantId });
    return true;
  }

  function stopGrant(grantId = null, reason = "revoked") {
    if (grantId !== null && activeGrant?.payload.grant_id !== grantId) return false;
    generation += 1;
    activeIceAbort?.abort(reason);
    activeIceAbort = null;
    activeIceRequest = null;
    activeIceConfiguration = null;
    activeAudience = new Set();
    for (const viewerId of [...peers.keys()]) closePeer(viewerId, reason);
    activeGrant = null;
    return true;
  }

  async function startPeer(viewerId, grantEvent, stream, iceServers) {
    if (
      activeGrant?.payload.grant_id !== grantEvent.payload.grant_id
      || !activeAudience.has(viewerId)
    ) return;
    closePeer(viewerId, "replaced");
    const peer = new PeerConnection({ iceServers });
    const record = {
      peer,
      grantId: grantEvent.payload.grant_id,
      remoteReady: false,
      answerReceived: false,
      receivedIceCandidates: 0,
      pendingIce: [],
    };
    peers.set(viewerId, record);
    for (const track of stream.getVideoTracks()) peer.addTrack(track, stream);
    peer.onicecandidate = (event) => {
      const signal = event.candidate ? toIceSignal(event.candidate) : null;
      if (!signal || peers.get(viewerId) !== record) return;
      const sent = sendJson(getSocket?.(), createMediaSignal({
        grantId: record.grantId,
        targetId: viewerId,
        signalType: "ice_candidate",
        signal,
      }));
      if (!sent) closePeer(viewerId, "signal_unavailable", record);
    };
    peer.onconnectionstatechange = () => {
      if (peers.get(viewerId) !== record) return;
      const state = peer.connectionState;
      onStatus({ state, viewerId, grantId: record.grantId });
      if (["failed", "disconnected", "closed"].includes(state)) {
        closePeer(viewerId, state, record);
      }
    };
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peers.get(viewerId) !== record) return;
      if (
        activeGrant?.payload.grant_id !== record.grantId
        || !activeAudience.has(viewerId)
      ) {
        closePeer(viewerId, "audience_removed", record);
        return;
      }
      const sent = sendJson(getSocket?.(), createMediaSignal({
        grantId: record.grantId,
        targetId: viewerId,
        signalType: "offer",
        signal: { sdp: peer.localDescription?.sdp || offer.sdp || "" },
      }));
      if (!sent) closePeer(viewerId, "signal_unavailable", record);
    } catch {
      closePeer(viewerId, "offer_failed", record);
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
    if (typeof getIceServers !== "function") {
      onStatus({
        state: "ice_unavailable",
        viewerId: null,
        grantId: grantEvent.payload.grant_id,
        error: "可靠实景网络配置不可用；已保持隐私骨架。",
      });
      return false;
    }
    const stream = getStream?.();
    if (!stream?.getVideoTracks?.().length) {
      onStatus({ state: "stream_unavailable", viewerId: null, grantId: grantEvent.payload.grant_id });
      return false;
    }
    const grantId = grantEvent.payload.grant_id;
    const sameGrant = activeGrant?.payload.grant_id === grantId;
    const nextViewerIds = [...new Set(viewerIds)];
    if (!sameGrant) {
      stopGrant(null, "replaced");
      activeGrant = grantEvent;
      activeAudience = new Set(nextViewerIds);
    } else {
      activeGrant = grantEvent;
      activeAudience = new Set(nextViewerIds);
    }

    if (sameGrant) {
      for (const viewerId of [...peers.keys()]) {
        if (!activeAudience.has(viewerId)) closePeer(viewerId, "audience_removed");
      }
    }
    if (activeAudience.size === 0) {
      activeIceAbort?.abort("audience_empty");
      activeIceAbort = null;
      activeIceRequest = null;
      activeIceConfiguration = null;
      onStatus({ state: "waiting_viewer", viewerId: null, grantId });
      return true;
    }
    const hasMissingViewer = [...activeAudience].some((viewerId) => {
      const record = peers.get(viewerId);
      return !record || record.grantId !== grantId;
    });
    if (!hasMissingViewer) return true;
    const iceServers = cachedIceServers() || await requestIceServers(grantEvent);
    if (!iceServers || activeGrant?.payload.grant_id !== grantId) return false;
    const missingViewerIds = [...activeAudience].filter((viewerId) => {
      const record = peers.get(viewerId);
      return !record || record.grantId !== grantId;
    });
    if (missingViewerIds.length === 0) return true;
    onStatus({ state: "connecting", viewerId: null, grantId });
    await Promise.all(
      missingViewerIds.map((viewerId) => startPeer(viewerId, grantEvent, stream, iceServers)),
    );
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
        if (record.answerReceived) {
          closePeer(value.from_id, "duplicate_answer", record);
          return false;
        }
        record.answerReceived = true;
        await record.peer.setRemoteDescription({ type: "answer", sdp: value.signal.sdp });
        if (peers.get(value.from_id) !== record) return false;
        record.remoteReady = true;
        for (const candidate of record.pendingIce.splice(0)) {
          await record.peer.addIceCandidate(candidate);
          if (peers.get(value.from_id) !== record) return false;
        }
        return true;
      }
      if (value.signal_type === "ice_candidate") {
        record.receivedIceCandidates += 1;
        if (record.receivedIceCandidates > MAX_CONTROLLER_MEDIA_ICE_CANDIDATES) {
          closePeer(value.from_id, "ice_overflow", record);
          return false;
        }
        const candidate = {
          candidate: value.signal.candidate,
          sdpMid: value.signal.sdp_mid,
          sdpMLineIndex: value.signal.sdp_mline_index,
        };
        if (!record.remoteReady) record.pendingIce.push(candidate);
        else {
          await record.peer.addIceCandidate(candidate);
          if (peers.get(value.from_id) !== record) return false;
        }
        return peers.get(value.from_id) === record;
      }
    } catch {
      closePeer(value.from_id, "signal_failed", record);
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
