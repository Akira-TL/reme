import { useEffect, useReducer } from "react";
import { relayWebSocketUrl } from "./config.js";
import { parsePoseFrame, VIEWER_PROTOCOL } from "./protocol.js";
import { createViewerState, reduceViewerState } from "./state.js";

const MAX_RETRY_MS = 8000;

export function useViewerRelay() {
  const [state, dispatch] = useReducer(reduceViewerState, undefined, createViewerState);

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
      } catch {
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
        const frame = parsePoseFrame(event.data);
        if (!frame) {
          dispatch({ type: "invalid_frame" });
          return;
        }
        dispatch({ type: "frame", frame, receivedAtMs: Date.now() });
      });
      socket.addEventListener("close", () => {
        if (!active) return;
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
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, []);

  return state;
}
