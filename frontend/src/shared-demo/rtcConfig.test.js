import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchRtcConfiguration,
  isRtcConfigurationWire,
} from "./rtcConfig.js";

function turnConfiguration(overrides = {}) {
  return {
    iceServers: [
      { urls: ["stun:turn.reme.example:3478"] },
      {
        urls: [
          "turn:turn.reme.example:3478?transport=udp",
          "turns:turn.reme.example:5349?transport=tcp",
        ],
        username: "temporary-user",
        credential: "temporary-credential",
      },
    ],
    mode: "turn_configured",
    credential_expires_at_ms: 60_000,
    ...overrides,
  };
}

test("RTC config accepts only the exact provider-neutral contract", () => {
  assert.equal(isRtcConfigurationWire(turnConfiguration()), true);
  assert.equal(isRtcConfigurationWire(turnConfiguration({ leaked_key: "no" })), false);
  assert.equal(isRtcConfigurationWire(turnConfiguration({
    iceServers: [{ urls: "https://not-an-ice-server.example" }],
  })), false);
  assert.equal(isRtcConfigurationWire(turnConfiguration({
    mode: "turn_configured",
    iceServers: [{ urls: ["stun:turn.reme.example:3478"] }],
  })), false);
  assert.equal(isRtcConfigurationWire(turnConfiguration({
    mode: "stun_only",
    credential_expires_at_ms: null,
    iceServers: [{ urls: ["stun:turn.reme.example:3478"] }],
  })), true);
  assert.equal(isRtcConfigurationWire({
    iceServers: [],
    mode: "local_network_only",
    credential_expires_at_ms: null,
  }), true);
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
  assert.equal(configuration.mode, "turn_configured");
  assert.equal(configuration.iceServers[1].credential, "temporary-credential");
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.iceServers), true);
});
