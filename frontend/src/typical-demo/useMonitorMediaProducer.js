import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { createMonitorMediaProducer } from "./monitorMedia.js";

const LOCAL_ONLY_RTC_CONFIGURATION = Object.freeze({});

/**
 * Binds a Relay media grant to one WebRTC producer peer per Viewer. The Relay
 * only carries SDP/ICE JSON; `remoteStream` remains inside this browser.
 */
export function useMonitorMediaProducer({
  connected = false,
  roomSessionId = null,
  runtimeSessionId = null,
  sourceGeneration = 0,
  sceneId = "living",
  remoteStream = null,
  grantMessage = null,
  incomingSignal = null,
  sendSignal,
  revokeMediaGrant = null,
  rtcConfiguration = LOCAL_ONLY_RTC_CONFIGURATION,
  onEvent = null,
  RTCPeerConnectionImpl,
  RTCSessionDescriptionImpl,
  RTCIceCandidateImpl,
  timerApi,
  now,
} = {}) {
  const context = useMemo(() => ({
    connected,
    roomSessionId,
    runtimeSessionId,
    sourceGeneration,
    sceneId,
    stream: remoteStream,
  }), [connected, remoteStream, roomSessionId, runtimeSessionId, sceneId, sourceGeneration]);

  const producer = useMemo(() => createMonitorMediaProducer({
    RTCPeerConnectionImpl,
    RTCSessionDescriptionImpl,
    RTCIceCandidateImpl,
    rtcConfiguration,
    timerApi,
    now,
  }), [
    now,
    rtcConfiguration,
    RTCIceCandidateImpl,
    RTCPeerConnectionImpl,
    RTCSessionDescriptionImpl,
    timerApi,
  ]);

  useEffect(() => {
    producer.setCallbacks({
      sendSignal,
      onEvent: (event) => {
        onEvent?.(event);
        if (
          event.type === "media_producer_stopped"
          && !["grant_expired", "grant_revoked", "relay_disconnected"].includes(event.reason)
          && connected
        ) revokeMediaGrant?.(event.grantId);
      },
    });
  }, [connected, onEvent, producer, revokeMediaGrant, sendSignal]);

  const snapshot = useSyncExternalStore(
    producer.subscribe,
    producer.getSnapshot,
    producer.getSnapshot,
  );

  useEffect(() => {
    producer.reconcile(context);
  }, [context, producer]);

  useEffect(() => {
    if (grantMessage === null) return;
    const result = producer.handleGrantMessage(grantMessage, context);
    if (!result.ok && grantMessage?.grant?.grant_id && connected) {
      revokeMediaGrant?.(grantMessage.grant.grant_id);
    }
  }, [connected, context, grantMessage, producer, revokeMediaGrant]);

  useEffect(() => {
    if (incomingSignal) void producer.handleSignal(incomingSignal);
  }, [incomingSignal, producer]);

  useEffect(() => () => producer.deactivate("monitor_unmounted"), [producer]);

  const handleMediaGrant = useCallback(
    (value) => producer.handleGrantMessage(value, context),
    [context, producer],
  );
  const handleMediaSignal = useCallback(
    (value) => producer.handleSignal(value),
    [producer],
  );
  const stop = useCallback(
    (reason = "monitor_stopped") => producer.deactivate(reason),
    [producer],
  );

  return {
    ...snapshot,
    handleMediaGrant,
    handleMediaSignal,
    stop,
  };
}
