import { Avatar, Box, Button, Dialog, Typography } from "@mui/material";
import PhoneDisabledRoundedIcon from "@mui/icons-material/PhoneDisabledRounded";
import { useEffect, useState } from "react";

export function CallDialog({ open, onClose }) {
  if (!open) return null;
  return <ActiveCallDialog onClose={onClose} />;
}

function ActiveCallDialog({ onClose }) {
  const [status, setStatus] = useState("等待接听…");

  useEffect(() => {
    const timer = window.setTimeout(() => setStatus("正在响铃 · 00:06"), 1600);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <Dialog
      open
      onClose={onClose}
      fullScreen
      slotProps={{ paper: { sx: { width: "min(100vw, 460px)", mx: "auto", bgcolor: "rgba(18,18,19,.96)", color: "#fff" } } }}
    >
      <Box className="flex h-full flex-col items-center justify-center px-8 text-center">
        <Avatar sx={{ width: 108, height: 108, mb: 2.5, fontSize: 44, bgcolor: "#efa96a", border: "3px solid rgba(255,255,255,.45)" }}>外</Avatar>
        <Typography color="rgba(255,255,255,.65)">正在呼叫</Typography>
        <Typography variant="h3" fontWeight={700} mt={1}>外婆</Typography>
        <Typography color="rgba(255,255,255,.75)" mt={1}>{status}</Typography>
        <Button
          onClick={onClose}
          aria-label="挂断电话"
          sx={{ mt: 10, minWidth: 72, width: 72, height: 72, borderRadius: "50%", color: "#fff", bgcolor: "#ff3b30", "&:hover": { bgcolor: "#e52d24" } }}
        >
          <PhoneDisabledRoundedIcon fontSize="large" />
        </Button>
      </Box>
    </Dialog>
  );
}
