import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

process.env.BACKEND_PUBLISH_TOKEN ??= "test-backend-secret";
process.env.TURN_KEY_ID ??= "local-disabled";
process.env.TURN_KEY_API_TOKEN ??= "local-disabled";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BACKEND_PUBLISH_TOKEN: "test-backend-secret",
          TURN_KEY_ID: "local-disabled",
          TURN_KEY_API_TOKEN: "local-disabled",
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
  },
});
