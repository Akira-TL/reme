import { APP_IMAGES } from "../data/content";
import { Hotspot } from "./Hotspot";

export function EmergencyOverlay({ open, onClose, onCall, onLive, onContact }) {
  if (!open) return null;
  return (
    <section className="emergency-layer" aria-label="紧急提醒" role="dialog" aria-modal="true">
      <img src={APP_IMAGES.emergency} alt="检测到异常姿态紧急提醒" draggable="false" />
      <Hotspot className="emergency-close" label="关闭提醒" onClick={onClose} />
      <Hotspot className="emergency-call" label="立即呼叫外婆" onClick={onCall} />
      <Hotspot className="emergency-live" label="查看实时状态" onClick={onLive} />
      <Hotspot className="emergency-contact" label="联系紧急联系人" onClick={onContact} />
    </section>
  );
}
