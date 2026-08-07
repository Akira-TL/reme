import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  palette: {
    primary: { main: "#ff5a00", dark: "#e54f00", light: "#fff0e5" },
    success: { main: "#239a34" },
    error: { main: "#ff3b30" },
    background: { default: "#ecebea", paper: "#ffffff" },
  },
  typography: {
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Helvetica Neue", sans-serif',
    button: { textTransform: "none", fontWeight: 700 },
  },
  shape: { borderRadius: 14 },
  components: {
    MuiButton: { defaultProps: { disableElevation: true } },
  },
});
