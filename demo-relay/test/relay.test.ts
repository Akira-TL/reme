import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DemoEvent,
  type FrameLandmarks,
  type MediaSignal,
} from "../src/index";
import { validateDemoEvent } from "../src/protocol";

const ORIGIN = "https://reme.maniforld.com";
const MONITOR_ORIGIN = "https://monitor.reme.maniforld.com";
const VERCEL_ORIGIN = "https://reme-sage.vercel.app";
const CONTROL_KEY = "correct horse battery staple";
const FRAME_SCHEMA_VERSION = "movenet-17/v1-demo";
const EVENT_SCHEMA_VERSION = "reme-demo-event/v1";
const MEDIA_SIGNAL_SCHEMA_VERSION = "reme-media-signal/v1";
const VIEWER_PROTOCOL = "reme-viewer-v1";
const CONTROLLER_PROTOCOL = "reme-controller-v1";

const sockets: WebSocket[] = [];
const issuedTokens: string[] = [];
const viewerIds = new WeakMap<WebSocket, string>();

interface UnlockSuccess {
  ok: true;
  token: string;
  session_id: string;
  lease_expires_at_ms: number;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const token of issuedTokens.splice(0)) {
    await relayFetch("/api/release", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "test_cleanup");
    }
  }
});

describe("single-room demo relay", () => {
  it("rejects an incorrect control key", async () => {
    const response = await relayFetch("/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "wrong" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "invalid_control_key",
    });
  });

  it("grants only one short-lived controller lease", async () => {
    const first = await unlock();
    const second = await relayFetch("/api/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: CONTROL_KEY }),
    });

    expect(second.status).toBe(423);
    await expect(second.json()).resolves.toEqual({
      ok: false,
      error: "controller_locked",
    });

    const status = await relayFetch("/api/status");
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      controller_locked: true,
      controller_connected: false,
      viewer_count: 0,
      session_id: first.session_id,
    });
  });

  it("fans a valid frame out to every viewer", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller); // controller_ready
    const viewerA = await connectViewer();
    const viewerB = await connectViewer();
    const frame = makeFrame(lease.session_id, 1);
    const receivedA = nextJson(viewerA);
    const receivedB = nextJson(viewerB);

    controller.send(JSON.stringify(frame));

    await expect(receivedA).resolves.toEqual(frame);
    await expect(receivedB).resolves.toEqual(frame);
    await expect(nextJson(controller)).resolves.toEqual({
      type: "frame_accepted",
      sequence: 1,
    });
  });

  it("sends the controller attachment snapshot to a late viewer", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const frame = makeFrame(lease.session_id, 7);
    const accepted = nextJson(controller);
    controller.send(JSON.stringify(frame));
    await accepted;

    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(frame);
  });

  it("does not replay a stale controller snapshot to a late viewer", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const accepted = nextJson(controller);
      controller.send(JSON.stringify(makeFrame(lease.session_id, 8)));
      await accepted;

      now.mockReturnValue(baseTime + 2_501);
      const lateViewer = await connectViewer();
      await expectNoMessage(lateViewer);
    } finally {
      now.mockRestore();
    }
  });

  it("makes viewer WebSockets strictly read-only", async () => {
    const viewer = await connectViewer();
    const rejection = nextJson(viewer);
    viewer.send(JSON.stringify({ type: "heartbeat" }));

    await expect(rejection).resolves.toEqual({
      type: "error",
      error: "viewer_read_only",
    });
  });

  it("rejects media fields and binary frames from the controller", async () => {
    const firstLease = await unlock();
    const firstController = await connectController(firstLease.token);
    await nextJson(firstController);
    const mediaRejection = nextJson(firstController);
    firstController.send(
      JSON.stringify({ ...makeFrame(firstLease.session_id, 1), image: "data:image/jpeg;base64,AA==" }),
    );
    await expect(mediaRejection).resolves.toEqual({
      type: "error",
      error: "media_fields_forbidden",
    });

    await release(firstLease.token);
    const secondLease = await unlock();
    const secondController = await connectController(secondLease.token);
    await nextJson(secondController);
    const binaryRejection = nextJson(secondController);
    secondController.send(new Uint8Array([1, 2, 3]).buffer);
    await expect(binaryRejection).resolves.toEqual({
      type: "error",
      error: "binary_frames_forbidden",
    });
  });

  it("rejects invalid source and person-quality metadata", async () => {
    const variants: Array<(frame: FrameLandmarks) => unknown> = [
      (frame) => ({ ...frame, source_width: 0 }),
      (frame) => ({ ...frame, source_height: 16_385 }),
      (frame) => ({ ...frame, source_width: 192.5 }),
      (frame) => ({
        ...frame,
        person_detected: false,
        landmark_quality: "degraded",
      }),
      (frame) => ({
        ...frame,
        person_detected: true,
        landmark_quality: "unavailable",
      }),
      (frame) => ({ ...frame, landmark_quality: "excellent" }),
      (frame) => ({
        ...frame,
        keypoints: frame.keypoints.map((point) => ({ ...point, score: 0 })),
      }),
      (frame) => ({
        ...frame,
        keypoints: frame.keypoints.map((point, index) =>
          index === 15 ? { ...point, score: 0.1 } : point),
      }),
      (frame) => ({
        ...frame,
        person_detected: false,
        landmark_quality: "unavailable",
      }),
      (frame) => ({ ...frame, unexpected: true }),
      (frame) => {
        const copy: Partial<FrameLandmarks> = { ...frame };
        delete copy.source_width;
        return copy;
      },
    ];

    for (const variant of variants) {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const rejection = nextJson(controller);
      controller.send(JSON.stringify(variant(makeFrame(lease.session_id, 1))));
      await expect(rejection).resolves.toEqual({
        type: "error",
        error: "invalid_frame",
      });
      await release(lease.token);
    }
  });

  it("accepts unavailable landmarks only when no person is detected", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();
    const frame: FrameLandmarks = {
      ...makeFrame(lease.session_id, 1),
      person_detected: false,
      landmark_quality: "unavailable",
      keypoints: makeFrame(lease.session_id, 1).keypoints.map((point) => ({
        ...point,
        score: 0,
      })),
    };
    const received = nextJson(viewer);

    controller.send(JSON.stringify(frame));

    await expect(received).resolves.toEqual(frame);
  });

  it("accepts exact monotonic demo events and replays latest structured state in order", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();

    const living = makeSceneEvent(lease.session_id, 0, "living");
    await publishEvent(controller, living, [viewer]);
    const activity = makeActivityEvent(lease.session_id, 1);
    await publishEvent(controller, activity, [viewer]);
    const card = makeCareCardEvent(lease.session_id, 2, "consent_pending");
    await publishEvent(controller, card, [viewer]);
    const kitchen = makeSceneEvent(lease.session_id, 3, "kitchen");
    await publishEvent(controller, kitchen, [viewer]);

    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(activity);
    await expect(nextJson(lateViewer)).resolves.toEqual(card);
    await expect(nextJson(lateViewer)).resolves.toEqual(kitchen);
    await expectNoMessage(lateViewer);
  });

  it("rejects unknown event fields and non-increasing event sequences", async () => {
    const firstLease = await unlock();
    const firstController = await connectController(firstLease.token);
    await nextJson(firstController);
    const event = makeSceneEvent(firstLease.session_id, 0, "living");
    firstController.send(JSON.stringify({ ...event, unexpected: true }));
    await expect(nextJson(firstController)).resolves.toEqual({
      type: "error",
      error: "invalid_event",
    });

    await release(firstLease.token);
    const secondLease = await unlock();
    const secondController = await connectController(secondLease.token);
    await nextJson(secondController);
    await publishEvent(
      secondController,
      makeSceneEvent(secondLease.session_id, 4, "living"),
      [],
    );
    secondController.send(JSON.stringify(makeSceneEvent(secondLease.session_id, 4, "kitchen")));
    await expect(nextJson(secondController)).resolves.toEqual({
      type: "error",
      error: "non_increasing_event_sequence",
    });
  });

  it("issues kitchen grants only after matching consent and excludes late viewers", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewerA = await connectViewer();
    const viewerB = await connectViewer();

    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), [viewerA, viewerB]);
    await publishEvent(
      controller,
      makeCareCardEvent(lease.session_id, 1, "consent_pending"),
      [viewerA, viewerB],
    );
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "cooking-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "media_grant_not_eligible",
    });

    await publishEvent(
      controller,
      makeCareCardEvent(lease.session_id, 2, "consented"),
      [viewerA, viewerB],
    );
    const grantForA = nextJson(viewerA);
    const grantForB = nextJson(viewerB);
    const grantAckPromise = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "cooking-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    const grantAck = readGrantAck(await grantAckPromise, "media_grant_accepted");
    expect(grantAck.viewer_ids).toEqual([viewerId(viewerA), viewerId(viewerB)].sort());
    await expect(grantForA).resolves.toEqual(grantAck.grant);
    await expect(grantForB).resolves.toEqual(grantAck.grant);
    expect(grantAck.grant.event_sequence).toBe(3);
    expect(grantAck.grant.payload).toMatchObject({
      event_id: "cooking-1",
      scope: "kitchen_moment",
      status: "active",
    });

    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(makeSceneEvent(lease.session_id, 0, "kitchen"));
    await expect(nextJson(lateViewer)).resolves.toEqual(
      makeCareCardEvent(lease.session_id, 2, "consented"),
    );
    await expectNoMessage(lateViewer);

    const grantId = mediaGrantId(grantAck.grant);
    const offer: MediaSignal = {
      schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
      grant_id: grantId,
      target_id: viewerId(viewerA),
      signal_type: "offer",
      signal: { sdp: "v=0\r\n" },
    };
    const forwardedOffer = nextJson(viewerA);
    controller.send(JSON.stringify(offer));
    await expect(forwardedOffer).resolves.toEqual({ ...offer, from_id: "controller" });

    const answer: MediaSignal = {
      schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
      grant_id: grantId,
      target_id: "controller",
      signal_type: "answer",
      signal: { sdp: "v=0\r\na=answer" },
    };
    const forwardedAnswer = nextJson(controller);
    viewerA.send(JSON.stringify(answer));
    await expect(forwardedAnswer).resolves.toEqual({
      ...answer,
      from_id: viewerId(viewerA),
    });

    const controllerIce: MediaSignal = {
      schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
      grant_id: grantId,
      target_id: viewerId(viewerB),
      signal_type: "ice_candidate",
      signal: { candidate: "candidate:controller", sdp_mid: "0", sdp_mline_index: 0 },
    };
    const forwardedControllerIce = nextJson(viewerB);
    controller.send(JSON.stringify(controllerIce));
    await expect(forwardedControllerIce).resolves.toEqual({
      ...controllerIce,
      from_id: "controller",
    });

    const viewerIce: MediaSignal = {
      schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
      grant_id: grantId,
      target_id: "controller",
      signal_type: "ice_candidate",
      signal: { candidate: "candidate:viewer", sdp_mid: null, sdp_mline_index: null },
    };
    const forwardedViewerIce = nextJson(controller);
    viewerB.send(JSON.stringify(viewerIce));
    await expect(forwardedViewerIce).resolves.toEqual({
      ...viewerIce,
      from_id: viewerId(viewerB),
    });

    lateViewer.send(JSON.stringify(answer));
    await expect(nextJson(lateViewer)).resolves.toEqual({
      type: "error",
      error: "media_signal_not_authorized",
    });

    const revokeForA = nextJson(viewerA);
    const revokeForB = nextJson(viewerB);
    const revokeAckPromise = nextJson(controller);
    controller.send(JSON.stringify({ type: "media_grant_revoke", grant_id: grantId }));
    const revokeAck = readGrantAck(await revokeAckPromise, "media_grant_revoked");
    expect(revokeAck.grant.event_sequence).toBe(4);
    expect(revokeAck.grant.payload).toMatchObject({ grant_id: grantId, status: "revoked" });
    await expect(revokeForA).resolves.toEqual(revokeAck.grant);
    await expect(revokeForB).resolves.toEqual(revokeAck.grant);
    await expectNoMessage(lateViewer);
  });

  it("issues fall media only for a matching escalated alarm", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "fall"), [viewer]);
    await publishEvent(controller, makeAlarmEvent(lease.session_id, 1, "checking"), [viewer]);

    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_in_ms: 10_000,
    }));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "media_grant_not_eligible",
    });

    await publishEvent(controller, makeAlarmEvent(lease.session_id, 2, "escalated"), [viewer]);
    const viewerGrant = nextJson(viewer);
    const ackPromise = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_in_ms: 10_000,
    }));
    const ack = readGrantAck(await ackPromise, "media_grant_accepted");
    expect(ack.grant.event_sequence).toBe(3);
    await expect(viewerGrant).resolves.toEqual(ack.grant);

    const resolved = makeAlarmEvent(lease.session_id, 4, "resolved");
    const viewerMessages = nextJsonBatch(viewer, 2);
    const controllerMessages = nextJsonBatch(controller, 2);
    controller.send(JSON.stringify(resolved));
    const [resolvedForViewer, revokedForViewer] = await viewerMessages;
    expect(resolvedForViewer).toEqual(resolved);
    const [eventAck, revokeAckValue] = await controllerMessages;
    expect(eventAck).toEqual({
      type: "event_accepted",
      event_sequence: 4,
      event_type: "alarm_state",
    });
    const revokeAck = readGrantAck(revokeAckValue, "media_grant_revoked");
    expect(revokeAck.grant.event_sequence).toBe(5);
    expect(revokeAck.grant.payload).toMatchObject({ status: "revoked" });
    expect(revokedForViewer).toEqual(revokeAck.grant);
  });

  it("rejects signal media fields, binary data, wrong directions, and expired grants", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "fall", baseTime), [viewer]);
      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 1, "escalated", baseTime),
        [viewer],
      );
      const viewerGrant = nextJson(viewer);
      const ackPromise = nextJson(controller);
      controller.send(JSON.stringify({
        type: "media_grant_request",
        event_id: "fall-1",
        scope: "fall_emergency",
        expires_in_ms: 5_000,
      }));
      const ack = readGrantAck(await ackPromise, "media_grant_accepted");
      await viewerGrant;
      const grantId = mediaGrantId(ack.grant);

      const wrongDirection: MediaSignal = {
        schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
        grant_id: grantId,
        target_id: viewerId(viewer),
        signal_type: "answer",
        signal: { sdp: "v=0" },
      };
      controller.send(JSON.stringify(wrongDirection));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "media_signal_direction_forbidden",
      });

      now.mockReturnValue(baseTime + 5_001);
      controller.send(JSON.stringify({
        ...wrongDirection,
        signal_type: "offer",
      }));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "media_signal_not_authorized",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("recognizes one bounded JPEG only with the active control token", async () => {
    const lease = await unlock();
    const outbound = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            classification: "cooking",
            confidence: 0.87,
            reason: "画面中人物正在案板前切配食材",
          }),
        },
      }],
    }));
    vi.stubGlobal("fetch", outbound);

    const response = await relayFetch("/api/activity/recognize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_b64: "/9j/2Q==" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      classification: "cooking",
      confidence: 0.87,
      reason: "画面中人物正在案板前切配食材",
      model: "mimo-v2.5",
    });
    expect(outbound).toHaveBeenCalledTimes(1);
    const call = outbound.mock.calls[0];
    expect(String(call?.[0])).toBe("https://api.xiaomimimo.com/v1/chat/completions");
  });

  it("makes activity authorization, size, JPEG, and MiMo parse failures explicit", async () => {
    const missing = await relayFetch("/api/activity/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_b64: "/9j/2Q==" }),
    });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ ok: false, error: "missing_control_token" });

    const lease = await unlock();
    const invalidJpeg = await recognize(lease.token, "bm90LWEtanBlZw==");
    expect(invalidJpeg.status).toBe(415);
    await expect(invalidJpeg.json()).resolves.toEqual({ ok: false, error: "invalid_jpeg" });

    const tooLarge = await relayFetch("/api/activity/recognize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.token}`,
        "Content-Length": String(900 * 1_024 + 1),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_b64: "/9j/2Q==" }),
    });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({ ok: false, error: "request_too_large" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      choices: [{ message: { content: "{\"classification\":\"maybe\"}" } }],
    })));
    const malformed = await recognize(lease.token, "/9j/2Q==");
    expect(malformed.status).toBe(502);
    await expect(malformed.json()).resolves.toEqual({
      ok: false,
      error: "invalid_mimo_response",
    });
  });

  it("rate limits repeated unlock attempts from one client address", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await relayFetch("/api/unlock", {
        method: "POST",
        headers: {
          "CF-Connecting-IP": "198.51.100.44",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "wrong" }),
      });
      expect(response.status).toBe(401);
    }

    const blocked = await relayFetch("/api/unlock", {
      method: "POST",
      headers: {
        "CF-Connecting-IP": "198.51.100.44",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ key: "still-wrong" }),
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThan(0);
    await expect(blocked.json()).resolves.toEqual({
      ok: false,
      error: "unlock_rate_limited",
    });
  });

  it("rejects missing or foreign origins and emits narrow CORS headers", async () => {
    const missingOrigin = await workerExports.default.fetch(
      new Request("https://relay.example/api/status"),
    );
    expect(missingOrigin.status).toBe(403);
    expect(missingOrigin.headers.get("Vary")).toBe("Origin");

    const foreignOrigin = await workerExports.default.fetch(
      new Request("https://relay.example/api/status", {
        headers: { Origin: "https://attacker.example" },
      }),
    );
    expect(foreignOrigin.status).toBe(403);
    expect(foreignOrigin.headers.get("Vary")).toBe("Origin");

    const vercelStatus = await workerExports.default.fetch(
      new Request("https://relay.example/api/status", {
        headers: { Origin: VERCEL_ORIGIN },
      }),
    );
    expect(vercelStatus.status).toBe(200);
    expect(vercelStatus.headers.get("Access-Control-Allow-Origin")).toBe(VERCEL_ORIGIN);
    expect(vercelStatus.headers.get("Vary")).toBe("Origin");

    const monitorStatus = await workerExports.default.fetch(
      new Request("https://relay.example/api/status", {
        headers: { Origin: MONITOR_ORIGIN },
      }),
    );
    expect(monitorStatus.status).toBe(200);
    expect(monitorStatus.headers.get("Access-Control-Allow-Origin")).toBe(MONITOR_ORIGIN);
    expect(monitorStatus.headers.get("Vary")).toBe("Origin");

    const preflight = await relayFetch("/api/unlock", {
      method: "OPTIONS",
      headers: {
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(preflight.headers.get("Vary")).toBe("Origin");
  });
});

async function relayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Origin", ORIGIN);
  return workerExports.default.fetch(
    new Request(`https://relay.example${path}`, { ...init, headers }),
  );
}

