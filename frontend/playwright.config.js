import { defineConfig } from "@playwright/test";

const environment = globalThis.process?.env || {};
const channel = environment.REME_E2E_CHANNEL?.trim();

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./test-results/playwright",
  fullyParallel: false,
  forbidOnly: Boolean(environment.CI),
  retries: environment.CI ? 1 : 0,
  workers: 1,
  reporter: environment.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "line",
  use: {
    baseURL: "http://127.0.0.1:4173",
    ...(channel ? { channel } : {}),
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/home",
    reuseExistingServer: !environment.CI,
    timeout: 120_000,
  },
});
