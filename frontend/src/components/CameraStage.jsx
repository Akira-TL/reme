import { Button, CircularProgress, IconButton } from "@mui/material";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import { useEffect } from "react";
import { describePosture } from "../adapters/perception";
import { usePoseLandmarker } from "../hooks/usePoseLandmarker";

export function CameraStage({ visible, onHide, runtime, externalFrame, posture, onVideoElement, onRetryRuntime }) {
  const { videoRef, canvasRef, personDetected, status, retry } = usePoseLandmarker(externalFrame);
  const runtimeLabel = runtime.state === "running"
    ? `A已接入${posture?.posture ? ` · ${describePosture(posture.posture)}` : ""}`
    : ({
        starting: "A启动中",
        input_unavailable: "A输入待接入",
        degraded: "A服务降级",
        stopped: "A已停止",
        offline: "本地后备",
      })[runtime.state] || "本地后备";

  useEffect(() => {
    onVideoElement?.(videoRef.current);
    return () => onVideoElement?.(null);
  }, [onVideoElement, videoRef]);

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

      <button
        type="button"
        className={`runtime-badge runtime-${runtime.state}`}
        title={runtime.reason || runtimeLabel}
        aria-label={`${runtimeLabel}。${runtime.state === "running" ? "" : "点击重试"}`}
        onClick={onRetryRuntime}
        disabled={["running", "starting"].includes(runtime.state)}
      >
        <i aria-hidden="true" />
        <span>{runtimeLabel}</span>
      </button>

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

      {personDetected && <div className="person-badge">{runtime.state === "running" ? "A · 17 节点火柴人" : "本地 · 17 节点火柴人"}</div>}
    </section>
  );
}