async function unlock(): Promise<UnlockSuccess> {
  const response = await relayFetch("/api/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: CONTROL_KEY }),
  });
  expect(response.status).toBe(200);
  const payload = await response.json<UnlockSuccess>();
  issuedTokens.push(payload.token);
  return payload;
}

async function release(token: string): Promise<void> {
  const response = await relayFetch("/api/release", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  const index = issuedTokens.indexOf(token);
  if (index >= 0) {
    issuedTokens.splice(index, 1);
  }
}

async function connectViewer(): Promise<WebSocket> {
  const response = await relayFetch("/ws/viewer", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": VIEWER_PROTOCOL,
    },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(VIEWER_PROTOCOL);
  const socket = requireSocket(response);
  socket.accept();
  sockets.push(socket);
  const ready = await nextJson(socket);
  expect(ready).toMatchObject({ type: "viewer_ready" });
  if (
    ready === null
    || typeof ready !== "object"
    || !("viewer_id" in ready)
    || typeof ready.viewer_id !== "string"
  ) {
    throw new Error("viewer_ready must include viewer_id");
  }
  viewerIds.set(socket, ready.viewer_id);
  return socket;
}

function viewerId(socket: WebSocket): string {
  const value = viewerIds.get(socket);
  if (value === undefined) throw new Error("viewer id is unavailable");
  return value;
}

async function connectController(token: string): Promise<WebSocket> {
  const response = await relayFetch("/ws/controller", {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": `${CONTROLLER_PROTOCOL}, reme-token-${token}`,
    },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get("Sec-WebSocket-Protocol")).toBe(CONTROLLER_PROTOCOL);
  const socket = requireSocket(response);
  socket.accept();
  sockets.push(socket);
  return socket;
}

function requireSocket(response: Response): WebSocket {
  if (response.webSocket === null) {
    throw new Error("expected a WebSocket response");
  }
  return response.webSocket;
}

function nextJson(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 2_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        if (typeof event.data !== "string") {
          reject(new Error("expected a text WebSocket message"));
          return;
        }
        resolve(JSON.parse(event.data) as unknown);
      },
      { once: true },
    );
  });
}

