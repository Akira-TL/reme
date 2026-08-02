import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { theme } from "../theme";
import { ViewerApp } from "./ViewerApp";
import "./viewer.css";

createRoot(document.getElementById("viewer-root")).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <ViewerApp />
  </ThemeProvider>,
);
