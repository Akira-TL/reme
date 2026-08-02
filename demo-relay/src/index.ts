import { DurableObject } from "cloudflare:workers";

import { handleActivityRecognition } from "./activity";
import {
  createForwardedMediaSignal,
  DEMO_EVENT_SCHEMA_VERSION,
  isExactObject,
  MEDIA_SIGNAL_SCHEMA_VERSION,
  type DemoEvent,
  type DemoEventType,
  type MediaGrantPayload,
  type MediaGrantScope,
  type MediaSignal,
  validateDemoEvent,
  validateMediaGrantRequest,
  validateMediaGrantRevoke,
  validateMediaSignal,
} from "./protocol";

export type { DemoEvent, MediaSignal } from "./protocol";

const FRAME_SCHEMA_VERSION = "movenet-17/v1-demo";
const VIEWER_PROTOCOL = "reme-viewer-v1";
const CONTROLLER_PROTOCOL = "reme-controller-v1";

const ROOM_NAME = "shared-live-demo";
const TOKEN_PROTOCOL_PREFIX = "reme-token-";
const LEASE_TTL_MS = 30_000;
const LATEST_FRAME_TTL_MS = 2_500;
const MAX_JSON_BYTES = 16_384;
const KEYPOINT_SCORE_THRESHOLD = 0.2;
const UNLOCK_ATTEMPT_WINDOW_MS = 60_000;
const MAX_UNLOCK_ATTEMPTS_PER_WINDOW = 5;
const MAX_TRACKED_CLIENTS = 1_024;

const MOVENET_KEYPOINT_NAMES = [
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

type KeypointName = (typeof MOVENET_KEYPOINT_NAMES)[number];

export interface FrameLandmarks {
  schema_version: typeof FRAME_SCHEMA_VERSION;
  session_id: string;
  sequence: number;
  timestamp_ms: number;
  source_width: number;
  source_height: number;
  person_detected: boolean;
  landmark_quality: "usable" | "degraded" | "unavailable";
  keypoints: Array<{
    name: KeypointName;
    x: number;
    y: number;
    score: number;
  }>;
}

interface LeaseRow {
  [key: string]: SqlStorageValue;
  token_hash: string;
  session_id: string;
  expires_at_ms: number;
}

interface ViewerAttachment {
  role: "viewer";
  viewerId: string;
}

interface ControllerAttachment {
  role: "controller";
  tokenHash: string;
  sessionId: string;
  leaseExpiresAtMs: number;
  latestFrame: FrameLandmarks | null;
  latestFrameReceivedAtMs: number | null;
}

type SocketAttachment = ViewerAttachment | ControllerAttachment;

type FrameValidation =
  | { ok: true; frame: FrameLandmarks }
  | { ok: false; error: "invalid_frame" | "media_fields_forbidden" };

interface EventSequenceRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  last_event_sequence: number;
}

interface FrameSequenceRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  last_frame_sequence: number;
}

interface EventStateRow {
  [key: string]: SqlStorageValue;
  event_type: DemoEventType;
  event_sequence: number;
  event_json: string;
}

interface GrantRow {
  [key: string]: SqlStorageValue;
  grant_id: string;
  session_id: string;
  event_id: string;
  scope: MediaGrantScope;
  expires_at_ms: number;
  status: "active" | "revoked" | "expired";
}

interface GrantViewerRow {
  [key: string]: SqlStorageValue;
  viewer_id: string;
}

const FORBIDDEN_MEDIA_KEYS = new Set([
  "audio",
  "base64",
  "blob",
  "evidence",
  "frame_data",
  "image",
  "jpeg",
  "media",
  "photo",
  "video",
]);

