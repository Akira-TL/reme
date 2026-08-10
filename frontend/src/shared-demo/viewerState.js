import { familyMediaAuthorization, isFamilyAlarm } from "./familyAuthority.js";

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
    stateStale: false,
    lastStateRevision: null,
    familyEvent: null,
    familyEventStale: false,
    lastFamilyRevision: null,
    remeDayRevisions: {},
    pose: null,
    lastPoseSequence: null,
    mediaGrant: null,
    acks: [],
    unavailableReason: "not_published",
    latestProtocolError: null,
    serverTimeOffsetMs: 0,
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
    stateStale: false,
    lastStateRevision: null,
    familyEvent: null,
    familyEventStale: false,
    lastFamilyRevision: null,
    pose: null,
    lastPoseSequence: null,
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

function hasAlarmFamilyEvent(event) {
  return isFamilyAlarm(event?.care);
}

function unavailableState(state, reason) {
  const historicalAlarmState = hasAlarmFamilyEvent(state.familyEvent)
    ? state.state
    : null;
  return {
    ...state,
    state: historicalAlarmState,
    stateStale: Boolean(historicalAlarmState),
    pose: null,
    lastPoseSequence: null,
    mediaGrant: null,
    unavailableReason: reason,
  };
}

export function failPendingAcks(acks, reason, timestampMs) {
  return acks.map((ack) => TERMINAL_ACK_PHASES.has(ack.phase) ? ack : {
    ...ack,
    phase: "failed",
    timestamp_ms: timestampMs,
    state_revision: null,
    reason,
  });
}

