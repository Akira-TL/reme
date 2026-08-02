import { SceneViewport } from "./SceneViewport";

export function DevicePanel({ scene, canvasRef, camera, viewMode }) {
  return (
    <section className={`device-panel tone-${scene.tone}`} aria-label="家中实时画面">
      <header className="panel-heading device-panel-heading-simple">
        <div>
          <span>家中实时画面</span>
          <h2>{scene.title}</h2>
        </div>
      </header>

      <SceneViewport
        sceneId={scene.id}
        backgroundImage={scene.backgroundImage}
        aspectRatio={camera.aspectRatio}
        canvasRef={canvasRef}
        cameraReady={camera.cameraReady}
        viewMode={viewMode}
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
