export const MONITOR_HOSTNAME = "monitor.reme.maniforld.com";

export function selectSharedDemoRole({ hostname, pathname }) {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  return hostname === MONITOR_HOSTNAME || normalizedPath === "/monitor"
    ? "monitor"
    : "viewer";
}
