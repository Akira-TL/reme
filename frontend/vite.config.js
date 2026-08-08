import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const frontendRoot = fileURLToPath(new URL(".", import.meta.url));

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
    allowedHosts: ["reme.babelbeast.com"],
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    allowedHosts: ["reme.babelbeast.com"],
  },
});
