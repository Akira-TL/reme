const TERMINAL_ACK_PHASES = new Set(["applied", "rejected", "failed"]);
const MAX_ACKS = 12;

export function createViewerState() {
  return {
    connection: "connecting",
    viewerId: null,
    roomSessionId: null,
    monitorOnline: false,
    viewerCount: 0,
    maxViewers: 5,
    controller: null,
    lease: null,
    state: null,
    pose: null,
    mediaGrant: null,
    acks: [],
    unavailableReason: "not_published",
    latestProtocolError: null,
  };
}

function sameRoom(state, roomSessionId) {
  return Boolean(state.roomSessionId && state.roomSessionId === roomSessionId);
}

function resetRoomState(state, roomSessionId) {
  if (state.roomSessionId === roomSessionId) return state;
  return {
    ...state,
    roomSessionId,
    controller: null,
    lease: null,
    state: null,
    pose: null,
    mediaGrant: null,
    acks: [],
    unavailableReason: roomSessionId ? "not_published" : "monitor_offline",
  };
}

function mergeAck(acks, nextAck) {
  const found = acks.findIndex((ack) => ack.command_id === nextAck.command_id);
  const next = found < 0
    ? [nextAck, ...acks]
    : acks.map((ack, index) => index === found ? { ...ack, ...nextAck } : ack);
  return next.slice(0, MAX_ACKS);
}

export function reduceViewerState(state, action) {
  if (action.type === "connecting") {
    return { ...state, connection: "connecting", latestProtocolError: null };
  }
  if (action.type === "disconnected") {
    return {
      ...state,
      connection: "disconnected",
      monitorOnline: false,
      controller: null,
      lease: null,
      mediaGrant: null,
      pose: null,
    };
  }
  if (action.type === "protocol_invalid") {
    return {
      ...state,
      latestProtocolError: action.reason || "invalid_server_message",
      controller: null,
      lease: null,
      mediaGrant: null,
      pose: null,
    };
  }
  if (action.type === "outgoing_command") {
    return {
      ...state,
      acks: mergeAck(state.acks, {
        command_id: action.command.command_id,
        command_name: action.command.command.name,
        phase: "sent",
        timestamp_ms: action.command.issued_at_ms,
        state_revision: null,
        reason: null,
      }),
    };
  }
  if (action.type !== "message") return state;

  const { kind, value } = action.message;
  if (kind === "viewer_ready") {
    const next = resetRoomState(state, value.room_session_id);
    return {
      ...next,
      connection: "connected",
      viewerId: value.viewer_id,
      monitorOnline: value.monitor_online,
      viewerCount: value.viewer_count,
      maxViewers: value.max_viewers,
      controller: value.controller,
      lease: value.controller?.viewer_id === value.viewer_id
        ? { lease_id: value.controller.lease_id, expires_at_ms: value.controller.expires_at_ms }
        : null,
      latestProtocolError: null,
    };
  }
  if (kind === "viewer_presence") {
    const next = resetRoomState(state, value.room_session_id);
    return {
      ...next,
      monitorOnline: value.monitor_online,
      viewerCount: value.viewer_count,
      maxViewers: value.max_viewers,
      ...(value.monitor_online ? {} : {
        controller: null,
        lease: null,
        mediaGrant: null,
        pose: null,
      }),
    };
  }
  if (kind === "controller_status") {
    if (value.room_session_id !== state.roomSessionId) {
      return value.room_session_id === null ? {
        ...state,
        controller: null,
        lease: null,
      } : state;
    }
    return {
      ...state,
      controller: value.controller,
      lease: value.controller?.viewer_id === state.viewerId
        ? { lease_id: value.controller.lease_id, expires_at_ms: value.controller.expires_at_ms }
        : null,
    };
  }
  if (kind === "control_claim_result") {
    if (value.room_session_id !== state.roomSessionId || value.status !== "granted") {
      return { ...state, lease: null };
    }
    return {
      ...state,
      lease: value.lease,
      controller: value.lease ? {
        viewer_id: state.viewerId,
        lease_id: value.lease.lease_id,
        expires_at_ms: value.lease.expires_at_ms,
      } : state.controller,
    };
  }
  if (kind === "control_heartbeat_ack") {
    if (!sameRoom(state, value.room_session_id) || state.lease?.lease_id !== value.lease_id) {
      return state;
    }
    return {
      ...state,
      lease: { ...state.lease, expires_at_ms: value.expires_at_ms },
      controller: state.controller
        ? { ...state.controller, expires_at_ms: value.expires_at_ms }
        : state.controller,
    };
  }
  if (kind === "control_ack") {
    if (!sameRoom(state, value.room_session_id)) return state;
    const existing = state.acks.find((ack) => ack.command_id === value.command_id);
    return {
      ...state,
      acks: mergeAck(state.acks, {
        ...value,
        command_name: existing?.command_name || "unknown",
      }),
    };
  }
  if (kind === "demo_state") {
    if (!sameRoom(state, value.room_session_id)) return state;
    if (state.state && value.state_revision <= state.state.state_revision) return state;
    const runtimeChanged = state.state
      && state.state.runtime_session_id !== value.runtime_session_id;
    return {
      ...state,
      state: value,
      pose: runtimeChanged ? null : state.pose,
      mediaGrant: value.state.media_grant,
      unavailableReason: null,
    };
  }
  if (kind === "pose_frame") {
    if (!sameRoom(state, value.room_session_id)
      || !state.state
      || value.runtime_session_id !== state.state.runtime_session_id
      || (state.pose && value.frame_sequence <= state.pose.frame_sequence)) return state;
    return { ...state, pose: value };
  }
  if (kind === "media_grant") {
    if (!sameRoom(state, value.room_session_id)) return state;
    return {
      ...state,
      mediaGrant: value.grant.status === "active" ? value.grant : null,
    };
  }
  if (kind === "state_unavailable") {
    return {
      ...state,
      unavailableReason: value.reason,
      mediaGrant: null,
      pose: value.reason === "stale" ? null : state.pose,
    };
  }
  if (kind === "protocol_error") {
    return { ...state, latestProtocolError: value.code };
  }
  return state;
}

export function ownsControllerLease(state, nowMs = Date.now()) {
  return Boolean(
    state.viewerId
    && state.controller?.viewer_id === state.viewerId
    && state.lease?.lease_id === state.controller.lease_id
    && state.lease.expires_at_ms > nowMs,
  );
}

export function hasPendingCommand(state) {
  return state.acks.some((ack) => !TERMINAL_ACK_PHASES.has(ack.phase));
}

export function selectActiveMediaGrant(state, nowMs = Date.now()) {
  const grant = state.mediaGrant;
  const snapshot = state.state;
  if (!grant
    || grant.status !== "active"
    || grant.expires_at_ms <= nowMs
    || !snapshot
    || snapshot.room_session_id !== state.roomSessionId
    || snapshot.state.scene_id === "bathroom"
    || snapshot.state.capture.status !== "active"
    || snapshot.state.capture.remote_video !== "available") return null;
  if (grant.scope === "kitchen_moment") {
    return snapshot.state.scene_id === "kitchen"
      && snapshot.state.care.consent === "granted"
      ? grant
      : null;
  }
  return grant.scope === "fall_emergency"
    && snapshot.state.care.phase === "emergency"
    && snapshot.state.care.alarm_authoritative
    ? grant
    : null;
}

export function canRevealAuthorizedVideo(state, highPrivacyEnabled, nowMs = Date.now()) {
  return !highPrivacyEnabled && Boolean(selectActiveMediaGrant(state, nowMs));
}
