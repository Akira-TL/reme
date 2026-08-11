import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublicRuntimeConfig } from "./publicRuntimeConfig.js";

const complete = Object.freeze({
  perceptionHttpUrl: "http://127.0.0.1:8770",
  perceptionInputWsUrl: "ws://127.0.0.1:8770/ws/camera-input",
  decisionHttpUrl: "https://reme.example/_reme/runtime/",
  relayUrl: "/_reme/relay/",
  mimoModel: "mimo-v2.5",
  mimoConfigured: true,
});

test("deployment runtime config overrides build values without accepting secrets", () => {
  const config = resolvePublicRuntimeConfig({
    runtimeConfig: complete,
    environment: { VITE_REME_RELAY_URL: "https://old.example/" },
    locationOrigin: "https://reme.example",
  });
  assert.equal(config.source, "runtime");
  assert.equal(config.perceptionHttpUrl, "http://127.0.0.1:8770/");
  assert.equal(config.decisionHttpUrl, "https://reme.example/_reme/runtime/");
  assert.equal(config.relayUrl, "https://reme.example/_reme/relay/");
  assert.equal(config.mimoConfigured, true);
});

test("relative camera input becomes a same-origin WebSocket", () => {
  const config = resolvePublicRuntimeConfig({
    runtimeConfig: { ...complete, perceptionInputWsUrl: "/_reme/runtime/ws/camera-input" },
    locationOrigin: "https://reme.example",
  });
  assert.equal(config.perceptionInputWsUrl, "wss://reme.example/_reme/runtime/ws/camera-input");
});

test("missing and unknown deployment fields fail instead of mixing configurations", () => {
  assert.throws(
    () => resolvePublicRuntimeConfig({ runtimeConfig: { ...complete, relayUrl: undefined } }),
    /Relay URL 必须是非空 URL/,
  );
  const missingRelay = Object.fromEntries(
    Object.entries(complete).filter(([key]) => key !== "relayUrl"),
  );
  assert.throws(
    () => resolvePublicRuntimeConfig({ runtimeConfig: missingRelay }),
    /缺少字段: relayUrl/,
  );
  assert.throws(
    () => resolvePublicRuntimeConfig({ runtimeConfig: { ...complete, room: "shared" } }),
    /未知字段: room/,
  );
});

test("secret-like deployment keys are rejected before values can enter the app", () => {
  assert.throws(
    () => resolvePublicRuntimeConfig({ runtimeConfig: { ...complete, runtimeToken: "x" } }),
    /禁止包含密钥或凭证字段/,
  );
});

test("remote plaintext Backend and Relay URLs fail closed while loopback remains valid", () => {
  for (const [field, value] of [
    ["perceptionHttpUrl", "http://192.0.2.10:8770"],
    ["perceptionInputWsUrl", "ws://192.0.2.10:8770/ws/camera-input"],
    ["decisionHttpUrl", "http://api.example"],
    ["relayUrl", "http://relay.example"],
  ]) {
    assert.throws(
      () => resolvePublicRuntimeConfig({ runtimeConfig: { ...complete, [field]: value } }),
      /必须使用 TLS/,
      field,
    );
  }
});

test("null deployment config preserves existing build-time and loopback defaults", () => {
  const config = resolvePublicRuntimeConfig({
    runtimeConfig: null,
    environment: { VITE_REME_RELAY_URL: "https://relay.example/prefix" },
    locationOrigin: "https://reme.example",
  });
  assert.equal(config.source, "build");
  assert.equal(config.perceptionHttpUrl, "http://127.0.0.1:8770/");
  assert.equal(config.perceptionInputWsUrl, "ws://127.0.0.1:8770/ws/camera-input");
  assert.equal(config.decisionHttpUrl, "http://127.0.0.1:8770/");
  assert.equal(config.relayUrl, "https://relay.example/prefix");
});
