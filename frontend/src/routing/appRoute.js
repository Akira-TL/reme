const APP_PATHS = Object.freeze({
  "/home": "home",
  "/family": "family",
  "/debug": "debug",
});

const LEGACY_REDIRECTS = Object.freeze({
  "/": "/home",
  "/index.html": "/home",
  "/viewer.html": "/family",
  "/typical-demo.html": "/debug",
});

function withoutSingleTrailingSlash(pathname) {
  if (
    pathname.length > 1
    && pathname.endsWith("/")
    && !pathname.endsWith("//")
  ) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

export function resolveAppRoute(pathname) {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    return Object.freeze({ type: "not_found" });
  }

  const pathWithoutTrailingSlash = withoutSingleTrailingSlash(pathname);
  const redirectPath = LEGACY_REDIRECTS[pathWithoutTrailingSlash];
  if (redirectPath) {
    return Object.freeze({ type: "redirect", pathname: redirectPath });
  }

  const app = APP_PATHS[pathWithoutTrailingSlash];
  if (!app) return Object.freeze({ type: "not_found" });
  if (pathWithoutTrailingSlash !== pathname) {
    return Object.freeze({ type: "redirect", pathname: pathWithoutTrailingSlash });
  }
  return Object.freeze({ type: "app", app });
}
