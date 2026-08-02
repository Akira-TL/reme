import { SceneViewport } from "./SceneViewport";

export function DevicePanel({ scene, canvasRef, camera, viewMode }) {
  return (
    <section className={`device-panel tone-${scene.tone}`} aria-label="老人端实时画面">
      <header className="panel-heading device-panel-heading-simple">
        <div>
          <span>老人端实时画面</span>
          <h2>{scene.title}</h2>
        </div>
      </header>

      <SceneViewport
        sceneId={scene.id}
        canvasRef={canvasRef}
        cameraReady={camera.cameraReady}
        viewMode={viewMode}
        segmentationReady={camera.segmentationReady}
        skeletonSource={camera.skeletonSource}
        showStatus={false}
      />

      {camera.error && (
        <button className="camera-error" type="button" onClick={camera.retry}>
          {camera.error} · 点击重试
        </button>
      )}
    </section>
  );
}
