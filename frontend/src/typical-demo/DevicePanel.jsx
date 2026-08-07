import AccountTreeRoundedIcon from "@mui/icons-material/AccountTreeRounded";
import MemoryRoundedIcon from "@mui/icons-material/MemoryRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button } from "@mui/material";
import { SceneViewport } from "./SceneViewport";
import { describeSkeletonSource, getCameraHealth, getModelHealth } from "./runtimeStatus";

export function DevicePanel({ scene, canvasRef, camera, viewMode }) {
  const cameraHealth = getCameraHealth(camera);
  const modelHealth = getModelHealth(camera);
  const skeletonSource = describeSkeletonSource(camera.skeletonSource);

  return (
    <section className={`device-panel tone-${scene.tone}`} aria-label="家中实时画面">
      <header className="panel-heading device-panel-heading-simple">
        <div>
          <span>家中实时画面</span>
          <h2>{scene.title}</h2>
        </div>
      </header>

      <div className="device-health-strip" aria-label="家中设备运行状态">
        <span className={`device-health-badge status-${cameraHealth.state} inline-flex items-center gap-1`} title={cameraHealth.detail}>
          <VideocamRoundedIcon sx={{ fontSize: 12 }} />{cameraHealth.label}
        </span>
        <span className={`device-health-badge status-${modelHealth.state} inline-flex items-center gap-1`} title={modelHealth.detail}>
          <MemoryRoundedIcon sx={{ fontSize: 12 }} />{modelHealth.label}
        </span>
        <span className={`device-health-badge source-${camera.skeletonSource} inline-flex items-center gap-1`} title={skeletonSource}>
          <AccountTreeRoundedIcon sx={{ fontSize: 12 }} />{skeletonSource}
        </span>
      </div>

      <SceneViewport
        sceneId={scene.id}
        backgroundImage={scene.backgroundImage}
        aspectRatio={camera.aspectRatio}
        canvasRef={canvasRef}
        cameraReady={camera.cameraReady}
        cameraError={camera.cameraError}
        perceptionState={camera.perceptionState}
        inputMode={camera.inputMode}
        perceptionReason={camera.perceptionReason}
        viewMode={viewMode}
        skeletonSource={camera.skeletonSource}
        showStatus={false}
      />

      {camera.error && (
        <Button
          className="camera-error"
          color="error"
          variant="outlined"
          startIcon={<RestartAltRoundedIcon />}
          onClick={camera.retry}
        >
          {camera.error} · 点击重试
        </Button>
      )}
    </section>
  );
}
