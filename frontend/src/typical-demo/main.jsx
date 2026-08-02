import { createRoot } from "react-dom/client";
import { CssBaseline, ThemeProvider } from "@mui/material";
import { theme } from "../theme";
import { TypicalDemoApp } from "./TypicalDemoApp";
import "./typical-demo.css";

createRoot(document.getElementById("typical-demo-root")).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <TypicalDemoApp />
  </ThemeProvider>,
);
