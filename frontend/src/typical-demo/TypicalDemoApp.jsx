import BathtubRoundedIcon from "@mui/icons-material/BathtubRounded";
import DirectionsWalkRoundedIcon from "@mui/icons-material/DirectionsWalkRounded";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import FullscreenRoundedIcon from "@mui/icons-material/FullscreenRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import MemoryRoundedIcon from "@mui/icons-material/MemoryRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import SyncRoundedIcon from "@mui/icons-material/SyncRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button, ButtonBase } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { projectCareDecision } from "../shared-demo/careDecision.js";
import { relayHttpBase } from "../shared-demo/config";
import { AcceptanceControls } from "./AcceptanceControls";
import { ChildPhone } from "./ChildPhone";
import { DevicePanel } from "./DevicePanel";
import { HomeCarePrompt } from "./HomeCarePrompt";
import { startLocalDemoSession } from "./localDemoStart";
import { MonitorControlPanel } from "./MonitorControlPanel";
import {
  confirmLocalMonitorCommand,
  executeMonitorCommand,
  switchAndCommitMonitorScene,
} from "./monitorCommandExecutor";
import { createDemoStateEnvelope, createPoseFrame } from "./monitorRelay";
import { createBoundedMediaSignalDispatcher } from "./monitorMedia";
import { RuntimeDebugPanel } from "./RuntimeDebugPanel";
import { shouldAutoOpenFamilyVideo } from "./phoneState";
import { homePrivacyViewMode } from "./privacyPresentation";
import { buildDemoState, mediaGrantEligibility } from "./remoteCommand";
import { getCameraHealth, getLinkHealth, getModelHealth } from "./runtimeStatus";
import { DEMO_SCENES } from "./scenes";
import {
  allowsRemoteCommand,
  exposesDebugInterface,
  initialSceneForSurface,
  normalizeSurface,
  remoteActionsForSurface,
} from "./surfacePolicy";
import { useFallLiveLink } from "./useFallLiveLink";
import { useLiveVideoSource } from "./useLiveVideoSource";
import { useMonitorMediaProducer } from "./useMonitorMediaProducer";
import { useMonitorRelay } from "./useMonitorRelay";
import { useRtcConfiguration } from "../shared-demo/useRtcConfiguration.js";

const SCENE_ICONS = {
  living: DirectionsWalkRoundedIcon,
  kitchen: RestaurantRoundedIcon,
  bathroom: BathtubRoundedIcon,
  fall: EmergencyRoundedIcon,
};

