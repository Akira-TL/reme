import { CssBaseline, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { theme } from "../theme.js";
import { ViewerApp } from "./ViewerApp.jsx";
import "./viewer.css";

createRoot(document.getElementById("root")).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <ViewerApp />
  </ThemeProvider>,
);