function nextJsonBatch(socket: WebSocket, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const messages: unknown[] = [];
    const timeout = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`timed out waiting for ${count} WebSocket messages`));
    }, 2_000);
    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        reject(new Error("expected a text WebSocket message"));
        return;
      }
      messages.push(JSON.parse(event.data) as unknown);
      if (messages.length === count) {
        clearTimeout(timeout);
        socket.removeEventListener("message", onMessage);
        resolve(messages);
      }
    };
    socket.addEventListener("message", onMessage);
  });
}

async function expectNoMessage(socket: WebSocket, waitMs = 75): Promise<void> {
  let received = false;
  const onMessage = () => {
    received = true;
  };
  socket.addEventListener("message", onMessage);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  socket.removeEventListener("message", onMessage);
  expect(received).toBe(false);
}

function makeFrame(sessionId: string, sequence: number): FrameLandmarks {
  const names = [
    "nose",
    "left_eye",
    "right_eye",
    "left_ear",
    "right_ear",
    "left_shoulder",
    "right_shoulder",
    "left_elbow",
    "right_elbow",
    "left_wrist",
    "right_wrist",
    "left_hip",
    "right_hip",
    "left_knee",
    "right_knee",
    "left_ankle",
    "right_ankle",
  ] as const;
  return {
    schema_version: FRAME_SCHEMA_VERSION,
    session_id: sessionId,
    sequence,
    timestamp_ms: sequence * 100,
    source_width: 1920,
    source_height: 1080,
    person_detected: true,
    landmark_quality: "usable",
    keypoints: names.map((name, index) => ({
      name,
      x: index / 20,
      y: index / 20,
      score: 0.9,
    })),
  };
}

