import assert from "node:assert/strict";
import test from "node:test";

import {
  fetchMediaIceServers,
  isMediaIceCapability,
  isMediaIceResponse,
  parseMediaIceCapability,
  selectMediaIceCapability,
} from "./mediaIce.js";

const TOKEN = "a".repeat(64);

function capability(overrides = {}) {
  return {
    type: "media_ice_capability",
    grant_id: "grant-1",
    bearer_token: TOKEN,
    expires_at_ms: 120_000,
    ...overrides,
  };
}

function responsePayload(overrides = {}) {
  return {
    ice_servers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "short-user",
        credential: "short-secret",
      },
    ],
    expires_at_ms: 120_000,
    ttl_ms: 30_000,
    ...overrides,
  };
}

test("media ICE capability parser requires the exact grant-scoped bearer contract", () => {
  assert.deepEqual(parseMediaIceCapability(JSON.stringify(capability())), capability());
  assert.equal(isMediaIceCapability(capability({ bearer_token: "public-viewer-id" })), false);
  assert.equal(isMediaIceCapability({ ...capability(), viewer_id: "viewer-1" }), false);
  assert.equal(parseMediaIceCapability("not-json"), null);
  assert.equal(selectMediaIceCapability(capability(), { grant_id: "grant-1" }, 100_000)?.bearer_token, TOKEN);
  assert.equal(selectMediaIceCapability(capability(), { grant_id: "grant-2" }, 100_000), null);
  assert.equal(selectMediaIceCapability(capability(), { grant_id: "grant-1" }, 120_000), null);
});

test("media ICE response requires both STUN and credentialed TURN without port 53", () => {
  assert.equal(isMediaIceResponse(responsePayload()), true);
  assert.equal(isMediaIceResponse(responsePayload({
    ice_servers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
  })), false);
  assert.equal(isMediaIceResponse(responsePayload({
    ice_servers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:evil.example:3478"], username: "u", credential: "c" },
    ],
  })), false);
  assert.equal(isMediaIceResponse(responsePayload({ ttl_ms: 30_000.5 })), false);
  assert.equal(isMediaIceResponse(responsePayload({
    ice_servers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:53?transport=udp"], username: "u", credential: "c" },
    ],
  })), false);
  assert.equal(isMediaIceResponse(responsePayload({
    ice_servers: [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478"], username: "u", credential: "c", extra: true },
    ],
  })), false);
  for (const rejectedUrl of [
    "stuns:stun.cloudflare.com:5349",
    "turn:turn.cloudflare.com:3478",
    "turn:turn.cloudflare.com:80?transport=udp",
  ]) {
    const isStun = rejectedUrl.startsWith("stun");
    assert.equal(isMediaIceResponse(responsePayload({
      ice_servers: [
        isStun
          ? { urls: [rejectedUrl] }
          : { urls: ["stun:stun.cloudflare.com:3478"] },
        isStun
          ? {
            urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
            username: "u",
            credential: "c",
          }
          : { urls: [rejectedUrl], username: "u", credential: "c" },
      ],
    })), false, rejectedUrl);
  }
  assert.equal(isMediaIceResponse(responsePayload({
    ice_servers: [
      { urls: ["stun:stun.cloudflare.com:3478?transport=udp"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp",
        ],
        username: "u",
        credential: "c",
      },
    ],
  })), true);
});

test("media ICE fetch uses exact authorization and returns a defensive RTC configuration", async () => {
  const requests = [];
  const result = await fetchMediaIceServers({
    bearerToken: TOKEN,
    grantId: "grant-1",
    now: () => 100_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify(responsePayload()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/media\/ice$/);
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(requests[0].init.body), { grant_id: "grant-1" });
  assert.deepEqual(result.iceServers, responsePayload().ice_servers);
  result.iceServers[0].urls.push("stun:mutated.example");
  assert.equal(responsePayload().ice_servers[0].urls.length, 1);
});

test("media ICE fetch makes old Relay and TURN failures explicit without STUN fallback", async (t) => {
  await t.test("old Relay 404", async () => {
    await assert.rejects(fetchMediaIceServers({
      bearerToken: TOKEN,
      grantId: "grant-1",
      fetchImpl: async () => new Response("not found", { status: 404 }),
    }), /尚未启用可靠实景网络能力/);
  });

  await t.test("TURN missing", async () => {
    await assert.rejects(fetchMediaIceServers({
      bearerToken: TOKEN,
      grantId: "grant-1",
      fetchImpl: async () => Response.json(
        { ok: false, error: "turn_not_configured" },
        { status: 503 },
      ),
    }), /尚未配置/);
  });

  await t.test("STUN-only success payload", async () => {
    await assert.rejects(fetchMediaIceServers({
      bearerToken: TOKEN,
      grantId: "grant-1",
      fetchImpl: async () => Response.json(responsePayload({
        ice_servers: [{ urls: ["stun:stun.cloudflare.com:3478"] }],
      })),
    }), /格式无效/);
  });
});

test("media ICE fetch refuses credentials whose authority is already too short", async () => {
  await assert.rejects(fetchMediaIceServers({
    bearerToken: TOKEN,
    grantId: "grant-1",
    now: () => 119_500,
    fetchImpl: async () => Response.json(responsePayload({ ttl_ms: 500 })),
  }), /剩余时间不足/);
});
