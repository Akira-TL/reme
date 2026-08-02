import { CameraStage } from "./CameraStage";
import { Hotspot } from "./Hotspot";

export function HomeScreen({ active, scene, cameraVisible, onOpenScenes, onToggleCamera, onHideCamera, onOpenStatus }) {
  return (
    <section className={`screen ${active ? "is-active" : ""}`} aria-label="首页">
      <img className="screen-art" src={scene.image} alt={`Reme 首页 · ${scene.name}`} draggable="false" />
      <CameraStage visible={active && scene.camera && cameraVisible} onHide={onHideCamera} />
      <Hotspot className="home-title-hotspot" label="切换演示场景" onClick={onOpenScenes} />
      <Hotspot className="device-hotspot" label="切换实时摄像头" onClick={onToggleCamera} />
      <Hotspot className="home-card-hotspot" label="查看当前状态详情" onClick={onOpenStatus} />
    </section>
  );
}