export class DemoRoom extends DurableObject<Env> {
  private readonly unlockAttempts = new Map<
    string,
    { windowStartedAtMs: number; attempts: number }
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS control_lease (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
          session_id TEXT NOT NULL,
          expires_at_ms INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS room_event_sequence (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          session_id TEXT NOT NULL,
          last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= -1)
        );
        CREATE TABLE IF NOT EXISTS room_frame_sequence (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          session_id TEXT NOT NULL,
          last_frame_sequence INTEGER NOT NULL CHECK (last_frame_sequence >= -1)
        );
        CREATE TABLE IF NOT EXISTS demo_event_state (
          event_type TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_sequence INTEGER NOT NULL CHECK (event_sequence >= 0),
          event_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS media_grant (
          grant_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('kitchen_moment', 'fall_emergency')),
          expires_at_ms INTEGER NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired'))
        );
        CREATE TABLE IF NOT EXISTS media_grant_audience (
          grant_id TEXT NOT NULL,
          viewer_id TEXT NOT NULL,
          PRIMARY KEY (grant_id, viewer_id)
        );
        CREATE INDEX IF NOT EXISTS media_grant_active_idx
          ON media_grant (session_id, status, expires_at_ms);
        CREATE INDEX IF NOT EXISTS media_grant_audience_viewer_idx
          ON media_grant_audience (viewer_id, grant_id)
      `);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/status" && request.method === "GET") {
      return this.status();
    }
    if (url.pathname === "/api/unlock" && request.method === "POST") {
      return this.unlock(request);
    }
    if (url.pathname === "/api/release" && request.method === "POST") {
      return this.release(request);
    }
    if (url.pathname === "/ws/viewer" && request.method === "GET") {
      return this.openViewer(request);
    }
    if (url.pathname === "/ws/controller" && request.method === "GET") {
      return this.openController(request);
    }

    return json({ ok: false, error: "not_found" }, 404);
  }

  async authorizeControlTokenHash(tokenHash: string): Promise<boolean> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return false;
    const lease = this.currentLease(Date.now());
    return lease !== null && constantTimeHexEqual(lease.token_hash, tokenHash);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment === null) {
      rejectSocket(ws, "invalid_socket_state", 1011);
      return;
    }
    if (message instanceof ArrayBuffer) {
      rejectSocket(ws, "binary_frames_forbidden", 1003);
      return;
    }
    if (message.length > MAX_JSON_BYTES) {
      rejectSocket(ws, "message_too_large", 1009);
      return;
    }

    const decoded = parseJson(message);
    if (containsForbiddenMediaField(decoded)) {
      rejectSocket(ws, "media_fields_forbidden", 1008);
      return;
    }

    if (attachment.role === "viewer") {
      if (!validateMediaSignal(decoded)) {
        rejectSocket(ws, "viewer_read_only", 1008);
        return;
      }
      this.forwardViewerSignal(ws, attachment, decoded, Date.now());
      return;
    }

    const lease = this.currentLease(Date.now());
    if (
      lease === null ||
      !constantTimeHexEqual(lease.token_hash, attachment.tokenHash) ||
      lease.session_id !== attachment.sessionId
    ) {
      rejectSocket(ws, "controller_lease_expired", 1008);
      return;
    }

    if (isExactObject(decoded, ["type"]) && decoded.type === "heartbeat") {
      const leaseExpiresAtMs = Date.now() + LEASE_TTL_MS;
      this.ctx.storage.sql.exec(
        "UPDATE control_lease SET expires_at_ms = ? WHERE singleton = 1 AND token_hash = ?",
        leaseExpiresAtMs,
        attachment.tokenHash,
      );
      ws.serializeAttachment({
        ...attachment,
        leaseExpiresAtMs,
      } satisfies ControllerAttachment);
      safeSend(ws, JSON.stringify({ type: "heartbeat_ack", lease_expires_at_ms: leaseExpiresAtMs }));
      return;
    }

    if (isExactObject(decoded, ["type"]) && decoded.type === "release") {
      safeSend(ws, JSON.stringify({ type: "released" }));
      this.dropLease(attachment.tokenHash);
      return;
    }

    if (validateMediaGrantRequest(decoded)) {
      this.issueMediaGrant(ws, attachment, decoded, Date.now());
      return;
    }
    if (isExactObject(decoded, ["type", "event_id", "scope", "expires_in_ms"])
      && decoded.type === "media_grant_request") {
      rejectSocket(ws, "invalid_media_grant_request", 1008);
      return;
    }

    if (validateMediaGrantRevoke(decoded)) {
      this.revokeMediaGrant(ws, attachment, decoded.grant_id, Date.now());
      return;
    }
    if (isExactObject(decoded, ["type", "grant_id"])
      && decoded.type === "media_grant_revoke") {
      rejectSocket(ws, "invalid_media_grant_revoke", 1008);
      return;
    }

    if (validateDemoEvent(decoded, attachment.sessionId)) {
      if (decoded.event_type === "media_grant") {
        rejectSocket(ws, "server_managed_event_type", 1008);
        return;
      }
      this.acceptDemoEvent(ws, attachment, decoded);
      return;
    }
    if (
      decoded !== null
      && typeof decoded === "object"
      && !Array.isArray(decoded)
      && "schema_version" in decoded
      && decoded.schema_version === DEMO_EVENT_SCHEMA_VERSION
    ) {
      rejectSocket(ws, "invalid_event", 1008);
      return;
    }

    if (validateMediaSignal(decoded)) {
      this.forwardControllerSignal(ws, attachment, decoded, Date.now());
      return;
    }
    if (
      decoded !== null
      && typeof decoded === "object"
      && !Array.isArray(decoded)
      && "schema_version" in decoded
      && decoded.schema_version === MEDIA_SIGNAL_SCHEMA_VERSION
    ) {
      rejectSocket(ws, "invalid_media_signal", 1008);
      return;
    }

    const validation = validateFrame(decoded, attachment.sessionId);
    if (!validation.ok) {
      rejectSocket(ws, validation.error, 1008);
      return;
    }

    const frameSequence = this.frameSequence(attachment.sessionId);
    if (validation.frame.sequence <= frameSequence.last_frame_sequence) {
      rejectSocket(ws, "non_increasing_sequence", 1008);
      return;
    }

    this.ctx.storage.sql.exec(
      `UPDATE room_frame_sequence
          SET last_frame_sequence = ?
        WHERE singleton = 1 AND session_id = ?`,
      validation.frame.sequence,
      attachment.sessionId,
    );

    ws.serializeAttachment({
      ...attachment,
      latestFrame: validation.frame,
      latestFrameReceivedAtMs: Date.now(),
    } satisfies ControllerAttachment);

    const serialized = JSON.stringify(validation.frame);
    for (const viewer of this.ctx.getWebSockets("viewer")) {
      if (viewer.readyState === WebSocket.OPEN) {
        safeSend(viewer, serialized);
      }
    }
    safeSend(
      ws,
      JSON.stringify({ type: "frame_accepted", sequence: validation.frame.sequence }),
    );
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const attachment = readAttachment(ws);
    if (attachment?.role === "controller") {
      // The lease remains briefly reconnectable, but event-scoped media is
      // fail-closed immediately when the publishing socket disappears.
      this.revokeAllActiveGrants(attachment.sessionId, Date.now(), null);
    }
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    const attachment = readAttachment(ws);
    if (attachment?.role === "controller") {
      this.revokeAllActiveGrants(attachment.sessionId, Date.now(), null);
    }
  }

  private acceptDemoEvent(
    ws: WebSocket,
    attachment: ControllerAttachment,
    event: Exclude<DemoEvent, { event_type: "media_grant" }>,
  ): void {
    const sequence = this.eventSequence(attachment.sessionId);
    if (event.event_sequence <= sequence.last_event_sequence) {
      rejectSocket(ws, "non_increasing_event_sequence", 1008);
      return;
    }

    this.ctx.storage.sql.exec(
      `UPDATE room_event_sequence
         SET last_event_sequence = ?
       WHERE singleton = 1 AND session_id = ?`,
      event.event_sequence,
      attachment.sessionId,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO demo_event_state
         (event_type, session_id, event_sequence, event_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_type) DO UPDATE SET
         session_id = excluded.session_id,
         event_sequence = excluded.event_sequence,
         event_json = excluded.event_json`,
      event.event_type,
      attachment.sessionId,
      event.event_sequence,
      JSON.stringify(event),
    );

    this.broadcastToAllViewers(event);
    safeSend(ws, JSON.stringify({
      type: "event_accepted",
      event_sequence: event.event_sequence,
      event_type: event.event_type,
    }));
    this.revokeInvalidatedGrants(event, ws);
  }

  private issueMediaGrant(
    ws: WebSocket,
    attachment: ControllerAttachment,
    request: {
      event_id: string;
      scope: MediaGrantScope;
      expires_in_ms: number;
    },
    now: number,
  ): void {
    this.expireGrantRows(attachment.sessionId, now);
    if (!this.isGrantEligible(attachment.sessionId, request.event_id, request.scope)) {
      sendSocketError(ws, "media_grant_not_eligible");
      return;
    }
    const existing = this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant_id, session_id, event_id, scope, expires_at_ms, status
         FROM media_grant
        WHERE session_id = ? AND event_id = ? AND scope = ? AND status = 'active'
        LIMIT 1`,
      attachment.sessionId,
      request.event_id,
      request.scope,
    ).toArray()[0];
    if (existing !== undefined) {
      sendSocketError(ws, "media_grant_already_active");
      return;
    }

    const viewerIds = this.openSockets("viewer")
      .map((viewer) => readAttachment(viewer))
      .filter((value): value is ViewerAttachment => value?.role === "viewer")
      .map((value) => value.viewerId);
    const uniqueViewerIds = [...new Set(viewerIds)].sort();
    if (uniqueViewerIds.length === 0) {
      sendSocketError(ws, "no_connected_viewers");
      return;
    }

    const eventSequence = this.nextServerEventSequence(attachment.sessionId);
    const grantId = `grant-${randomHex(16)}`;
    const expiresAtMs = now + request.expires_in_ms;
    const payload: MediaGrantPayload = {
      grant_id: grantId,
      event_id: request.event_id,
      scope: request.scope,
      expires_at_ms: expiresAtMs,
      status: "active",
    };
    const event: DemoEvent = {
      schema_version: DEMO_EVENT_SCHEMA_VERSION,
      session_id: attachment.sessionId,
      event_sequence: eventSequence,
      timestamp_ms: now,
      event_type: "media_grant",
      payload,
    };

    this.ctx.storage.sql.exec(
      `INSERT INTO media_grant
         (grant_id, session_id, event_id, scope, expires_at_ms, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      grantId,
      attachment.sessionId,
      request.event_id,
      request.scope,
      expiresAtMs,
    );
    for (const viewerId of uniqueViewerIds) {
      this.ctx.storage.sql.exec(
        `INSERT INTO media_grant_audience (grant_id, viewer_id) VALUES (?, ?)`,
        grantId,
        viewerId,
      );
    }

    this.broadcastToViewerIds(uniqueViewerIds, event);
    safeSend(ws, JSON.stringify({
      type: "media_grant_accepted",
      grant: event,
      viewer_ids: uniqueViewerIds,
    }));
  }

  private revokeMediaGrant(
    ws: WebSocket,
    attachment: ControllerAttachment,
    grantId: string,
    now: number,
  ): void {
    const grant = this.grantById(grantId);
    if (
      grant === null
      || grant.session_id !== attachment.sessionId
      || grant.status !== "active"
      || grant.expires_at_ms <= now
    ) {
      if (grant?.status === "active" && grant.expires_at_ms <= now) {
        this.ctx.storage.sql.exec(
          "UPDATE media_grant SET status = 'expired' WHERE grant_id = ?",
          grant.grant_id,
        );
      }
      sendSocketError(ws, "invalid_media_grant");
      return;
    }
    this.revokeGrantRow(grant, now, ws);
  }

  private forwardControllerSignal(
    ws: WebSocket,
    attachment: ControllerAttachment,
    signal: MediaSignal,
    now: number,
  ): void {
    if (signal.signal_type === "answer" || signal.target_id === "controller") {
      sendSocketError(ws, "media_signal_direction_forbidden");
      return;
    }
    const grant = this.activeGrant(signal.grant_id, attachment.sessionId, now);
    if (grant === null || !this.grantIncludesViewer(grant.grant_id, signal.target_id)) {
      sendSocketError(ws, "media_signal_not_authorized");
      return;
    }
    const viewer = this.viewerSocket(signal.target_id);
    if (viewer === null) {
      sendSocketError(ws, "media_signal_target_unavailable");
      return;
    }
    safeSend(viewer, JSON.stringify(createForwardedMediaSignal(signal, "controller")));
  }

  private forwardViewerSignal(
    ws: WebSocket,
    attachment: ViewerAttachment,
    signal: MediaSignal,
    now: number,
  ): void {
    if (signal.target_id !== "controller" || signal.signal_type === "offer") {
      sendSocketError(ws, "media_signal_direction_forbidden");
      return;
    }
    const grant = this.activeGrantForViewer(signal.grant_id, attachment.viewerId, now);
    if (grant === null) {
      sendSocketError(ws, "media_signal_not_authorized");
      return;
    }
    const controller = this.controllerSocket(grant.session_id);
    if (controller === null) {
      sendSocketError(ws, "media_signal_target_unavailable");
      return;
    }
    safeSend(
      controller,
      JSON.stringify(createForwardedMediaSignal(signal, attachment.viewerId)),
    );
  }

  private revokeInvalidatedGrants(
    event: Exclude<DemoEvent, { event_type: "media_grant" }>,
    controller: WebSocket,
  ): void {
    const now = Date.now();
    const active = this.activeGrants(event.session_id, now);
    for (const grant of active) {
      const revokedByScene = event.event_type === "scene_state" && (
        (grant.scope === "kitchen_moment" && event.payload.scene_id !== "kitchen")
        || (grant.scope === "fall_emergency" && event.payload.scene_id !== "fall")
      );
      const revokedByCard = event.event_type === "care_card"
        && grant.scope === "kitchen_moment"
        && grant.event_id === event.payload.event_id
        && event.payload.share_state !== "consented";
      const revokedByAlarm = event.event_type === "alarm_state"
        && grant.scope === "fall_emergency"
        && grant.event_id === event.payload.event_id
        && event.payload.phase !== "escalated";
      if (revokedByScene || revokedByCard || revokedByAlarm) {
        this.revokeGrantRow(grant, now, controller);
      }
    }
  }

  private revokeAllActiveGrants(
    sessionId: string,
    now: number,
    controller: WebSocket | null,
  ): void {
    for (const grant of this.activeGrants(sessionId, now)) {
      this.revokeGrantRow(grant, now, controller);
    }
  }

  private revokeGrantRow(grant: GrantRow, now: number, controller: WebSocket | null): void {
    const eventSequence = this.nextServerEventSequence(grant.session_id);
    this.ctx.storage.sql.exec(
      "UPDATE media_grant SET status = 'revoked' WHERE grant_id = ? AND status = 'active'",
      grant.grant_id,
    );
    const event: DemoEvent = {
      schema_version: DEMO_EVENT_SCHEMA_VERSION,
      session_id: grant.session_id,
      event_sequence: eventSequence,
      timestamp_ms: now,
      event_type: "media_grant",
      payload: {
        grant_id: grant.grant_id,
        event_id: grant.event_id,
        scope: grant.scope,
        expires_at_ms: grant.expires_at_ms,
        status: "revoked",
      },
    };
    this.broadcastToViewerIds(this.grantViewerIds(grant.grant_id), event);
    const ack = JSON.stringify({ type: "media_grant_revoked", grant: event });
    if (controller !== null && controller.readyState === WebSocket.OPEN) {
      safeSend(controller, ack);
    } else {
      const activeController = this.controllerSocket(grant.session_id);
      if (activeController !== null) safeSend(activeController, ack);
    }
  }

  private isGrantEligible(
    sessionId: string,
    eventId: string,
    scope: MediaGrantScope,
  ): boolean {
    const scene = this.structuredEvent(sessionId, "scene_state");
    if (scope === "kitchen_moment") {
      const event = this.structuredEvent(sessionId, "care_card");
      return scene?.event_type === "scene_state"
        && scene.payload.scene_id === "kitchen"
        && event?.event_type === "care_card"
        && event.payload.event_id === eventId
        && event.payload.share_state === "consented";
    }
    const event = this.structuredEvent(sessionId, "alarm_state");
    return scene?.event_type === "scene_state"
      && scene.payload.scene_id === "fall"
      && event?.event_type === "alarm_state"
      && event.payload.event_id === eventId
      && event.payload.phase === "escalated"
      && event.payload.media_scope === "fall_emergency";
  }

  private structuredEvent(sessionId: string, eventType: DemoEventType): DemoEvent | null {
    const row = this.ctx.storage.sql.exec<EventStateRow>(
      `SELECT event_type, event_sequence, event_json
         FROM demo_event_state
        WHERE event_type = ? AND session_id = ?`,
      eventType,
      sessionId,
    ).toArray()[0];
    if (row === undefined) return null;
    const decoded = parseJson(row.event_json);
    return validateDemoEvent(decoded, sessionId) ? decoded : null;
  }

  private replayableEvents(sessionId: string): DemoEvent[] {
    const rows = this.ctx.storage.sql.exec<EventStateRow>(
      `SELECT event_type, event_sequence, event_json
         FROM demo_event_state
        WHERE session_id = ?
        ORDER BY event_sequence ASC`,
      sessionId,
    ).toArray();
    const events: DemoEvent[] = [];
    for (const row of rows) {
      const decoded = parseJson(row.event_json);
      if (validateDemoEvent(decoded, sessionId) && decoded.event_type !== "media_grant") {
        events.push(decoded);
      }
    }
    return events;
  }

  private eventSequence(sessionId: string): EventSequenceRow {
    const existing = this.ctx.storage.sql.exec<EventSequenceRow>(
      `SELECT session_id, last_event_sequence
         FROM room_event_sequence
        WHERE singleton = 1`,
    ).toArray()[0];
    if (existing !== undefined && existing.session_id === sessionId) return existing;
    this.ctx.storage.sql.exec("DELETE FROM room_event_sequence WHERE singleton = 1");
    this.ctx.storage.sql.exec(
      `INSERT INTO room_event_sequence (singleton, session_id, last_event_sequence)
       VALUES (1, ?, -1)`,
      sessionId,
    );
    return { session_id: sessionId, last_event_sequence: -1 };
  }

  private nextServerEventSequence(sessionId: string): number {
    const sequence = this.eventSequence(sessionId).last_event_sequence + 1;
    this.ctx.storage.sql.exec(
      `UPDATE room_event_sequence
          SET last_event_sequence = ?
        WHERE singleton = 1 AND session_id = ?`,
      sequence,
      sessionId,
    );
    return sequence;
  }

  private frameSequence(sessionId: string): FrameSequenceRow {
    const existing = this.ctx.storage.sql.exec<FrameSequenceRow>(
      `SELECT session_id, last_frame_sequence
         FROM room_frame_sequence
        WHERE singleton = 1`,
    ).toArray()[0];
    if (existing !== undefined && existing.session_id === sessionId) return existing;
    this.ctx.storage.sql.exec("DELETE FROM room_frame_sequence WHERE singleton = 1");
    this.ctx.storage.sql.exec(
      `INSERT INTO room_frame_sequence (singleton, session_id, last_frame_sequence)
       VALUES (1, ?, -1)`,
      sessionId,
    );
    return { session_id: sessionId, last_frame_sequence: -1 };
  }

  private grantById(grantId: string): GrantRow | null {
    return this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant_id, session_id, event_id, scope, expires_at_ms, status
         FROM media_grant
        WHERE grant_id = ?`,
      grantId,
    ).toArray()[0] ?? null;
  }

  private activeGrant(grantId: string, sessionId: string, now: number): GrantRow | null {
    const grant = this.grantById(grantId);
    if (grant === null || grant.session_id !== sessionId || grant.status !== "active") return null;
    if (grant.expires_at_ms <= now) {
      this.ctx.storage.sql.exec(
        "UPDATE media_grant SET status = 'expired' WHERE grant_id = ?",
        grant.grant_id,
      );
      return null;
    }
    return grant;
  }

  private activeGrantForViewer(grantId: string, viewerId: string, now: number): GrantRow | null {
    const grant = this.grantById(grantId);
    if (grant === null) return null;
    const lease = this.currentLease(now);
    if (lease === null || lease.session_id !== grant.session_id) return null;
    const active = this.activeGrant(grantId, grant.session_id, now);
    return active !== null && this.grantIncludesViewer(grantId, viewerId) ? active : null;
  }

  private activeGrants(sessionId: string, now: number): GrantRow[] {
    this.expireGrantRows(sessionId, now);
    return this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant_id, session_id, event_id, scope, expires_at_ms, status
         FROM media_grant
        WHERE session_id = ? AND status = 'active'
        ORDER BY expires_at_ms ASC`,
      sessionId,
    ).toArray();
  }

  private expireGrantRows(sessionId: string, now: number): void {
    this.ctx.storage.sql.exec(
      `UPDATE media_grant
          SET status = 'expired'
        WHERE session_id = ? AND status = 'active' AND expires_at_ms <= ?`,
      sessionId,
      now,
    );
  }

  private grantIncludesViewer(grantId: string, viewerId: string): boolean {
    return this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; count: number }>(
      `SELECT COUNT(*) AS count
         FROM media_grant_audience
        WHERE grant_id = ? AND viewer_id = ?`,
      grantId,
      viewerId,
    ).one().count === 1;
  }

  private grantViewerIds(grantId: string): string[] {
    return this.ctx.storage.sql.exec<GrantViewerRow>(
      `SELECT viewer_id
         FROM media_grant_audience
        WHERE grant_id = ?
        ORDER BY viewer_id ASC`,
      grantId,
    ).toArray().map((row) => row.viewer_id);
  }

  private viewerSocket(viewerId: string): WebSocket | null {
    for (const socket of this.openSockets("viewer")) {
      const attachment = readAttachment(socket);
      if (attachment?.role === "viewer" && attachment.viewerId === viewerId) return socket;
    }
    return null;
  }

  private controllerSocket(sessionId: string): WebSocket | null {
    for (const socket of this.openSockets("controller")) {
      const attachment = readAttachment(socket);
      if (attachment?.role === "controller" && attachment.sessionId === sessionId) return socket;
    }
    return null;
  }

  private broadcastToAllViewers(message: DemoEvent): void {
    const serialized = JSON.stringify(message);
    for (const viewer of this.openSockets("viewer")) safeSend(viewer, serialized);
  }

  private broadcastToViewerIds(viewerIds: readonly string[], message: DemoEvent): void {
    const serialized = JSON.stringify(message);
    const audience = new Set(viewerIds);
    for (const viewer of this.openSockets("viewer")) {
      const attachment = readAttachment(viewer);
      if (attachment?.role === "viewer" && audience.has(attachment.viewerId)) {
        safeSend(viewer, serialized);
      }
    }
  }

  private status(): Response {
    const lease = this.currentLease(Date.now());
    const controllerConnected = this.openSockets("controller").length > 0;
    return json({
      ok: true,
      controller_locked: lease !== null,
      controller_connected: controllerConnected,
      viewer_count: this.openSockets("viewer").length,
      session_id: lease?.session_id ?? null,
      lease_expires_at_ms: lease?.expires_at_ms ?? null,
    });
  }

  private async unlock(request: Request): Promise<Response> {
    const clientAddress = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const retryAfterSeconds = this.consumeUnlockAttempt(clientAddress, Date.now());
    if (retryAfterSeconds !== null) {
      return json(
        { ok: false, error: "unlock_rate_limited" },
        429,
        { "Retry-After": String(retryAfterSeconds) },
      );
    }

    const decoded = await readBoundedJson(request, 4_096);
    if (!isExactObject(decoded, ["key"]) || typeof decoded.key !== "string") {
      return json({ ok: false, error: "invalid_request" }, 400);
    }

    const expectedDigest = this.env.CONTROL_KEY_SHA256.toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
      console.error(JSON.stringify({ message: "CONTROL_KEY_SHA256 is not a SHA-256 hex digest" }));
      return json({ ok: false, error: "relay_misconfigured" }, 503);
    }

    const providedDigest = await sha256Hex(decoded.key);
    if (!constantTimeHexEqual(providedDigest, expectedDigest)) {
      return json({ ok: false, error: "invalid_control_key" }, 401);
    }
    this.unlockAttempts.delete(clientAddress);

    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    const sessionId = crypto.randomUUID();
    const leaseExpiresAtMs = Date.now() + LEASE_TTL_MS;

    // All awaited work is complete before the check-and-insert sequence. Durable
    // Object event serialization therefore makes the single-row claim atomic.
    if (this.currentLease(Date.now()) !== null) {
      return json({ ok: false, error: "controller_locked" }, 423);
    }
    this.ctx.storage.sql.exec("DELETE FROM media_grant_audience");
    this.ctx.storage.sql.exec("DELETE FROM media_grant");
    this.ctx.storage.sql.exec("DELETE FROM demo_event_state");
    this.ctx.storage.sql.exec("DELETE FROM room_event_sequence WHERE singleton = 1");
    this.ctx.storage.sql.exec("DELETE FROM room_frame_sequence WHERE singleton = 1");
    this.ctx.storage.sql.exec(
      `INSERT INTO control_lease
         (singleton, token_hash, session_id, expires_at_ms)
       VALUES (1, ?, ?, ?)`,
      tokenHash,
      sessionId,
      leaseExpiresAtMs,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO room_event_sequence (singleton, session_id, last_event_sequence)
       VALUES (1, ?, -1)`,
      sessionId,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO room_frame_sequence (singleton, session_id, last_frame_sequence)
       VALUES (1, ?, -1)`,
      sessionId,
    );

    return json({
      ok: true,
      token,
      session_id: sessionId,
      lease_expires_at_ms: leaseExpiresAtMs,
    });
  }

  private async release(request: Request): Promise<Response> {
    const authorization = request.headers.get("Authorization");
    if (authorization === null || !authorization.startsWith("Bearer ")) {
      return json({ ok: false, error: "missing_control_token" }, 401);
    }
    const token = authorization.slice("Bearer ".length);
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return json({ ok: false, error: "invalid_control_token" }, 401);
    }

    const tokenHash = await sha256Hex(token);
    const lease = this.currentLease(Date.now());
    if (lease === null || !constantTimeHexEqual(lease.token_hash, tokenHash)) {
      return json({ ok: false, error: "invalid_control_token" }, 401);
    }

    this.dropLease(tokenHash);
    return json({ ok: true });
  }

  private openViewer(request: Request): Response {
    if (!isWebSocketUpgrade(request)) {
      return json({ ok: false, error: "websocket_upgrade_required" }, 426);
    }
    const protocols = requestedProtocols(request);
    if (protocols.length !== 1 || protocols[0] !== VIEWER_PROTOCOL) {
      return json({ ok: false, error: "invalid_websocket_protocol" }, 400);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    let viewerId: string;
    do {
      viewerId = `viewer-${randomHex(12)}`;
    } while (this.viewerSocket(viewerId) !== null);
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment({ role: "viewer", viewerId } satisfies ViewerAttachment);

    // This must be the first server message so the browser can address later
    // grant-bound WebRTC signalling to this exact hibernating connection.
    safeSend(server, JSON.stringify({ type: "viewer_ready", viewer_id: viewerId }));

    const now = Date.now();
    const lease = this.currentLease(now);
    if (lease !== null) {
      for (const event of this.replayableEvents(lease.session_id)) {
        safeSend(server, JSON.stringify(event));
      }
    }
    const latestFrame = lease === null ? null : this.latestControllerFrame(now);
    if (latestFrame !== null) {
      safeSend(server, JSON.stringify(latestFrame));
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": VIEWER_PROTOCOL },
    });
  }

  private async openController(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return json({ ok: false, error: "websocket_upgrade_required" }, 426);
    }

    const protocols = requestedProtocols(request);
    const tokenProtocol = protocols.find((protocol) => protocol.startsWith(TOKEN_PROTOCOL_PREFIX));
    if (
      protocols.length !== 2 ||
      !protocols.includes(CONTROLLER_PROTOCOL) ||
      tokenProtocol === undefined
    ) {
      return json({ ok: false, error: "invalid_websocket_protocol" }, 400);
    }
    const token = tokenProtocol.slice(TOKEN_PROTOCOL_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(token)) {
      return json({ ok: false, error: "invalid_control_token" }, 401);
    }

    const tokenHash = await sha256Hex(token);
    const lease = this.currentLease(Date.now());
    if (lease === null || !constantTimeHexEqual(lease.token_hash, tokenHash)) {
      return json({ ok: false, error: "invalid_control_token" }, 401);
    }
    if (this.openSockets("controller").length > 0) {
      return json({ ok: false, error: "controller_socket_locked" }, 409);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const eventSequence = this.eventSequence(lease.session_id);
    const frameSequence = this.frameSequence(lease.session_id);
    const attachment: ControllerAttachment = {
      role: "controller",
      tokenHash,
      sessionId: lease.session_id,
      leaseExpiresAtMs: lease.expires_at_ms,
      latestFrame: null,
      latestFrameReceivedAtMs: null,
    };
    this.ctx.acceptWebSocket(server, ["controller"]);
    server.serializeAttachment(attachment);
    safeSend(
      server,
      JSON.stringify({
        type: "controller_ready",
        session_id: lease.session_id,
        lease_expires_at_ms: lease.expires_at_ms,
        last_event_sequence: eventSequence.last_event_sequence,
        last_frame_sequence: frameSequence.last_frame_sequence,
      }),
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": CONTROLLER_PROTOCOL },
    });
  }

  private currentLease(now: number): LeaseRow | null {
    const lease =
      this.ctx.storage.sql
        .exec<LeaseRow>(
          "SELECT token_hash, session_id, expires_at_ms FROM control_lease WHERE singleton = 1",
        )
        .toArray()[0] ?? null;

    if (lease !== null && lease.expires_at_ms <= now) {
      this.revokeAllActiveGrants(lease.session_id, now, null);
      this.ctx.storage.sql.exec("DELETE FROM control_lease WHERE singleton = 1");
      for (const socket of this.ctx.getWebSockets("controller")) {
        socket.close(1008, "controller_lease_expired");
      }
      return null;
    }
    return lease;
  }

  private dropLease(tokenHash: string): void {
    const lease = this.ctx.storage.sql.exec<LeaseRow>(
      `SELECT token_hash, session_id, expires_at_ms
         FROM control_lease
        WHERE singleton = 1`,
    ).toArray()[0];
    if (lease !== undefined && constantTimeHexEqual(lease.token_hash, tokenHash)) {
      this.revokeAllActiveGrants(lease.session_id, Date.now(), null);
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM control_lease WHERE singleton = 1 AND token_hash = ?",
      tokenHash,
    );
    for (const socket of this.ctx.getWebSockets("controller")) {
      const attachment = readAttachment(socket);
      if (
        attachment?.role === "controller" &&
        constantTimeHexEqual(attachment.tokenHash, tokenHash)
      ) {
        socket.close(1000, "controller_released");
      }
    }
  }

  private openSockets(tag: "controller" | "viewer"): WebSocket[] {
    return this.ctx
      .getWebSockets(tag)
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private latestControllerFrame(now: number): FrameLandmarks | null {
    for (const socket of this.openSockets("controller")) {
      const attachment = readAttachment(socket);
      if (
        attachment?.role === "controller"
        && attachment.latestFrame !== null
        && attachment.latestFrameReceivedAtMs !== null
        && now - attachment.latestFrameReceivedAtMs <= LATEST_FRAME_TTL_MS
      ) {
        return attachment.latestFrame;
      }
    }
    return null;
  }

  private consumeUnlockAttempt(clientAddress: string, now: number): number | null {
    const existing = this.unlockAttempts.get(clientAddress);
    if (existing === undefined || now - existing.windowStartedAtMs >= UNLOCK_ATTEMPT_WINDOW_MS) {
      if (existing === undefined && this.unlockAttempts.size >= MAX_TRACKED_CLIENTS) {
        for (const [address, window] of this.unlockAttempts) {
          if (now - window.windowStartedAtMs >= UNLOCK_ATTEMPT_WINDOW_MS) {
            this.unlockAttempts.delete(address);
          }
        }
        if (this.unlockAttempts.size >= MAX_TRACKED_CLIENTS) {
          const oldestAddress = this.unlockAttempts.keys().next().value;
          if (oldestAddress !== undefined) this.unlockAttempts.delete(oldestAddress);
        }
      }
      this.unlockAttempts.set(clientAddress, { windowStartedAtMs: now, attempts: 1 });
      return null;
    }
    if (existing.attempts >= MAX_UNLOCK_ATTEMPTS_PER_WINDOW) {
      return Math.max(
        1,
        Math.ceil(
          (UNLOCK_ATTEMPT_WINDOW_MS - (now - existing.windowStartedAtMs)) / 1_000,
        ),
      );
    }
    existing.attempts += 1;
    return null;
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const knownPath =
      url.pathname === "/api/status" ||
      url.pathname === "/api/unlock" ||
      url.pathname === "/api/release" ||
      url.pathname === "/api/activity/recognize" ||
      url.pathname === "/ws/viewer" ||
      url.pathname === "/ws/controller";
    if (!knownPath) {
      return json({ ok: false, error: "not_found" }, 404);
    }

    const origin = request.headers.get("Origin");
    if (origin === null || !allowedOrigins(env.ALLOWED_ORIGINS).has(origin)) {
      return withVaryOrigin(json({ ok: false, error: "origin_forbidden" }, 403));
    }

    if (request.method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }), origin);
    }

    const stub = env.DEMO_ROOM.getByName(ROOM_NAME);
    try {
      if (url.pathname === "/api/activity/recognize") {
        if (request.method !== "POST") {
          return withCors(json({ ok: false, error: "method_not_allowed" }, 405), origin);
        }
        const response = await handleActivityRecognition(
          request,
          env,
          (tokenHash) => stub.authorizeControlTokenHash(tokenHash),
        );
        return withCors(response, origin);
      }
      const response = await stub.fetch(request);
      return withCors(response, origin);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "demo relay request failed",
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return withCors(json({ ok: false, error: "relay_unavailable" }, 503), origin);
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;

function validateFrame(value: unknown, sessionId: string): FrameValidation {
  if (containsForbiddenMediaField(value)) {
    return { ok: false, error: "media_fields_forbidden" };
  }
  return isStrictFrame(value, sessionId)
    ? { ok: true, frame: value }
    : { ok: false, error: "invalid_frame" };
}

function isStrictFrame(value: unknown, sessionId: string): value is FrameLandmarks {
  if (
    !isExactObject(value, [
      "schema_version",
      "session_id",
      "sequence",
      "timestamp_ms",
      "source_width",
      "source_height",
      "person_detected",
      "landmark_quality",
      "keypoints",
    ]) ||
    value.schema_version !== FRAME_SCHEMA_VERSION ||
    value.session_id !== sessionId ||
    !Number.isSafeInteger(value.sequence) ||
    typeof value.sequence !== "number" ||
    value.sequence < 0 ||
    !isFiniteNonNegativeNumber(value.timestamp_ms) ||
    !isSourceDimension(value.source_width) ||
    !isSourceDimension(value.source_height) ||
    typeof value.person_detected !== "boolean" ||
    !isLandmarkQuality(value.landmark_quality) ||
    (value.person_detected && value.landmark_quality === "unavailable") ||
    (!value.person_detected && value.landmark_quality !== "unavailable") ||
    !Array.isArray(value.keypoints) ||
    value.keypoints.length !== MOVENET_KEYPOINT_NAMES.length
  ) {
    return false;
  }

  const keypoints = value.keypoints;
  for (let index = 0; index < MOVENET_KEYPOINT_NAMES.length; index += 1) {
    const keypoint = keypoints[index];
    if (
      !isExactObject(keypoint, ["name", "x", "y", "score"]) ||
      keypoint.name !== MOVENET_KEYPOINT_NAMES[index] ||
      !isUnitNumber(keypoint.x) ||
      !isUnitNumber(keypoint.y) ||
      !isUnitNumber(keypoint.score)
    ) {
      return false;
    }
  }
  const shoulderVisible = [5, 6].some(
    (index) => keypoints[index].score >= KEYPOINT_SCORE_THRESHOLD,
  );
  const hipVisible = [11, 12].some(
    (index) => keypoints[index].score >= KEYPOINT_SCORE_THRESHOLD,
  );
  const torsoDetected = shoulderVisible && hipVisible;
  if (value.person_detected !== torsoDetected) {
    return false;
  }
  const expectedQuality: FrameLandmarks["landmark_quality"] = !torsoDetected
    ? "unavailable"
    : [5, 6, 11, 12, 13, 14, 15, 16].every(
      (index) => keypoints[index].score >= KEYPOINT_SCORE_THRESHOLD,
    )
      ? "usable"
      : "degraded";
  return value.landmark_quality === expectedQuality;
}

function containsForbiddenMediaField(value: unknown, depth = 0): boolean {
  if (depth > 4 || value === null || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenMediaField(item, depth + 1));
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_MEDIA_KEYS.has(key.toLowerCase())) {
      return true;
    }
    if (containsForbiddenMediaField(child, depth + 1)) {
      return true;
    }
  }
  return false;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isUnitNumber(value: unknown): value is number {
  return isFiniteNonNegativeNumber(value) && value <= 1;
}

function isSourceDimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 16_384
  );
}

function isLandmarkQuality(
  value: unknown,
): value is FrameLandmarks["landmark_quality"] {
  return value === "usable" || value === "degraded" || value === "unavailable";
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (request.body === null) {
    return null;
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      bytesRead += result.value.byteLength;
      if (bytesRead > maxBytes) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return parseJson(text);
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function requestedProtocols(request: Request): string[] {
  const header = request.headers.get("Sec-WebSocket-Protocol");
  if (header === null) {
    return [];
  }
  return header
    .split(",")
    .map((protocol) => protocol.trim())
    .filter((protocol) => protocol.length > 0);
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (
    isExactObject(value, ["role", "viewerId"])
    && value.role === "viewer"
    && typeof value.viewerId === "string"
    && /^viewer-[a-f0-9]{24}$/.test(value.viewerId)
  ) {
    return { role: "viewer", viewerId: value.viewerId };
  }
  if (
    isExactObject(value, [
      "role",
      "tokenHash",
      "sessionId",
      "leaseExpiresAtMs",
      "latestFrame",
      "latestFrameReceivedAtMs",
    ]) &&
    value.role === "controller" &&
    typeof value.tokenHash === "string" &&
    /^[a-f0-9]{64}$/.test(value.tokenHash) &&
    typeof value.sessionId === "string" &&
    isFiniteNonNegativeNumber(value.leaseExpiresAtMs) &&
    (value.latestFrameReceivedAtMs === null
      || isFiniteNonNegativeNumber(value.latestFrameReceivedAtMs))
  ) {
    const latestFrameValidation =
      value.latestFrame === null ? null : validateFrame(value.latestFrame, value.sessionId);
    const attachmentIsConsistent = value.latestFrame === null
      ? value.latestFrameReceivedAtMs === null
      : value.latestFrameReceivedAtMs !== null;
    if (attachmentIsConsistent && (latestFrameValidation === null || latestFrameValidation.ok)) {
      return {
        role: "controller",
        tokenHash: value.tokenHash,
        sessionId: value.sessionId,
        leaseExpiresAtMs: value.leaseExpiresAtMs,
        latestFrame:
          latestFrameValidation === null ? null : latestFrameValidation.frame,
        latestFrameReceivedAtMs: value.latestFrameReceivedAtMs,
      };
    }
  }
  return null;
}

function rejectSocket(ws: WebSocket, error: string, code: number): void {
  safeSend(ws, JSON.stringify({ type: "error", error }));
  ws.close(code, error.slice(0, 123));
}

function sendSocketError(ws: WebSocket, error: string): void {
  safeSend(ws, JSON.stringify({ type: "error", error }));
}

function safeSend(ws: WebSocket, message: string): void {
  try {
    ws.send(message);
  } catch {
    ws.close(1011, "send_failed");
  }
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(left: string, right: string): boolean {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (leftBytes === null || rightBytes === null) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    bytes[index] = byte;
  }
  return bytes;
}

function json(payload: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return Response.json(payload, {
    status,
    headers,
  });
}

function allowedOrigins(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
}

function withCors(response: Response, allowedOrigin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowedOrigin);
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin");
  const init: ResponseInit = {
    status: response.status,
    statusText: response.statusText,
    headers,
  };
  if (response.status === 101 && response.webSocket !== null) {
    return new Response(null, { ...init, webSocket: response.webSocket });
  }
  return new Response(response.body, init);
}

function withVaryOrigin(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
