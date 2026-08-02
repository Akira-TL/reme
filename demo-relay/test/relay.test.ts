import { env, exports as workerExports } from "cloudflare:workers";
import {
  abortAllDurableObjects,
  evictDurableObject,
  reset as resetCloudflareBindings,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type DemoEvent,
  type FrameLandmarks,
  type MediaSignal,
} from "../src/index";
import { handleActivityRecognition } from "../src/activity";
import { validateDemoEvent } from "../src/protocol";
import { handleSceneRecognition } from "../src/scene";

const ORIGIN = "https://reme.maniforld.com";
const MONITOR_ORIGIN = "https://monitor.reme.maniforld.com";
const VERCEL_ORIGIN = "https://reme-sage.vercel.app";
const CONTROL_KEY = "correct horse battery staple";
const FRAME_SCHEMA_VERSION = "movenet-17/v1-demo";
const EVENT_SCHEMA_VERSION = "reme-demo-event/v1";
const MEDIA_SIGNAL_SCHEMA_VERSION = "reme-media-signal/v1";
const VIEWER_PROTOCOL = "reme-viewer-v1";
const CONTROLLER_PROTOCOL = "reme-controller-v1";
const ROOM_NAME = "shared-live-demo";
const MINIMAL_MP4_B64 = "AAAADGZ0eXBpc29t";
const MINIMAL_JPEG_B64 = "/9j/2Q==";

const sockets: WebSocket[] = [];
const issuedTokens: string[] = [];
const viewerIds = new WeakMap<WebSocket, string>();
const socketInboxes = new WeakMap<WebSocket, SocketInbox>();

