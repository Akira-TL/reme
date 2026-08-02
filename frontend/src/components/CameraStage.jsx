import { Button, CircularProgress, IconButton } from "@mui/material";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import { usePoseLandmarker } from "../hooks/usePoseLandmarker";

export function CameraStage({ visible, onHide }) {
  const { videoRef, canvasRef, personDetected, status, retry } = usePoseLandmarker();

  return (
    <section className={`camera-stage ${visible ? "" : "is-hidden"}`} aria-label="本地实时姿态画面">
      <video ref={videoRef} autoPlay muted playsInline aria-hidden="true" />
      <canvas ref={canvasRef} aria-label="实时 17 节点火柴人" />

      <div className="stage-pill stage-pill-live">
        <i aria-hidden="true" />
        <b>LIVE</b>
        <WifiRoundedIcon sx={{ fontSize: 17 }} />
        <b>{status.connection}</b>
      </div>
      <div className="stage-pill stage-pill-local">
        <ShieldOutlinedIcon sx={{ fontSize: 17 }} />
        <b>本地处理</b>
      </div>

      <IconButton className="stage-privacy" onClick={onHide} aria-label="隐藏实时摄像头画面">
        <VisibilityOffRoundedIcon fontSize="small" />
      </IconButton>

      {status.visible && (
        <div className="camera-message" role="status" aria-live="polite">
          {!status.retryable && <CircularProgress size={24} sx={{ color: "#ff6900", mb: 0.5 }} />}
          <strong>{status.title}</strong>
          <small>{status.hint}</small>
          {status.retryable && (
            <Button size="small" variant="contained" onClick={retry} sx={{ mt: 1, borderRadius: 999 }}>
              允许并重试
            </Button>
          )}
        </div>
      )}

      {personDetected && <div className="person-badge">已转换为 17 节点火柴人</div>}
    </section>
  );
}
