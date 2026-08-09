import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchRtcConfiguration,
  isRtcConfigurationWire,
} from "./rtcConfig.js";

function turnConfiguration(overrides = {}) {
  return {
    schema_version: "reme-rtc-config/v1",
    iceServers: [
      { urls: "stun:stun.cloudflare.com:3478" },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
        ],
        username: "temporary-user",
        credential: "temporary-credential",
      },
    ],
    expires_at_ms: 60_000,
    capability: "turn",
    ...overrides,
  };
}

test("RTC config requires an exact short-lived TURN/STUN contract", () => {
  assert.equal(isRtcConfigurationWire(turnConfiguration()), true);
  assert.equal(isRtcConfigurationWire(turnConfiguration({ leaked_key: "no" })), false);
  assert.equal(isRtcConfigurationWire(turnConfiguration({
    iceServers: [{ urls: "https://not-an-ice-server.example" }],
  })), false);
  assert.equal(isRtcConfigurationWire(turnConfiguration({
    capability: "turn",
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  })), false);
  assert.equal(isRtcConfigurationWire(turnConfiguration({
    capability: "stun_only",
    iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
  })), true);
});

test("RTC config fetch keeps credentials ephemeral and immutable", async () => {
  const wire = turnConfiguration();
  const calls = [];
  const configuration = await fetchRtcConfiguration({
    relayUrl: "https://relay.example/",
    async fetchImpl(url, init) {
      calls.push({ url, init });
      return new Response(JSON.stringify(wire), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(configuration.capability, "turn");
  assert.equal(configuration.iceServers[1].credential, "temporary-credential");
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.iceServers), true);
});
