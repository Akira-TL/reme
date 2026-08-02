import { Avatar, Box, Drawer, IconButton, List, ListItemButton, ListItemText, Typography } from "@mui/material";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";

const CONTACTS = [
  ["女", "女儿", "首要紧急联系人"],
  ["邻", "社区管家", "距离外婆家约 350 米"],
];

export function ContactDrawer({ open, onClose, onSelect }) {
  return (
    <Drawer anchor="bottom" open={open} onClose={onClose} slotProps={{ paper: { sx: { borderRadius: "28px 28px 0 0", maxWidth: 460, mx: "auto", p: 2.25 } } }}>
      <Box className="mb-3 flex items-start justify-between">
        <Box>
          <Typography variant="overline" color="primary" fontWeight={800}>EMERGENCY CONTACTS</Typography>
          <Typography variant="h5" fontWeight={800}>联系紧急联系人</Typography>
        </Box>
        <IconButton onClick={onClose} aria-label="关闭"><CloseRoundedIcon /></IconButton>
      </Box>
      <List className="grid gap-2 p-0">
        {CONTACTS.map(([avatar, name, detail]) => (
          <ListItemButton key={name} onClick={() => onSelect(name)} sx={{ border: "1px solid rgba(255,105,0,.13)", borderRadius: 3.5, bgcolor: "#fffaf6" }}>
            <Avatar sx={{ mr: 1.5, bgcolor: "#fff0e5", color: "primary.main" }}>{avatar}</Avatar>
            <ListItemText primary={name} secondary={detail} slotProps={{ primary: { fontWeight: 700 } }} />
            <ChevronRightRoundedIcon color="action" />
          </ListItemButton>
        ))}
      </List>
    </Drawer>
  );
}
