import {
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from "@mui/material";
import CheckRoundedIcon from "@mui/icons-material/CheckRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import PrivacyTipRoundedIcon from "@mui/icons-material/PrivacyTipRounded";
import SoupKitchenRoundedIcon from "@mui/icons-material/SoupKitchenRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import { SCENES } from "../data/content";

const ICONS = {
  home: HomeRoundedIcon,
  cooking: SoupKitchenRoundedIcon,
  privacy: PrivacyTipRoundedIcon,
  risk: WarningAmberRoundedIcon,
};

export function SceneDrawer({ open, currentScene, onClose, onSelect }) {
  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      ModalProps={{ keepMounted: true }}
      slotProps={{ paper: { sx: { borderRadius: "28px 28px 0 0", maxWidth: 460, mx: "auto", p: 2.25 } } }}
    >
      <Box className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-300" />
      <Box className="mb-3 flex items-start justify-between">
        <Box>
          <Typography variant="overline" color="primary" fontWeight={800}>HOME SCENES</Typography>
          <Typography variant="h5" fontWeight={800}>切换演示场景</Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="关闭场景选择"><CloseRoundedIcon /></IconButton>
      </Box>
      <List className="grid gap-2 p-0">
        {Object.entries(SCENES).map(([key, scene]) => {
          const SceneIcon = ICONS[scene.icon];
          const selected = key === currentScene;
          return (
            <ListItemButton
              key={key}
              selected={selected}
              onClick={() => onSelect(key)}
              sx={{ border: "1px solid", borderColor: selected ? "primary.main" : "rgba(255,105,0,.13)", borderRadius: 3.5, bgcolor: "#fffaf6", py: 1.2 }}
            >
              <ListItemIcon sx={{ minWidth: 52, color: "primary.main" }}>
                <Box className="grid h-11 w-11 place-items-center rounded-2xl bg-orange-50"><SceneIcon /></Box>
              </ListItemIcon>
              <ListItemText primary={scene.name} secondary={scene.detail} slotProps={{ primary: { fontWeight: 700 } }} />
              {selected && <CheckRoundedIcon color="primary" />}
            </ListItemButton>
          );
        })}
      </List>
    </Drawer>
  );
}
