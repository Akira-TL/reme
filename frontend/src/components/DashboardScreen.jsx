import { APP_IMAGES, DASHBOARD_HOTSPOTS } from "../data/content";
import { Hotspot } from "./Hotspot";

export function DashboardScreen({ active, onOpenDetail }) {
  return (
    <section className={`screen ${active ? "is-active" : ""}`} aria-label="关怀看板">
      <img className="screen-art" src={APP_IMAGES.dashboard} alt="Reme 关怀看板" draggable="false" />
      {DASHBOARD_HOTSPOTS.map(([key, className, label]) => (
        <Hotspot key={key} className={className} label={label} onClick={() => onOpenDetail(key)} />
      ))}
    </section>
  );
}
