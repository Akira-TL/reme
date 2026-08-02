import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { relayWebSocketUrl } from "./config.js";
import {
  isMediaSignal,
  parseDemoEvent,
  parseForwardedMediaSignal,
  parsePoseFrame,
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

export function useViewerRelay() {
  const [state, dispatch] = useReducer(reduceViewerState, undefined, createViewerState);
  const [socket, setSocket] = useState(null);
  const socketRef = useRef(null);
  const signalBufferRef = useRef(createForwardedMediaSignalBuffer());

  const drainMediaSignals = useCallback(
    (predicate) => signalBufferRef.current.drain(predicate),
    [],
  );

  const sendSignal = useCallback((message) => {
    const activeSocket = socketRef.current;
    if (
      !isMediaSignal(message)
      || !activeSocket
      || activeSocket.readyState !== WebSocket.OPEN
    ) {
      return false;
    }
    activeSocket.send(JSON.stringify(message));
    return true;
  }, []);

  useEffect(() => {
    const signalBuffer = signalBufferRef.current;
    let active = true;
    let socket = null;
    let retryTimer = 0;
    let attempts = 0;

    function connect() {
      if (!active || document.visibilityState === "hidden") return;
      dispatch({ type: "connecting" });
      signalBuffer.clear();
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
        if (document.visibilityState !== "hidden") {
          retryTimer = window.setTimeout(connect, MAX_RETRY_MS);
        }
        return;
      }

      nextSocket.addEventListener("open", () => {
        if (!active) return;
        attempts = 0;
        dispatch({ type: "connected" });
      });
      nextSocket.addEventListener("message", (event) => {
        if (!active) return;
        const ready = parseViewerReady(event.data);
        if (ready) {
          dispatch({ type: "viewer_ready", viewerId: ready.viewer_id });
          return;
        }
        const frame = parsePoseFrame(event.data);
        if (frame) {
          dispatch({ type: "frame", frame, receivedAtMs: Date.now() });
          return;
        }
        const demoEvent = parseDemoEvent(event.data);
        if (demoEvent) {
          dispatch({ type: "demo_event", event: demoEvent, receivedAtMs: Date.now() });
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
        if (!active) return;
        if (socketRef.current === nextSocket) {
          socketRef.current = null;
          signalBuffer.clear();
          setSocket(null);
        }
        dispatch({ type: "disconnected" });
        if (document.visibilityState === "hidden") return;
        const waitMs = Math.min(1000 * (2 ** attempts), MAX_RETRY_MS);
        attempts += 1;
        retryTimer = window.setTimeout(connect, waitMs);
      });
      nextSocket.addEventListener("error", () => nextSocket.close());
    }

    const handleVisibilityChange = () => {
      window.clearTimeout(retryTimer);
      retryTimer = 0;
      if (document.visibilityState === "hidden") {
        signalBuffer.clear();
        socketRef.current?.close(1000, "viewer_hidden");
        return;
      }
      if (!socketRef.current || socketRef.current.readyState === WebSocket.CLOSED) connect();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    connect();
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      socketRef.current = null;
      signalBuffer.clear();
      setSocket(null);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return { ...state, socket, sendSignal, drainMediaSignals };
}