interface SocketInbox {
  messages: Array<{ value?: unknown; error?: Error }>;
  waiters: Array<{
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
}

interface UnlockSuccess {
  ok: true;
  token: string;
  session_id: string;
  lease_expires_at_ms: number;
}

interface DangerWatchdogSnapshot {
  alarm_at_ms: number | null;
  watchdogs: Array<{
    session_id: string;
    event_id: string;
    deadline_ms: number;
    status: "checking" | "escalated" | "resolved";
  }>;
  alarm_event: DemoEvent | null;
  last_event_sequence: number | null;
}

type AlarmTrigger = Extract<DemoEvent, { event_type: "alarm_state" }>["payload"]["trigger"];
type AlarmStateEvent = Extract<DemoEvent, { event_type: "alarm_state" }>;

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(1000, "test_cleanup");
    }
  }
  issuedTokens.splice(0);
  await abortAllDurableObjects();
  await resetCloudflareBindings();
  await resetRoomStorage();
  await abortAllDurableObjects();
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

  it("reports empty authoritative cursors for a new controller session", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);

    await expect(nextJson(controller)).resolves.toEqual({
      type: "controller_ready",
      session_id: lease.session_id,
      lease_expires_at_ms: lease.lease_expires_at_ms,
      last_event_sequence: -1,
      last_frame_sequence: -1,
      current_alarm: null,
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

  it("resumes the same token with authoritative event and frame cursors", async () => {
    const lease = await unlock();
    const firstController = await connectController(lease.token);
    await nextJson(firstController);
    const viewer = await connectViewer();

    await publishEvent(
      firstController,
      makeSceneEvent(lease.session_id, 3, "kitchen"),
      [viewer],
    );
    const frameAccepted = nextJson(firstController);
    const frameReceived = nextJson(viewer);
    firstController.send(JSON.stringify(makeFrame(lease.session_id, 7)));
    await expect(frameAccepted).resolves.toEqual({
      type: "frame_accepted",
      sequence: 7,
    });
    await expect(frameReceived).resolves.toEqual(makeFrame(lease.session_id, 7));

    await closeControllerSocket(firstController, 1000, "controller_refresh");
    const status = await relayFetch("/api/status");
    await expect(status.json()).resolves.toMatchObject({
      controller_locked: true,
      controller_connected: false,
      session_id: lease.session_id,
    });

    const resumedController = await connectController(lease.token);
    await expect(nextJson(resumedController)).resolves.toEqual({
      type: "controller_ready",
      session_id: lease.session_id,
      lease_expires_at_ms: lease.lease_expires_at_ms,
      last_event_sequence: 3,
      last_frame_sequence: 7,
      current_alarm: null,
    });

    await publishEvent(
      resumedController,
      makeSceneEvent(lease.session_id, 1_024, "fall"),
      [viewer],
    );
    const resumedFrameAccepted = nextJson(resumedController);
    const resumedFrameReceived = nextJson(viewer);
    resumedController.send(JSON.stringify(makeFrame(lease.session_id, 8)));
    await expect(resumedFrameAccepted).resolves.toEqual({
      type: "frame_accepted",
      sequence: 8,
    });
    await expect(resumedFrameReceived).resolves.toEqual(makeFrame(lease.session_id, 8));

    const rejection = nextJson(resumedController);
    resumedController.send(JSON.stringify(makeFrame(lease.session_id, 8)));
    await expect(rejection).resolves.toEqual({
      type: "error",
      error: "non_increasing_sequence",
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
    const activity = makeActivityEvent(lease.session_id, 1, "candidate");
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

  it("issues kitchen live grants only after confirmed activity and adds late viewers", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);

    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), []);
    controller.send(JSON.stringify(makeActivityEvent(lease.session_id, 1)));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "activity_evidence_not_verified",
      event_sequence: 1,
      event_type: "activity_state",
    });
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "media_grant_not_eligible",
    });

    const outbound = vi.fn(async () => mimoActivityResponse("cooking", 0.87));
    vi.stubGlobal("fetch", outbound);
    const firstVerdict = await (await recognize(lease.token, MINIMAL_JPEG_B64)).json<{
      receipt_id: string | null;
      consecutive: number;
    }>();
    expect(firstVerdict).toMatchObject({ receipt_id: null, consecutive: 1 });
    await publishEvent(
      controller,
      makeActivityEvent(lease.session_id, 2, "candidate"),
      [],
    );

    const secondVerdict = await (await recognize(lease.token, MINIMAL_JPEG_B64)).json<{
      receipt_id: string | null;
      consecutive: number;
    }>();
    expect(secondVerdict.consecutive).toBe(2);
    expect(secondVerdict.receipt_id).toMatch(/^activity-receipt-[a-f0-9]{32}$/);
    await publishEvent(controller, makeActivityEvent(lease.session_id, 3), []);

    // The public event id remains stable and carries no secret receipt. Relay
    // binds it to the just-consumed server receipt before signing media.
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-forged",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "media_grant_not_eligible",
    });

    const grantAckPromise = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-3",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    const grantAck = readGrantAck(await grantAckPromise, "media_grant_accepted");
    expect(grantAck.viewer_ids).toEqual([]);
    expect(grantAck.grant.event_sequence).toBe(4);
    expect(grantAck.grant.payload).toMatchObject({
      event_id: "activity-3",
      scope: "kitchen_moment",
      status: "active",
    });

    const viewerAAckPromise = nextJson(controller);
    const viewerA = await connectViewer();
    await expect(nextJson(viewerA)).resolves.toEqual(makeSceneEvent(lease.session_id, 0, "kitchen"));
    await expect(nextJson(viewerA)).resolves.toEqual(makeActivityEvent(lease.session_id, 3));
    const viewerAAck = readGrantAck(await viewerAAckPromise, "media_grant_accepted");
    expect(viewerAAck.viewer_ids).toEqual([viewerId(viewerA)]);
    expect(viewerAAck.grant.event_sequence).toBe(5);
    await expect(nextJson(viewerA)).resolves.toEqual(viewerAAck.grant);

    const viewerBAckPromise = nextJson(controller);
    const viewerB = await connectViewer();
    await expect(nextJson(viewerB)).resolves.toEqual(makeSceneEvent(lease.session_id, 0, "kitchen"));
    await expect(nextJson(viewerB)).resolves.toEqual(makeActivityEvent(lease.session_id, 3));
    const viewerBAck = readGrantAck(await viewerBAckPromise, "media_grant_accepted");
    expect(viewerBAck.viewer_ids).toEqual([viewerId(viewerA), viewerId(viewerB)].sort());
    expect(viewerBAck.grant.event_sequence).toBe(6);
    await expect(nextJson(viewerB)).resolves.toEqual(viewerBAck.grant);

    const localCard = makeCareCardEvent(lease.session_id, 7, "local_only", "activity-3");
    await publishEvent(controller, localCard, [viewerA, viewerB]);
    await expectNoMessage(viewerA);
    await expectNoMessage(viewerB);

    const lateGrantAckPromise = nextJson(controller);
    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(makeSceneEvent(lease.session_id, 0, "kitchen"));
    await expect(nextJson(lateViewer)).resolves.toEqual(makeActivityEvent(lease.session_id, 3));
    await expect(nextJson(lateViewer)).resolves.toEqual(localCard);
    const lateGrantAck = readGrantAck(await lateGrantAckPromise, "media_grant_accepted");
    expect(lateGrantAck.viewer_ids).toEqual([
      viewerId(viewerA),
      viewerId(viewerB),
      viewerId(lateViewer),
    ].sort());
    expect(lateGrantAck.grant.event_sequence).toBe(8);
    await expect(nextJson(lateViewer)).resolves.toEqual(lateGrantAck.grant);

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

    const lateAnswer = { ...answer };
    const forwardedLateAnswer = nextJson(controller);
    lateViewer.send(JSON.stringify(lateAnswer));
    await expect(forwardedLateAnswer).resolves.toEqual({
      ...lateAnswer,
      from_id: viewerId(lateViewer),
    });

    const audienceAfterClose = nextJson(controller);
    viewerB.close(1000, "viewer_hidden");
    const audienceAck = readGrantAck(await audienceAfterClose, "media_grant_accepted");
    expect(audienceAck.grant.event_sequence).toBe(9);
    expect(audienceAck.viewer_ids).toEqual([
      viewerId(viewerA),
      viewerId(lateViewer),
    ].sort());

    const revokeForA = nextJson(viewerA);
    const revokeForLate = nextJson(lateViewer);
    const revokeAckPromise = nextJson(controller);
    controller.send(JSON.stringify({ type: "media_grant_revoke", grant_id: grantId }));
    const revokeAck = readGrantAck(await revokeAckPromise, "media_grant_revoked");
    expect(revokeAck.grant.event_sequence).toBe(10);
    expect(revokeAck.grant.payload).toMatchObject({ grant_id: grantId, status: "revoked" });
    await expect(revokeForA).resolves.toEqual(revokeAck.grant);
    await expect(revokeForLate).resolves.toEqual(revokeAck.grant);
  });

  it("revokes an active kitchen grant when an unverified replacement is rejected", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();
    const scene = makeSceneEvent(lease.session_id, 0, "kitchen");
    await publishEvent(controller, scene, [viewer]);

    vi.stubGlobal("fetch", vi.fn(async () => mimoActivityResponse("cooking", 0.87)));
    await recognize(lease.token, MINIMAL_JPEG_B64);
    await recognize(lease.token, MINIMAL_JPEG_B64);
    const verified = makeActivityEvent(lease.session_id, 1);
    await publishEvent(controller, verified, [viewer]);

    const grantForViewer = nextJson(viewer);
    const grantAckPromise = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    const grantAck = readGrantAck(await grantAckPromise, "media_grant_accepted");
    await expect(grantForViewer).resolves.toEqual(grantAck.grant);
    const grantId = mediaGrantId(grantAck.grant);

    const controllerRejection = nextJsonBatch(controller, 2);
    const viewerRevocation = nextJson(viewer);
    controller.send(JSON.stringify(makeActivityEvent(lease.session_id, 3)));
    const [error, revokedValue] = await controllerRejection;
    expect(error).toEqual({
      type: "error",
      error: "activity_evidence_not_verified",
      event_sequence: 3,
      event_type: "activity_state",
    });
    const revoked = readGrantAck(revokedValue, "media_grant_revoked");
    expect(revoked.grant.payload).toMatchObject({
      grant_id: grantId,
      status: "revoked",
    });
    await expect(viewerRevocation).resolves.toEqual(revoked.grant);

    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(scene);
    await expect(nextJson(lateViewer)).resolves.toEqual(verified);
    await expectNoMessage(lateViewer);

    controller.send(JSON.stringify({
      schema_version: MEDIA_SIGNAL_SCHEMA_VERSION,
      grant_id: grantId,
      target_id: viewerId(viewer),
      signal_type: "offer",
      signal: { sdp: "v=0\r\n" },
    } satisfies MediaSignal));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "media_signal_not_authorized",
    });
  });

  it("revokes media grants on disconnect while keeping the lease resumable", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), [viewer]);
    vi.stubGlobal("fetch", vi.fn(async () => mimoActivityResponse("cooking", 0.87)));
    await recognize(lease.token, MINIMAL_JPEG_B64);
    await recognize(lease.token, MINIMAL_JPEG_B64);
    await publishEvent(controller, makeActivityEvent(lease.session_id, 1), [viewer]);

    const grantedForViewer = nextJson(viewer);
    const grantAckPromise = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    const grantAck = readGrantAck(await grantAckPromise, "media_grant_accepted");
    await expect(grantedForViewer).resolves.toEqual(grantAck.grant);

    const revokedForViewer = nextJson(viewer);
    await closeControllerSocket(controller, 4001, "controller_network_lost");
    await expect(revokedForViewer).resolves.toMatchObject({
      event_sequence: 3,
      event_type: "media_grant",
      payload: {
        grant_id: mediaGrantId(grantAck.grant),
        status: "revoked",
      },
    });

    const status = await relayFetch("/api/status");
    await expect(status.json()).resolves.toMatchObject({
      controller_locked: true,
      controller_connected: false,
      session_id: lease.session_id,
    });
    const resumedController = await connectController(lease.token);
    await expect(nextJson(resumedController)).resolves.toMatchObject({
      type: "controller_ready",
      session_id: lease.session_id,
      last_event_sequence: 3,
      last_frame_sequence: -1,
    });
  });

  it("keeps a verified cooking fact across 200 seconds of one capture but closes on unavailable", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "kitchen", baseTime),
        [],
      );
      vi.stubGlobal("fetch", vi.fn(async () => mimoActivityResponse("cooking", 0.87)));
      const first = await (await recognize(lease.token, MINIMAL_JPEG_B64)).json<{
        receipt_id: string | null;
        consecutive: number;
      }>();
      const second = await (await recognize(lease.token, MINIMAL_JPEG_B64)).json<{
        receipt_id: string | null;
        consecutive: number;
      }>();
      expect(first).toMatchObject({ receipt_id: null, consecutive: 1 });
      expect(second).toMatchObject({ consecutive: 2 });
      expect(second.receipt_id).toMatch(/^activity-receipt-[a-f0-9]{32}$/);
      await publishEvent(controller, makeActivityEvent(lease.session_id, 1), []);

      const firstGrantPromise = nextJson(controller);
      controller.send(JSON.stringify({
        type: "media_grant_request",
        event_id: "activity-1",
        scope: "kitchen_moment",
        expires_in_ms: 5_000,
      }));
      const firstGrant = readGrantAck(await firstGrantPromise, "media_grant_accepted");

      now.mockReturnValue(baseTime + 5_001);
      const firstExpired = nextJson(controller);
      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
      expect(readGrantAck(await firstExpired, "media_grant_revoked").grant.payload)
        .toMatchObject({ status: "expired" });

      for (let offsetMs = 25_000; offsetMs <= 200_000; offsetMs += 25_000) {
        now.mockReturnValue(baseTime + offsetMs);
        const heartbeatAck = nextJson(controller);
        controller.send(JSON.stringify({ type: "heartbeat" }));
        await expect(heartbeatAck).resolves.toEqual({
          type: "heartbeat_ack",
          lease_expires_at_ms: baseTime + offsetMs + 30_000,
        });
      }
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: baseTime + 230_000,
      });

      const continuedPromise = nextJson(controller);
      controller.send(JSON.stringify({
        type: "media_grant_request",
        event_id: "activity-1",
        scope: "kitchen_moment",
        expires_in_ms: 5_000,
      }));
      const continued = readGrantAck(await continuedPromise, "media_grant_accepted");
      expect(mediaGrantId(continued.grant)).not.toBe(mediaGrantId(firstGrant.grant));
      if (continued.grant.event_type !== "media_grant") throw new Error("expected media grant");
      const continuedExpiry = continued.grant.payload.expires_at_ms;

      const lateAudience = nextJson(controller);
      const lateViewer = await connectViewer();
      await expect(nextJson(lateViewer)).resolves.toEqual(
        makeSceneEvent(lease.session_id, 0, "kitchen", baseTime),
      );
      await expect(nextJson(lateViewer)).resolves.toEqual(makeActivityEvent(lease.session_id, 1));
      const lateAck = readGrantAck(await lateAudience, "media_grant_accepted");
      expect(lateAck.viewer_ids).toEqual([viewerId(lateViewer)]);
      if (lateAck.grant.event_type !== "media_grant") throw new Error("expected media grant");
      expect(lateAck.grant.payload.expires_at_ms).toBe(continuedExpiry);
      await expect(nextJson(lateViewer)).resolves.toEqual(lateAck.grant);

      const unavailable = makeActivityEvent(
        lease.session_id,
        6,
        "unavailable",
      );
      const viewerClosed = nextJsonBatch(lateViewer, 2);
      const controllerClosed = nextJsonBatch(controller, 2);
      controller.send(JSON.stringify(unavailable));
      const [unavailableForViewer, revokedForViewer] = await viewerClosed;
      expect(unavailableForViewer).toEqual(unavailable);
      const [unavailableAck, revokedAckValue] = await controllerClosed;
      expect(unavailableAck).toEqual({
        type: "event_accepted",
        event_sequence: 6,
        event_type: "activity_state",
      });
      const revokedAck = readGrantAck(revokedAckValue, "media_grant_revoked");
      expect(revokedAck.grant.payload).toMatchObject({ status: "revoked" });
      expect(revokedForViewer).toEqual(revokedAck.grant);

      controller.send(JSON.stringify({
        type: "media_grant_request",
        event_id: "activity-1",
        scope: "kitchen_moment",
        expires_in_ms: 5_000,
      }));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "media_grant_not_eligible",
      });

      const restartedWithoutEvidence = makeActivityEvent(lease.session_id, 8);
      controller.send(JSON.stringify(restartedWithoutEvidence));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "activity_evidence_not_verified",
        event_sequence: 8,
        event_type: "activity_state",
      });
      await expectNoMessage(lateViewer);
      controller.send(JSON.stringify({
        type: "media_grant_request",
        event_id: "activity-8",
        scope: "kitchen_moment",
        expires_in_ms: 5_000,
      }));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "media_grant_not_eligible",
      });

      const afterRestart = await connectViewer();
      await expect(nextJson(afterRestart)).resolves.toEqual(
        makeSceneEvent(lease.session_id, 0, "kitchen", baseTime),
      );
      await expect(nextJson(afterRestart)).resolves.toEqual(unavailable);
      await expectNoMessage(afterRestart);
    } finally {
      now.mockRestore();
    }
  });

  it("revokes verified kitchen media on scene leave and never admits a late viewer", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), [viewer]);
    vi.stubGlobal("fetch", vi.fn(async () => mimoActivityResponse("cooking", 0.87)));
    await recognize(lease.token, MINIMAL_JPEG_B64);
    await recognize(lease.token, MINIMAL_JPEG_B64);
    await publishEvent(controller, makeActivityEvent(lease.session_id, 1), [viewer]);

    const activeForViewer = nextJson(viewer);
    const activeForController = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    const active = readGrantAck(await activeForController, "media_grant_accepted");
    await expect(activeForViewer).resolves.toEqual(active.grant);

    const living = makeSceneEvent(lease.session_id, 3, "living");
    const viewerMessages = nextJsonBatch(viewer, 2);
    const controllerMessages = nextJsonBatch(controller, 2);
    controller.send(JSON.stringify(living));
    const [livingForViewer, revokedForViewer] = await viewerMessages;
    expect(livingForViewer).toEqual(living);
    const [livingAck, revokedAckValue] = await controllerMessages;
    expect(livingAck).toEqual({
      type: "event_accepted",
      event_sequence: 3,
      event_type: "scene_state",
    });
    const revokedAck = readGrantAck(revokedAckValue, "media_grant_revoked");
    expect(revokedAck.grant.payload).toMatchObject({ status: "revoked" });
    expect(revokedForViewer).toEqual(revokedAck.grant);

    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "activity-1",
      scope: "kitchen_moment",
      expires_in_ms: 30_000,
    }));
    await expect(nextJson(controller)).resolves.toEqual({
      type: "error",
      error: "media_grant_not_eligible",
    });
    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(makeActivityEvent(lease.session_id, 1));
    await expect(nextJson(lateViewer)).resolves.toEqual(living);
    await expectNoMessage(lateViewer);
  });

  it("issues fall media only for a matching escalated alarm", async () => {
    const baseTime = Date.now();
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const viewer = await connectViewer();
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "fall"), [viewer]);
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 1, "checking", baseTime),
      [viewer],
    );

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

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 2, "escalated", baseTime + 1),
      [viewer],
    );
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

    const resolved = makeAlarmEvent(lease.session_id, 4, "resolved", baseTime + 2);
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

  it("expires an idle media grant from the Durable Object clock and reschedules the lease", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 1, "escalated", baseTime),
        [viewer],
      );
      const viewerGrant = nextJson(viewer);
      const grantAckPromise = nextJson(controller);
      controller.send(JSON.stringify({
        type: "media_grant_request",
        event_id: "fall-1",
        scope: "fall_emergency",
        expires_in_ms: 5_000,
      }));
      const grantAck = readGrantAck(await grantAckPromise, "media_grant_accepted");
      await expect(viewerGrant).resolves.toEqual(grantAck.grant);
      if (grantAck.grant.event_type !== "media_grant") throw new Error("expected media grant");
      const authoritativeExpiry = grantAck.grant.payload.expires_at_ms;
      expect(authoritativeExpiry).toBe(baseTime + 5_000);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: authoritativeExpiry,
      });

      now.mockReturnValue(authoritativeExpiry + 1);
      const expiredForViewer = nextJson(viewer);
      const expiredForController = nextJson(controller);
      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
      const expiredAck = readGrantAck(
        await expiredForController,
        "media_grant_revoked",
      );
      expect(expiredAck.grant.payload).toMatchObject({
        grant_id: mediaGrantId(grantAck.grant),
        expires_at_ms: authoritativeExpiry,
        status: "expired",
      });
      await expect(expiredForViewer).resolves.toEqual(expiredAck.grant);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: lease.lease_expires_at_ms,
      });
    } finally {
      now.mockRestore();
    }
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
      const expiredForViewer = nextJson(viewer);
      const controllerExpiry = nextJsonBatch(controller, 2);
      controller.send(JSON.stringify({
        ...wrongDirection,
        signal_type: "offer",
      }));
      const [expiredAckValue, signalError] = await controllerExpiry;
      const expiredAck = readGrantAck(expiredAckValue, "media_grant_revoked");
      expect(expiredAck.grant.payload).toMatchObject({ status: "expired" });
      await expect(expiredForViewer).resolves.toEqual(expiredAck.grant);
      expect(signalError).toEqual({
        type: "error",
        error: "media_signal_not_authorized",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("recognizes one bounded JPEG only with the active control token", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), []);
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
      receipt_id: null,
      consecutive: 1,
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
    const controller = await connectController(lease.token);
    await nextJson(controller);
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), []);
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

    vi.stubGlobal("fetch", vi.fn(async () => mimoActivityResponse("cooking", 0.87)));
    const retry = await recognize(lease.token, "/9j/2Q==");
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      ok: true,
      classification: "cooking",
      consecutive: 1,
    });
  });

  it("single-flights overlapping activity recognition before a second MiMo call", async () => {
    const token = "b".repeat(64);
    let inflight = false;
    const authority = {
      beginAttempt: vi.fn(async () => {
        if (inflight) {
          return { ok: false, error: "activity_request_in_progress" } as const;
        }
        inflight = true;
        return { ok: true, attempt_id: crypto.randomUUID() } as const;
      }),
      cancelAttempt: vi.fn(async () => {
        inflight = false;
      }),
      finishAttempt: vi.fn(async () => {
        inflight = false;
        return { receipt_id: null, consecutive: 1 };
      }),
    };
    let resolveUpstream: (response: Response) => void = () => {
      throw new Error("activity upstream resolver was not installed");
    };
    const outbound = vi.fn(async () => new Promise<Response>((resolve) => {
      resolveUpstream = resolve;
    }));
    vi.stubGlobal("fetch", outbound);

    const request = () => new Request("https://relay.example/api/activity/recognize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_b64: MINIMAL_JPEG_B64 }),
    });
    const activityEnv = {
      MIMO_API_KEY: "test-key",
      MIMO_BASE_URL: "https://api.xiaomimimo.com/v1",
      MIMO_MODEL: "mimo-v2.5",
    } as unknown as Env;
    const first = handleActivityRecognition(request(), activityEnv, authority);
    await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
    const overlapping = await handleActivityRecognition(request(), activityEnv, authority);
    expect(overlapping.status).toBe(409);
    await expect(overlapping.json()).resolves.toEqual({
      ok: false,
      error: "activity_request_in_progress",
    });
    expect(outbound).toHaveBeenCalledTimes(1);

    resolveUpstream(mimoActivityResponse("cooking", 0.87));
    const firstResponse = await first;
    expect(firstResponse.status).toBe(200);
    await expect(firstResponse.json()).resolves.toMatchObject({
      receipt_id: null,
      consecutive: 1,
    });
    expect(authority.finishAttempt).toHaveBeenCalledTimes(1);
    expect(authority.cancelAttempt).not.toHaveBeenCalled();
  });

  it("starts cooking evidence from one after an unavailable generation boundary", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), []);
    const tokenHash = await testSha256Hex(lease.token);

    const first = await runInDurableObject(
      roomStub(),
      (instance) => instance.beginActivityRecognitionAttempt(tokenHash),
    );
    if (!first.ok) throw new Error("first activity attempt should start");
    await expect(runInDurableObject(
      roomStub(),
      (instance) => instance.finishActivityRecognitionAttempt(
        tokenHash,
        first.attempt_id,
        { classification: "cooking", confidence: 0.87, reason: "第一次真实做饭" },
      ),
    )).resolves.toEqual({ receipt_id: null, consecutive: 1 });

    await publishEvent(
      controller,
      makeActivityEvent(lease.session_id, 1, "unavailable"),
      [],
    );
    const restarted = await runInDurableObject(
      roomStub(),
      (instance) => instance.beginActivityRecognitionAttempt(tokenHash),
    );
    if (!restarted.ok) throw new Error("restarted activity attempt should start");
    await expect(runInDurableObject(
      roomStub(),
      (instance) => instance.finishActivityRecognitionAttempt(
        tokenHash,
        restarted.attempt_id,
        { classification: "cooking", confidence: 0.87, reason: "新采集第一次做饭" },
      ),
    )).resolves.toEqual({ receipt_id: null, consecutive: 1 });
  });

  it("rejects an in-flight activity finish after its generation is invalidated", async () => {
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "kitchen"), []);
    const tokenHash = await testSha256Hex(lease.token);
    const stale = await runInDurableObject(
      roomStub(),
      (instance) => instance.beginActivityRecognitionAttempt(tokenHash),
    );
    if (!stale.ok) throw new Error("activity attempt should start");

    await publishEvent(
      controller,
      makeActivityEvent(lease.session_id, 1, "unavailable"),
      [],
    );
    await expect(runInDurableObject(
      roomStub(),
      (instance) => instance.finishActivityRecognitionAttempt(
        tokenHash,
        stale.attempt_id,
        { classification: "cooking", confidence: 0.87, reason: "失效后的旧响应" },
      ),
    )).resolves.toBeNull();

    const current = await runInDurableObject(
      roomStub(),
      (instance) => instance.beginActivityRecognitionAttempt(tokenHash),
    );
    if (!current.ok) throw new Error("new activity generation should start");
    await expect(runInDurableObject(
      roomStub(),
      (instance) => instance.finishActivityRecognitionAttempt(
        tokenHash,
        current.attempt_id,
        { classification: "cooking", confidence: 0.87, reason: "新代次响应" },
      ),
    )).resolves.toEqual({ receipt_id: null, consecutive: 1 });
  });

  it("a stale activity finish cannot clear the newer in-flight attempt", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "kitchen", baseTime),
        [],
      );
      const tokenHash = await testSha256Hex(lease.token);
      const first = await runInDurableObject(
        roomStub(),
        (instance) => instance.beginActivityRecognitionAttempt(tokenHash),
      );
      if (!first.ok) throw new Error("first activity attempt should start");

      now.mockReturnValue(baseTime + 10_001);
      const second = await runInDurableObject(
        roomStub(),
        (instance) => instance.beginActivityRecognitionAttempt(tokenHash),
      );
      if (!second.ok) throw new Error("stale activity attempt should be replaceable");
      await expect(runInDurableObject(
        roomStub(),
        (instance) => instance.finishActivityRecognitionAttempt(
          tokenHash,
          first.attempt_id,
          { classification: "cooking", confidence: 0.87, reason: "旧响应" },
        ),
      )).resolves.toBeNull();
      await expect(runInDurableObject(
        roomStub(),
        (instance) => instance.finishActivityRecognitionAttempt(
          tokenHash,
          second.attempt_id,
          { classification: "cooking", confidence: 0.87, reason: "新响应" },
        ),
      )).resolves.toEqual({ receipt_id: null, consecutive: 1 });
    } finally {
      now.mockRestore();
    }
  });

  it("recognizes one event-scoped WAV through the MiMo input_audio path without sensitive logs", async () => {
    const lease = await unlock();
    await prepareDangerChecking(lease);
    const audioB64 = makePcmWavBase64();
    const outbound = vi.fn(
      async (..._args: Parameters<typeof fetch>): Promise<Response> =>
        mimoVoiceResponse("safe", "我没事"),
    );
    vi.stubGlobal("fetch", outbound);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const response = await recognizeDangerVoice(lease.token, "fall-1", audioB64);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      intent: "safe",
      transcript: "我没事",
      model: "mimo-v2.5",
      latency_ms: expect.any(Number),
    });
    expect(outbound).toHaveBeenCalledTimes(1);
    const call = outbound.mock.calls[0];
    expect(String(call?.[0])).toBe("https://api.xiaomimimo.com/v1/chat/completions");
    const init = call?.[1];
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-mimo-api-key");
    const payload = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: unknown }>;
      thinking: unknown;
      response_format: unknown;
    };
    expect(payload.model).toBe("mimo-v2.5");
    expect(payload.messages[1]?.content).toEqual([
      { type: "text", text: "这是老人对“您还好吗、是否需要帮助”的短语音回应。" },
      {
        type: "input_audio",
        input_audio: { data: `data:audio/wav;base64,${audioB64}` },
      },
    ]);
    expect(payload.thinking).toEqual({ type: "disabled" });
    expect(payload.response_format).toEqual({ type: "json_object" });

    expect(log).toHaveBeenCalledTimes(1);
    const logRecord = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(logRecord).toEqual({
      event: "danger_voice_mimo",
      event_id: "fall-1",
      request_id: expect.any(String),
      provider: "xiaomi_mimo",
      model: "mimo-v2.5",
      status: 200,
      latency_ms: expect.any(Number),
      outcome: "safe",
      bytes: 8_044,
    });
    const serializedLogs = JSON.stringify(log.mock.calls);
    expect(serializedLogs).not.toContain(audioB64);
    expect(serializedLogs).not.toContain(lease.token);
    expect(serializedLogs).not.toContain("我没事");
  });

  it("keeps danger voice method, token, event, and body failures closed before MiMo", async () => {
    const outbound = vi.fn(async (): Promise<Response> => mimoVoiceResponse("safe", "我没事"));
    vi.stubGlobal("fetch", outbound);

    const wrongMethod = await relayFetch("/api/danger/voice");
    expect(wrongMethod.status).toBe(405);
    await expect(wrongMethod.json()).resolves.toEqual({ ok: false, error: "method_not_allowed" });

    const missingToken = await relayFetch("/api/danger/voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dangerVoiceBody()),
    });
    expect(missingToken.status).toBe(401);
    await expect(missingToken.json()).resolves.toEqual({
      ok: false,
      error: "missing_control_token",
    });

    const lease = await unlock();
    const noEvent = await recognizeDangerVoice(lease.token);
    expect(noEvent.status).toBe(409);
    await expect(noEvent.json()).resolves.toEqual({
      ok: false,
      error: "no_active_danger_event",
    });

    await prepareDangerChecking(lease);
    const variants: Array<{ body: unknown; status: number; error: string }> = [
      {
        body: { ...dangerVoiceBody(), unexpected: true },
        status: 400,
        error: "invalid_request",
      },
      {
        body: dangerVoiceBody("fall-1", "not-base64"),
        status: 415,
        error: "invalid_wav",
      },
      {
        body: dangerVoiceBody("fall-1", bytesToBase64(new Uint8Array([1, 2, 3, 4]))),
        status: 415,
        error: "invalid_wav",
      },
      {
        body: dangerVoiceBody("fall-1", makePcmWavBase64(10_001)),
        status: 415,
        error: "invalid_wav",
      },
    ];
    for (const variant of variants) {
      const rejected = await relayFetch("/api/danger/voice", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lease.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(variant.body),
      });
      expect(rejected.status).toBe(variant.status);
      await expect(rejected.json()).resolves.toEqual({ ok: false, error: variant.error });
    }

    const tooLarge = await relayFetch("/api/danger/voice", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.token}`,
        "Content-Length": String(450 * 1_024 + 1),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dangerVoiceBody()),
    });
    expect(tooLarge.status).toBe(413);
    await expect(tooLarge.json()).resolves.toEqual({
      ok: false,
      error: "request_too_large",
    });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("applies conservative deterministic guardrails to MiMo voice intent", async () => {
    const lease = await unlock();
    const baseTime = Date.now();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "fall", baseTime), []);
    const outbound = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementationOnce(
        async () => mimoVoiceResponse("safe", "我摔倒了，腿很疼，需要帮助"),
      )
      .mockImplementationOnce(
        async () => mimoVoiceResponse("safe", "我不需要帮助，也不疼，没摔倒"),
      )
      .mockImplementationOnce(async () => mimoVoiceResponse("unclear", "腿疼"))
      .mockImplementationOnce(async () => mimoVoiceResponse("safe", null));
    vi.stubGlobal("fetch", outbound);

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 1, "checking", baseTime, "fall-help"),
      [],
    );
    const explicitHelp = await recognizeDangerVoice(lease.token, "fall-help");
    await expect(explicitHelp.json()).resolves.toMatchObject({ ok: true, intent: "need_help" });
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 2, "escalated", baseTime + 1, "fall-help"),
      [],
    );
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 3, "resolved", baseTime + 2, "fall-help"),
      [],
    );

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 4, "checking", baseTime + 3, "fall-safe"),
      [],
    );
    const negated = await recognizeDangerVoice(lease.token, "fall-safe");
    await expect(negated.json()).resolves.toMatchObject({ ok: true, intent: "safe" });
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 5, "resolved", baseTime + 4, "fall-safe"),
      [],
    );

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 6, "checking", baseTime + 5, "fall-soft"),
      [],
    );
    const softConcern = await recognizeDangerVoice(lease.token, "fall-soft");
    await expect(softConcern.json()).resolves.toMatchObject({ ok: true, intent: "need_help" });
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 7, "escalated", baseTime + 6, "fall-soft"),
      [],
    );
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 8, "resolved", baseTime + 7, "fall-soft"),
      [],
    );

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 9, "checking", baseTime + 8, "fall-silent"),
      [],
    );
    const silentSafe = await recognizeDangerVoice(lease.token, "fall-silent");
    await expect(silentSafe.json()).resolves.toMatchObject({ ok: true, intent: "unclear" });
    expect(outbound).toHaveBeenCalledTimes(4);
  });

  it("allows only one paid voice attempt per event, including after failure and republish", async () => {
    const lease = await unlock();
    const baseTime = Date.now();
    const controller = await prepareDangerChecking(lease, baseTime);
    const outbound = vi.fn(async (): Promise<Response> => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", outbound);

    const first = await recognizeDangerVoice(lease.token);
    expect(first.status).toBe(502);
    await expect(first.json()).resolves.toEqual({ ok: false, error: "mimo_unavailable" });

    const retry = await recognizeDangerVoice(lease.token);
    expect(retry.status).toBe(429);
    await expect(retry.json()).resolves.toEqual({ ok: false, error: "voice_attempt_limit" });

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 2, "checking", baseTime, "fall-1"),
      [],
    );
    const republished = await recognizeDangerVoice(lease.token);
    expect(republished.status).toBe(429);
    await expect(republished.json()).resolves.toEqual({
      ok: false,
      error: "voice_attempt_limit",
    });
    expect(outbound).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent voice requests without a second MiMo call", async () => {
    const lease = await unlock();
    await prepareDangerChecking(lease);
    const outbound = vi.fn(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return mimoVoiceResponse("safe", "我没事");
      },
    );
    vi.stubGlobal("fetch", outbound);

    const firstPromise = recognizeDangerVoice(lease.token);
    await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
    const concurrent = await recognizeDangerVoice(lease.token);
    expect(concurrent.status).toBe(409);
    await expect(concurrent.json()).resolves.toEqual({
      ok: false,
      error: "voice_request_in_progress",
    });
    expect(outbound).toHaveBeenCalledTimes(1);

    const first = await firstPromise;
    expect(first.status).toBe(200);
  });

  it("rejects an already-expired checking window before calling MiMo", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      await prepareDangerChecking(lease, baseTime);
      const outbound = vi.fn(async (): Promise<Response> => mimoVoiceResponse("safe", "我没事"));
      vi.stubGlobal("fetch", outbound);

      now.mockReturnValue(baseTime + 8_001);
      const expired = await recognizeDangerVoice(lease.token);
      expect(expired.status).toBe(409);
      await expect(expired.json()).resolves.toEqual({
        ok: false,
        error: "no_active_danger_event",
      });
      expect(outbound).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it("drops a safe verdict that arrives after the frozen checking deadline", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      await prepareDangerChecking(lease, baseTime);
      const outbound = vi.fn(
        async (..._args: Parameters<typeof fetch>): Promise<Response> => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return mimoVoiceResponse("safe", "我没事");
        },
      );
      vi.stubGlobal("fetch", outbound);

      const request = recognizeDangerVoice(lease.token);
      await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
      now.mockReturnValue(baseTime + 8_001);

      const stale = await request;
      expect(stale.status).toBe(409);
      await expect(stale.json()).resolves.toEqual({
        ok: false,
        error: "stale_danger_event",
      });
    } finally {
      now.mockRestore();
    }
  });

  it("drops a late safe verdict after the alarm has already escalated", async () => {
    const lease = await unlock();
    const baseTime = Date.now();
    const controller = await prepareDangerChecking(lease, baseTime);
    const outbound = vi.fn(
      async (..._args: Parameters<typeof fetch>): Promise<Response> => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return mimoVoiceResponse("safe", "我没事");
      },
    );
    vi.stubGlobal("fetch", outbound);

    const request = recognizeDangerVoice(lease.token);
    await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 2, "escalated", baseTime + 1),
      [],
    );

    const stale = await request;
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      ok: false,
      error: "stale_danger_event",
    });
  });

  it("persists a checking deadline and reschedules an early Durable Object alarm", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      const deadline = baseTime + 8_000;
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 1, "checking", baseTime, "fall-1", deadline),
        [viewer],
      );

      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: deadline,
        watchdogs: [{
          session_id: lease.session_id,
          event_id: "fall-1",
          deadline_ms: deadline,
          status: "checking",
        }],
        last_event_sequence: 1,
      });

      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
      await expectNoMessage(viewer);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: deadline,
        watchdogs: [{ status: "checking", deadline_ms: deadline }],
        last_event_sequence: 1,
      });

      now.mockReturnValue(deadline + 1);
      const escalatedForViewer = nextJson(viewer);
      const escalatedForController = nextJson(controller);
      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
      const authoritativeEscalation = await escalatedForViewer;
      expect(authoritativeEscalation).toMatchObject({
        session_id: lease.session_id,
        event_sequence: 2,
        timestamp_ms: deadline + 1,
        event_type: "alarm_state",
        payload: {
          event_id: "fall-1",
          phase: "escalated",
          trigger: "check_in_timeout",
          response_deadline_ms: null,
          media_scope: "fall_emergency",
        },
      });
      await expect(escalatedForController).resolves.toEqual(authoritativeEscalation);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: lease.lease_expires_at_ms,
        watchdogs: [{ status: "escalated", deadline_ms: deadline }],
        alarm_event: {
          event_sequence: 2,
          event_type: "alarm_state",
          payload: { phase: "escalated", trigger: "check_in_timeout" },
        },
        last_event_sequence: 2,
      });
      const noViewerDuplicate = expectNoMessage(viewer);
      const noControllerDuplicate = expectNoMessage(controller);
      await runInDurableObject(roomStub(), (instance) => instance.alarm());
      await Promise.all([noViewerDuplicate, noControllerDuplicate]);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: lease.lease_expires_at_ms,
        watchdogs: [{ status: "escalated", deadline_ms: deadline }],
        alarm_event: { event_sequence: 2, event_type: "alarm_state" },
        last_event_sequence: 2,
      });
      // The lease deadline remains scheduled after the watchdog is terminal.
      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("ACKs a controller escalation that races with the authoritative watchdog", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      const deadline = baseTime + 8_000;
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 1, "checking", baseTime, "fall-1", deadline),
        [viewer],
      );

      now.mockReturnValue(deadline + 1);
      const escalatedForViewer = nextJson(viewer);
      const escalatedForController = nextJson(controller);
      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
      const authoritativeEscalation = await escalatedForViewer;
      expect(authoritativeEscalation).toMatchObject({
        event_sequence: 2,
        event_type: "alarm_state",
        payload: { event_id: "fall-1", phase: "escalated" },
      });
      await expect(escalatedForController).resolves.toEqual(authoritativeEscalation);

      const noConflictDuplicate = expectNoMessage(viewer);
      const conflictMessages = nextJsonBatch(controller, 2);
      controller.send(JSON.stringify(makeAlarmEvent(
        lease.session_id,
        3,
        "escalated",
        deadline + 1,
        "fall-1",
        null,
        "elder_need_help",
      )));
      await expect(conflictMessages).resolves.toEqual([
        authoritativeEscalation,
        { type: "error", error: "danger_authoritative_alarm_conflict" },
      ]);
      await noConflictDuplicate;
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{ status: "escalated" }],
        alarm_event: {
          event_sequence: 2,
          payload: { phase: "escalated", trigger: "check_in_timeout" },
        },
        last_event_sequence: 2,
      });

      const noDuplicate = expectNoMessage(viewer);
      controller.send(JSON.stringify(
        makeAlarmEvent(lease.session_id, 2, "escalated", deadline + 1),
      ));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "event_accepted",
        event_sequence: 2,
        event_type: "alarm_state",
      });
      await noDuplicate;

      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 3, "resolved", deadline + 2),
        [viewer],
      );
      expect(controller.readyState).toBe(WebSocket.OPEN);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{ status: "resolved" }],
        alarm_event: { event_sequence: 3, event_type: "alarm_state" },
        last_event_sequence: 3,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("allows a checking deadline to shorten but rejects extension and scene abandonment", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(
          lease.session_id,
          1,
          "checking",
          baseTime,
          "fall-1",
          baseTime + 8_000,
        ),
        [],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(
          lease.session_id,
          2,
          "checking",
          baseTime + 100,
          "fall-1",
          baseTime + 6_000,
        ),
        [],
      );

      controller.send(JSON.stringify(makeAlarmEvent(
        lease.session_id,
        3,
        "checking",
        baseTime + 200,
        "fall-1",
        baseTime + 7_000,
      )));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "danger_deadline_extension_forbidden",
      });

      controller.send(JSON.stringify(
        makeSceneEvent(lease.session_id, 3, "living", baseTime + 300),
      ));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "danger_check_in_active",
      });

      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: baseTime + 6_000,
        watchdogs: [{
          event_id: "fall-1",
          deadline_ms: baseTime + 6_000,
          status: "checking",
        }],
        alarm_event: {
          event_sequence: 2,
          event_type: "alarm_state",
          payload: { response_deadline_ms: baseTime + 6_000 },
        },
        last_event_sequence: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("upgrades before rejecting a resolved event received after its deadline", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      const deadline = baseTime + 8_000;
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 1, "checking", baseTime, "fall-1", deadline),
        [viewer],
      );

      now.mockReturnValue(deadline + 1);
      const escalatedForViewer = nextJson(viewer);
      const controllerMessages = nextJsonBatch(controller, 2);
      controller.send(JSON.stringify(
        makeAlarmEvent(lease.session_id, 2, "resolved", deadline + 1),
      ));
      const [escalatedForController, rejection] = await controllerMessages;
      expect(rejection).toEqual({
        type: "error",
        error: "danger_deadline_elapsed",
      });
      const authoritativeEscalation = await escalatedForViewer;
      expect(authoritativeEscalation).toMatchObject({
        event_sequence: 2,
        event_type: "alarm_state",
        payload: {
          event_id: "fall-1",
          phase: "escalated",
          trigger: "check_in_timeout",
        },
      });
      expect(escalatedForController).toEqual(authoritativeEscalation);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: lease.lease_expires_at_ms,
        watchdogs: [{ status: "escalated" }],
        alarm_event: {
          event_sequence: 2,
          event_type: "alarm_state",
          payload: { phase: "escalated" },
        },
        last_event_sequence: 2,
      });

      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 3, "resolved", deadline + 2),
        [viewer],
      );
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{ status: "resolved" }],
        alarm_event: {
          event_sequence: 3,
          event_type: "alarm_state",
          payload: { phase: "resolved" },
        },
        last_event_sequence: 3,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("rolls an unresolved release escalation into the next session until explicitly closed", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      const deadline = baseTime + 8_000;
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(lease.session_id, 1, "checking", baseTime, "fall-1", deadline),
        [viewer],
      );

      const escalatedForViewer = nextJson(viewer);
      await release(lease.token);
      const releasedEscalation = await escalatedForViewer;
      expect(releasedEscalation).toMatchObject({
        session_id: lease.session_id,
        event_sequence: 2,
        event_type: "alarm_state",
        payload: { phase: "escalated", trigger: "check_in_timeout" },
      });
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: null,
        watchdogs: [{ status: "escalated" }],
        alarm_event: {
          event_sequence: 2,
          event_type: "alarm_state",
          payload: { phase: "escalated" },
        },
        last_event_sequence: 2,
      });
      const releasedStatus = await relayFetch("/api/status");
      await expect(releasedStatus.json()).resolves.toMatchObject({
        controller_locked: false,
        controller_connected: false,
      });

      const freshViewer = await connectViewer();
      await expect(nextJson(freshViewer)).resolves.toEqual(releasedEscalation);

      const rolloverForViewer = nextJson(viewer);
      const nextLease = await unlock();
      expect(nextLease.session_id).not.toBe(lease.session_id);
      const rolledAlarm = await rolloverForViewer;
      expect(rolledAlarm).toMatchObject({
        session_id: nextLease.session_id,
        event_sequence: 0,
        event_type: "alarm_state",
        payload: {
          event_id: "fall-1",
          phase: "escalated",
          trigger: "check_in_timeout",
        },
      });
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: nextLease.lease_expires_at_ms,
        watchdogs: [{
          session_id: nextLease.session_id,
          event_id: "fall-1",
          deadline_ms: deadline,
          status: "escalated",
        }],
        alarm_event: rolledAlarm,
        last_event_sequence: 0,
      });

      const nextController = await connectController(nextLease.token);
      await expect(nextJson(nextController)).resolves.toEqual({
        type: "controller_ready",
        session_id: nextLease.session_id,
        lease_expires_at_ms: nextLease.lease_expires_at_ms,
        last_event_sequence: 0,
        last_frame_sequence: -1,
        current_alarm: rolledAlarm,
      });

      for (const staleTrigger of ["fall_transition", "voice_intent"] as const) {
        nextController.send(JSON.stringify(makeAlarmEvent(
          nextLease.session_id,
          1,
          "resolved",
          baseTime + 1,
          "fall-1",
          null,
          staleTrigger,
        )));
        await expect(nextJson(nextController)).resolves.toEqual({
          type: "error",
          error: "danger_stale_resolution",
        });
      }
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{ status: "escalated" }],
        alarm_event: rolledAlarm,
        last_event_sequence: 0,
      });

      await publishEvent(
        nextController,
        makeAlarmEvent(
          nextLease.session_id,
          1,
          "resolved",
          baseTime + 2,
          "fall-1",
          null,
          "check_in_timeout",
        ),
        [viewer],
      );
      await release(nextLease.token);
      const finalLease = await unlock();
      expect(finalLease.session_id).not.toBe(nextLease.session_id);
      await expect(dangerWatchdogSnapshot()).resolves.toEqual({
        alarm_at_ms: finalLease.lease_expires_at_ms,
        watchdogs: [],
        alarm_event: null,
        last_event_sequence: -1,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("makes an escalated-first reconnect authoritative across lease rollover", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(
          lease.session_id,
          1,
          "escalated",
          baseTime,
          "fall-offline",
          null,
          "voice_intent",
        ),
        [viewer],
      );
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: lease.lease_expires_at_ms,
        watchdogs: [{
          session_id: lease.session_id,
          event_id: "fall-offline",
          deadline_ms: baseTime,
          status: "escalated",
        }],
        alarm_event: {
          session_id: lease.session_id,
          event_sequence: 1,
          payload: { trigger: "voice_intent" },
        },
        last_event_sequence: 1,
      });

      controller.send(JSON.stringify(makeAlarmEvent(
        lease.session_id,
        2,
        "checking",
        baseTime + 1,
        "fall-new",
      )));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "danger_alarm_unresolved",
      });
      controller.send(JSON.stringify(
        makeSceneEvent(lease.session_id, 2, "living", baseTime + 1),
      ));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "danger_alarm_unresolved",
      });
      controller.send(JSON.stringify(makeAlarmEvent(
        lease.session_id,
        2,
        "resolved",
        baseTime + 1,
        "fall-offline",
        null,
        "fall_transition",
      )));
      await expect(nextJson(controller)).resolves.toEqual({
        type: "error",
        error: "danger_stale_resolution",
      });

      await release(lease.token);
      const rolloverForViewer = nextJson(viewer);
      const nextLease = await unlock();
      const rolledAlarm = await rolloverForViewer;
      expect(rolledAlarm).toMatchObject({
        session_id: nextLease.session_id,
        event_sequence: 0,
        event_type: "alarm_state",
        payload: {
          event_id: "fall-offline",
          phase: "escalated",
          trigger: "voice_intent",
        },
      });
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{
          session_id: nextLease.session_id,
          event_id: "fall-offline",
          deadline_ms: baseTime,
          status: "escalated",
        }],
        alarm_event: rolledAlarm,
        last_event_sequence: 0,
      });

      const nextController = await connectController(nextLease.token);
      await expect(nextJson(nextController)).resolves.toMatchObject({
        type: "controller_ready",
        session_id: nextLease.session_id,
        last_event_sequence: 0,
        current_alarm: rolledAlarm,
      });
      await publishEvent(
        nextController,
        makeAlarmEvent(
          nextLease.session_id,
          1,
          "resolved",
          baseTime + 2,
          "fall-offline",
          null,
          "voice_intent",
        ),
        [viewer],
      );
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{ status: "resolved" }],
        alarm_event: {
          session_id: nextLease.session_id,
          event_sequence: 1,
          payload: { phase: "resolved", trigger: "voice_intent" },
        },
        last_event_sequence: 1,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("backfills and idempotently reschedules a legacy checking alarm after eviction", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const legacyStub = roomStub("legacy-checking-migration");
      const sessionId = "legacy-checking-session";
      const deadline = baseTime + 8_000;
      await seedLegacyAlarmState(
        makeAlarmEvent(sessionId, 1, "checking", baseTime, "fall-legacy", deadline),
        { leaseExpiresAtMs: baseTime + 30_000, lastEventSequence: -1 },
        legacyStub,
      );

      await expect(dangerWatchdogSnapshot(legacyStub)).resolves.toMatchObject({
        alarm_at_ms: deadline,
        watchdogs: [{
          session_id: sessionId,
          event_id: "fall-legacy",
          deadline_ms: deadline,
          status: "checking",
        }],
        alarm_event: {
          session_id: sessionId,
          event_sequence: 1,
          payload: { phase: "checking", response_deadline_ms: deadline },
        },
        last_event_sequence: 1,
      });

      await runInDurableObject(legacyStub, (_instance, state) => state.storage.deleteAlarm());
      await evictDurableObject(legacyStub);
      await expect(dangerWatchdogSnapshot(legacyStub)).resolves.toMatchObject({
        alarm_at_ms: deadline,
        watchdogs: [{ status: "checking", deadline_ms: deadline }],
        last_event_sequence: 1,
      });

      now.mockReturnValue(deadline + 1);
      await expect(runDurableObjectAlarm(legacyStub)).resolves.toBe(true);
      await expect(dangerWatchdogSnapshot(legacyStub)).resolves.toMatchObject({
        alarm_at_ms: baseTime + 30_000,
        watchdogs: [{ status: "escalated", deadline_ms: deadline }],
        alarm_event: {
          session_id: sessionId,
          event_sequence: 2,
          payload: { phase: "escalated", trigger: "check_in_timeout" },
        },
        last_event_sequence: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("immediately escalates an expired legacy checking alarm during cold start", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const legacyStub = roomStub("legacy-expired-migration");
      const sessionId = "legacy-expired-session";
      const deadline = baseTime - 1;
      await seedLegacyAlarmState(
        makeAlarmEvent(
          sessionId,
          1,
          "checking",
          baseTime - 8_000,
          "fall-expired",
          deadline,
        ),
        { leaseExpiresAtMs: baseTime + 30_000, lastEventSequence: 1 },
        legacyStub,
      );

      await expect(dangerWatchdogSnapshot(legacyStub)).resolves.toMatchObject({
        alarm_at_ms: baseTime + 30_000,
        watchdogs: [{
          session_id: sessionId,
          event_id: "fall-expired",
          deadline_ms: deadline,
          status: "escalated",
        }],
        alarm_event: {
          session_id: sessionId,
          event_sequence: 2,
          payload: { phase: "escalated", trigger: "check_in_timeout" },
        },
        last_event_sequence: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("backfills legacy escalated authority while keeping resolved state inactive", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const oldSessionId = "legacy-escalated-session";
      const legacyEscalation = makeAlarmEvent(
        oldSessionId,
        5,
        "escalated",
        baseTime - 2_000,
        "fall-escalated",
        null,
        "elder_need_help",
      );
      await seedLegacyAlarmState(legacyEscalation, { lastEventSequence: 4 });

      const lateViewer = await connectViewer();
      await expect(nextJson(lateViewer)).resolves.toEqual(legacyEscalation);
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: null,
        watchdogs: [{
          session_id: oldSessionId,
          event_id: "fall-escalated",
          deadline_ms: expect.any(Number),
          status: "escalated",
        }],
        last_event_sequence: 5,
      });

      const rolloverForViewer = nextJson(lateViewer);
      const lease = await unlock();
      await expect(rolloverForViewer).resolves.toMatchObject({
        session_id: lease.session_id,
        event_sequence: 0,
        payload: {
          event_id: "fall-escalated",
          phase: "escalated",
          trigger: "elder_need_help",
        },
      });
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        watchdogs: [{ session_id: lease.session_id, status: "escalated" }],
        alarm_event: { session_id: lease.session_id, event_sequence: 0 },
        last_event_sequence: 0,
      });

      await resetRoomStorage();
      const resolvedSessionId = "legacy-resolved-session";
      const legacyResolution = makeAlarmEvent(
        resolvedSessionId,
        3,
        "resolved",
        baseTime - 1_000,
        "fall-resolved",
        null,
        "check_in_timeout",
      );
      await seedLegacyAlarmState(legacyResolution, { lastEventSequence: 2 });
      await expect(dangerWatchdogSnapshot()).resolves.toEqual({
        alarm_at_ms: null,
        watchdogs: [{
          session_id: resolvedSessionId,
          event_id: "fall-resolved",
          deadline_ms: expect.any(Number),
          status: "resolved",
        }],
        alarm_event: legacyResolution,
        last_event_sequence: 3,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("monotonically reconciles rollback writes against persisted alarm authority", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const sessionId = "rollback-merge-session";
      const authority = makeAlarmEvent(
        sessionId,
        2,
        "escalated",
        baseTime - 2_000,
        "fall-rollback",
        null,
        "check_in_timeout",
      );

      const reopenedStub = roomStub("legacy-rollback-reopen");
      await seedDivergentAlarmAuthority(
        authority,
        makeAlarmEvent(
          sessionId,
          3,
          "checking",
          baseTime - 1_000,
          "fall-rollback",
          baseTime + 8_000,
        ),
        reopenedStub,
      );
      await expect(dangerWatchdogSnapshot(reopenedStub)).resolves.toMatchObject({
        alarm_at_ms: null,
        watchdogs: [{ status: "escalated" }],
        alarm_event: {
          event_sequence: 4,
          payload: { phase: "escalated", trigger: "check_in_timeout" },
        },
        last_event_sequence: 4,
      });

      const mismatchedResolutionStub = roomStub("legacy-rollback-stale-resolution");
      await seedDivergentAlarmAuthority(
        authority,
        makeAlarmEvent(
          sessionId,
          3,
          "resolved",
          baseTime - 1_000,
          "fall-rollback",
          null,
          "voice_intent",
        ),
        mismatchedResolutionStub,
      );
      await expect(dangerWatchdogSnapshot(mismatchedResolutionStub)).resolves.toMatchObject({
        alarm_at_ms: null,
        watchdogs: [{ status: "escalated" }],
        alarm_event: {
          event_sequence: 4,
          payload: { phase: "escalated", trigger: "check_in_timeout" },
        },
        last_event_sequence: 4,
      });

      const matchingResolution = makeAlarmEvent(
        sessionId,
        3,
        "resolved",
        baseTime - 1_000,
        "fall-rollback",
        null,
        "check_in_timeout",
      );
      const matchingResolutionStub = roomStub("legacy-rollback-matching-resolution");
      await seedDivergentAlarmAuthority(
        authority,
        matchingResolution,
        matchingResolutionStub,
      );
      await expect(dangerWatchdogSnapshot(matchingResolutionStub)).resolves.toEqual({
        alarm_at_ms: null,
        watchdogs: [{
          session_id: sessionId,
          event_id: "fall-rollback",
          deadline_ms: baseTime - 8_000,
          status: "resolved",
        }],
        alarm_event: matchingResolution,
        last_event_sequence: 3,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("escalates rather than abandoning checking when the controller lease expires", async () => {
    const baseTime = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(baseTime);
    try {
      const lease = await unlock();
      const controller = await connectController(lease.token);
      await nextJson(controller);
      const viewer = await connectViewer();
      await publishEvent(
        controller,
        makeSceneEvent(lease.session_id, 0, "fall", baseTime),
        [viewer],
      );
      await publishEvent(
        controller,
        makeAlarmEvent(
          lease.session_id,
          1,
          "checking",
          baseTime,
          "fall-1",
          baseTime + 40_000,
        ),
        [viewer],
      );
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: lease.lease_expires_at_ms,
        watchdogs: [{ status: "checking", deadline_ms: baseTime + 40_000 }],
      });

      now.mockReturnValue(lease.lease_expires_at_ms + 1);
      const escalatedForViewer = nextJson(viewer);
      await expect(runDurableObjectAlarm(roomStub())).resolves.toBe(true);
      await expect(escalatedForViewer).resolves.toMatchObject({
        session_id: lease.session_id,
        event_sequence: 2,
        event_type: "alarm_state",
        payload: { phase: "escalated", trigger: "check_in_timeout" },
      });
      const expiredStatus = await relayFetch("/api/status");
      await expect(expiredStatus.json()).resolves.toMatchObject({
        controller_locked: false,
        controller_connected: false,
      });
      await expect(dangerWatchdogSnapshot()).resolves.toMatchObject({
        alarm_at_ms: null,
        watchdogs: [{ status: "escalated" }],
        alarm_event: {
          event_sequence: 2,
          event_type: "alarm_state",
          payload: { phase: "escalated" },
        },
        last_event_sequence: 2,
      });
    } finally {
      now.mockRestore();
    }
  });

  it("makes strict MiMo response, rate-limit, network, and timeout failures explicit", async () => {
    const lease = await unlock();
    const baseTime = Date.now();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    await publishEvent(controller, makeSceneEvent(lease.session_id, 0, "fall", baseTime), []);
    const outbound = vi
      .fn<(...args: Parameters<typeof fetch>) => Promise<Response>>()
      .mockImplementationOnce(
        async () => mimoVoiceResponse("safe", "我没事", { unexpected: true }),
      )
      .mockImplementationOnce(async () => new Response(null, { status: 429 }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    vi.stubGlobal("fetch", outbound);

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 1, "checking", baseTime, "fall-invalid"),
      [],
    );
    const invalid = await recognizeDangerVoice(lease.token, "fall-invalid");
    expect(invalid.status).toBe(502);
    await expect(invalid.json()).resolves.toEqual({
      ok: false,
      error: "invalid_mimo_response",
    });
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 2, "escalated", baseTime + 1, "fall-invalid"),
      [],
    );
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 3, "resolved", baseTime + 2, "fall-invalid"),
      [],
    );

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 4, "checking", baseTime + 3, "fall-rate"),
      [],
    );
    const rateLimited = await recognizeDangerVoice(lease.token, "fall-rate");
    expect(rateLimited.status).toBe(502);
    await expect(rateLimited.json()).resolves.toEqual({
      ok: false,
      error: "mimo_rate_limited",
    });
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 5, "escalated", baseTime + 4, "fall-rate"),
      [],
    );
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 6, "resolved", baseTime + 5, "fall-rate"),
      [],
    );

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 7, "checking", baseTime + 6, "fall-network"),
      [],
    );
    const network = await recognizeDangerVoice(lease.token, "fall-network");
    expect(network.status).toBe(502);
    await expect(network.json()).resolves.toEqual({ ok: false, error: "mimo_unavailable" });
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 8, "escalated", baseTime + 7, "fall-network"),
      [],
    );
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 9, "resolved", baseTime + 8, "fall-network"),
      [],
    );

    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 10, "checking", baseTime + 9, "fall-timeout"),
      [],
    );
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort());
    outbound.mockImplementationOnce(async () => {
      throw new DOMException("timed out", "AbortError");
    });
    try {
      const timedOut = await recognizeDangerVoice(lease.token, "fall-timeout");
      expect(timedOut.status).toBe(504);
      await expect(timedOut.json()).resolves.toEqual({ ok: false, error: "mimo_timeout" });
    } finally {
      timeout.mockRestore();
    }
    expect(outbound).toHaveBeenCalledTimes(4);
  });

  it("accepts voice_intent as an alarm trigger", () => {
    const event = makeAlarmEvent("session-voice", 1, "resolved");
    if (event.event_type !== "alarm_state") throw new Error("expected alarm_state");
    event.payload.trigger = "voice_intent";

    expect(validateDemoEvent(event, event.session_id)).toBe(true);
  });

  it("aborts an in-flight cooking request when automatic scene recognition takes over", async () => {
    const token = "b".repeat(64);
    const requestController = new AbortController();
    const outbound = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const upstreamSignal = args[1]?.signal;
      return new Promise((_resolve, reject) => {
        const rejectCancelled = () => reject(new DOMException("cancelled", "AbortError"));
        if (upstreamSignal?.aborted) {
          rejectCancelled();
          return;
        }
        upstreamSignal?.addEventListener("abort", rejectCancelled, { once: true });
      });
    });
    vi.stubGlobal("fetch", outbound);

    const cancelAttempt = vi.fn(async () => undefined);
    const pending = handleActivityRecognition(new Request(
      "https://relay.example/api/activity/recognize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ image_b64: MINIMAL_JPEG_B64 }),
        signal: requestController.signal,
      },
    ), {
      MIMO_API_KEY: "test-key",
      MIMO_BASE_URL: "https://api.xiaomimimo.com/v1",
      MIMO_MODEL: "mimo-v2.5",
    } as unknown as Env, {
      beginAttempt: async () => ({ ok: true, attempt_id: crypto.randomUUID() }),
      cancelAttempt,
      finishAttempt: async () => ({ receipt_id: null, consecutive: 0 }),
    });
    await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
    requestController.abort();

    const cancelled = await pending;
    expect(cancelled.status).toBe(499);
    await expect(cancelled.json()).resolves.toEqual({
      ok: false,
      error: "request_cancelled",
    });
    const observedSignal = outbound.mock.calls[0]?.[1]?.signal;
    expect(observedSignal?.aborted).toBe(true);
    expect(cancelAttempt).toHaveBeenCalledTimes(1);
  });

  it("classifies one explicit short MP4 and emits metadata-only logs", async () => {
    const lease = await unlock();
    const authorityBefore = await demoAuthoritySnapshot();
    const outbound = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => (
      mimoSceneResponse("kitchen", true, "人物连续切配食材并操作锅具")
    ));
    vi.stubGlobal("fetch", outbound);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const response = await recognizeScene(lease.token, {
        visual_kind: "video_clip",
        media_format: "mp4",
        media_b64: MINIMAL_MP4_B64,
        duration_ms: 2_000,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        ok: true,
        scene_id: "kitchen",
        confidence: 0.87,
        reason: "人物连续切配食材并操作锅具",
        temporal_evidence: true,
        model: "mimo-v2.5",
        latency_ms: expect.any(Number),
      });
      expect(outbound).toHaveBeenCalledTimes(1);
      const call = outbound.mock.calls[0];
      expect(String(call?.[0])).toBe("https://api.xiaomimimo.com/v1/chat/completions");
      const request = JSON.parse(String(call?.[1]?.body)) as {
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      expect(request.messages[1]?.content[1]).toEqual({
        type: "video_url",
        video_url: { url: `data:video/mp4;base64,${MINIMAL_MP4_B64}` },
        fps: 1,
      });
      expect(log).toHaveBeenCalledTimes(1);
      const logged = String(log.mock.calls[0]?.[0]);
      expect(logged).not.toContain(MINIMAL_MP4_B64);
      expect(logged).not.toContain("人物连续切配食材并操作锅具");
      expect(JSON.parse(logged)).toMatchObject({
        event: "scene_recognition_mimo",
        provider: "xiaomi_mimo",
        model: "mimo-v2.5",
        status: 200,
        outcome: "success",
        visual_kind: "video_clip",
        media_format: "mp4",
        duration_ms: 2_000,
        bytes: 12,
      });
      await expect(demoAuthoritySnapshot()).resolves.toEqual(authorityBefore);
    } finally {
      log.mockRestore();
    }
  });

  it("accepts the exact JPEG keyframe fallback and keeps fall as a classification only", async () => {
    const lease = await unlock();
    const authorityBefore = await demoAuthoritySnapshot();
    const outbound = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => (
      mimoSceneResponse("fall", false, "人物疑似倒地，但单帧没有跨帧证据")
    ));
    vi.stubGlobal("fetch", outbound);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const response = await recognizeScene(lease.token, {
        visual_kind: "keyframe",
        media_format: "jpeg",
        media_b64: MINIMAL_JPEG_B64,
        duration_ms: 0,
      });

      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        scene_id: "fall",
        temporal_evidence: false,
      });
      const call = outbound.mock.calls[0];
      const request = JSON.parse(String(call?.[1]?.body)) as {
        messages: Array<{ content: Array<Record<string, unknown>> }>;
      };
      expect(request.messages[1]?.content[1]).toEqual({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${MINIMAL_JPEG_B64}` },
      });

      const viewer = await connectViewer();
      await expectNoMessage(viewer);
      await expect(demoAuthoritySnapshot()).resolves.toEqual(authorityBefore);
    } finally {
      log.mockRestore();
    }
  });

  it("rejects non-exact scene unions, invalid media, and oversized requests before MiMo", async () => {
    const lease = await unlock();
    const outbound = vi.fn();
    vi.stubGlobal("fetch", outbound);
    const invalidBodies = [
      {
        visual_kind: "video_clip",
        media_format: "jpeg",
        media_b64: MINIMAL_JPEG_B64,
        duration_ms: 2_000,
      },
      {
        visual_kind: "video_clip",
        media_format: "mp4",
        media_b64: MINIMAL_MP4_B64,
        duration_ms: 0,
      },
      {
        visual_kind: "keyframe",
        media_format: "jpeg",
        media_b64: MINIMAL_JPEG_B64,
        duration_ms: 1,
      },
      {
        visual_kind: "keyframe",
        media_format: "jpeg",
        media_b64: MINIMAL_JPEG_B64,
        duration_ms: 0,
        extra: true,
      },
    ];
    for (const body of invalidBodies) {
      const response = await recognizeScene(lease.token, body);
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ ok: false, error: "invalid_request" });
    }

    const invalidMagic = await recognizeScene(lease.token, {
      visual_kind: "video_clip",
      media_format: "mp4",
      media_b64: MINIMAL_JPEG_B64,
      duration_ms: 2_000,
    });
    expect(invalidMagic.status).toBe(415);
    await expect(invalidMagic.json()).resolves.toEqual({ ok: false, error: "invalid_media" });

    const oversized = await relayFetch("/api/scene/recognize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.token}`,
        "Content-Length": String(3 * 1_024 * 1_024 + 1),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sceneKeyframeBody()),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toEqual({ ok: false, error: "request_too_large" });
    expect(outbound).not.toHaveBeenCalled();
  });

  it("requires the active control token and POST JSON for scene recognition", async () => {
    const missing = await relayFetch("/api/scene/recognize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sceneKeyframeBody()),
    });
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({
      ok: false,
      error: "missing_control_token",
    });

    const lease = await unlock();
    const wrongMethod = await relayFetch("/api/scene/recognize", {
      headers: { Authorization: `Bearer ${lease.token}` },
    });
    expect(wrongMethod.status).toBe(405);
    await expect(wrongMethod.json()).resolves.toEqual({
      ok: false,
      error: "method_not_allowed",
    });
    const wrongContentType = await relayFetch("/api/scene/recognize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${lease.token}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(sceneKeyframeBody()),
    });
    expect(wrongContentType.status).toBe(415);
    await expect(wrongContentType.json()).resolves.toEqual({
      ok: false,
      error: "invalid_content_type",
    });
  });

  it("strictly rejects malformed MiMo scene verdicts", async () => {
    const lease = await unlock();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const invalidVerdicts = [
      { scene_id: "bedroom", confidence: 0.8, reason: "unknown", temporal_evidence: false },
      { scene_id: "living", confidence: 4, reason: "ordinary", temporal_evidence: false },
      {
        scene_id: "living",
        confidence: 0.8,
        reason: "ordinary",
        temporal_evidence: false,
        extra: true,
      },
      { scene_id: "fall", confidence: 0.8, reason: "single frame", temporal_evidence: true },
    ];

    try {
      for (const verdict of invalidVerdicts) {
        vi.stubGlobal("fetch", vi.fn(async () => Response.json({
          choices: [{ message: { content: JSON.stringify(verdict) } }],
        })));
        const response = await recognizeScene(lease.token, sceneKeyframeBody());
        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({
          ok: false,
          error: "invalid_mimo_response",
        });
      }
    } finally {
      log.mockRestore();
    }
  });

  it("fails scene recognition closed on MiMo timeout and clears the single-flight marker", async () => {
    const lease = await unlock();
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("deadline exceeded", "TimeoutError");
    }));

    try {
      const timedOut = await recognizeScene(lease.token, sceneKeyframeBody());
      expect(timedOut.status).toBe(504);
      await expect(timedOut.json()).resolves.toEqual({ ok: false, error: "mimo_timeout" });

      vi.stubGlobal("fetch", vi.fn(async () => (
        mimoSceneResponse("living", false, "普通居家活动")
      )));
      const recovered = await recognizeScene(lease.token, sceneKeyframeBody());
      expect(recovered.status).toBe(200);
    } finally {
      log.mockRestore();
    }
  });

  it("aborts the paid MiMo request when the incoming controller request is cancelled", async () => {
    const token = "a".repeat(64);
    const requestController = new AbortController();
    const outbound = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const upstreamSignal = args[1]?.signal;
      return new Promise((_resolve, reject) => {
        const rejectCancelled = () => reject(new DOMException("cancelled", "AbortError"));
        if (upstreamSignal?.aborted) {
          rejectCancelled();
          return;
        }
        upstreamSignal?.addEventListener("abort", rejectCancelled, { once: true });
      });
    });
    vi.stubGlobal("fetch", outbound);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const finishAttempt = vi.fn(async () => ({ ok: true as const }));

    try {
      const pending = handleSceneRecognition(new Request("https://relay.example/api/scene/recognize", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(sceneKeyframeBody()),
        signal: requestController.signal,
      }), {
        MIMO_API_KEY: "test-key",
        MIMO_BASE_URL: "https://api.xiaomimimo.com/v1",
        MIMO_MODEL: "mimo-v2.5",
      } as unknown as Env, {
        authorizeTokenHash: async () => true,
        beginAttempt: async () => ({ ok: true, session_id: "session-cancelled" }),
        finishAttempt,
      });
      await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
      requestController.abort();

      const cancelled = await pending;
      expect(cancelled.status).toBe(499);
      await expect(cancelled.json()).resolves.toEqual({
        ok: false,
        error: "request_cancelled",
      });
      const observedSignal = outbound.mock.calls[0]?.[1]?.signal;
      expect(observedSignal?.aborted).toBe(true);
      expect(finishAttempt).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("single-flights scene recognition and limits each session to six paid attempts per minute", async () => {
    const lease = await unlock();
    const outbound = vi.fn(async (..._args: Parameters<typeof fetch>): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return mimoSceneResponse("living", false, "普通居家活动");
    });
    vi.stubGlobal("fetch", outbound);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      const first = recognizeScene(lease.token, sceneKeyframeBody());
      await vi.waitFor(() => expect(outbound).toHaveBeenCalledTimes(1));
      const concurrent = await recognizeScene(lease.token, sceneKeyframeBody());
      expect(concurrent.status).toBe(409);
      await expect(concurrent.json()).resolves.toEqual({
        ok: false,
        error: "scene_request_in_progress",
      });
      expect((await first).status).toBe(200);

      vi.stubGlobal("fetch", vi.fn(async () => (
        mimoSceneResponse("living", false, "普通居家活动")
      )));
      for (let attempt = 1; attempt < 6; attempt += 1) {
        expect((await recognizeScene(lease.token, sceneKeyframeBody())).status).toBe(200);
      }
      const limited = await recognizeScene(lease.token, sceneKeyframeBody());
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);
      await expect(limited.json()).resolves.toMatchObject({
        ok: false,
        error: "scene_rate_limited",
      });
    } finally {
      log.mockRestore();
    }
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

  it("keeps late fall viewers outside an already-issued emergency audience", async () => {
    const baseTime = Date.now();
    const lease = await unlock();
    const controller = await connectController(lease.token);
    await nextJson(controller);
    const initialViewer = await connectViewer();
    await publishEvent(
      controller,
      makeSceneEvent(lease.session_id, 0, "fall"),
      [initialViewer],
    );
    await publishEvent(
      controller,
      makeAlarmEvent(lease.session_id, 1, "escalated", baseTime),
      [initialViewer],
    );
    const initialGrant = nextJson(initialViewer);
    const grantAck = nextJson(controller);
    controller.send(JSON.stringify({
      type: "media_grant_request",
      event_id: "fall-1",
      scope: "fall_emergency",
      expires_in_ms: 30_000,
    }));
    await initialGrant;
    await grantAck;

    const lateViewer = await connectViewer();
    await expect(nextJson(lateViewer)).resolves.toEqual(makeSceneEvent(lease.session_id, 0, "fall"));
    await expect(nextJson(lateViewer)).resolves.toEqual(
      makeAlarmEvent(lease.session_id, 1, "escalated", baseTime),
    );
    await expectNoMessage(lateViewer);
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

function roomStub(name = ROOM_NAME): DurableObjectStub<import("../src/index").DemoRoom> {
  return env.DEMO_ROOM.getByName(name);
}

async function dangerWatchdogSnapshot(
  stub = roomStub(),
): Promise<DangerWatchdogSnapshot> {
  return runInDurableObject(stub, async (_instance, state) => {
    const watchdogs = state.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      session_id: string;
      event_id: string;
      deadline_ms: number;
      status: "checking" | "escalated" | "resolved";
    }>(
      `SELECT session_id, event_id, deadline_ms, status
         FROM danger_watchdog
        ORDER BY event_id ASC`,
    ).toArray().map((row) => ({
      session_id: row.session_id,
      event_id: row.event_id,
      deadline_ms: row.deadline_ms,
      status: row.status,
    }));
    const eventRow = state.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      event_json: string;
    }>(
      `SELECT event_json
         FROM demo_event_state
        WHERE event_type = 'alarm_state'`,
    ).toArray()[0];
    const sequenceRow = state.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      last_event_sequence: number;
    }>(
      "SELECT last_event_sequence FROM room_event_sequence WHERE singleton = 1",
    ).toArray()[0];

    return {
      alarm_at_ms: await state.storage.getAlarm(),
      watchdogs,
      alarm_event: eventRow === undefined
        ? null
        : JSON.parse(eventRow.event_json) as DemoEvent,
      last_event_sequence: sequenceRow?.last_event_sequence ?? null,
    };
  });
}

