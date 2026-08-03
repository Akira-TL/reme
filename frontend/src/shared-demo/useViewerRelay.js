import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { relayWebSocketUrl } from "./config.js";
import { parseMediaIceCapability } from "./mediaIce.js";
import {
  isMediaSignal,
  parseDemoEvent,
  parseForwardedMediaSignal,
  parsePoseProjectionUnavailable,
  parsePoseWireFrame,
  VIEWER_PROTOCOL,
} from "./protocol.js";
import { createViewerState, reduceViewerState } from "./state.js";

const MAX_RETRY_MS = 8000;
export const MAX_BUFFERED_FORWARDED_SIGNALS = 64;

export function createForwardedMediaSignalBuffer(
  maxSize = MAX_BUFFERED_FORWARDED_SIGNALS,
) {
  if (!Number.isSafeInteger(maxSize) || maxSize < 1) {
    throw new TypeError("forwarded signal buffer size must be a positive integer");
  }

  let signals = [];
  const signalRoute = (signal) => [
    signal?.grant_id,
    signal?.target_id,
    signal?.from_id,
  ].join("\u0000");
  return {
    push(signal) {
      if (signal?.signal_type === "offer") {
        signals = signals.filter((entry) => !(
          entry?.signal_type === "offer"
          && entry.grant_id === signal.grant_id
          && entry.target_id === signal.target_id
          && entry.from_id === signal.from_id
        ));
      }
      signals.push(signal);
      while (signals.length > maxSize) {
        const incomingRoute = signalRoute(signal);
        const staleRouteIndex = signals.findIndex(
          (entry) => signalRoute(entry) !== incomingRoute,
        );
        const oldestIceIndex = signals.findIndex(
          (entry) => entry?.signal_type === "ice_candidate",
        );
        signals.splice(
          staleRouteIndex >= 0
            ? staleRouteIndex
            : oldestIceIndex >= 0 ? oldestIceIndex : 0,
          1,
        );
      }
    },
    drain(predicate = () => true) {
      const drained = [];
      const retained = [];
      for (const signal of signals) {
        if (predicate(signal)) drained.push(signal);
        else retained.push(signal);
      }
      signals = retained;
      return drained;
    },
    clear() {
      signals = [];
    },
    size() {
      return signals.length;
    },
  };
}

