import { afterEach, describe, expect, it, vi } from "vitest";

import {
  generateTurnCredentials,
  providerTurnTtlSeconds,
  type BrowserIceServer,
} from "../src/turn";

const TURN_KEY_ID = "0123456789abcdef0123456789abcdef";
const TURN_API_TOKEN = "test-turn-api-token-0123456789abcdef";
const TURN_ENV = {
  TURN_KEY_ID,
  TURN_KEY_API_TOKEN: TURN_API_TOKEN,
};
const EXPECTED_BROWSER_ICE_SERVERS: BrowserIceServer[] = [
  { urls: ["stun:stun.cloudflare.com:3478"] },
  {
    urls: [
      "turn:turn.cloudflare.com:3478?transport=udp",
      "turn:turn.cloudflare.com:3478?transport=tcp",
      "turn:turn.cloudflare.com:80?transport=tcp",
      "turns:turn.cloudflare.com:5349?transport=tcp",
      "turns:turn.cloudflare.com:443?transport=tcp",
    ],
    username: "short-lived-user",
    credential: "short-lived-credential",
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cloudflare TURN credential adapter", () => {
  it("calls the official endpoint and filters provider port 53 URLs", async () => {
    const provider = vi.fn(async () => providerResponse());
    vi.stubGlobal("fetch", provider);

    await expect(generateTurnCredentials(TURN_ENV, 45)).resolves.toEqual({
      ok: true,
      ice_servers: EXPECTED_BROWSER_ICE_SERVERS,
    });
    expect(provider).toHaveBeenCalledTimes(1);
    const [url, init] = provider.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${TURN_KEY_ID}/credentials/generate-ice-servers`,
    );
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      Authorization: `Bearer ${TURN_API_TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(init.body).toBe(JSON.stringify({ ttl: 45 }));
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails before fetch when the long-lived secrets are missing", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);

    await expect(generateTurnCredentials({}, 45)).resolves.toEqual({
      ok: false,
      error: "turn_not_configured",
    });
    expect(provider).not.toHaveBeenCalled();
  });

  it("maps network and non-201 failures without logging provider bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network unavailable");
    }));
    await expect(generateTurnCredentials(TURN_ENV, 45)).resolves.toEqual({
      ok: false,
      error: "turn_provider_unavailable",
    });

    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "do-not-log-this-provider-secret",
      { status: 500 },
    )));
    await expect(generateTurnCredentials(TURN_ENV, 45)).resolves.toEqual({
      ok: false,
      error: "turn_provider_unavailable",
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain("do-not-log-this-provider-secret");
  });

  it.each([
    ["missing STUN", providerResponse({ includeStun: false })],
    ["missing TURN", providerResponse({ includeTurn: false })],
    ["extra top-level data", providerResponse({ extraTopLevel: true })],
    ["UDP on provider port 80", providerResponse({ turnUrls: [
      "turn:turn.cloudflare.com:80?transport=udp",
    ] })],
    ["malformed JSON", new Response("{", { status: 201 })],
    ["oversized body", new Response("x".repeat(32 * 1_024 + 1), { status: 201 })],
    ["more than 16 ICE server entries", Response.json({
      iceServers: [
        ...Array.from({ length: 16 }, () => ({
          urls: ["stun:stun.cloudflare.com:3478"],
        })),
        {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "short-lived-user",
          credential: "short-lived-credential",
        },
      ],
    }, { status: 201 })],
  ])("rejects an invalid provider response: %s", async (_label, response) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));
    await expect(generateTurnCredentials(TURN_ENV, 45)).resolves.toEqual({
      ok: false,
      error: "turn_provider_invalid_response",
    });
  });

  it("maps a provider response stream failure to an invalid response", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error("provider stream failed");
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 201 })));

    await expect(generateTurnCredentials(TURN_ENV, 45)).resolves.toEqual({
      ok: false,
      error: "turn_provider_invalid_response",
    });
  });
});

describe("TURN TTL policy", () => {
  it.each([
    [0, 15],
    [1, 16],
    [30_000, 45],
    [60_000, 75],
    [100_000, 75],
  ])("maps %i ms remaining to %i seconds", (remainingMs, expectedSeconds) => {
    expect(providerTurnTtlSeconds(remainingMs)).toBe(expectedSeconds);
  });
});

function providerResponse(
  {
    includeStun = true,
    includeTurn = true,
    extraTopLevel = false,
    turnUrls,
  }: {
    includeStun?: boolean;
    includeTurn?: boolean;
    extraTopLevel?: boolean;
    turnUrls?: string[];
  } = {},
): Response {
  const iceServers: Array<Record<string, unknown>> = [];
  if (includeStun) {
    iceServers.push({
      urls: [
        "stun:stun.cloudflare.com:3478",
        "stun:stun.cloudflare.com:53",
      ],
    });
  }
  if (includeTurn) {
    iceServers.push({
      urls: turnUrls ?? [
        "turn:turn.cloudflare.com:3478?transport=udp",
        "turn:turn.cloudflare.com:53?transport=udp",
        "turn:turn.cloudflare.com:3478?transport=tcp",
        "turn:turn.cloudflare.com:80?transport=tcp",
        "turns:turn.cloudflare.com:5349?transport=tcp",
        "turns:turn.cloudflare.com:443?transport=tcp",
      ],
      username: "short-lived-user",
      credential: "short-lived-credential",
    });
  }
  return Response.json(
    extraTopLevel ? { iceServers, unexpected: true } : { iceServers },
    { status: 201 },
  );
}
