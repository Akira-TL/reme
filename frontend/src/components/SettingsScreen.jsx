import { Switch } from "@mui/material";
import { APP_IMAGES, SETTINGS_HOTSPOTS } from "../data/content";
import { Hotspot } from "./Hotspot";

const switchSx = {
  p: 0,
  width: "100%",
  height: "100%",
  "& .MuiSwitch-switchBase": {
    p: "5%",
    "&.Mui-checked": {
      transform: "translateX(82%)",
      color: "#fff",
      "+ .MuiSwitch-track": { backgroundColor: "#ff5a00", opacity: 1 },
    },
  },
  "& .MuiSwitch-thumb": { width: "90%", height: "90%", boxShadow: "0 1px 4px rgba(0,0,0,.2)" },
  "& .MuiSwitch-track": { borderRadius: 999, backgroundColor: "#dedee3", opacity: 1 },
};

export function SettingsScreen({ active, privacyOn, mimoOn, onTogglePrivacy, onToggleMimo, onOpenDetail }) {
  return (
    <section className={`screen ${active ? "is-active" : ""}`} aria-label="设置">
      <img className="screen-art" src={APP_IMAGES.settings} alt="Reme 设置" draggable="false" />
      {SETTINGS_HOTSPOTS.map(([key, className, label]) => (
        <Hotspot key={key} className={className} label={label} onClick={() => onOpenDetail(key)} />
      ))}

      <div className="mui-switch settings-privacy-switch">
        <Switch checked={privacyOn} onChange={onTogglePrivacy} slotProps={{ input: { "aria-label": "自动隐私保护" } }} sx={switchSx} />
      </div>
      <div className="mui-switch settings-mimo-switch">
        <Switch checked={mimoOn} onChange={onToggleMimo} slotProps={{ input: { "aria-label": "MiMo 主动关怀" } }} sx={switchSx} />
      </div>
    </section>
  );
}
