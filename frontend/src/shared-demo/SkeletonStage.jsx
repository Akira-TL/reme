import LockRoundedIcon from "@mui/icons-material/LockRounded";
import SensorsRoundedIcon from "@mui/icons-material/SensorsRounded";
import VideocamOffRoundedIcon from "@mui/icons-material/VideocamOffRounded";
import { useEffect, useRef } from "react";
import { isPoseFresh } from "./viewerState.js";

const EDGES = Object.freeze([
  [0, 1], [0, 2], [1, 3], [2, 4],
  [5, 6], [5, 7], [7, 9], [6, 8], [8, 10],
  [5, 11], [6, 12], [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
]);

const SCENE_IMAGES = Object.freeze({
  living: "/scenes/living-room.jpg",
  kitchen: "/scenes/kitchen.jpg",
  bathroom: "/scenes/bathroom.jpg",
  fall: "/scenes/living-room.jpg",
});

function drawPose(canvas, frame) {
  const bounds = canvas.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(bounds.width * ratio));
  const height = Math.max(1, Math.round(bounds.height * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  if (!frame?.person_detected) return;
  const points = frame.keypoints;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#ff5a00";
  context.lineWidth = Math.max(3, width * 0.007);
  for (const [start, end] of EDGES) {
    if (points[start]?.score < 0.2 || points[end]?.score < 0.2) continue;
    context.beginPath();
    context.moveTo(points[start].x * width, points[start].y * height);
    context.lineTo(points[end].x * width, points[end].y * height);
    context.stroke();
  }
  for (const point of points) {
    if (point.score < 0.2) continue;
    context.beginPath();
    context.arc(point.x * width, point.y * height, Math.max(4, width * 0.012), 0, Math.PI * 2);
    context.fillStyle = "#ffffff";
    context.fill();
    context.lineWidth = Math.max(2, width * 0.004);
    context.strokeStyle = "#ff5a00";
    context.stroke();
  }
}

export function SkeletonStage({
  sceneId,
  pose,
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
  const frameFresh = isPoseFresh(pose, localNowMs);
  const visiblePose = frameFresh ? pose : null;
  const videoLive = revealVideo && mediaStatus === "live";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    drawPose(canvas, visiblePose);
    const observer = new ResizeObserver(() => drawPose(canvas, visiblePose));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [visiblePose]);

  const modeCopy = (() => {
    if (sceneId === "bathroom") return "浴室硬隐私 · 仅同步匿名骨架";
    if (grant && highPrivacyEnabled) return "高隐私显示已隐藏授权原画";
    if (videoLive) return "事件授权原画 · 到期自动关闭";
    if (grant && mediaStatus === "failed") return "原画连接失败 · 已回退匿名骨架";
    if (grant) return "事件授权已生效 · 原画连接中";
    if (!frameFresh) return "等待当前运行时的可靠骨架";
    return pose.landmark_quality === "degraded" ? "骨架质量较低 · 未补造画面" : "本地处理 · 仅同步匿名骨架";
  })();

  return (
    <section className={`viewer-stage scene-${sceneId} ${videoLive ? "has-video" : ""}`} aria-label="外婆家实时状态">
      <img className="viewer-stage-environment" src={SCENE_IMAGES[sceneId]} alt="" />
      <video
        ref={videoRef}
        className={`viewer-stage-video ${videoLive ? "is-visible" : ""}`}
        autoPlay
        playsInline
        muted
        aria-label="事件期临时授权现场画面"
        onClick={mediaStatus === "failed" ? onRetryPlayback : undefined}
      />
      {!videoLive && <canvas ref={canvasRef} className="viewer-stage-pose" aria-label="实时匿名骨架" />}
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