async function demoAuthoritySnapshot(): Promise<Record<string, number>> {
  return runInDurableObject(roomStub(), (_instance, state) => {
    const count = (table: string): number => state.storage.sql.exec<{
      [key: string]: SqlStorageValue;
      count: number;
    }>(`SELECT COUNT(*) AS count FROM ${table}`).one().count;
    return {
      demo_events: count("demo_event_state"),
      media_grants: count("media_grant"),
      media_audience: count("media_grant_audience"),
      activity_evidence: count("activity_recognition_evidence"),
      danger_watchdogs: count("danger_watchdog"),
      danger_checkpoints: count("danger_alarm_checkpoint"),
      danger_voice_attempts: count("danger_voice_attempt"),
    };
  });
}

async function resetRoomStorage(): Promise<void> {
  await runInDurableObject(roomStub(), async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.transactionSync(() => {
      state.storage.sql.exec("DELETE FROM media_grant_audience");
      state.storage.sql.exec("DELETE FROM media_grant");
      state.storage.sql.exec("DELETE FROM danger_voice_attempt");
      state.storage.sql.exec("DELETE FROM activity_recognition_evidence");
      state.storage.sql.exec("DELETE FROM danger_alarm_checkpoint");
      state.storage.sql.exec("DELETE FROM danger_watchdog");
      state.storage.sql.exec("DELETE FROM demo_event_state");
      state.storage.sql.exec("DELETE FROM room_event_sequence");
      state.storage.sql.exec("DELETE FROM room_frame_sequence");
      state.storage.sql.exec("DELETE FROM control_lease");
    });
  });
}

