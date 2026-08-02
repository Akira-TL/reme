import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";

export function SceneViewport({
  sceneId,
  canvasRef,
  cameraReady,
  viewMode,
  segmentationReady,
  skeletonSource = "c_local",
  compact = false,
  showStatus = true,
}) {
  const privacy = sceneId === "bathroom";
  const night = sceneId === "fall";

  return (
    <div className={`scene-viewport scene-${sceneId} ${compact ? "is-compact" : ""}`}>
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
        aria-label={viewMode === "video_skeleton" ? "实时原视频与后端骨架叠加" : "实时火柴人骨架"}
      />

      {showStatus && (
        <>
          <div className="viewport-pill viewport-live">
            <span className={cameraReady ? "live-dot" : "live-dot is-waiting"} />
            <b>{cameraReady ? "LIVE" : "WAITING"}</b>
            <WifiRoundedIcon />
            <span>{cameraReady ? "已连接" : "连接中"}</span>
          </div>
          <div className="viewport-pill viewport-privacy">
            <LockOutlinedIcon />
            <span>
              {privacy
                ? "浴室仅骨架"
                : viewMode === "video_skeleton"
                  ? `${skeletonSource === "a_backend" ? "A 骨架" : "C 后备骨架"} + 原视频`
                  : viewMode === "video"
                    ? (segmentationReady ? "人物抠像" : "原画降级")
                    : skeletonSource === "a_backend" ? "A 返回骨架" : "C 本地后备"}
            </span>
          </div>
        </>
      )}
      {night && <div className="night-time">23:47</div>}
      {privacy && <div className="privacy-curtain"><span>隐私幕布</span></div>}
    </div>
  );
}
