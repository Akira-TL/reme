import FullscreenRoundedIcon from "@mui/icons-material/FullscreenRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button } from "@mui/material";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChildPhone } from "./ChildPhone";
import { DevicePanel } from "./DevicePanel";
import { DEMO_SCENES } from "./scenes";
import { useFallLiveLink } from "./useFallLiveLink";
import { useLiveDemoCamera } from "./useLiveDemoCamera";

export function TypicalDemoApp() {
  const [sceneId, setSceneId] = useState("living");
  const [fallPhase, setFallPhase] = useState("idle");
  const [kitchenShared, setKitchenShared] = useState(false);
  const [videoElement, setVideoElement] = useState(null);
  const timersRef = useRef([]);
  const sendLandmarksRef = useRef(null);

  const scene = useMemo(() => DEMO_SCENES.find((item) => item.id === sceneId), [sceneId]);
  const handleLandmarks = useCallback(
    (points, timestampMs) => sendLandmarksRef.current?.(points, timestampMs),
    [],
  );
  const live = useFallLiveLink({ enabled: sceneId === "fall", videoElement });
  const effectivePhase = live.active ? live.phase : fallPhase;
  const emergencyVideo = sceneId === "fall"
    && (live.active
      ? live.showEmergencyVideo
      : ["emergency", "contacting", "resolved"].includes(effectivePhase));
  const viewMode = sceneId === "kitchen" || emergencyVideo ? "video" : "skeleton";
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
    error: cameraError,
    retry: retryCamera,
  } = useLiveDemoCamera({ viewMode, skeletonColor, onLandmarks: handleLandmarks });

  useEffect(() => {
    setVideoElement(videoRef.current);
  }, [videoRef]);

  useEffect(() => {
    sendLandmarksRef.current = sceneId === "fall" ? live.sendLandmarks : null;
  }, [live.sendLandmarks, sceneId]);
  const cameraState = useMemo(() => ({
    cameraReady,
    modelReady,
    segmentationReady,
    personDetected,
    error: cameraError,
    retry: retryCamera,
  }), [cameraError, cameraReady, modelReady, personDetected, retryCamera, segmentationReady]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((timer) => window.clearTimeout(timer));
    timersRef.current = [];
  }, []);

  const selectScene = useCallback((nextScene) => {
    clearTimers();
    setSceneId(nextScene);
    setFallPhase("idle");
    setKitchenShared(false);
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
        // 真实决策流接管时，跌倒只能来自镜头前的动作，空格剧本让位。
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
          <div><h1>典型场景双端演示</h1><p>智能设备端与子女设备端实时联动</p></div>
        </div>
        <div className="topbar-actions">
          <span className={`camera-health ${cameraReady ? "is-online" : ""}`}><VideocamRoundedIcon />{cameraReady ? "摄像头已连接" : "摄像头连接中"}</span>
          {sceneId === "fall" && (
            <span className={`camera-health live-link-health ${live.active ? "is-online" : ""}`}>
              {live.active ? "B 决策流已接入" : "演示脚本模式"}
            </span>
          )}
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
          viewMode={viewMode}
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
          viewMode={viewMode}
          onContact={contactEmergency}
          onSafe={markSafe}
        />
      </div>

      <footer className="demo-footer">
        <span><b>现场模式</b> 摄像头帧仅在当前页面内存中处理，不默认录制</span>
        <span><b>演示控制</b> 数字键 1–4 切换场景，深夜场景按空格启动流程</span>
        <button type="button" onClick={() => selectScene(sceneId)}><RestartAltRoundedIcon />重置当前场景</button>
      </footer>
    </main>
  );
}