async function seedLegacyAlarmState(
  event: Extract<DemoEvent, { event_type: "alarm_state" }>,
  {
    leaseExpiresAtMs = null,
    lastEventSequence = event.event_sequence,
  }: {
    leaseExpiresAtMs?: number | null;
    lastEventSequence?: number;
  } = {},
  stub = roomStub(),
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.transactionSync(() => {
      state.storage.sql.exec("DELETE FROM media_grant_audience");
      state.storage.sql.exec("DELETE FROM media_grant");
      state.storage.sql.exec("DELETE FROM danger_voice_attempt");
      state.storage.sql.exec("DELETE FROM activity_recognition_evidence");
      state.storage.sql.exec("DELETE FROM danger_alarm_checkpoint");
      state.storage.sql.exec("DELETE FROM danger_watchdog");
      state.storage.sql.exec("DELETE FROM demo_event_state");
      state.storage.sql.exec("DELETE FROM room_event_sequence");
      state.storage.sql.exec("DELETE FROM room_frame_sequence");
      state.storage.sql.exec("DELETE FROM control_lease");
      state.storage.sql.exec(
        `INSERT INTO room_event_sequence
           (singleton, session_id, last_event_sequence)
         VALUES (1, ?, ?)`,
        event.session_id,
        lastEventSequence,
      );
      state.storage.sql.exec(
        `INSERT INTO room_frame_sequence
           (singleton, session_id, last_frame_sequence)
         VALUES (1, ?, -1)`,
        event.session_id,
      );
      state.storage.sql.exec(
        `INSERT INTO demo_event_state
           (event_type, session_id, event_sequence, event_json)
         VALUES ('alarm_state', ?, ?, ?)`,
        event.session_id,
        event.event_sequence,
        JSON.stringify(event),
      );
      if (leaseExpiresAtMs !== null) {
        state.storage.sql.exec(
          `INSERT INTO control_lease
             (singleton, token_hash, session_id, expires_at_ms)
           VALUES (1, ?, ?, ?)`,
          "a".repeat(64),
          event.session_id,
          leaseExpiresAtMs,
        );
      }
    });
  });
  await evictDurableObject(stub, { webSockets: "close" });
}