export function parseViewerReady(raw) {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "type,viewer_id"
      || value.type !== "viewer_ready"
      || typeof value.viewer_id !== "string"
      || !/^[a-z0-9_-]{1,128}$/i.test(value.viewer_id)
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function suspendViewerRelayConnection({
  signalBuffer,
  socket,
  clearCapability = () => {},
  clearSocket = () => {},
  reason = "viewer_suspended",
} = {}) {
  signalBuffer?.clear?.();
  clearCapability();
  clearSocket();
  try {
    socket?.close?.(1000, reason);
  } catch {
    // The local authority is already cleared even if browser socket close throws.
  }
}

export function isCurrentViewerSocket(activeSocket, candidateSocket) {
  return Boolean(candidateSocket && activeSocket === candidateSocket);
}

export function canStartViewerSocketConnection({
  active,
  pageSuspended,
  visibilityState,
  currentSocket,
  connectingState = 0,
  openState = 1,
} = {}) {
  return active === true
    && pageSuspended !== true
    && visibilityState !== "hidden"
    && ![connectingState, openState].includes(currentSocket?.readyState);
}

export function sendViewerSignal(socket, message, openState = 1) {
  if (!isMediaSignal(message) || !socket || socket.readyState !== openState) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

export function useViewerRelay() {
  const [state, dispatch] = useReducer(reduceViewerState, undefined, createViewerState);
  const [socket, setSocket] = useState(null);
  const [mediaIceCapability, setMediaIceCapability] = useState(null);
  const socketRef = useRef(null);
  const signalBufferRef = useRef(createForwardedMediaSignalBuffer());

  const drainMediaSignals = useCallback(
    (predicate) => signalBufferRef.current.drain(predicate),
    [],
  );

  const sendSignal = useCallback((message) => {
    return sendViewerSignal(socketRef.current, message, WebSocket.OPEN);
  }, []);

  useEffect(() => {
    const signalBuffer = signalBufferRef.current;
    let active = true;
    let socket = null;
    let retryTimer = 0;
    let attempts = 0;
    let pageSuspended = false;

    function connect() {
      if (!canStartViewerSocketConnection({
        active,
        pageSuspended,
        visibilityState: document.visibilityState,
        currentSocket: socketRef.current,
        connectingState: WebSocket.CONNECTING,
        openState: WebSocket.OPEN,
      })) return;
      dispatch({ type: "connecting" });
      signalBuffer.clear();
      setMediaIceCapability(null);
      let nextSocket;
      try {
        nextSocket = new WebSocket(relayWebSocketUrl("/ws/viewer"), VIEWER_PROTOCOL);
        socket = nextSocket;
        socketRef.current = nextSocket;
        setSocket(nextSocket);
      } catch {
        socketRef.current = null;
        setSocket(null);
        dispatch({ type: "disconnected" });
        if (!pageSuspended && document.visibilityState !== "hidden") {
          retryTimer = window.setTimeout(connect, MAX_RETRY_MS);
        }
        return;
      }

      nextSocket.addEventListener("open", () => {
        if (!active || !isCurrentViewerSocket(socketRef.current, nextSocket)) return;
        attempts = 0;
        dispatch({ type: "connected" });
      });
      nextSocket.addEventListener("message", (event) => {
        if (!active || !isCurrentViewerSocket(socketRef.current, nextSocket)) return;
        const ready = parseViewerReady(event.data);
        if (ready) {
          dispatch({ type: "viewer_ready", viewerId: ready.viewer_id });
          return;
        }
        const frame = parsePoseWireFrame(event.data);
        if (frame) {
          dispatch({ type: "frame", frame, receivedAtMs: Date.now() });
          return;
        }
        const projectionUnavailable = parsePoseProjectionUnavailable(event.data);
        if (projectionUnavailable) {
          dispatch({
            type: "pose_projection_unavailable",
            message: projectionUnavailable,
            receivedAtMs: Date.now(),
          });
          return;
        }
        const demoEvent = parseDemoEvent(event.data);
        if (demoEvent) {
          dispatch({ type: "demo_event", event: demoEvent, receivedAtMs: Date.now() });
          if (demoEvent.event_type === "media_grant" && demoEvent.payload.status !== "active") {
            setMediaIceCapability((current) => (
              current?.grant_id === demoEvent.payload.grant_id ? null : current
            ));
          }
          return;
        }
        const iceCapability = parseMediaIceCapability(event.data);
        if (iceCapability) {
          setMediaIceCapability(iceCapability);
          return;
        }
        const forwardedSignal = parseForwardedMediaSignal(event.data);
        if (forwardedSignal) {
          signalBuffer.push(forwardedSignal);
          return;
        }
        dispatch({ type: "invalid_frame" });
      });
      nextSocket.addEventListener("close", () => {
        if (!active || !isCurrentViewerSocket(socketRef.current, nextSocket)) return;
        socketRef.current = null;
        signalBuffer.clear();
        setMediaIceCapability(null);
        setSocket(null);
        dispatch({ type: "disconnected" });
        if (pageSuspended || document.visibilityState === "hidden") return;
        const waitMs = Math.min(1000 * (2 ** attempts), MAX_RETRY_MS);
        attempts += 1;
        retryTimer = window.setTimeout(connect, waitMs);
      });
      nextSocket.addEventListener("error", () => {
        if (active && isCurrentViewerSocket(socketRef.current, nextSocket)) nextSocket.close();
      });
    }

    const suspendConnection = (reason) => {
      window.clearTimeout(retryTimer);
      retryTimer = 0;
      const activeSocket = socketRef.current;
      socketRef.current = null;
      suspendViewerRelayConnection({
        signalBuffer,
        socket: activeSocket,
        clearCapability: () => setMediaIceCapability(null),
        clearSocket: () => setSocket(null),
        reason,
      });
      dispatch({ type: "disconnected" });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        suspendConnection("viewer_hidden");
        return;
      }
      if (pageSuspended) return;
      if (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED) connect();
    };
    const handlePageHide = () => {
      pageSuspended = true;
      suspendConnection("viewer_pagehide");
    };
    const handlePageShow = () => {
      pageSuspended = false;
      if (document.visibilityState !== "hidden") connect();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("pageshow", handlePageShow);
    connect();
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("pageshow", handlePageShow);
      socketRef.current = null;
      signalBuffer.clear();
      setMediaIceCapability(null);
      setSocket(null);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return {
    ...state,
    socket,
    sendSignal,
    drainMediaSignals,
    mediaIceCapability,
  };
}
