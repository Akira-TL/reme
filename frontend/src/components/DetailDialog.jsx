import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, Typography } from "@mui/material";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";

export function DetailDialog({ open, content, onClose, onPrimary }) {
  if (!content) return null;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs" slotProps={{ paper: { sx: { borderRadius: 5, m: 2 } } }}>
      <DialogTitle sx={{ pr: 6 }}>
        <Typography variant="overline" color="primary" fontWeight={800}>{content.eyebrow || "PRIVACY BY DESIGN"}</Typography>
        <Typography variant="h5" fontWeight={800}>{content.title}</Typography>
        <IconButton onClick={onClose} aria-label="关闭" sx={{ position: "absolute", right: 12, top: 12 }}><CloseRoundedIcon /></IconButton>
      </DialogTitle>
      <DialogContent>
        <Alert icon={<ShieldOutlinedIcon />} severity="info" sx={{ bgcolor: "#fff7f0", color: "text.primary", border: "1px solid rgba(255,105,0,.14)" }}>
          {content.body}
        </Alert>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 3 }}>
        <Button onClick={onClose} variant="outlined" fullWidth>稍后再看</Button>
        <Button onClick={onPrimary} variant="contained" fullWidth>{content.action || "发起一次关怀"}</Button>
      </DialogActions>
    </Dialog>
  );
}
