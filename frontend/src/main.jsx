import { CssBaseline, ThemeProvider } from "@mui/material";
import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { getPublicRuntimeConfig } from "./config/publicRuntimeConfig.js";
import { resolveAppRoute } from "./routing/appRoute.js";
import "./routing/routeShell.css";
import { theme } from "./theme";

const ROUTE_APPS = Object.freeze({
  home: lazy(() => import("./apps/home/HomeApp.jsx")),
  family: lazy(() => import("./apps/family/FamilyApp.jsx")),
  debug: lazy(() => import("./apps/debug/DebugApp.jsx")),
});

const ROUTE_TITLES = Object.freeze({
  home: "Reme · 居家端",
  family: "Reme · 家属端",
  debug: "Reme · 调试前端",
});

function resolveCurrentRoute() {
  const initial = resolveAppRoute(window.location.pathname);
  if (initial.type !== "redirect") return initial;

  const canonicalUrl = new URL(window.location.href);
  canonicalUrl.pathname = initial.pathname;
  window.history.replaceState(null, "", `${canonicalUrl.pathname}${canonicalUrl.search}${canonicalUrl.hash}`);
  return resolveAppRoute(initial.pathname);
}

const routeLoading = (
  <main data-app-role="loading" aria-busy="true" aria-live="polite">
    正在加载 Reme…
  </main>
);

const notFound = (
  <main data-app-role="not-found">
    <p>404</p>
    <h1>页面不存在</h1>
    <a href="/home">返回居家端</a>
  </main>
);

function resolveRuntimeConfigError() {
  try {
    getPublicRuntimeConfig();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "公开运行配置无法读取";
  }
}

const runtimeConfigError = resolveRuntimeConfigError();
const invalidRuntimeConfig = runtimeConfigError ? (
  <main data-app-role="configuration-error" role="alert">
    <p>CONFIGURATION ERROR</p>
    <h1>Reme 公开运行配置无效</h1>
    <span>{runtimeConfigError}</span>
  </main>
) : null;

const route = resolveCurrentRoute();
const RouteApp = route.type === "app" ? ROUTE_APPS[route.app] : null;
if (route.type === "app") document.title = ROUTE_TITLES[route.app];

createRoot(document.getElementById("root")).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    {invalidRuntimeConfig || (RouteApp ? (
      <Suspense fallback={routeLoading}>
        <RouteApp />
      </Suspense>
    ) : notFound)}
  </ThemeProvider>,
);