async function seedDivergentAlarmAuthority(
  authority: AlarmStateEvent,
  legacyEvent: AlarmStateEvent,
  stub: DurableObjectStub<import("../src/index").DemoRoom>,
): Promise<void> {
  if (
    authority.session_id !== legacyEvent.session_id
    || authority.payload.event_id !== legacyEvent.payload.event_id
    || authority.payload.phase !== "escalated"
  ) {
    throw new Error("divergent authority seed requires one matching escalated alarm");
  }
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAlarm();
    state.storage.transactionSync(() => {
      state.storage.sql.exec("DELETE FROM danger_alarm_checkpoint");
      state.storage.sql.exec("DELETE FROM danger_watchdog");
      state.storage.sql.exec("DELETE FROM demo_event_state");
      state.storage.sql.exec("DELETE FROM room_event_sequence");
      state.storage.sql.exec("DELETE FROM room_frame_sequence");
      state.storage.sql.exec("DELETE FROM control_lease");
      state.storage.sql.exec(
        `INSERT INTO room_event_sequence
           (singleton, session_id, last_event_sequence)
         VALUES (1, ?, ?)`,
        legacyEvent.session_id,
        legacyEvent.event_sequence,
      );
      state.storage.sql.exec(
        `INSERT INTO room_frame_sequence
           (singleton, session_id, last_frame_sequence)
         VALUES (1, ?, -1)`,
        legacyEvent.session_id,
      );
      state.storage.sql.exec(
        `INSERT INTO demo_event_state
           (event_type, session_id, event_sequence, event_json)
         VALUES ('alarm_state', ?, ?, ?)`,
        legacyEvent.session_id,
        legacyEvent.event_sequence,
        JSON.stringify(legacyEvent),
      );
      state.storage.sql.exec(
        `INSERT INTO danger_watchdog
           (session_id, event_id, deadline_ms, status)
         VALUES (?, ?, ?, 'escalated')`,
        authority.session_id,
        authority.payload.event_id,
        authority.timestamp_ms - 6_000,
      );
      state.storage.sql.exec(
        `INSERT INTO danger_alarm_checkpoint
           (session_id, event_id, event_json)
         VALUES (?, ?, ?)`,
        authority.session_id,
        authority.payload.event_id,
        JSON.stringify(authority),
      );
    });
  });
  await evictDurableObject(stub, { webSockets: "close" });
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

