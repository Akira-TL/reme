import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";

export function SceneViewport({
  sceneId,
  backgroundImage,
  aspectRatio,
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
    <div
      className={`scene-viewport scene-${sceneId} ${backgroundImage ? "has-scene-background" : ""} ${compact ? "is-compact" : ""}`}
      style={{
        "--scene-background": backgroundImage ? `url(${backgroundImage})` : "none",
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
                ? "浴室仅显示姿态"
                : viewMode === "video_skeleton"
                  ? `${skeletonSource === "a_backend" ? "实时姿态" : "本地姿态"} + 现场画面`
                  : viewMode === "video"
                    ? (segmentationReady ? "人物轮廓画面" : "现场画面")
                    : skeletonSource === "a_backend" ? "实时姿态画面" : "本地姿态画面"}
            </span>
          </div>
        </>
      )}
      {night && <div className="night-time">23:47</div>}
      {privacy && <div className="privacy-curtain"><span>隐私幕布</span></div>}
    </div>
  );
}