export function TypicalDemoApp({ surface = "debug" }) {
  const rtc = useRtcConfiguration();
  const normalizedSurface = normalizeSurface(surface);
  const debugInterface = exposesDebugInterface(normalizedSurface);
  const [sceneId, setSceneId] = useState(() => initialSceneForSurface(normalizedSurface));
  const [familyViewDecisionId, setFamilyViewDecisionId] = useState(null);
  const [videoElement, setVideoElement] = useState(null);
  const [pendingScenario, setPendingScenario] = useState(null);
  const [demoStarted, setDemoStarted] = useState(false);
  const [demoStarting, setDemoStarting] = useState(false);
  const [sourceGeneration, setSourceGeneration] = useState(0);
  const [stateRevision, setStateRevision] = useState(0);
  const [pendingCommands, setPendingCommands] = useState([]);
  const [confirmingCommands, setConfirmingCommands] = useState([]);
  const [grantMessage, setGrantMessage] = useState(null);
  const [grantClockMs, setGrantClockMs] = useState(() => Date.now());
  const [authorizationClockMs, setAuthorizationClockMs] = useState(() => Date.now());
  const [mediaSignalDispatcher] = useState(() => createBoundedMediaSignalDispatcher());
  const autoConversationRef = useRef(null);
  const revisionRef = useRef(0);
  const stateFingerprintRef = useRef(null);
  const commandContextRef = useRef(null);
  const commandActionsRef = useRef({});
  const roomSessionRef = useRef(null);
  const confirmingCommandIdsRef = useRef(new Set());
  const controlGenerationRef = useRef(0);
  const pendingCommandGenerationsRef = useRef(new Map());
  const grantAttemptsRef = useRef(new Map());
  const relayClockOffsetRef = useRef(0);
  const conversationGuardRef = useRef({
    status: "idle",
    scenario: null,
    waitingResponse: false,
  });

  const bumpStateRevision = useCallback(() => {
    const next = revisionRef.current + 1;
    revisionRef.current = next;
    if (commandContextRef.current) {
      commandContextRef.current = { ...commandContextRef.current, stateRevision: next };
    }
    setStateRevision(next);
    return next;
  }, []);
  const relayNow = useCallback(
    () => Date.now() + relayClockOffsetRef.current,
    [],
  );

  const handleRemoteCommand = useCallback(async (envelope) => {
    if (!allowsRemoteCommand(normalizedSurface, envelope?.command?.name)) {
      return { phase: "rejected", code: "command_not_supported_on_surface" };
    }
    const expectedControlGeneration = controlGenerationRef.current;
    const result = await executeMonitorCommand(envelope, {
      getContext: () => commandContextRef.current || {},
      getActions: () => commandActionsRef.current,
      getControlGeneration: () => controlGenerationRef.current,
      expectedControlGeneration,
      now: relayNow,
    });
    if (result.phase === "awaiting_local_confirmation") {
      pendingCommandGenerationsRef.current.set(
        envelope.command_id,
        expectedControlGeneration,
      );
      setPendingCommands((current) => (
        current.some((item) => item.command_id === envelope.command_id)
          ? current
          : [...current, envelope]
      ));
      return result;
    }
    if (result.phase === "applied") {
      return { ...result, stateRevision: bumpStateRevision() };
    }
    if (result.authoritativeStateCommitted) bumpStateRevision();
    return result;
  }, [bumpStateRevision, normalizedSurface, relayNow]);

  const relayUrl = useMemo(() => relayHttpBase().toString(), []);

  const scene = useMemo(
    () => DEMO_SCENES.find((item) => item.id === sceneId),
    [sceneId],
  );
  const live = useFallLiveLink({
    enabled: demoStarted,
    videoElement,
    sceneId,
    sourceGeneration,
  });
  const {
    active: liveActive,
    runtime: liveRuntime,
    triggerDebugScenario,
    resetSceneState,
    startDemoConversation,
    switchScene,
  } = live;
  const effectivePhase = demoStarted ? live.phase : "idle";
  const currentDecision = live.decision?.decision || null;
  const projectedDecision = useMemo(
    () => projectCareDecision(currentDecision),
    [currentDecision],
  );
  const alarmActive = Boolean(projectedDecision?.alarm);
  const kitchenShareDecision = useMemo(
    () => [live.decision?.decision, ...(live.decision?.history || [])]
      .find((item) => (
        item?.scene_id === "kitchen"
        && item.action === "notify_family"
        && item.family_notification
        && item.action_card === null
        && item.alarm === null
      )),
    [live.decision?.decision, live.decision?.history],
  );
  const kitchenShared = Boolean(kitchenShareDecision);
  const kitchenNotification = kitchenShareDecision?.family_notification || "";
  const activeGrant = grantMessage?.grant?.status === "active"
    && grantMessage.grant.expires_at_ms > grantClockMs
    ? grantMessage.grant
    : null;
  const backendAuthorization = projectedDecision?.media_authorization || null;
  const familyGrantActive = Boolean(
    activeGrant
      && sceneId !== "bathroom"
      && rtc.configuration.mode !== "unavailable"
      && ["visible", "blurred"].includes(projectedDecision?.privacy_mode)
      && backendAuthorization?.status === "active"
      && backendAuthorization.decision_id === projectedDecision?.decision_id
      && backendAuthorization.decision_id === activeGrant.event_id
      && backendAuthorization.scope === activeGrant.scope
      && backendAuthorization.scene_id === sceneId,
  );
  const deviceViewMode = homePrivacyViewMode(sceneId, projectedDecision);
  const autoFamilyViewOpen = shouldAutoOpenFamilyVideo(sceneId, projectedDecision);
  const effectiveFamilyViewOpen = Boolean(
    projectedDecision?.decision_id
      && familyViewDecisionId === projectedDecision.decision_id,
  );
  const phoneViewMode = (autoFamilyViewOpen || effectiveFamilyViewOpen) && familyGrantActive
    ? "video_skeleton"
    : "skeleton";
  const skeletonColor = ["candidate", "checking"].includes(effectivePhase)
    ? "#ff3b30"
    : "#ff5a00";
  const onSourceGenerationChange = useCallback(({ generation }) => {
    setSourceGeneration(generation);
  }, []);
  const media = useLiveVideoSource({
    deviceViewMode,
    phoneViewMode,
    skeletonColor,
    backendLandmarkFrame: live.landmarkFrame,
    autoStart: false,
    onSourceGenerationChange,
  });

  useEffect(() => {
    if (!demoStarted) return undefined;
    const tick = () => {
      setGrantClockMs(relayNow());
      setAuthorizationClockMs(relayNow());
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [demoStarted, relayNow]);
  const {
    videoRef,
    deviceCanvasRef,
    phoneCanvasRef,
    cameraReady,
    aspectRatio: cameraAspectRatio,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    cameraError,
    error: cameraRuntimeError,
    sourceError: cameraSourceError,
    retry: retryCamera,
    sourceStatus,
    source: sourceDescriptor,
  } = media;

  const bindCaptureVideo = useCallback((node) => {
    videoRef.current = node;
    setVideoElement(node);
  }, [videoRef]);

  const cameraState = useMemo(() => ({
    cameraReady,
    aspectRatio: cameraAspectRatio,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    cameraError,
    error: cameraRuntimeError,
    errorCode: cameraSourceError?.code || null,
    retry: retryCamera,
    sourceStatus,
    sourceKind: sourceDescriptor?.kind || null,
    sourceLabel: sourceDescriptor?.label || null,
    perceptionState: liveRuntime?.state || "offline",
    inputMode: liveRuntime?.inputMode || null,
    modelCapabilities: liveRuntime?.modelCapabilities || null,
    effectiveModels: liveRuntime?.effectiveModels || null,
    perceptionReason: liveRuntime?.reason || "",
  }), [
    backendSkeletonActive,
    cameraAspectRatio,
    cameraError,
    cameraReady,
    cameraRuntimeError,
    cameraSourceError?.code,
    liveRuntime?.inputMode,
    liveRuntime?.modelCapabilities,
    liveRuntime?.effectiveModels,
    liveRuntime?.reason,
    liveRuntime?.state,
    personDetected,
    retryCamera,
    skeletonSource,
    sourceDescriptor?.kind,
    sourceDescriptor?.label,
    sourceStatus,
  ]);

  const cameraHealth = getCameraHealth(cameraState);
  const modelHealth = getModelHealth(cameraState);
  const linkHealth = getLinkHealth(live);

  const mediaAuthorityEligibility = useMemo(() => mediaGrantEligibility({
    sceneId,
    runtimeSessionId: liveRuntime?.sessionId || null,
    authorization: backendAuthorization,
    authorizationRuntimeSessionId: liveRuntime?.sessionId || null,
    privacyMode: projectedDecision?.privacy_mode || "hidden",
    now: authorizationClockMs,
  }), [
    authorizationClockMs,
    backendAuthorization,
    liveRuntime?.sessionId,
    projectedDecision?.privacy_mode,
    sceneId,
  ]);
  const mediaAuthorityKey = mediaAuthorityEligibility.allowed
    ? `${mediaAuthorityEligibility.scope}:${mediaAuthorityEligibility.eventId}`
    : null;
  const mediaAuthorityActive = Boolean(
    mediaAuthorityKey
      && liveActive
      && live.connection === "open"
      && rtc.configuration.mode !== "unavailable",
  );
  const relayRuntime = useMemo(() => {
    if (!demoStarted) return liveRuntime;
    if (liveActive && media.ready && live.connection === "open") return liveRuntime;
    return {
      ...liveRuntime,
      state: "degraded",
      reason: !media.ready
        ? "本机媒体源不可用；当前实时状态与事件原画均不可用"
        : live.connection !== "open"
          ? "决策链路不可用；当前实时状态与事件原画均不可用"
          : "感知链路不可用；当前实时状态与事件原画均不可用",
    };
  }, [demoStarted, live.connection, liveActive, liveRuntime, media.ready]);
  const stateFingerprint = JSON.stringify([
    liveRuntime?.sessionId || null,
    sceneId,
    media.sourceGeneration,
    media.sourceStatus,
    sourceDescriptor?.id || null,
    sourceDescriptor?.kind || null,
    sourceDescriptor?.remote_video || null,
    media.sourceError?.code || null,
    relayRuntime?.state || null,
    relayRuntime?.inputMode || null,
    relayRuntime?.reason || null,
    currentDecision?.decision_id || null,
    currentDecision?.state || null,
    currentDecision?.action || null,
    currentDecision?.family_notification || null,
    currentDecision?.privacy_mode || null,
    currentDecision?.alarm?.trigger || null,
  ]);

  useEffect(() => {
    if (!demoStarted || !liveRuntime?.sessionId) return undefined;
    if (stateFingerprintRef.current === stateFingerprint) return undefined;
    const timer = window.setTimeout(() => {
      if (stateFingerprintRef.current === stateFingerprint) return;
      stateFingerprintRef.current = stateFingerprint;
      bumpStateRevision();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [bumpStateRevision, demoStarted, liveRuntime?.sessionId, stateFingerprint]);

  const stateEnvelope = useCallback((roomSessionId) => {
    if (
      !liveRuntime?.sessionId
      || !Number.isSafeInteger(stateRevision)
      || stateFingerprintRef.current !== stateFingerprint
    ) return null;
    const built = buildDemoState({
      roomSessionId,
      runtimeSessionId: liveRuntime.sessionId,
      stateRevision,
      sceneId,
      sourceGeneration: media.sourceGeneration,
      source: sourceDescriptor,
      capture: {
        status: media.sourceStatus,
        active: media.ready,
        error: media.sourceError?.message || null,
      },
      runtime: relayRuntime,
      decision: currentDecision,
    });
    return createDemoStateEnvelope({
      roomSessionId,
      runtimeSessionId: liveRuntime.sessionId,
      stateRevision,
      state: built.state,
      timestampMs: built.timestamp_ms,
    });
  }, [
    liveRuntime,
    currentDecision,
    media.ready,
    media.sourceError?.message,
    media.sourceGeneration,
    media.sourceStatus,
    sceneId,
    sourceDescriptor,
    relayRuntime,
    stateFingerprint,
    stateRevision,
  ]);

  const poseFrame = useCallback((roomSessionId) => {
    const runtimeSessionId = liveRuntime?.sessionId;
    const frameSequence = live.landmarkFrame?.payload?.frame_index;
    if (
      !runtimeSessionId
      || !Number.isSafeInteger(frameSequence)
      || live.landmarkFrame?.sourceGeneration !== media.sourceGeneration
    ) return null;
    const sourceWidth = Math.max(1, Math.round(videoElement?.videoWidth || 640));
    const sourceHeight = Math.max(1, Math.round(videoElement?.videoHeight || 360));
    return createPoseFrame({
      roomSessionId,
      runtimeSessionId,
      frameSequence,
      sourceWidth,
      sourceHeight,
      landmarks: live.landmarkFrame?.landmarks || [],
      landmarkQuality: live.landmarkFrame?.payload?.landmark_quality || "unavailable",
    });
  }, [
    live.landmarkFrame,
    liveRuntime?.sessionId,
    media.sourceGeneration,
    videoElement,
  ]);

  const monitor = useMonitorRelay({
    relayUrl,
    enabled: demoStarted,
    stateEnvelope,
    onCommand: handleRemoteCommand,
    onMediaGrant: setGrantMessage,
    onMediaSignal: mediaSignalDispatcher.dispatch,
  });
  const sendMonitorAck = monitor.sendControlAck;
  const requestMonitorGrant = monitor.requestMediaGrant;
  const publishMonitorPose = monitor.publishPose;
  const controllerLeaseId = monitor.controller?.lease_id || null;

  useEffect(() => {
    if (!monitor.connected || !monitor.roomSessionId) return;
    const value = poseFrame(monitor.roomSessionId);
    if (value) publishMonitorPose(value);
  }, [
    monitor.connected,
    monitor.roomSessionId,
    poseFrame,
    publishMonitorPose,
  ]);

  useEffect(() => {
    controlGenerationRef.current += 1;
    pendingCommandGenerationsRef.current.clear();
    const timer = window.setTimeout(() => setPendingCommands([]), 0);
    return () => window.clearTimeout(timer);
  }, [controllerLeaseId, monitor.roomSessionId]);

  useEffect(() => {
    relayClockOffsetRef.current = monitor.serverTimeOffsetMs || 0;
    const timer = window.setTimeout(() => setGrantClockMs(relayNow()), 0);
    return () => window.clearTimeout(timer);
  }, [monitor.serverTimeOffsetMs, relayNow]);

  useEffect(() => {
    if (!grantMessage?.grant || !monitor.roomSessionId || !liveRuntime?.sessionId) return;
    const key = [
      monitor.roomSessionId,
      liveRuntime.sessionId,
      media.sourceGeneration,
      grantMessage.grant.scope,
      grantMessage.grant.event_id,
    ].join(":");
    if (grantMessage.grant.status === "active") {
      grantAttemptsRef.current.set(
        key,
        { status: "accepted", attemptedAtMs: relayNow() },
      );
    } else {
      grantAttemptsRef.current.delete(key);
    }
  }, [
    grantMessage,
    liveRuntime?.sessionId,
    media.sourceGeneration,
    monitor.roomSessionId,
    relayNow,
  ]);

  useEffect(() => {
    if (!monitor.connected || !liveRuntime?.sessionId) return undefined;
    const timer = window.setInterval(() => bumpStateRevision(), 10_000);
    return () => window.clearInterval(timer);
  }, [bumpStateRevision, liveRuntime?.sessionId, monitor.connected]);

  const mediaProducer = useMonitorMediaProducer({
    connected: monitor.connected,
    roomSessionId: monitor.roomSessionId,
    runtimeSessionId: liveRuntime?.sessionId || null,
    sourceGeneration: media.sourceGeneration,
    sceneId,
    remoteStream: media.remoteStream,
    authorized: mediaAuthorityActive,
    authorityKey: mediaAuthorityKey,
    grantMessage,
    sendSignal: monitor.sendMediaSignal,
    revokeMediaGrant: monitor.revokeMediaGrant,
    rtcConfiguration: rtc.configuration,
    now: relayNow,
  });

  useEffect(() => {
    mediaSignalDispatcher.setHandler(mediaProducer.handleMediaSignal);
    return () => mediaSignalDispatcher.clearHandler(mediaProducer.handleMediaSignal);
  }, [mediaProducer.handleMediaSignal, mediaSignalDispatcher]);

  const startLocalDemo = useCallback(async () => {
    setDemoStarting(true);
    try {
      return await startLocalDemoSession({
        markStarted: () => setDemoStarted(true),
        startCapture: () => media.selectCamera({ facingMode: "user" }),
        startRelay: monitor.startDemo,
      });
    } finally {
      setDemoStarting(false);
    }
  }, [media, monitor]);

  const stopLocalDemo = useCallback(() => {
    mediaProducer.stop("monitor_stopped");
    media.stop();
    monitor.stopDemo();
    setDemoStarted(false);
    setPendingScenario(null);
    setPendingCommands([]);
    setConfirmingCommands([]);
    confirmingCommandIdsRef.current.clear();
    pendingCommandGenerationsRef.current.clear();
    setGrantMessage(null);
    mediaSignalDispatcher.clear();
    setFamilyViewDecisionId(null);
  }, [media, mediaProducer, mediaSignalDispatcher, monitor]);

  const revokeRemoteControl = useCallback(() => {
    controlGenerationRef.current += 1;
    pendingCommandGenerationsRef.current.clear();
    const sent = monitor.revokeControl();
    if (sent) setPendingCommands([]);
    return sent;
  }, [monitor]);

  const roomPresentation = useMemo(() => ({
    connectionLabel: ({
      claiming: "正在取得 producer 租约",
      connecting: "正在连接 Relay",
      reconnecting: "Relay 重连中",
      connected: ({
        local_network_only: "Relay 在线 · 原画仅局域网",
        stun_only: "Relay 在线 · STUN 直连",
        turn_configured: "Relay 与 TURN 在线",
        unavailable: "RTC 配置不可用 · 原画关闭",
      })[mediaProducer.connectivity] || "Relay 在线 · RTC 配置待确认",
      busy: "producer 已被其他 Monitor 占用",
      error: monitor.error || "Relay 连接失败",
    })[monitor.status] || (demoStarted ? "等待本地 Relay" : "尚未加入房间"),
    roomSessionId: monitor.roomSessionId,
    viewerCount: monitor.viewerCount,
    maxViewers: monitor.maxViewers,
    monitorOnline: monitor.connected,
    controllerActive: Boolean(monitor.controller),
    controllerLabel: monitor.controller
      ? `Viewer ${monitor.controller.viewer_id.slice(-6)} · ${Math.max(0, Math.ceil((monitor.controller.expires_at_ms - grantClockMs) / 1000))} 秒`
      : "尚无 Viewer 接管",
    stateRevision,
    mediaGrantLabel: activeGrant
      ? `${activeGrant.scope === "kitchen_moment" ? "厨房授权" : "跌倒升级"} · ${Math.max(0, Math.ceil((activeGrant.expires_at_ms - grantClockMs) / 1000))} 秒`
      : "未开放",
  }), [
    activeGrant,
    demoStarted,
    grantClockMs,
    mediaProducer.connectivity,
    monitor.connected,
    monitor.controller,
    monitor.error,
    monitor.maxViewers,
    monitor.roomSessionId,
    monitor.status,
    monitor.viewerCount,
    stateRevision,
  ]);

  const selectScene = useCallback((nextScene, execution = null) => (
    switchAndCommitMonitorScene({
      nextScene,
      switchScene,
      execution,
      commitScene(committedScene) {
        setSceneId(committedScene);
        setFamilyViewDecisionId(null);
        autoConversationRef.current = null;
      },
    })
  ), [switchScene]);

  const requestManualScenario = useCallback((scenario, targetScene) => {
    if (!liveActive) return;
    if (sceneId !== targetScene) {
      setPendingScenario({ scenario, targetScene });
      selectScene(targetScene);
      return;
    }
    triggerDebugScenario(scenario);
  }, [liveActive, sceneId, selectScene, triggerDebugScenario]);

  const resetAcceptance = useCallback(() => {
    setPendingScenario(null);
    return resetSceneState()
      .then(() => {
        const triggered = triggerDebugScenario("normal");
        return {
          ok: triggered,
          code: triggered ? "demo_reset" : "scenario_unavailable",
        };
      });
  }, [resetSceneState, triggerDebugScenario]);

  const runRemoteScenario = useCallback(async (scenario, execution = null) => {
    if (scenario === "fall" && sceneId !== "fall") {
      const switched = await selectScene("fall", execution);
      if (switched?.ok === false) return switched;
    }
    const authority = execution?.revalidate();
    if (authority && !authority.ok) return { ok: false, code: authority.code };
    const triggered = triggerDebugScenario(scenario);
    return {
      ok: triggered,
      code: triggered ? "scenario_started" : "scenario_unavailable",
    };
  }, [sceneId, selectScene, triggerDebugScenario]);

  const submitRemoteResponse = useCallback((decisionId, response) => {
    const responders = {
      safe: live.respondSafe,
      need_help: live.respondNeedHelp,
      consent_granted: live.respondConsentGranted,
      consent_denied: live.respondConsentDenied,
    };
    const responder = responders[response];
    return responder
      ? responder(decisionId)
      : Promise.resolve({ ok: false, code: "response_not_supported" });
  }, [
    live.respondConsentDenied,
    live.respondConsentGranted,
    live.respondNeedHelp,
    live.respondSafe,
  ]);

  const startRemoteCapture = useCallback(() => {
    if (media.sourceStatus === "stopped" || media.sourceStatus === "ended" || media.sourceError) {
      return media.retry();
    }
    if (media.ready) return Promise.resolve({ ok: true, code: "capture_already_active" });
    return media.selectCamera({ facingMode: "user" });
  }, [media]);

  const selectRemoteSource = useCallback(
    (sourceId, options = {}) => media.selectSource(sourceId, options),
    [media],
  );

  useEffect(() => {
    commandContextRef.current = {
      roomSessionId: monitor.roomSessionId,
      stateRevision,
      sceneId,
      decisionId: projectedDecision?.decision_id || null,
      activeSafetyEvent: alarmActive,
      sources: debugInterface ? media.availableSources : [],
    };
    commandActionsRef.current = remoteActionsForSurface(normalizedSurface, {
      selectScene,
      selectSource: selectRemoteSource,
      startCapture: startRemoteCapture,
      stopCapture: media.stop,
      runDemoScenario: runRemoteScenario,
      resetDemo: resetAcceptance,
      startConversation: startDemoConversation,
      submitResponse: submitRemoteResponse,
      confirmAlarm: live.confirmAlarm,
      confirmActionCard: live.confirmActionCard,
      replayVoice: live.replayVoice,
    });
  }, [
    alarmActive,
    debugInterface,
    live.confirmAlarm,
    live.confirmActionCard,
    live.replayVoice,
    media.availableSources,
    media.stop,
    monitor.roomSessionId,
    normalizedSurface,
    projectedDecision?.decision_id,
    resetAcceptance,
    runRemoteScenario,
    sceneId,
    selectRemoteSource,
    selectScene,
    startDemoConversation,
    startRemoteCapture,
    stateRevision,
    submitRemoteResponse,
  ]);

  const confirmPendingCommand = useCallback(async (commandId, options = {}) => {
    const pending = pendingCommands.find((item) => item.command_id === commandId);
    if (!pending || confirmingCommandIdsRef.current.has(commandId)) return;
    confirmingCommandIdsRef.current.add(commandId);
    const confirmationGeneration = pendingCommandGenerationsRef.current.get(commandId);
    pendingCommandGenerationsRef.current.delete(commandId);
    setPendingCommands((current) => current.filter((item) => item.command_id !== commandId));
    setConfirmingCommands((current) => [...current, pending]);
    const actions = {
      ...commandActionsRef.current,
      selectSource: (sourceId) => selectRemoteSource(sourceId, options),
    };
    try {
      let result = Number.isSafeInteger(confirmationGeneration)
        ? await confirmLocalMonitorCommand(pending, actions, {
            getContext: () => commandContextRef.current || {},
            getControlGeneration: () => controlGenerationRef.current,
            expectedControlGeneration: confirmationGeneration,
            now: relayNow,
          })
        : { phase: "rejected", code: "controller_lease_ended" };
      const roomStillCurrent = roomSessionRef.current === pending.room_session_id;
      const controlStillCurrent = controlGenerationRef.current === confirmationGeneration;
      const expired = pending.expires_at_ms <= relayNow();
      if (result.phase === "applied" && (!roomStillCurrent || !controlStillCurrent || expired)) {
        if (result.code !== "capture_already_active") media.stop();
        result = {
          phase: "rejected",
          code: expired
            ? "command_expired"
            : controlStillCurrent
              ? "stale_room_session"
              : "controller_lease_ended",
        };
      }
      if (roomStillCurrent && controlStillCurrent) {
        const nextRevision = result.phase === "applied" ? bumpStateRevision() : null;
        sendMonitorAck({
          commandId,
          phase: result.phase,
          stateRevision: nextRevision,
          reason: result.code || result.detail || null,
        });
      }
    } finally {
      confirmingCommandIdsRef.current.delete(commandId);
      setConfirmingCommands((current) => (
        current.filter((item) => item.command_id !== commandId)
      ));
    }
  }, [bumpStateRevision, media, pendingCommands, relayNow, selectRemoteSource, sendMonitorAck]);

  const rejectPendingCommand = useCallback((commandId, reason = "local_confirmation_denied") => {
    pendingCommandGenerationsRef.current.delete(commandId);
    setPendingCommands((current) => current.filter((item) => item.command_id !== commandId));
    sendMonitorAck({
      commandId,
      phase: "rejected",
      stateRevision: null,
      reason,
    });
  }, [sendMonitorAck]);

  useEffect(() => {
    if (roomSessionRef.current === monitor.roomSessionId) return;
    roomSessionRef.current = monitor.roomSessionId;
    setPendingCommands([]);
    setConfirmingCommands([]);
    confirmingCommandIdsRef.current.clear();
    pendingCommandGenerationsRef.current.clear();
    setGrantMessage(null);
    grantAttemptsRef.current.clear();
    mediaSignalDispatcher.clear();
  }, [mediaSignalDispatcher, monitor.roomSessionId]);

  useEffect(() => {
    if (pendingCommands.length === 0) return undefined;
    const nextExpiry = Math.min(...pendingCommands.map((item) => item.expires_at_ms));
    const timer = window.setTimeout(() => {
      const now = relayNow();
      setPendingCommands((current) => {
        const expired = current.filter((item) => item.expires_at_ms <= now);
        for (const item of expired) {
          pendingCommandGenerationsRef.current.delete(item.command_id);
          sendMonitorAck({
            commandId: item.command_id,
            phase: "rejected",
            stateRevision: null,
            reason: "command_expired",
          });
        }
        return current.filter((item) => item.expires_at_ms > now);
      });
    }, Math.max(0, nextExpiry - relayNow()) + 5);
    return () => window.clearTimeout(timer);
  }, [pendingCommands, relayNow, sendMonitorAck]);

  useEffect(() => {
    const runtimeSessionId = liveRuntime?.sessionId;
    const attemptNowMs = relayNow();
    const eligibility = mediaAuthorityEligibility;
    if (
      !monitor.connected
      || !liveActive
      || live.connection !== "open"
      || !runtimeSessionId
      || !eligibility.allowed
      || !media.ready
      || rtc.configuration.mode === "unavailable"
      || sourceDescriptor?.remote_video !== "available"
      || stateFingerprintRef.current !== stateFingerprint
    ) return;
    if (monitor.acceptedStateRevision < stateRevision) return undefined;
    const eventKey = [
      monitor.roomSessionId,
      runtimeSessionId,
      media.sourceGeneration,
      eligibility.scope,
      eligibility.eventId,
    ].join(":");
    const previousAttempt = grantAttemptsRef.current.get(eventKey);
    if (previousAttempt?.status === "accepted") return undefined;
    if (
      previousAttempt?.status === "pending"
      && attemptNowMs - previousAttempt.attemptedAtMs < 1_500
    ) return undefined;
    const sent = requestMonitorGrant({
      runtimeSessionId,
      eventId: eligibility.eventId,
      scope: eligibility.scope,
      expiresInMs: eligibility.durationMs,
    });
    if (!sent) return undefined;
    grantAttemptsRef.current.set(eventKey, { status: "pending", attemptedAtMs: attemptNowMs });
    const retryTimer = window.setTimeout(() => setGrantClockMs(relayNow()), 1_550);
    return () => window.clearTimeout(retryTimer);
  }, [
    grantClockMs,
    live.connection,
    liveActive,
    liveRuntime?.sessionId,
    mediaAuthorityEligibility,
    media.ready,
    media.sourceGeneration,
    monitor.connected,
    monitor.acceptedStateRevision,
    monitor.roomSessionId,
    requestMonitorGrant,
    relayNow,
    rtc.configuration.mode,
    sceneId,
    sourceDescriptor?.remote_video,
    stateRevision,
    stateFingerprint,
  ]);

  useEffect(() => {
    if (
      !pendingScenario
      || sceneId !== pendingScenario.targetScene
      || !liveActive
      || !liveRuntime?.sessionId
    ) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (triggerDebugScenario(pendingScenario.scenario)) {
        setPendingScenario(null);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    liveActive,
    liveRuntime?.sessionId,
    triggerDebugScenario,
    pendingScenario,
    sceneId,
  ]);

  useEffect(() => {
    conversationGuardRef.current = {
      status: live.decision?.mimoRequest?.status || "idle",
      scenario: live.decision?.mimoRequest?.scenario || null,
      waitingResponse: Boolean(live.decision?.decision?.need_dialogue),
    };
  }, [
    live.decision?.decision?.need_dialogue,
    live.decision?.mimoRequest?.scenario,
    live.decision?.mimoRequest?.status,
  ]);

  useEffect(() => {
    if (!debugInterface) return undefined;
    const sessionId = liveRuntime?.sessionId;
    const scenario = scene.conversationScenario;
    const requestKey = sessionId && scenario ? `${sessionId}:${scene.id}:${scenario}` : null;
    const alreadyCompleted = scenario === "kitchen_share" && kitchenShared;
    if (
      !scene.autoConversation
      || !liveActive
      || live.connection !== "open"
      || !requestKey
      || alreadyCompleted
      || autoConversationRef.current === requestKey
    ) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      const guard = conversationGuardRef.current;
      if (
        guard.waitingResponse
        || (guard.scenario === scenario
          && ["waiting_scene", "requesting", "succeeded"].includes(guard.status))
      ) return;
      autoConversationRef.current = requestKey;
      startDemoConversation(scenario).catch(() => {
        if (autoConversationRef.current === requestKey) {
          autoConversationRef.current = null;
        }
      });
    }, 2500);

    return () => window.clearTimeout(timer);
  }, [
    debugInterface,
    kitchenShared,
    live.connection,
    liveActive,
    liveRuntime?.sessionId,
    scene,
    startDemoConversation,
  ]);

  const contactEmergency = live.confirmAlarm;

  useEffect(() => {
    if (!debugInterface) return undefined;
    function onKeyDown(event) {
      if (["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) return;
      if (/^[1-4]$/.test(event.key)) selectScene(DEMO_SCENES[Number(event.key) - 1].id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [debugInterface, selectScene]);

  async function enterFullscreen() {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else await document.exitFullscreen?.();
  }

  return (
    <main
      className={`typical-demo is-${normalizedSurface}-surface scene-tone-${scene.tone} ${!debugInterface && !demoStarted ? "is-home-idle" : ""}`}
      data-app-role={normalizedSurface}
    >
      <video ref={bindCaptureVideo} className="capture-video" autoPlay muted playsInline aria-hidden="true" />

      <header className="demo-topbar">
        <div className="brand-lockup">
          <span className="reme-word">Reme</span>
          <div>
            <h1>{debugInterface ? "Reme ABC 工程验收" : "Reme 家中采集端"}</h1>
            <p>{debugInterface
              ? "同屏核对本机感知、MiMo 决策、家属呈现与失败状态"
              : "面向全屋智能统一采集数据；当前演示接入本机视频，并在本地转为姿态与事件"}</p>
          </div>
          {debugInterface && <b className="debug-surface-badge">DEBUG · 非产品界面</b>}
        </div>
        {(debugInterface || demoStarted) && (
          <div className="topbar-actions">
            {debugInterface && (
              <>
                <span
                  className={`camera-health status-${cameraHealth.state}`}
                  title={cameraHealth.detail}
                >
                  <VideocamRoundedIcon />{cameraHealth.label}
                </span>
                <span
                  className={`camera-health status-${modelHealth.state}`}
                  title={modelHealth.detail}
                >
                  <MemoryRoundedIcon />{modelHealth.label}
                </span>
              </>
            )}
            <span
              className={`camera-health live-link-health status-${linkHealth.state}`}
              title={linkHealth.detail}
            >
              <HubRoundedIcon />{linkHealth.label}
            </span>
            {debugInterface && (
              <Button variant="outlined" startIcon={<FullscreenRoundedIcon />} onClick={enterFullscreen}>进入全屏</Button>
            )}
          </div>
        )}
      </header>

      <MonitorControlPanel
        surface={normalizedSurface}
        started={demoStarted}
        starting={demoStarting}
        onStart={startLocalDemo}
        onStop={stopLocalDemo}
        media={media}
        room={roomPresentation}
        pendingCommands={pendingCommands}
        confirmingCommands={confirmingCommands}
        onConfirmCommand={confirmPendingCommand}
        onRejectCommand={rejectPendingCommand}
        onRevokeControl={revokeRemoteControl}
        nowMs={grantClockMs}
      />

      {debugInterface && (
        <nav className="scene-tabs" aria-label="选择典型演示场景">
          {DEMO_SCENES.map((item, index) => {
            const SceneIcon = SCENE_ICONS[item.id];
            return (
              <ButtonBase
                key={item.id}
                className={sceneId === item.id ? "is-active" : ""}
                onClick={() => selectScene(item.id)}
              >
                <small>0{index + 1}</small>
                <span className="flex items-center gap-2">
                  <SceneIcon sx={{ fontSize: 17 }} />
                  {item.nav.replace(/^场景.：/, "")}
                </span>
                <kbd>{index + 1}</kbd>
              </ButtonBase>
            );
          })}
        </nav>
      )}

      <div className="demo-workspace">
        {debugInterface ? (
          <>
            <DevicePanel
              surface={normalizedSurface}
              scene={scene}
              canvasRef={deviceCanvasRef}
              camera={cameraState}
              viewMode={deviceViewMode}
            />

            <div className="sync-rail" aria-hidden="true">
              <span /><i /><span />
              <SyncRoundedIcon className="text-orange-500" sx={{ fontSize: 18 }} />
              <b>实时同步</b>
            </div>

            <ChildPhone
              scene={scene}
              fallPhase={effectivePhase}
              alarmActive={alarmActive}
              fallStateOverride={liveActive ? live.fallState : null}
              emergencyNote={liveActive ? live.emergencyNote : null}
              kitchenShared={kitchenShared}
              kitchenNotification={kitchenNotification}
              canvasRef={phoneCanvasRef}
              camera={cameraState}
              viewMode={phoneViewMode}
              familyViewOpen={effectiveFamilyViewOpen}
              autoFamilyViewOpen={autoFamilyViewOpen}
              familyVideoAllowed={familyGrantActive}
              onToggleFamilyView={() => setFamilyViewDecisionId((current) => (
                current === projectedDecision?.decision_id
                  ? null
                  : projectedDecision?.decision_id || null
              ))}
              onContact={contactEmergency}
            />
          </>
        ) : (
          <>
            <DevicePanel
              surface={normalizedSurface}
              started={demoStarted}
              scene={scene}
              canvasRef={deviceCanvasRef}
              camera={cameraState}
              viewMode={deviceViewMode}
            />
            <HomeCarePrompt
              scene={scene}
              live={live}
              started={demoStarted}
              available={Boolean(liveActive && media.ready)}
            />
          </>
        )}
      </div>

      {debugInterface && (
        <>
          <AcceptanceControls
            scene={scene}
            live={live}
            onTriggerFall={() => requestManualScenario("fall", "fall")}
            onReset={resetAcceptance}
          />

          <RuntimeDebugPanel camera={cameraState} live={live} monitor={monitor} scene={scene} />

          <footer className="demo-footer">
            <Button size="small" variant="text" startIcon={<RestartAltRoundedIcon />} onClick={resetAcceptance}>
              重新开始当前场景
            </Button>
          </footer>
        </>
      )}
    </main>
  );
}
