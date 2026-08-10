import LockRoundedIcon from "@mui/icons-material/LockRounded";
import SensorsRoundedIcon from "@mui/icons-material/SensorsRounded";
import VideocamOffRoundedIcon from "@mui/icons-material/VideocamOffRounded";
import { useEffect, useRef } from "react";
import {
  advancePosePresentation,
} from "../runtime/viewer/posePresentation.js";
import { createPoseCanvasRuntime } from "../runtime/viewer/poseCanvasRuntime.js";

const SCENE_IMAGES = Object.freeze({
  living: "/scenes/living-room.jpg",
  kitchen: "/scenes/kitchen.jpg",
  bathroom: "/scenes/bathroom.jpg",
  fall: "/scenes/living-room.jpg",
});

export function SkeletonStage({
  sceneId,
  pose,
  lastDetectedPose,
  runtimeSessionId,
  videoRef,
  mediaStatus,
  revealVideo,
  highPrivacyEnabled,
  grant,
  localNowMs,
  relayConnected,
  runtimeStatus,
  onRetryPlayback,
}) {
  const canvasRef = useRef(null);
  const canvasRuntimeRef = useRef(null);
  const presentation = advancePosePresentation({
    previous: {
      runtimeSessionId: lastDetectedPose?.runtime_session_id || runtimeSessionId,
      lastGoodPose: lastDetectedPose,
    },
    pose,
    runtimeSessionId,
    localNowMs,
    authorityAvailable: relayConnected,
  });
  const visiblePose = presentation.visiblePose;
  const frameFresh = Boolean(visiblePose);
  const videoLive = revealVideo && mediaStatus === "live";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || videoLive) return undefined;
    const runtime = createPoseCanvasRuntime({ canvas });
    canvasRuntimeRef.current = runtime;
    return () => {
      if (canvasRuntimeRef.current === runtime) canvasRuntimeRef.current = null;
      runtime.dispose();
    };
  }, [videoLive]);

  useEffect(() => {
    if (!videoLive) canvasRuntimeRef.current?.render(visiblePose);
  }, [videoLive, visiblePose]);

  const modeCopy = (() => {
    if (sceneId === "bathroom") return "浴室硬隐私 · 仅同步匿名骨架";
    if (grant && highPrivacyEnabled) return "高隐私显示已隐藏授权原画";
    if (videoLive) return "事件授权原画 · 到期自动关闭";
    if (grant && mediaStatus === "failed") return "原画连接失败 · 已回退匿名骨架";
    if (grant) return "事件授权已生效 · 原画连接中";
    if (!frameFresh) return "等待当前运行时的可靠骨架";
    if (presentation.mode === "held") return "骨架短时保持 · 非新的识别结果";
    return pose.landmark_quality === "degraded" ? "骨架质量较低 · 未补造画面" : "本地处理 · 仅同步匿名骨架";
  })();

  return (
    <section className={`viewer-stage scene-${sceneId || "unavailable"} ${videoLive ? "has-video" : ""}`} aria-label="外婆家实时状态">
      {SCENE_IMAGES[sceneId] && <img className="viewer-stage-environment" src={SCENE_IMAGES[sceneId]} alt="" />}
      <video
        ref={videoRef}
        data-testid="authorized-event-video"
        className={`viewer-stage-video ${videoLive ? "is-visible" : ""}`}
        autoPlay
        playsInline
        muted
        aria-label="事件期临时授权现场画面"
        onClick={mediaStatus === "failed" ? onRetryPlayback : undefined}
      />
      {!videoLive && <canvas ref={canvasRef} data-testid="family-pose-canvas" className="viewer-stage-pose" aria-label="实时匿名骨架" />}
      {sceneId === "bathroom" && <div className="viewer-privacy-veil" aria-hidden="true" />}
      <div className={`stage-connection-pill ${relayConnected ? "is-connected" : "is-waiting"}`}>
        <span /> {relayConnected ? "LIVE · 已连接" : "WAITING · 等待连接"}
      </div>
      <div className="stage-local-pill"><LockRoundedIcon /> {runtimeStatus === "ready" ? "本地处理" : "能力未就绪"}</div>
      <div className="stage-mode-pill">
        {sceneId === "bathroom"
          ? <LockRoundedIcon />
          : videoLive ? <SensorsRoundedIcon /> : <VideocamOffRoundedIcon />}
        {modeCopy}
      </div>
    </section>
  );
}
