import { ButtonBase } from "@mui/material";

export function Hotspot({ className, label, onClick, children }) {
  return (
    <ButtonBase className={`hotspot ${className}`} aria-label={label} onClick={onClick} disableRipple>
      {children}
    </ButtonBase>
  );
}