async function closeControllerSocket(
  socket: WebSocket,
  code: number,
  reason: string,
): Promise<void> {
  socket.close(code, reason);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await relayFetch("/api/status");
    const payload = await status.json<{ controller_connected: boolean }>();
    if (!payload.controller_connected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for controller disconnection");
}

function requireSocket(response: Response): WebSocket {
  if (response.webSocket === null) {
    throw new Error("expected a WebSocket response");
  }
  const socket = response.webSocket;
  ensureSocketInbox(socket);
  return socket;
}

function nextJson(socket: WebSocket): Promise<unknown> {
  const inbox = ensureSocketInbox(socket);
  const queued = inbox.messages.shift();
  if (queued !== undefined) {
    return queued.error === undefined
      ? Promise.resolve(queued.value)
      : Promise.reject(queued.error);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve,
      reject,
      timeout: setTimeout(() => {
        const index = inbox.waiters.indexOf(waiter);
        if (index >= 0) inbox.waiters.splice(index, 1);
        reject(new Error("timed out waiting for WebSocket message"));
      }, 2_000),
    };
    inbox.waiters.push(waiter);
  });
}

function nextJsonBatch(socket: WebSocket, count: number): Promise<unknown[]> {
  return Promise.all(Array.from({ length: count }, () => nextJson(socket)));
}

