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
    let active = true;
    let socket = null;
    let retryTimer = 0;
    let attempts = 0;

    function connect() {
      if (!active) return;
      dispatch({ type: "connecting" });
      try {
        socket = new WebSocket(relayWebSocketUrl("/ws/viewer"), VIEWER_PROTOCOL);
        socketRef.current = socket;
        setSocket(socket);
      } catch {
        socketRef.current = null;
        setSocket(null);
        dispatch({ type: "disconnected" });
        retryTimer = window.setTimeout(connect, MAX_RETRY_MS);
        return;
      }

      socket.addEventListener("open", () => {
        if (!active) return;
        attempts = 0;
        dispatch({ type: "connected" });
      });
      socket.addEventListener("message", (event) => {
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
        if (parseForwardedMediaSignal(event.data)) return;
        dispatch({ type: "invalid_frame" });
      });
      socket.addEventListener("close", () => {
        if (!active) return;
        if (socketRef.current === socket) {
          socketRef.current = null;
          setSocket(null);
        }
        dispatch({ type: "disconnected" });
        const waitMs = Math.min(1000 * (2 ** attempts), MAX_RETRY_MS);
        attempts += 1;
        retryTimer = window.setTimeout(connect, waitMs);
      });
      socket.addEventListener("error", () => socket?.close());
    }

    connect();
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
      socketRef.current = null;
      setSocket(null);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return { ...state, socket, sendSignal };
}
