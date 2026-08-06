import { CssBaseline, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { theme } from "./theme";
import { TypicalDemoApp } from "./typical-demo/TypicalDemoApp";
import "./typical-demo/typical-demo.css";

if (window.location.pathname !== "/") {
  const canonicalUrl = new URL(window.location.href);
  canonicalUrl.pathname = "/";
  window.history.replaceState(null, "", `${canonicalUrl.pathname}${canonicalUrl.search}${canonicalUrl.hash}`);
}

createRoot(document.getElementById("root")).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <TypicalDemoApp />
  </ThemeProvider>,
);
