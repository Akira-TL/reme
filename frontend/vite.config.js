import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { env } from "node:process";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));
const runtimeProxyPath = "/_reme/runtime";
const relayProxyPath = "/_reme/relay";

function stripPrefix(prefix) {
  return (pathname) => pathname.slice(prefix.length) || "/";
}

function localProxy() {
  return {
    [runtimeProxyPath]: {
      target: env.REME_VITE_BACKEND_PROXY_TARGET || "http://127.0.0.1:8770",
      changeOrigin: false,
      ws: true,
      rewrite: stripPrefix(runtimeProxyPath),
    },
    [relayProxyPath]: {
      target: env.REME_VITE_RELAY_PROXY_TARGET || "http://127.0.0.1:8787",
      changeOrigin: false,
      ws: true,
      rewrite: stripPrefix(relayProxyPath),
    },
  };
}

function localHttps() {
  const certPath = env.REME_VITE_TLS_CERT?.trim();
  const keyPath = env.REME_VITE_TLS_KEY?.trim();
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error("REME_VITE_TLS_CERT and REME_VITE_TLS_KEY must be set together");
  }
  if (!certPath || !keyPath) return undefined;
  return {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

function allowedHosts() {
  return ["reme.babelbeast.com", env.REME_VITE_PUBLIC_HOST?.trim()]
    .filter(Boolean);
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  envDir: "..",
  build: {
    rollupOptions: {
      input: {
        monitor: `${frontendRoot}index.html`,
        viewer: `${frontendRoot}viewer.html`,
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 4174,
    allowedHosts: allowedHosts(),
    https: localHttps(),
    proxy: localProxy(),
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    allowedHosts: allowedHosts(),
    https: localHttps(),
    proxy: localProxy(),
  },
});
