import {
  createExactControlAck,
  exactKeys,
  HEARTBEAT_INTERVAL_MS,
  isBoundedString,
  isFiniteNonNegative,
  isId,
  isNonNegativeInteger,
  MONITOR_PROTOCOL,
  parseRelayMessage,
  resolveMonitorRelayEndpoints,
  serializeRelayMessage,
  TOKEN_PROTOCOL_PREFIX,
  validController,
  validMediaSignal,
  validViewerCounts,
  validateClaim,
  validateControlCommand,
  validateDemoStateEnvelope,
  validateForwardedMediaSignal,
  validateMediaGrant,
  validatePoseFrame,
} from "../transport/relay/monitorProtocol.js";

export {
  containsForbiddenRawMedia,
  createDemoStateEnvelope,
  createExactControlAck,
  createPoseFrame,
  monitorRelayProtocol,
  resolveMonitorRelayEndpoints,
  validateDemoStateEnvelope,
  validateForwardedMediaSignal,
} from "../transport/relay/monitorProtocol.js";

const MAX_SOCKET_BUFFER_BYTES = 64 * 1024;
const CLAIM_STORAGE_KEY = "reme-monitor-claim/v1";

export async function claimMonitor(relayUrl, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch 不可用");
  const endpoints = resolveMonitorRelayEndpoints(relayUrl);
  const response = await fetchImpl(endpoints.claimUrl, {
    method: "POST",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // A stable local error is safer than exposing an arbitrary proxy response.
  }
  if (!response.ok) {
    const error = new Error(payload?.error === "monitor_busy" ? "Monitor 正被另一设备占用" : "Relay claim 失败");
    error.code = payload?.error || `http_${response.status}`;
    error.retryAtMs = isFiniteNonNegative(payload?.retry_at_ms) ? payload.retry_at_ms : null;
    error.serverTimeMs = isFiniteNonNegative(payload?.server_time_ms)
      ? payload.server_time_ms
      : null;
    error.retryAfterMs = isFiniteNonNegative(payload?.retry_after_ms)
      ? payload.retry_after_ms
      : error.retryAtMs !== null && error.serverTimeMs !== null
        ? Math.max(0, error.retryAtMs - error.serverTimeMs)
        : null;
    throw error;
  }
  if (!validateClaim(payload)) {
    const error = new Error("Relay 返回了无效的 producer claim");
    error.code = "invalid_claim_response";
    throw error;
  }
  return Object.freeze({ ...payload, relay_url: relayUrl });
}

export function createSessionClaimStore(storage = globalThis.sessionStorage) {
  return Object.freeze({
    load(relayUrl, nowMs = Date.now()) {
      if (!storage?.getItem) return null;
      try {
        const value = JSON.parse(storage.getItem(CLAIM_STORAGE_KEY));
        if (!exactKeys(value, [
          "relay_url",
          "room_name",
          "room_session_id",
          "producer_token",
          "expires_at_ms",
        ])) return null;
        if (value.relay_url !== relayUrl || !validateClaim({
          room_name: value.room_name,
          room_session_id: value.room_session_id,
          producer_token: value.producer_token,
          expires_at_ms: value.expires_at_ms,
        })) return null;
        return value.expires_at_ms > nowMs ? Object.freeze(value) : null;
      } catch {
        return null;
      }
    },
    save(claim) {
      const claimPayload = {
        room_name: claim?.room_name,
        room_session_id: claim?.room_session_id,
        producer_token: claim?.producer_token,
        expires_at_ms: claim?.expires_at_ms,
      };
      if (!storage?.setItem || !validateClaim(claimPayload) || typeof claim.relay_url !== "string") {
        return;
      }
      try {
        storage.setItem(CLAIM_STORAGE_KEY, JSON.stringify({
          relay_url: claim.relay_url,
          room_name: claim.room_name,
          room_session_id: claim.room_session_id,
          producer_token: claim.producer_token,
          expires_at_ms: claim.expires_at_ms,
        }));
      } catch {
        // Memory-only operation remains valid when sessionStorage is unavailable.
      }
    },
    clear() {
      try {
        storage?.removeItem?.(CLAIM_STORAGE_KEY);
      } catch {
        // An unavailable sessionStorage must never block local cleanup.
      }
    },
  });
}

export function createLatestPublicationQueue(send, canSend = () => true) {
  let roomSessionId = null;
  let runtimeSessionId = null;
  let latestState = null;
  let latestPose = null;
  let stateInFlight = null;
  let poseInFlight = null;
  let acceptedStateRevision = -1;
  let acceptedPoseSequence = -1;

  function drain() {
    if (!canSend()) return;
    if (
      latestState
      && stateInFlight === null
      && latestState.state_revision > acceptedStateRevision
    ) {
      stateInFlight = latestState.state_revision;
      send(latestState);
      return;
    }
    if (
      latestPose
      && poseInFlight === null
      && acceptedStateRevision >= 0
      && latestPose.frame_sequence > acceptedPoseSequence
    ) {
      poseInFlight = latestPose.frame_sequence;
      send(latestPose);
    }
  }

  return Object.freeze({
    reset(nextRoomSessionId, nextRuntimeSessionId) {
      roomSessionId = nextRoomSessionId;
      runtimeSessionId = nextRuntimeSessionId;
      latestState = null;
      latestPose = null;
      stateInFlight = null;
      poseInFlight = null;
      acceptedStateRevision = -1;
      acceptedPoseSequence = -1;
    },
    transportInterrupted() {
      // An ACK may have been lost. Keep the last accepted cursors unchanged and
      // retry the exact in-flight value after reconnect; Relay treats exact
      // duplicate state/pose publications idempotently.
      stateInFlight = null;
      poseInFlight = null;
    },
    offerState(value) {
      if (!validateDemoStateEnvelope(value, roomSessionId)) return false;
      const runtimeChanged = runtimeSessionId !== null
        && value.runtime_session_id !== runtimeSessionId;
      if (runtimeChanged) {
        latestState = null;
        stateInFlight = null;
        acceptedStateRevision = -1;
        latestPose = null;
        poseInFlight = null;
        acceptedPoseSequence = -1;
      }
      runtimeSessionId = value.runtime_session_id;
      if (latestState === null || value.state_revision > latestState.state_revision) {
        latestState = value;
      }
      drain();
      return true;
    },
    offerPose(value) {
      if (!validatePoseFrame(value, roomSessionId, runtimeSessionId)) return false;
      if (latestPose === null || value.frame_sequence > latestPose.frame_sequence) {
        latestPose = value;
      }
      drain();
      return true;
    },
    acceptState(revision) {
      if (!isNonNegativeInteger(revision)) return;
      acceptedStateRevision = Math.max(acceptedStateRevision, revision);
      if (stateInFlight !== null && revision >= stateInFlight) stateInFlight = null;
      drain();
    },
    acceptPose(sequence) {
      if (!isNonNegativeInteger(sequence)) return;
      acceptedPoseSequence = Math.max(acceptedPoseSequence, sequence);
      if (poseInFlight !== null && sequence >= poseInFlight) poseInFlight = null;
      drain();
    },
    rejectPose() {
      latestPose = null;
      poseInFlight = null;
    },
    drain,
    snapshot() {
      return {
        roomSessionId,
        runtimeSessionId,
        latestStateRevision: latestState?.state_revision ?? null,
        latestPoseSequence: latestPose?.frame_sequence ?? null,
        stateInFlight,
        poseInFlight,
        acceptedStateRevision,
        acceptedPoseSequence,
      };
    },
  });
}

function initialSnapshot(relayUrl) {
  return Object.freeze({
    relayUrl,
    status: relayUrl ? "idle" : "unconfigured",
    roomName: "shared-live-demo",
    roomSessionId: null,
    producerLeaseExpiresAtMs: null,
    viewerCount: 0,
    maxViewers: 5,
    controller: null,
    connectionGeneration: 0,
    error: relayUrl ? null : "Relay URL 未配置",
    lastProtocolError: null,
    acceptedStateRevision: -1,
    latestPoseSequence: null,
    poseInFlight: null,
    acceptedPoseSequence: -1,
    serverTimeOffsetMs: 0,
  });
}

function defaultTimerApi() {
  return {
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
}

export function createMonitorRelayClient({
  relayUrl,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  claimStore = createSessionClaimStore(),
  timerApi = defaultTimerApi(),
  now = () => Date.now(),
  onCommand = null,
  onMediaGrant = null,
  onMediaSignal = null,
  onEvent = null,
} = {}) {
  let snapshot = initialSnapshot(relayUrl || "");
  let desiredActive = false;
  let claim = null;
  let socket = null;
  let heartbeatTimer = null;
  let reconnectTimer = null;
  let generation = 0;
  let controlGeneration = 0;
  let controlRevocationPending = false;
  let commandChain = Promise.resolve();
  let callbacks = { onCommand, onMediaGrant, onMediaSignal, onEvent };
  const listeners = new Set();
  const handledCommands = new Map();
  const appliedAcks = new Map();
  const endpoints = relayUrl ? resolveMonitorRelayEndpoints(relayUrl) : null;

  function emitEvent(event) {
    callbacks.onEvent?.(event);
  }

  function update(values) {
    snapshot = Object.freeze({ ...snapshot, ...values });
    for (const listener of listeners) listener(snapshot);
  }

  function socketOpen() {
    return socket?.readyState === 1;
  }

  function relayNow() {
    return now() + (snapshot.serverTimeOffsetMs || 0);
  }

  function canPublish() {
    return snapshot.status === "connected"
      && socketOpen()
      && (socket.bufferedAmount || 0) <= MAX_SOCKET_BUFFER_BYTES;
  }

  function send(value) {
    if (!socketOpen()) return false;
    try {
      socket.send(serializeRelayMessage(value));
      return true;
    } catch {
      return false;
    }
  }

  const publications = createLatestPublicationQueue(send, canPublish);

  function flushAppliedAcks() {
    if (!canPublish()) return;
    const acceptedRevision = publications.snapshot().acceptedStateRevision;
    for (const entry of appliedAcks.values()) {
      if (
        entry.ack.state_revision <= acceptedRevision
        && entry.sentGeneration !== generation
        && send(entry.ack)
      ) entry.sentGeneration = generation;
    }
  }

  function clearTimers() {
    if (heartbeatTimer !== null) timerApi.clearInterval(heartbeatTimer);
    if (reconnectTimer !== null) timerApi.clearTimeout(reconnectTimer);
    heartbeatTimer = null;
    reconnectTimer = null;
  }

  function closeSocket(code = 1000, reason = "monitor_stopped") {
    const previous = socket;
    socket = null;
    publications.transportInterrupted();
    if (previous && previous.readyState < 2) previous.close(code, reason);
  }

  function heartbeat() {
    if (!claim || !socketOpen()) return;
    send({ type: "monitor_heartbeat", room_session_id: claim.room_session_id });
    publications.drain();
    flushAppliedAcks();
  }

  function beginHeartbeat() {
    if (heartbeatTimer !== null) timerApi.clearInterval(heartbeatTimer);
    heartbeatTimer = timerApi.setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  }

  function scheduleReconnect(delayMs = 500) {
    if (!desiredActive || reconnectTimer !== null) return;
    reconnectTimer = timerApi.setTimeout(() => {
      reconnectTimer = null;
      if (!desiredActive) return;
      if (claim?.expires_at_ms > relayNow()) void connect(claim, true);
      else void start(true);
    }, delayMs);
  }

  function rememberHandledCommand(commandId, phase = "received") {
    handledCommands.set(commandId, phase);
    if (handledCommands.size > 64) handledCommands.delete(handledCommands.keys().next().value);
  }

  function sendControlAck(parameters) {
    if (!claim) return false;
    const ack = createExactControlAck({
      roomSessionId: claim.room_session_id,
      timestampMs: parameters.timestampMs ?? relayNow(),
      ...parameters,
    });
    rememberHandledCommand(ack.command_id, ack.phase);
    if (ack.phase === "applied") {
      appliedAcks.set(ack.command_id, { ack, sentGeneration: -1 });
      if (appliedAcks.size > 64) appliedAcks.delete(appliedAcks.keys().next().value);
      flushAppliedAcks();
      return true;
    }
    return send(ack);
  }

  async function dispatchCommand(command, expectedControlGeneration) {
    if (!claim || command.room_session_id !== claim.room_session_id) return;
    if (expectedControlGeneration !== controlGeneration) return;
    if (handledCommands.has(command.command_id)) return;
    rememberHandledCommand(command.command_id);
    if (command.expires_at_ms <= relayNow()) {
      sendControlAck({
        commandId: command.command_id,
        phase: "rejected",
        stateRevision: null,
        reason: "command_expired",
      });
      return;
    }
    try {
      const result = await callbacks.onCommand?.(command);
      if (expectedControlGeneration !== controlGeneration) return;
      if (result?.phase) {
        sendControlAck({
          commandId: command.command_id,
          phase: result.phase,
          stateRevision: result.stateRevision ?? null,
          reason: result.reason ?? result.code ?? null,
        });
      }
    } catch (error) {
      if (expectedControlGeneration !== controlGeneration) return;
      sendControlAck({
        commandId: command.command_id,
        phase: "failed",
        stateRevision: null,
        reason: isBoundedString(error?.code, 240) ? error.code : "monitor_command_failed",
      });
    }
  }

  function handleMessage(event, connectionGeneration) {
    if (generation !== connectionGeneration || event.currentTarget !== socket) return;
    const value = parseRelayMessage(event.data);
    if (value.type === "monitor_ready") {
      if (!exactKeys(value, [
        "type",
        "room_name",
        "room_session_id",
        "expires_at_ms",
        "viewer_count",
        "max_viewers",
        "controller",
        "heartbeat_interval_ms",
        "server_time_ms",
      ]) || value.room_name !== "shared-live-demo" || value.room_session_id !== claim?.room_session_id
        || !isFiniteNonNegative(value.expires_at_ms)
        || !validViewerCounts(value.viewer_count, value.max_viewers)
        || value.heartbeat_interval_ms !== HEARTBEAT_INTERVAL_MS
        || !isFiniteNonNegative(value.server_time_ms)
        || !validController(value.controller)) {
        update({
          status: "reconnecting",
          lastProtocolError: "invalid_monitor_ready",
          error: "Relay monitor_ready 协议不匹配",
        });
        closeSocket(1008, "invalid_monitor_ready");
        scheduleReconnect();
        return;
      }
      claim = Object.freeze({ ...claim, expires_at_ms: value.expires_at_ms });
      claimStore.save(claim);
      update({
        status: "connected",
        roomName: value.room_name,
        roomSessionId: value.room_session_id,
        producerLeaseExpiresAtMs: value.expires_at_ms,
        viewerCount: value.viewer_count,
        maxViewers: value.max_viewers,
        controller: value.controller,
        serverTimeOffsetMs: value.server_time_ms - now(),
        error: null,
      });
      beginHeartbeat();
      emitEvent({ type: "needs_state", roomSessionId: value.room_session_id, connectionGeneration });
      publications.drain();
      flushAppliedAcks();
      return;
    }
    if (value.type === "viewer_presence") {
      if (exactKeys(value, [
        "type", "room_session_id", "viewer_count", "max_viewers", "monitor_online", "server_time_ms",
      ])
        && value.room_session_id === claim?.room_session_id
        && validViewerCounts(value.viewer_count, value.max_viewers)
        && typeof value.monitor_online === "boolean"
        && isFiniteNonNegative(value.server_time_ms)) {
        update({ viewerCount: value.viewer_count, maxViewers: value.max_viewers });
      }
      return;
    }
    if (value.type === "controller_status") {
      if (exactKeys(value, ["type", "room_session_id", "controller", "server_time_ms"])
        && value.room_session_id === claim?.room_session_id
        && validController(value.controller)
        && isFiniteNonNegative(value.server_time_ms)) {
        if (controlRevocationPending && value.controller === null) {
          controlRevocationPending = false;
        }
        update({ controller: value.controller });
      }
      return;
    }
    if (value.type === "monitor_heartbeat_ack") {
      if (exactKeys(value, ["type", "room_session_id", "expires_at_ms"])
        && value.room_session_id === claim?.room_session_id
        && isFiniteNonNegative(value.expires_at_ms)) {
        claim = Object.freeze({ ...claim, expires_at_ms: value.expires_at_ms });
        claimStore.save(claim);
        update({ producerLeaseExpiresAtMs: value.expires_at_ms });
      }
      return;
    }
    if (value.type === "state_accepted") {
      if (exactKeys(value, ["type", "room_session_id", "state_revision"])
        && value.room_session_id === claim?.room_session_id
        && isNonNegativeInteger(value.state_revision)) {
        publications.acceptState(value.state_revision);
        update({
          acceptedStateRevision: Math.max(
            snapshot.acceptedStateRevision,
            value.state_revision,
          ),
        });
        flushAppliedAcks();
      }
      return;
    }
    if (value.type === "pose_accepted") {
      if (exactKeys(value, ["type", "room_session_id", "frame_sequence"])
        && value.room_session_id === claim?.room_session_id
        && isNonNegativeInteger(value.frame_sequence)) {
        publications.acceptPose(value.frame_sequence);
        const publication = publications.snapshot();
        update({
          latestPoseSequence: publication.latestPoseSequence,
          poseInFlight: publication.poseInFlight,
          acceptedPoseSequence: publication.acceptedPoseSequence,
        });
      }
      return;
    }
    if (validateControlCommand(value)) {
      if (value.room_session_id === claim?.room_session_id && !controlRevocationPending) {
        const commandGeneration = generation;
        const commandControlGeneration = controlGeneration;
        commandChain = commandChain.catch(() => undefined).then(() => {
          if (commandGeneration !== generation
            || commandControlGeneration !== controlGeneration) return undefined;
          return dispatchCommand(value, commandControlGeneration);
        });
      }
      return;
    }
    if (validateMediaGrant(value)) {
      if (value.room_session_id === claim?.room_session_id) callbacks.onMediaGrant?.(value);
      return;
    }
    if (validateForwardedMediaSignal(value)) {
      if (value.room_session_id === claim?.room_session_id && value.target_id === "monitor") {
        callbacks.onMediaSignal?.(value);
      }
      return;
    }
    if (value.type === "protocol_error" && exactKeys(value, ["type", "code"])
      && isBoundedString(value.code, 240)) {
      if ([
        "state_required_before_pose",
        "state_stale",
        "invalid_pose_frame",
        "frame_sequence_conflict",
        "non_increasing_frame_sequence",
      ].includes(value.code)) {
        publications.rejectPose();
        const publication = publications.snapshot();
        update({
          latestPoseSequence: publication.latestPoseSequence,
          poseInFlight: publication.poseInFlight,
          acceptedPoseSequence: publication.acceptedPoseSequence,
        });
      } else {
        update({ lastProtocolError: value.code });
      }
      emitEvent(value);
      return;
    }
    emitEvent({ type: "ignored_relay_message" });
  }

  function connect(nextClaim, reconnecting = false) {
    if (typeof WebSocketImpl !== "function") {
      update({ status: "error", error: "WebSocket 不可用" });
      return Promise.resolve(false);
    }
    generation += 1;
    const connectionGeneration = generation;
    clearTimers();
    closeSocket(1000, "connection_replaced");
    claim = nextClaim;
    controlRevocationPending = false;
    const roomChanged = snapshot.roomSessionId !== claim.room_session_id;
    if (roomChanged) {
      publications.reset(claim.room_session_id, null);
      handledCommands.clear();
      appliedAcks.clear();
    }
    update({
      status: reconnecting ? "reconnecting" : "connecting",
      roomSessionId: claim.room_session_id,
      producerLeaseExpiresAtMs: claim.expires_at_ms,
      connectionGeneration,
      ...(roomChanged ? { acceptedStateRevision: -1 } : {}),
      error: null,
    });
    return new Promise((resolve) => {
      let settled = false;
      const nextSocket = new WebSocketImpl(endpoints.monitorWsUrl, [
        MONITOR_PROTOCOL,
        `${TOKEN_PROTOCOL_PREFIX}${claim.producer_token}`,
      ]);
      socket = nextSocket;
      nextSocket.onopen = () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        if (!settled) {
          settled = true;
          resolve(true);
        }
      };
      nextSocket.onmessage = (event) => handleMessage(event, connectionGeneration);
      nextSocket.onerror = () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        update({ error: "Relay WebSocket 连接失败" });
      };
      nextSocket.onclose = () => {
        if (generation !== connectionGeneration || socket !== nextSocket) return;
        socket = null;
        publications.transportInterrupted();
        claimStore.clear();
        claim = null;
        if (heartbeatTimer !== null) timerApi.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        callbacks.onMediaGrant?.(null);
        update({ status: desiredActive ? "reconnecting" : "idle", controller: null });
        emitEvent({ type: "relay_disconnected", connectionGeneration });
        if (!settled) {
          settled = true;
          resolve(false);
        }
        scheduleReconnect();
      };
    });
  }

  async function start(reconnecting = false) {
    if (!relayUrl || !endpoints) {
      update({ status: "unconfigured", error: "Relay URL 未配置" });
      return false;
    }
    if (
      !reconnecting
      && desiredActive
      && ["claiming", "connecting", "connected", "reconnecting"].includes(snapshot.status)
    ) return true;
    desiredActive = true;
    update({ status: reconnecting ? "reconnecting" : "claiming", error: null });
    try {
      // Reloading the page also resets its monotonic state cursor. Reusing a
      // stored token could reconnect to an older room revision and permanently
      // conflict, so every explicit start obtains a fresh room session.
      claim = await claimMonitor(relayUrl, fetchImpl);
      claimStore.save(claim);
      return connect(claim, reconnecting);
    } catch (error) {
      update({
        status: error?.code === "monitor_busy" ? "busy" : "error",
        error: error?.message || "Relay claim 失败",
      });
      if (desiredActive && isFiniteNonNegative(error?.retryAfterMs)) {
        scheduleReconnect(Math.max(250, error.retryAfterMs + 50));
      }
      return false;
    }
  }

  function stop({ release = true } = {}) {
    desiredActive = false;
    clearTimers();
    if (release && claim && socketOpen()) {
      send({ type: "monitor_release", room_session_id: claim.room_session_id });
    }
    generation += 1;
    closeSocket(1000, "monitor_stopped");
    claimStore.clear();
    claim = null;
    publications.reset(null, null);
    handledCommands.clear();
    appliedAcks.clear();
    update({
      ...initialSnapshot(relayUrl || ""),
      connectionGeneration: generation,
    });
  }

  function publishState(value) {
    if (!claim) return false;
    const previousRuntimeSessionId = publications.snapshot().runtimeSessionId;
    const offered = publications.offerState({ ...value, timestamp_ms: relayNow() });
    if (
      offered
      && previousRuntimeSessionId !== null
      && previousRuntimeSessionId !== value.runtime_session_id
    ) update({ acceptedStateRevision: -1 });
    return offered;
  }

  function publishPose(value) {
    if (!claim) return false;
    const offered = publications.offerPose({ ...value, timestamp_ms: relayNow() });
    const publication = publications.snapshot();
    update({
      latestPoseSequence: publication.latestPoseSequence,
      poseInFlight: publication.poseInFlight,
      acceptedPoseSequence: publication.acceptedPoseSequence,
    });
    return offered;
  }

  function requestMediaGrant({ runtimeSessionId, eventId, scope, expiresInMs }) {
    if (!claim || !isId(runtimeSessionId) || !isId(eventId)) return false;
    const maximum = scope === "kitchen_moment" ? 60_000 : scope === "fall_emergency" ? 30_000 : 0;
    if (!Number.isSafeInteger(expiresInMs) || expiresInMs < 1_000 || expiresInMs > maximum) {
      return false;
    }
    return send({
      type: "media_grant_request",
      room_session_id: claim.room_session_id,
      runtime_session_id: runtimeSessionId,
      event_id: eventId,
      scope,
      expires_in_ms: expiresInMs,
    });
  }

  function revokeMediaGrant(grantId) {
    return Boolean(claim && isId(grantId) && send({
      type: "media_grant_revoke",
      room_session_id: claim.room_session_id,
      grant_id: grantId,
    }));
  }

  function revokeControl() {
    const sent = Boolean(claim && send({
      type: "control_revoke",
      room_session_id: claim.room_session_id,
    }));
    if (sent) {
      controlGeneration += 1;
      controlRevocationPending = true;
    }
    return sent;
  }

  function sendMediaSignal(value) {
    if (!claim || !validMediaSignal(value, false)) return false;
    if (value.room_session_id !== claim.room_session_id || value.target_id === "monitor") return false;
    return send(value);
  }

  return Object.freeze({
    start,
    stop,
    publishState,
    publishPose,
    sendControlAck,
    requestMediaGrant,
    revokeMediaGrant,
    revokeControl,
    sendMediaSignal,
    setCallbacks(next = {}) {
      callbacks = {
        onCommand: next.onCommand ?? null,
        onMediaGrant: next.onMediaGrant ?? null,
        onMediaSignal: next.onMediaSignal ?? null,
        onEvent: next.onEvent ?? null,
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getPublicationSnapshot: () => publications.snapshot(),
  });
}
