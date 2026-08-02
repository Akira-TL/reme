import { exports as workerExports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type FrameLandmarks,
} from "../src/index";

const ORIGIN = "https://reme.maniforld.com";
const MONITOR_ORIGIN = "https://monitor.reme.maniforld.com";
const VERCEL_ORIGIN = "https://reme-sage.vercel.app";
const CONTROL_KEY = "correct horse battery staple";
const FRAME_SCHEMA_VERSION = "movenet-17/v1-demo";
const VIEWER_PROTOCOL = "reme-viewer-v1";
const CONTROLLER_PROTOCOL = "reme-controller-v1";

const sockets: WebSocket[] = [];
const issuedTokens: string[] = [];

interface UnlockSuccess {
  ok: true;
  token: string;
  session_id: string;
  lease_expires_at_ms: number;
}

afterEach(async () => {
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
  return socket;
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