export function isPoseFresh(pose, localNowMs = Date.now(), maxAgeMs = 5_000) {
  if (!pose
    || !Number.isFinite(pose.receivedAtMs)
    || !Number.isFinite(localNowMs)
    || !Number.isFinite(maxAgeMs)
    || maxAgeMs < 0) return false;
  const ageMs = localNowMs - pose.receivedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

function sameMediaGrant(left, right) {
  return Boolean(
    left
      && right
      && left.grant_id === right.grant_id
      && left.event_id === right.event_id
      && left.scope === right.scope
      && left.expires_at_ms === right.expires_at_ms
      && left.status === right.status,
  );
}

export function reduceViewerState(state, action) {
  if (action.type === "connecting") {
    return { ...state, connection: "connecting" };
  }
  if (action.type === "disconnected") {
    const next = unavailableState(state, "monitor_offline");
    const timestampMs = Number.isFinite(action.timestampMs)
      ? action.timestampMs
      : Date.now() + (state.serverTimeOffsetMs || 0);
    return {
      ...next,
      connection: "disconnected",
      monitorOnline: false,
      familyEventStale: Boolean(state.familyEvent),
      controller: null,
      lease: null,
      acks: failPendingAcks(state.acks, "relay_disconnected", timestampMs),
    };
  }
  if (action.type === "protocol_invalid") {
    const reason = action.reason || "invalid_server_message";
    const next = unavailableState(state, "protocol_invalid");
    const timestampMs = Number.isFinite(action.timestampMs)
      ? action.timestampMs
      : Date.now() + (state.serverTimeOffsetMs || 0);
    return {
      ...next,
      connection: "disconnected",
      latestProtocolError: action.reason || "invalid_server_message",
      familyEventStale: Boolean(state.familyEvent),
      controller: null,
      lease: null,
      acks: failPendingAcks(state.acks, reason, timestampMs),
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
  const receivedAtMs = Number.isFinite(action.receivedAtMs)
    ? action.receivedAtMs
    : Date.now();
  const serverTimeOffsetMs = Number.isFinite(value.server_time_ms)
    ? value.server_time_ms - receivedAtMs
    : state.serverTimeOffsetMs;
  if (kind === "viewer_ready") {
    let next = resetRoomState(state, value.room_session_id);
    if (!value.monitor_online) next = unavailableState(next, "monitor_offline");
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
      serverTimeOffsetMs,
    };
  }
  if (kind === "viewer_presence") {
    let next = resetRoomState(state, value.room_session_id);
    if (!value.monitor_online) next = unavailableState(next, "monitor_offline");
    return {
      ...next,
      monitorOnline: value.monitor_online,
      viewerCount: value.viewer_count,
      maxViewers: value.max_viewers,
      serverTimeOffsetMs,
      ...(value.monitor_online ? {} : {
        controller: null,
        lease: null,
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
      serverTimeOffsetMs,
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
    if (existing && TERMINAL_ACK_PHASES.has(existing.phase)) return state;
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
    if (Number.isSafeInteger(state.lastStateRevision)
      && (value.state_revision < state.lastStateRevision
        || (value.state_revision === state.lastStateRevision && !state.unavailableReason))) return state;
    const runtimeChanged = state.state
      && state.state.runtime_session_id !== value.runtime_session_id;
    const projectedGrant = value.state.media_grant;
    return {
      ...state,
      state: value,
      stateStale: false,
      lastStateRevision: value.state_revision,
      pose: runtimeChanged ? null : state.pose,
      lastPoseSequence: runtimeChanged ? null : state.lastPoseSequence,
      mediaGrant: sameMediaGrant(state.mediaGrant, projectedGrant)
        ? state.mediaGrant
        : projectedGrant,
      unavailableReason: null,
    };
  }
  if (kind === "reme_day_revision") {
    const current = state.remeDayRevisions[value.date];
    if (current
      && (value.timeline_revision < current.timeline_revision
        || (value.timeline_revision === current.timeline_revision
          && value.summary_revision < current.summary_revision))) return state;
    return {
      ...state,
      remeDayRevisions: {
        ...state.remeDayRevisions,
        [value.date]: value,
      },
    };
  }
  if (kind === "family_event") {
    if (!sameRoom(state, value.room_session_id)) return state;
    const runtimeChanged = state.familyEvent
      && state.familyEvent.runtime_session_id !== value.runtime_session_id;
    if (!runtimeChanged
      && Number.isSafeInteger(state.lastFamilyRevision)
      && (
        value.revision < state.lastFamilyRevision
        || (value.revision === state.lastFamilyRevision && !state.familyEventStale)
      )) return state;
    const authorization = familyMediaAuthorization(value);
    const keepGrant = authorization?.status === "active"
      && state.mediaGrant?.event_id === authorization.decision_id
      && state.mediaGrant?.scope === authorization.scope;
    return {
      ...state,
      familyEvent: value,
      familyEventStale: false,
      lastFamilyRevision: value.revision,
      mediaGrant: keepGrant ? state.mediaGrant : null,
    };
  }
  if (kind === "pose_frame") {
    if (!sameRoom(state, value.room_session_id)
      || !state.state
      || state.unavailableReason
      || value.runtime_session_id !== state.state.runtime_session_id
      || (Number.isSafeInteger(state.lastPoseSequence)
        && value.frame_sequence <= state.lastPoseSequence)) return state;
    const holdLastDetected = value.person_detected === false
      && state.pose?.person_detected === true
      && isPoseFresh(state.pose, receivedAtMs);
    return {
      ...state,
      pose: holdLastDetected ? state.pose : { ...value, receivedAtMs },
      lastPoseSequence: value.frame_sequence,
    };
  }
  if (kind === "media_grant") {
    if (!sameRoom(state, value.room_session_id) || state.unavailableReason) return state;
    const nextGrant = value.grant.status === "active" ? value.grant : null;
    return {
      ...state,
      mediaGrant: sameMediaGrant(state.mediaGrant, nextGrant)
        ? state.mediaGrant
        : nextGrant,
    };
  }
  if (kind === "state_unavailable") {
    const next = unavailableState(state, value.reason);
    return value.reason === "monitor_offline" ? {
      ...next,
      monitorOnline: false,
      controller: null,
      lease: null,
    } : next;
  }
  if (kind === "protocol_error") {
    return { ...state, latestProtocolError: value.code };
  }
  return state;
}

export function ownsControllerLease(
  state,
  nowMs = Date.now() + (state.serverTimeOffsetMs || 0),
) {
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

export function selectActiveMediaGrant(
  state,
  nowMs = Date.now() + (state.serverTimeOffsetMs || 0),
) {
  const grant = state.mediaGrant;
  const snapshot = state.state;
  const familyEvent = state.familyEvent;
  const authorization = familyMediaAuthorization(familyEvent);
  const decision = familyEvent?.care;
  if (state.unavailableReason
    || state.stateStale
    || !grant
    || grant.status !== "active"
    || grant.expires_at_ms <= nowMs
    || !snapshot
    || snapshot.room_session_id !== state.roomSessionId
    || snapshot.state.scene_id === "bathroom"
    || snapshot.state.runtime.status !== "ready"
    || snapshot.state.capture.status !== "active"
    || snapshot.state.capture.remote_video !== "available"
    || !familyEvent
    || state.familyEventStale
    || familyEvent.room_session_id !== state.roomSessionId
    || familyEvent.runtime_session_id !== snapshot.runtime_session_id
    || authorization?.status !== "active"
    || authorization.expires_at_ms <= nowMs
    || authorization.decision_id !== grant.event_id
    || authorization.scope !== grant.scope
    || authorization.scene_id !== snapshot.state.scene_id
    || authorization.decision_id !== decision?.decision_id
    || !["visible", "blurred"].includes(decision?.privacy_mode)) return null;
  if (grant.scope === "kitchen_moment") return grant;
  if (grant.scope !== "fall_emergency"
    || decision.alarm === null) return null;
  return grant;
}

export function canRevealAuthorizedVideo(
  state,
  highPrivacyEnabled,
  nowMs = Date.now() + (state.serverTimeOffsetMs || 0),
) {
  return !highPrivacyEnabled && Boolean(selectActiveMediaGrant(state, nowMs));
}
