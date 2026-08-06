import FullscreenRoundedIcon from "@mui/icons-material/FullscreenRounded";
import MemoryRoundedIcon from "@mui/icons-material/MemoryRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcceptanceControls } from "./AcceptanceControls";
import { ChildPhone } from "./ChildPhone";
import { DevicePanel } from "./DevicePanel";
import { RuntimeDebugPanel } from "./RuntimeDebugPanel";
import { shouldAutoOpenFamilyVideo, shouldCloseFamilyVideo } from "./phoneState";
import { getCameraHealth, getLinkHealth, getModelHealth } from "./runtimeStatus";
import { DEMO_SCENES } from "./scenes";
import { useFallLiveLink } from "./useFallLiveLink";
import { useLiveDemoCamera } from "./useLiveDemoCamera";

export function TypicalDemoApp() {
  const [sceneId, setSceneId] = useState("fall");
  const [familyViewOpen, setFamilyViewOpen] = useState(false);
  const [videoElement, setVideoElement] = useState(null);
  const [pendingScenario, setPendingScenario] = useState(null);
  const sendLandmarksRef = useRef(null);
  const autoConversationRef = useRef(null);
  const conversationGuardRef = useRef({
    status: "idle",
    scenario: null,
    waitingResponse: false,
  });

  const scene = useMemo(
    () => DEMO_SCENES.find((item) => item.id === sceneId),
    [sceneId],
  );
  const handleLandmarks = useCallback(
    (points, timestampMs) => sendLandmarksRef.current?.(points, timestampMs),
    [],
  );
  const live = useFallLiveLink({
    enabled: true,
    videoElement,
    sceneId,
  });
  const {
    active: liveActive,
    runtime: liveRuntime,
    triggerDebugScenario,
    resetSceneState,
    startDemoConversation,
  } = live;
  const effectivePhase = sceneId === "fall" && liveActive ? live.phase : "idle";
  const kitchenShareDecision = useMemo(
    () => [live.decision?.decision, ...(live.decision?.history || [])]
      .find((item) => (
        item?.scene_id === "kitchen"
        && item.action === "notify_family"
        && item.family_notification
      )),
    [live.decision?.decision, live.decision?.history],
  );
  const kitchenShared = Boolean(kitchenShareDecision);
  const kitchenNotification = kitchenShareDecision?.family_notification || "";
  const deviceViewMode = sceneId === "bathroom" ? "skeleton" : "video_skeleton";
  const autoFamilyViewOpen = shouldAutoOpenFamilyVideo(sceneId, effectivePhase);
  const effectiveFamilyViewOpen = familyViewOpen
    && !(sceneId === "fall" && shouldCloseFamilyVideo(effectivePhase));
  const phoneViewMode = (autoFamilyViewOpen || effectiveFamilyViewOpen) && live.familyVideoAllowed
    ? "video_skeleton"
    : "skeleton";
  const skeletonColor = sceneId === "fall" && ["candidate", "checking"].includes(effectivePhase)
    ? "#ff3b30"
    : "#ff5a00";
  const {
    videoRef,
    deviceCanvasRef,
    phoneCanvasRef,
    cameraReady,
    aspectRatio: cameraAspectRatio,
    modelReady,
    inferenceBackend,
    gpuRenderer,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    cameraError,
    modelError,
    error: cameraRuntimeError,
    retry: retryCamera,
  } = useLiveDemoCamera({
    deviceViewMode,
    phoneViewMode,
    skeletonColor,
    onLandmarks: handleLandmarks,
    backendLandmarkFrame: live.landmarkFrame,
  });

  useEffect(() => {
    setVideoElement(videoRef.current);
  }, [videoRef]);

  useEffect(() => {
    sendLandmarksRef.current = live.sendLandmarks;
  }, [live.sendLandmarks]);

  const cameraState = useMemo(() => ({
    cameraReady,
    aspectRatio: cameraAspectRatio,
    modelReady,
    inferenceBackend,
    gpuRenderer,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    cameraError,
    modelError,
    error: cameraRuntimeError,
    retry: retryCamera,
  }), [
    backendSkeletonActive,
    cameraAspectRatio,
    cameraError,
    cameraReady,
    cameraRuntimeError,
    gpuRenderer,
    inferenceBackend,
    modelError,
    modelReady,
    personDetected,
    retryCamera,
    skeletonSource,
  ]);

  const cameraHealth = getCameraHealth(cameraState);
  const modelHealth = getModelHealth(cameraState);
  const linkHealth = getLinkHealth(live);

  const selectScene = useCallback((nextScene) => {
    setSceneId(nextScene);
    setFamilyViewOpen(false);
    autoConversationRef.current = null;
  }, []);


  const markSafe = live.respondSafe;

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
    resetSceneState()
      .then(() => triggerDebugScenario("normal"));
  }, [resetSceneState, triggerDebugScenario]);

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
    kitchenShared,
    live.connection,
    liveActive,
    liveRuntime?.sessionId,
    scene,
    startDemoConversation,
  ]);

  const contactEmergency = live.confirmAlarm;

  useEffect(() => {
    function onKeyDown(event) {
      if (["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) return;
      if (/^[1-4]$/.test(event.key)) selectScene(DEMO_SCENES[Number(event.key) - 1].id);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectScene]);

  async function enterFullscreen() {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    else await document.exitFullscreen?.();
  }

  return (
    <main className={`typical-demo scene-tone-${scene.tone}`}>
      <video ref={videoRef} className="capture-video" autoPlay muted playsInline aria-hidden="true" />

      <header className="demo-topbar">
        <div className="brand-lockup">
          <span className="reme-word">Reme</span>
          <div><h1>Reme 家庭关怀演示</h1><p>在本地理解日常状态，需要时再主动询问并提醒家人</p></div>
        </div>
        <div className="topbar-actions">
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
          <span
            className={`camera-health live-link-health status-${linkHealth.state}`}
            title={linkHealth.detail}
          >
            {linkHealth.label}
          </span>
          <Button variant="outlined" startIcon={<FullscreenRoundedIcon />} onClick={enterFullscreen}>进入全屏</Button>
        </div>
      </header>

      <nav className="scene-tabs" aria-label="选择典型演示场景">
        {DEMO_SCENES.map((item, index) => (
          <button
            type="button"
            key={item.id}
            className={sceneId === item.id ? "is-active" : ""}
            onClick={() => selectScene(item.id)}
          >
            <small>0{index + 1}</small>
            <span>{item.nav.replace(/^场景.：/, "")}</span>
            <kbd>{index + 1}</kbd>
          </button>
        ))}
      </nav>

      <div className="demo-workspace">
        <DevicePanel
          scene={scene}
          canvasRef={deviceCanvasRef}
          camera={cameraState}
          viewMode={deviceViewMode}
        />

        <div className="sync-rail" aria-hidden="true">
          <span /><i /><span />
          <b>实时同步</b>
        </div>

        <ChildPhone
          scene={scene}
          fallPhase={effectivePhase}
          fallStateOverride={liveActive ? live.fallState : null}
          emergencyNote={liveActive ? live.emergencyNote : null}
          kitchenShared={kitchenShared}
          kitchenNotification={kitchenNotification}
          canvasRef={phoneCanvasRef}
          camera={cameraState}
          viewMode={phoneViewMode}
          familyViewOpen={effectiveFamilyViewOpen}
          autoFamilyViewOpen={autoFamilyViewOpen}
          familyVideoAllowed={live.familyVideoAllowed}
          onToggleFamilyView={() => setFamilyViewOpen((current) => !current)}
          onContact={contactEmergency}
          onSafe={markSafe}
        />
      </div>

      <AcceptanceControls
        scene={scene}
        live={live}
        onTriggerFall={() => requestManualScenario("fall", "fall")}
        onReset={resetAcceptance}
      />

      <RuntimeDebugPanel camera={cameraState} live={live} scene={scene} />

      <footer className="demo-footer">
        <button type="button" onClick={resetAcceptance}><RestartAltRoundedIcon />重新开始当前场景</button>
      </footer>
    </main>
  );
}
