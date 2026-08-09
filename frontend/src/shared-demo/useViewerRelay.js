import { useCallback, useEffect, useReducer, useRef } from "react";
import { relayWebSocketUrl } from "./config.js";
import {
  createControlCommand,
  createOpaqueId,
  parseViewerMessage,
  VIEWER_PROTOCOL,
} from "./protocol.js";
import {
  createViewerState,
  ownsControllerLease,
  reduceViewerState,
} from "./viewerState.js";
import { synchronizeCommandCursor } from "./viewerCommandCursor.js";

const HEARTBEAT_MS = 10_000;
const COMMAND_TTL_MS = 8_000;
const LOCAL_CONFIRMATION_TTL_MS = 60_000;
const MAX_RETRY_MS = 8_000;
const MAX_SIGNAL_BUFFER = 64;

function sendJson(socket, payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function useViewerRelay() {
  const [state, dispatch] = useReducer(reduceViewerState, undefined, createViewerState);
  const stateRef = useRef(state);
  const socketRef = useRef(null);
  const retryTimerRef = useRef(0);
  const attemptsRef = useRef(0);
  const commandCursorRef = useRef({ roomSessionId: null, leaseId: null, next: 1 });
  const signalListenersRef = useRef(new Set());
  const signalBufferRef = useRef([]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    commandCursorRef.current = synchronizeCommandCursor(commandCursorRef.current, {
      roomSessionId: state.roomSessionId,
      leaseId: state.lease?.lease_id || null,
    });
  }, [state.lease?.lease_id, state.roomSessionId]);

  const deliverMediaSignal = useCallback((signal) => {
    if (signalListenersRef.current.size === 0) {
      signalBufferRef.current.push(signal);
      if (signalBufferRef.current.length > MAX_SIGNAL_BUFFER) {
        const oldestIce = signalBufferRef.current.findIndex(
          (entry) => entry.signal_type === "ice_candidate",
        );
        signalBufferRef.current.splice(oldestIce >= 0 ? oldestIce : 0, 1);
      }
      return;
    }
    for (const listener of signalListenersRef.current) listener(signal);
  }, []);

  useEffect(() => {
    let active = true;

    function clearRetry() {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = 0;
    }

    function scheduleReconnect() {
      if (!active || document.visibilityState === "hidden" || retryTimerRef.current) return;
      const base = Math.min(MAX_RETRY_MS, 500 * (2 ** attemptsRef.current));
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      attemptsRef.current += 1;
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = 0;
        connect();
      }, delay);
    }

    function connect() {
      if (!active || document.visibilityState === "hidden") return;
      if ([WebSocket.CONNECTING, WebSocket.OPEN].includes(socketRef.current?.readyState)) return;
      dispatch({ type: "connecting" });
      signalBufferRef.current = [];
      let socket;
      try {
        socket = new WebSocket(relayWebSocketUrl(), VIEWER_PROTOCOL);
      } catch {
        dispatch({
          type: "disconnected",
          timestampMs: Date.now() + (stateRef.current.serverTimeOffsetMs || 0),
        });
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (socketRef.current !== socket) return;
        attemptsRef.current = 0;
      };
      socket.onmessage = (event) => {
        if (socketRef.current !== socket) return;
        if (typeof event.data !== "string") {
          dispatch({
            type: "protocol_invalid",
            reason: "binary_frame_rejected",
            timestampMs: Date.now() + (stateRef.current.serverTimeOffsetMs || 0),
          });
          socket.close(1003, "binary_frame_rejected");
          return;
        }
        const message = parseViewerMessage(event.data);
        if (!message) {
          dispatch({
            type: "protocol_invalid",
            reason: "invalid_server_message",
            timestampMs: Date.now() + (stateRef.current.serverTimeOffsetMs || 0),
          });
          socket.close(1003, "invalid_server_message");
          return;
        }
        if (message.kind === "media_signal") {
          const current = stateRef.current;
          if (message.value.target_id === current.viewerId
            && message.value.room_session_id === current.roomSessionId
            && message.value.from_id === "monitor") {
            deliverMediaSignal(message.value);
          }
          return;
        }
        dispatch({ type: "message", message, receivedAtMs: Date.now() });
      };
      socket.onclose = () => {
        if (socketRef.current !== socket) return;
        socketRef.current = null;
        signalBufferRef.current = [];
        dispatch({
          type: "disconnected",
          timestampMs: Date.now() + (stateRef.current.serverTimeOffsetMs || 0),
        });
        scheduleReconnect();
      };
      socket.onerror = () => {
        socket.close();
      };
    }

    function releaseForPageSuspend() {
      const current = stateRef.current;
      if (ownsControllerLease(current) && current.roomSessionId && current.lease) {
        sendJson(socketRef.current, {
          type: "control_release",
          room_session_id: current.roomSessionId,
          lease_id: current.lease.lease_id,
        });
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        clearRetry();
        releaseForPageSuspend();
        socketRef.current?.close(1000, "viewer_hidden");
      } else {
        connect();
      }
    }

    function handlePageHide() {
      releaseForPageSuspend();
      socketRef.current?.close(1000, "viewer_pagehide");
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    connect();
    return () => {
      active = false;
      clearRetry();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      releaseForPageSuspend();
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close(1000, "viewer_unmount");
      signalBufferRef.current = [];
    };
  }, [deliverMediaSignal]);

  const claimControl = useCallback(() => {
    const current = stateRef.current;
    if (!current.roomSessionId || !current.monitorOnline) return false;
    return sendJson(socketRef.current, {
      type: "control_claim",
      room_session_id: current.roomSessionId,
    });
  }, []);

  const releaseControl = useCallback(() => {
    const current = stateRef.current;
    if (!current.roomSessionId || !current.lease) return false;
    return sendJson(socketRef.current, {
      type: "control_release",
      room_session_id: current.roomSessionId,
      lease_id: current.lease.lease_id,
    });
  }, []);

  useEffect(() => {
    if (!state.roomSessionId || !state.lease?.lease_id) return undefined;
    const timer = window.setInterval(() => {
      const current = stateRef.current;
      if (!ownsControllerLease(current)) return;
      sendJson(socketRef.current, {
        type: "control_heartbeat",
        room_session_id: current.roomSessionId,
        lease_id: current.lease.lease_id,
      });
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [state.roomSessionId, state.lease?.lease_id]);

  const sendCommand = useCallback((command) => {
    const current = stateRef.current;
    const nowMs = Date.now() + (current.serverTimeOffsetMs || 0);
    if (!ownsControllerLease(current, nowMs)) {
      return { ok: false, reason: "需要先接管控制" };
    }
    if (!current.roomSessionId || !current.state) {
      return { ok: false, reason: "等待权威状态后再操作" };
    }
    if (current.unavailableReason || current.stateStale) {
      return { ok: false, reason: "当前权威状态不可用，请等待恢复" };
    }
    commandCursorRef.current = synchronizeCommandCursor(commandCursorRef.current, {
      roomSessionId: current.roomSessionId,
      leaseId: current.lease.lease_id,
    });
    const envelope = createControlCommand({
      roomSessionId: current.roomSessionId,
      commandId: createOpaqueId("cmd"),
      commandSequence: commandCursorRef.current.next,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + (
        ["select_source", "start_capture"].includes(command.name)
          ? LOCAL_CONFIRMATION_TTL_MS
          : COMMAND_TTL_MS
      ),
      expectedStateRevision: current.state.state_revision,
      command,
    });
    if (!sendJson(socketRef.current, envelope)) {
      return { ok: false, reason: "Relay 未连接，命令未发送" };
    }
    commandCursorRef.current.next += 1;
    dispatch({ type: "outgoing_command", command: envelope });
    return { ok: true, commandId: envelope.command_id };
  }, []);

  const subscribeMediaSignals = useCallback((listener) => {
    signalListenersRef.current.add(listener);
    const buffered = signalBufferRef.current;
    signalBufferRef.current = [];
    for (const signal of buffered) listener(signal);
    return () => signalListenersRef.current.delete(listener);
  }, []);

  const sendMediaSignal = useCallback((message) => sendJson(socketRef.current, message), []);

  const ownsControl = ownsControllerLease(state)
    && !state.unavailableReason
    && !state.stateStale;

  return {
    ...state,
    ownsControl,
    claimControl,
    releaseControl,
    sendCommand,
    subscribeMediaSignals,
    sendMediaSignal,
  };
}
