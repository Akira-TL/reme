import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// SHA-256("correct horse battery staple"). This is test data, not a deploy secret.
const TEST_CONTROL_KEY_SHA256 =
  "c4bbcb1fbec99d65bf59d85c8cb62ee2db963f0fe106f483d9afa73bd4e39a8a";
const TEST_MIMO_API_KEY = "test-mimo-api-key";

process.env.CONTROL_KEY_SHA256 ??= TEST_CONTROL_KEY_SHA256;
process.env.MIMO_API_KEY ??= TEST_MIMO_API_KEY;

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CONTROL_KEY_SHA256: TEST_CONTROL_KEY_SHA256,
          MIMO_API_KEY: TEST_MIMO_API_KEY,
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
  },
});