async function expectNoMessage(socket: WebSocket, waitMs = 75): Promise<void> {
  const inbox = ensureSocketInbox(socket);
  expect(inbox.messages).toHaveLength(0);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  expect(inbox.messages).toHaveLength(0);
}

function ensureSocketInbox(socket: WebSocket): SocketInbox {
  const existing = socketInboxes.get(socket);
  if (existing !== undefined) return existing;
  const inbox: SocketInbox = { messages: [], waiters: [] };
  socketInboxes.set(socket, inbox);
  socket.addEventListener("message", (event) => {
    let message: { value?: unknown; error?: Error };
    if (typeof event.data !== "string") {
      message = { error: new Error("expected a text WebSocket message") };
    } else {
      try {
        message = { value: JSON.parse(event.data) as unknown };
      } catch {
        message = { error: new Error("expected valid JSON WebSocket message") };
      }
    }
    const waiter = inbox.waiters.shift();
    if (waiter === undefined) {
      inbox.messages.push(message);
      return;
    }
    clearTimeout(waiter.timeout);
    if (message.error === undefined) waiter.resolve(message.value);
    else waiter.reject(message.error);
  });
  return inbox;
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

function makeActivityEvent(
  sessionId: string,
  eventSequence: number,
  phase: "sampling" | "candidate" | "confirmed" | "unavailable" = "confirmed",
  source: "mimo_visual" | "manual_debug" = "mimo_visual",
): DemoEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: eventSequence * 1_000,
    event_type: "activity_state",
    payload: {
      activity: "cooking",
      phase,
      source,
      confidence: 0.87,
      reason: "连续样本显示人物正在备菜",
    },
  };
}