function makeSceneEvent(
  sessionId: string,
  eventSequence: number,
  sceneId: "living" | "kitchen" | "bathroom" | "fall",
  timestampMs = eventSequence * 1_000,
): DemoEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: timestampMs,
    event_type: "scene_state",
    payload: {
      scene_id: sceneId,
      visual_mode: sceneId === "bathroom" ? "skeleton_only" : "abstract_environment",
    },
  };
}

function makeActivityEvent(sessionId: string, eventSequence: number): DemoEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: eventSequence * 1_000,
    event_type: "activity_state",
    payload: {
      activity: "cooking",
      phase: "confirmed",
      source: "mimo_visual",
      confidence: 0.87,
      reason: "连续样本显示人物正在备菜",
    },
  };
}

function makeCareCardEvent(
  sessionId: string,
  eventSequence: number,
  shareState: "local_only" | "consent_pending" | "consented" | "denied" | "expired",
): DemoEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: eventSequence * 1_000,
    event_type: "care_card",
    payload: {
      card_id: "card-1",
      event_id: "cooking-1",
      kind: "family_heartbeat",
      title: "厨房里的家庭心跳",
      body: "检测到一段做饭时光，等待本人决定是否分享。",
      occurred_at_ms: 1_000,
      share_state: shareState,
    },
  };
}

