import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";
import { describeSkeletonSource, getCameraHealth, getModelHealth } from "./runtimeStatus";

export function SceneViewport({
  sceneId,
  backgroundImage,
  aspectRatio,
  canvasRef,
  cameraReady,
  cameraError = "",
  modelReady = false,
  modelError = "",
  inferenceBackend = "loading",
  viewMode,
  skeletonSource = "unavailable",
  compact = false,
  showStatus = true,
}) {
  const privacy = sceneId === "bathroom";
  const night = sceneId === "fall";
  const hideEnvironment = privacy && compact;
  const hasSceneBackground = Boolean(backgroundImage) && !hideEnvironment;
  const cameraHealth = getCameraHealth({ cameraReady, cameraError });
  const modelHealth = getModelHealth({ modelReady, modelError, inferenceBackend });
  const sourceLabel = describeSkeletonSource(skeletonSource);
  const liveCode = cameraHealth.state === "online"
    ? "LIVE"
    : cameraHealth.state === "degraded" ? "ERROR" : "WAITING";

  return (
    <div
      className={`scene-viewport scene-${sceneId} ${hasSceneBackground ? "has-scene-background" : ""} ${compact ? "is-compact" : ""} ${hideEnvironment ? "is-private-compact" : ""}`}
      style={{
        "--scene-background": hasSceneBackground ? `url(${backgroundImage})` : "none",
        aspectRatio: aspectRatio || 16 / 9,
      }}
    >
      <div className="room-wall" />
      <div className="room-floor" />
      <div className="set-window"><i /><i /></div>
      <div className="set-console"><i /></div>
      <div className="set-sofa"><i /><i /></div>
      <div className="set-rug" />
      <div className="set-lamp"><i /></div>
      <div className="set-counter"><i /><i /><i /></div>
      <div className="set-cabinets"><i /><i /><i /></div>
      <div className="set-island"><i /><i /></div>
      <div className="set-shower"><i /><i /></div>
      <div className="set-tiles" />
      <div className="set-bath-shelf"><i /><i /></div>

      <canvas
        ref={canvasRef}
        className="live-output"
        aria-label={viewMode === "video_skeleton" ? "现场画面与姿态识别叠加" : "实时姿态画面"}
      />

      {showStatus && (
        <>
          <div
            className={`viewport-pill viewport-live status-${cameraHealth.state}`}
            title={cameraHealth.detail}
          >
            <span className={`live-dot is-${cameraHealth.state}`} />
            <b>{liveCode}</b>
            <WifiRoundedIcon />
            <span>{cameraHealth.label}</span>
          </div>
          <div
            className={`viewport-pill viewport-privacy status-${modelHealth.state}`}
            title={`${modelHealth.detail} · ${sourceLabel}`}
          >
            <LockOutlinedIcon />
            <span>
              {privacy
                ? `浴室仅显示姿态 · ${sourceLabel}`
                : viewMode === "video_skeleton"
                  ? `${sourceLabel} + 现场画面`
                  : viewMode === "video"
                    ? "现场画面"
                    : sourceLabel}
            </span>
          </div>
        </>
      )}
      {night && <div className="night-time">23:47</div>}
      {privacy && <div className="privacy-curtain"><span>{compact ? "浴室隐私保护" : "隐私幕布"}</span></div>}
    </div>
  );
}
