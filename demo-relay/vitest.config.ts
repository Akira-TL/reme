import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          RUNTIME_INGEST_TOKEN: "test-runtime-ingest-token",
          REME_STUN_URLS: "stun:turn.test:3478",
          REME_TURN_URLS: "turn:turn.test:3478?transport=udp,turns:turn.test:5349?transport=tcp",
          REME_TURN_SHARED_SECRET: "test-turn-shared-secret",
          REME_TURN_CREDENTIAL_TTL_SECONDS: "600",
        },
      },
    }),
  ],
  test: {
    fileParallelism: false,
  },
});