function makeAlarmEvent(
  sessionId: string,
  eventSequence: number,
  phase: "checking" | "escalated" | "resolved",
  timestampMs = eventSequence * 1_000,
): DemoEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: timestampMs,
    event_type: "alarm_state",
    payload: {
      event_id: "fall-1",
      phase,
      trigger: phase === "checking" ? "fall_transition" : "check_in_timeout",
      message: phase === "checking" ? "刚才的动作有些突然，您还好吗？" : "未收到回应，已通知家人。",
      response_deadline_ms: phase === "checking" ? timestampMs + 8_000 : null,
      media_scope: phase === "escalated" ? "fall_emergency" : "none",
    },
  };
}

async function publishEvent(
  controller: WebSocket,
  event: DemoEvent,
  viewers: readonly WebSocket[],
): Promise<void> {
  const viewerMessages = viewers.map((viewer) => nextJson(viewer));
  const ack = nextJson(controller);
  controller.send(JSON.stringify(event));
  await expect(ack).resolves.toEqual({
    type: "event_accepted",
    event_sequence: event.event_sequence,
    event_type: event.event_type,
  });
  for (const message of viewerMessages) {
    await expect(message).resolves.toEqual(event);
  }
}

function readGrantAck(
  value: unknown,
  expectedType: "media_grant_accepted" | "media_grant_revoked",
): { grant: DemoEvent; viewer_ids: string[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("grant ack must be an object");
  }
  if (!("type" in value) || value.type !== expectedType || !("grant" in value)) {
    throw new Error(`expected ${expectedType}`);
  }
  const grant = value.grant;
  if (
    grant === null
    || typeof grant !== "object"
    || Array.isArray(grant)
    || !("session_id" in grant)
    || typeof grant.session_id !== "string"
    || !validateDemoEvent(grant, grant.session_id)
    || grant.event_type !== "media_grant"
  ) {
    throw new Error("grant ack contains an invalid media_grant event");
  }
  const ids = "viewer_ids" in value ? value.viewer_ids : [];
  if (!Array.isArray(ids) || !ids.every((item) => typeof item === "string")) {
    throw new Error("grant ack viewer_ids must be strings");
  }
  return { grant, viewer_ids: ids };
}

function mediaGrantId(event: DemoEvent): string {
  if (event.event_type !== "media_grant") throw new Error("expected media grant event");
  return event.payload.grant_id;
}

async function recognize(token: string, imageB64: string): Promise<Response> {
  return relayFetch("/api/activity/recognize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ image_b64: imageB64 }),
  });
}
