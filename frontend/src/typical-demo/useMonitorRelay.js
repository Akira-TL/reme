import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { createMonitorRelayClient } from "./monitorRelay.js";

/**
 * Monitor-side Relay transport. `enabled` is intentionally controlled by the
 * page's local “开始演示” click; this hook never fabricates that user gesture.
 */
export function useMonitorRelay({
  relayUrl,
  enabled = false,
  stateEnvelope = null,
  poseFrame = null,
  onCommand = null,
  onFamilyEvent = null,
  onMediaGrant = null,
  onMediaSignal = null,
  onEvent = null,
  fetchImpl,
  WebSocketImpl,
  claimStore,
  timerApi,
  now,
} = {}) {
  const client = useMemo(() => createMonitorRelayClient({
    relayUrl,
    fetchImpl,
    WebSocketImpl,
    claimStore,
    timerApi,
    now,
  }), [
    claimStore,
    fetchImpl,
    now,
    relayUrl,
    timerApi,
    WebSocketImpl,
  ]);

  useEffect(() => {
    client.setCallbacks({ onCommand, onFamilyEvent, onMediaGrant, onMediaSignal, onEvent });
  }, [client, onCommand, onEvent, onFamilyEvent, onMediaGrant, onMediaSignal]);

  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  useEffect(() => {
    if (enabled) void client.start();
    else client.stop();
  }, [client, enabled]);

  useEffect(() => () => client.stop(), [client]);

  useEffect(() => {
    if (snapshot.status !== "connected" || !snapshot.roomSessionId || !stateEnvelope) return;
    const value = typeof stateEnvelope === "function"
      ? stateEnvelope(snapshot.roomSessionId)
      : stateEnvelope;
    if (value) client.publishState(value);
  }, [client, snapshot.connectionGeneration, snapshot.roomSessionId, snapshot.status, stateEnvelope]);

  useEffect(() => {
    if (snapshot.status !== "connected" || !snapshot.roomSessionId || !poseFrame) return;
    const value = typeof poseFrame === "function"
      ? poseFrame(snapshot.roomSessionId)
      : poseFrame;
    if (value) client.publishPose(value);
  }, [client, poseFrame, snapshot.roomSessionId, snapshot.status]);

  const startDemo = useCallback(() => client.start(), [client]);
  const stopDemo = useCallback(() => client.stop(), [client]);
  const publishState = useCallback((value) => client.publishState(value), [client]);
  const publishPose = useCallback((value) => client.publishPose(value), [client]);
  const sendControlAck = useCallback(
    (parameters) => client.sendControlAck(parameters),
    [client],
  );
  const requestMediaGrant = useCallback(
    (parameters) => client.requestMediaGrant(parameters),
    [client],
  );
  const revokeMediaGrant = useCallback(
    (grantId) => client.revokeMediaGrant(grantId),
    [client],
  );
  const revokeControl = useCallback(() => client.revokeControl(), [client]);
  const sendMediaSignal = useCallback(
    (signal) => client.sendMediaSignal(signal),
    [client],
  );

  return {
    ...snapshot,
    connected: snapshot.status === "connected",
    startDemo,
    stopDemo,
    publishState,
    publishPose,
    sendControlAck,
    requestMediaGrant,
    revokeMediaGrant,
    revokeControl,
    sendMediaSignal,
  };
}
