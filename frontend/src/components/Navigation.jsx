import { BottomNavigation, BottomNavigationAction } from "@mui/material";

export function Navigation({ value, onChange }) {
  return (
    <BottomNavigation
      className="tabbar"
      value={value}
      onChange={(_, nextValue) => onChange(nextValue)}
      showLabels
      sx={{ position: "absolute", background: "transparent", zIndex: 10 }}
      aria-label="主导航"
    >
      <BottomNavigationAction className="tab-hit" label="首页" value="home" />
      <BottomNavigationAction className="tab-hit" label="看板" value="dashboard" />
      <BottomNavigationAction className="tab-hit" label="设置" value="settings" />
    </BottomNavigation>
  );
}
