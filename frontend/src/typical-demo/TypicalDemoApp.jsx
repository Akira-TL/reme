import FullscreenRoundedIcon from "@mui/icons-material/FullscreenRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AcceptanceControls } from "./AcceptanceControls";
import { ChildPhone } from "./ChildPhone";
import { DevicePanel } from "./DevicePanel";
import { RuntimeDebugPanel } from "./RuntimeDebugPanel";
import { DEMO_SCENES } from "./scenes";
import { useFallLiveLink } from "./useFallLiveLink";
import { useLiveDemoCamera } from "./useLiveDemoCamera";

export function TypicalDemoApp() {
  const [sceneId, setSceneId] = useState("fall");
  const [fallPhase, setFallPhase] = useState("idle");
  const [kitchenShared, setKitchenShared] = useState(false);
  const [familyViewOpen, setFamilyViewOpen] = useState(false);
  const [videoElement, setVideoElement] = useState(null);
  const [pendingScenario, setPendingScenario] = useState(null);
  const timersRef = useRef([]);
  const sendLandmarksRef = useRef(null);

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
  const effectivePhase = sceneId === "fall" && live.active ? live.phase : fallPhase;
  const deviceViewMode = sceneId === "bathroom" ? "skeleton" : "video_skeleton";
  const phoneViewMode = familyViewOpen && live.familyVideoAllowed
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
    modelReady,
    segmentationReady,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    error: cameraError,
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
    modelReady,
    segmentationReady,
    personDetected,
    backendSkeletonActive,
    skeletonSource,
    error: cameraError,
    retry: retryCamera,
  }), [
    backendSkeletonActive,
    cameraError,
    cameraReady,
    modelReady,
    personDetected,
    retryCamera,
    segmentationReady,
    skeletonSource,
  ]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const selectScene = useCallback((nextScene) => {
    clearTimers();
    setSceneId(nextScene);
    setFallPhase("idle");
    setKitchenShared(false);
    setFamilyViewOpen(false);
  }, [clearTimers]);

  const startFall = useCallback(() => {
    clearTimers();
    setFallPhase("candidate");
    navigator.vibrate?.([80, 50, 80]);
    timersRef.current = [
      window.setTimeout(() => setFallPhase("checking"), 2200),
      window.setTimeout(() => {
        setFallPhase("emergency");
        navigator.vibrate?.([180, 80, 180]);
      }, 5600),
    ];
  }, [clearTimers]);

  const markSafe = useCallback(() => {
    if (live.active) {
      live.respondSafe();
      return;
    }
    clearTimers();
    setFallPhase("idle");
  }, [clearTimers, live]);

  const requestManualScenario = useCallback((scenario, targetScene) => {
    if (!live.active) return;
    if (sceneId !== targetScene) {
      setPendingScenario({ scenario, targetScene });
      selectScene(targetScene);
      return;
    }
    live.triggerDebugScenario(scenario);
  }, [live.active, live.triggerDebugScenario, sceneId, selectScene]);

  const resetAcceptance = useCallback(() => {
    clearTimers();
    setFallPhase("idle");
    setPendingScenario(null);
    live.resetSceneState()
      .then(() => live.triggerDebugScenario("normal"));
  }, [clearTimers, live.resetSceneState, live.triggerDebugScenario]);

  useEffect(() => {
    if (
      !pendingScenario
      || sceneId !== pendingScenario.targetScene
      || !live.active
      || !live.runtime?.sessionId
    ) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (live.triggerDebugScenario(pendingScenario.scenario)) {
        setPendingScenario(null);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    live.active,
    live.runtime?.sessionId,
    live.triggerDebugScenario,
    pendingScenario,
    sceneId,
  ]);

  const contactEmergency = useCallback(() => {
    if (live.active) {
      live.confirmAlarm();
      return;
    }
    clearTimers();
    setFallPhase("contacting");
    timersRef.current = [window.setTimeout(() => setFallPhase("resolved"), 2400)];
  }, [clearTimers, live]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    function onKeyDown(event) {
      if (["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) return;
      if (/^[1-4]$/.test(event.key)) selectScene(DEMO_SCENES[Number(event.key) - 1].id);
      if (event.code === "Space" && sceneId === "fall" && fallPhase === "idle" && !live.active) {
        event.preventDefault();
        startFall();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [fallPhase, live.active, sceneId, selectScene, startFall]);

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
          <div><h1>ABC 单机实时演示</h1><p>A 感知、B 决策与家属端在同一台电脑联动</p></div>
        </div>
        <div className="topbar-actions">
          <span className={`camera-health ${cameraReady ? "is-online" : ""}`}>
            <VideocamRoundedIcon />{cameraReady ? "摄像头已连接" : "摄像头连接中"}
          </span>
          <span className={`camera-health live-link-health ${live.active ? "is-online" : ""}`}>
            {live.active ? "ABC 链路已接入" : "等待 ABC 链路"}
          </span>
          <Button variant="outlined" startIcon={<FullscreenRoundedIcon />} onClick={enterFullscreen}>全屏演示</Button>
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
          fallPhase={effectivePhase}
          fallStateOverride={live.active ? live.fallState : null}
          liveActive={live.active}
          kitchenShared={kitchenShared}
          canvasRef={deviceCanvasRef}
          camera={cameraState}
          viewMode={deviceViewMode}
          onShare={() => setKitchenShared(true)}
          onStartFall={startFall}
          onSafe={markSafe}
          onResetFall={markSafe}
        />

        <div className="sync-rail" aria-hidden="true">
          <span /><i /><span />
          <b>实时同步</b>
        </div>

        <ChildPhone
          scene={scene}
          fallPhase={effectivePhase}
          fallStateOverride={live.active ? live.fallState : null}
          emergencyNote={live.active ? live.emergencyNote : null}
          kitchenShared={kitchenShared}
          canvasRef={phoneCanvasRef}
          camera={cameraState}
          viewMode={phoneViewMode}
          familyViewOpen={familyViewOpen}
          familyVideoAllowed={live.familyVideoAllowed}
          onToggleFamilyView={() => setFamilyViewOpen((current) => !current)}
          onContact={contactEmergency}
          onSafe={markSafe}
        />
      </div>

      <AcceptanceControls
        scene={scene}
        live={live}
        onTrigger={requestManualScenario}
        onReset={resetAcceptance}
      />

      <RuntimeDebugPanel camera={cameraState} live={live} scene={scene} />

      <footer className="demo-footer">
        <span><b>老人端</b> 非浴室场景显示本机原视频与 A 返回骨架叠加</span>
        <span><b>家属端</b> 默认仅骨架，主动查看且隐私策略允许时才显示原视频</span>
        <button type="button" onClick={() => selectScene(sceneId)}><RestartAltRoundedIcon />重置当前场景</button>
      </footer>
    </main>
  );
}