function makeCareCardEvent(
  sessionId: string,
  eventSequence: number,
  shareState: "local_only" | "consent_pending" | "consented" | "denied" | "expired",
  eventId = "cooking-1",
): DemoEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: eventSequence * 1_000,
    event_type: "care_card",
    payload: {
      card_id: "card-1",
      event_id: eventId,
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
  eventId = "fall-1",
  checkingDeadlineMs: number | null = null,
  trigger: AlarmTrigger | null = null,
): AlarmStateEvent {
  return {
    schema_version: EVENT_SCHEMA_VERSION,
    session_id: sessionId,
    event_sequence: eventSequence,
    timestamp_ms: timestampMs,
    event_type: "alarm_state",
    payload: {
      event_id: eventId,
      phase,
      trigger: trigger ?? (phase === "checking" ? "fall_transition" : "check_in_timeout"),
      message: phase === "checking" ? "刚才的动作有些突然，您还好吗？" : "未收到回应，已通知家人。",
      response_deadline_ms: phase === "checking"
        ? checkingDeadlineMs ?? timestampMs + 8_000
        : null,
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
    ...(event.event_type === "activity_state" && event.payload.phase === "confirmed"
      ? { activity_verified: true }
      : {}),
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

function mimoActivityResponse(
  classification: "cooking" | "not_cooking" | "uncertain",
  confidence: number,
  reason = "画面中人物正在案板前切配食材",
): Response {
  return Response.json({
    choices: [{
      message: {
        content: JSON.stringify({ classification, confidence, reason }),
      },
    }],
  });
}

async function testSha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sceneKeyframeBody(): Record<string, unknown> {
  return {
    visual_kind: "keyframe",
    media_format: "jpeg",
    media_b64: MINIMAL_JPEG_B64,
    duration_ms: 0,
  };
}

async function recognizeScene(
  token: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return relayFetch("/api/scene/recognize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function mimoSceneResponse(
  sceneId: "living" | "kitchen" | "bathroom" | "fall" | "uncertain",
  temporalEvidence: boolean,
  reason: string,
): Response {
  return Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          scene_id: sceneId,
          confidence: 0.87,
          reason,
          temporal_evidence: temporalEvidence,
        }),
      },
    }],
  });
}

async function prepareDangerChecking(
  lease: UnlockSuccess,
  timestampMs = Date.now(),
  eventId = "fall-1",
): Promise<WebSocket> {
  const controller = await connectController(lease.token);
  await nextJson(controller);
  await publishEvent(
    controller,
    makeSceneEvent(lease.session_id, 0, "fall", timestampMs),
    [],
  );
  await publishEvent(
    controller,
    makeAlarmEvent(lease.session_id, 1, "checking", timestampMs, eventId),
    [],
  );
  return controller;
}

function dangerVoiceBody(
  eventId = "fall-1",
  audioB64 = makePcmWavBase64(),
): { event_id: string; audio_b64: string; audio_format: "wav" } {
  return { event_id: eventId, audio_b64: audioB64, audio_format: "wav" };
}

async function recognizeDangerVoice(
  token: string,
  eventId = "fall-1",
  audioB64 = makePcmWavBase64(),
): Promise<Response> {
  return relayFetch("/api/danger/voice", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(dangerVoiceBody(eventId, audioB64)),
  });
}

function makePcmWavBase64(durationMs = 250): string {
  const sampleCount = Math.max(1, Math.floor(16_000 * durationMs / 1_000));
  const dataBytes = sampleCount * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(bytes, 0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  writeAscii(bytes, 8, "WAVE");
  writeAscii(bytes, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(bytes, 36, "data");
  view.setUint32(40, dataBytes, true);
  return bytesToBase64(bytes);
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    target[offset + index] = value.charCodeAt(index);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkBytes = 32_768;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkBytes));
  }
  return btoa(binary);
}

function mimoVoiceResponse(
  intent: string,
  transcript: string | null,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json({
    choices: [{
      message: {
        content: JSON.stringify({ intent, transcript, ...extra }),
      },
    }],
  });
}
