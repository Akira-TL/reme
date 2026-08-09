import assert from "node:assert/strict";
import test from "node:test";

import { resolveRelayEndpointUrl } from "./config.js";

test("relay endpoint keeps an HTTPS reverse-proxy path prefix", () => {
  assert.equal(
    resolveRelayEndpointUrl(
      "https://192.168.1.42:4174/_reme/relay/",
      "/ws/viewer",
    ).href,
    "https://192.168.1.42:4174/_reme/relay/ws/viewer",
  );
});

test("relay endpoint normalizes a base without a trailing slash", () => {
  assert.equal(
    resolveRelayEndpointUrl(
      "http://127.0.0.1:8787/prefix",
      "api/monitor/claim",
    ).href,
    "http://127.0.0.1:8787/prefix/api/monitor/claim",
  );
});

test("relay endpoint rejects non-HTTP transports", () => {
  assert.throws(
    () => resolveRelayEndpointUrl("file:///tmp/relay", "ws/viewer"),
    /http 或 https/,
  );
});
