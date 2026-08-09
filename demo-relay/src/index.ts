import { DurableObject } from "cloudflare:workers";

import {
  canonicalJson,
  containsForbiddenRawMedia,
  CONTROL_COMMAND_SCHEMA_VERSION,
  createForwardedMediaSignal,
  DEMO_STATE_SCHEMA_VERSION,
  isExactObject,
  isOpaqueId,
  MEDIA_SIGNAL_SCHEMA_VERSION,
  POSE_FRAME_SCHEMA_VERSION,
  ROOM_NAME,
  type ActiveMediaGrant,
  type ControlAck,
  type ControlAckPhase,
  type ControlCommand,
  type DemoStateEnvelope,
  type MediaGrantRequest,
  type MediaGrantScope,
  type MediaSignal,
  type PoseFrame,
  validateControlAck,
  validateControlCommand,
  validateDemoState,
  validateMediaGrantRequest,
  validateMediaGrantRevoke,
  validateMediaSignal,
  validatePoseFrame,
  withMediaGrant,
} from "./protocol";

export type {
  ActiveMediaGrant,
  ControlAck,
  ControlCommand,
  DemoStateEnvelope,
  MediaSignal,
  PoseFrame,
} from "./protocol";

const MONITOR_PROTOCOL = "reme-monitor-v1";
const VIEWER_PROTOCOL = "reme-viewer-v1";
const TOKEN_PROTOCOL_PREFIX = "reme-token-";
const LEASE_TTL_MS = 30_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const LATEST_POSE_TTL_MS = 2_500;
const LATEST_STATE_TTL_MS = LEASE_TTL_MS;
const MAX_VIEWERS = 5;
const MAX_JSON_BYTES = 16_384;
const MAX_SIGNAL_MESSAGES_PER_GRANT = 160;
const MAX_COMMAND_LIFETIME_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_TERMINAL_COMMAND_HISTORY = 256;

interface SqlRow {
  [key: string]: SqlStorageValue;
}

interface RoomRow extends SqlRow {
  room_session_id: string;
  created_at_ms: number;
}

interface ProducerLeaseRow extends SqlRow {
  token_hash: string;
  room_session_id: string;
  expires_at_ms: number;
  socket_id: string | null;
}

interface LatestStateRow extends SqlRow {
  room_session_id: string;
  runtime_session_id: string;
  state_revision: number;
  state_json: string;
  received_at_ms: number;
}

interface LatestPoseRow extends SqlRow {
  room_session_id: string;
  runtime_session_id: string;
  frame_sequence: number;
  pose_json: string;
  received_at_ms: number;
}

interface ControllerLeaseRow extends SqlRow {
  room_session_id: string;
  viewer_id: string;
  lease_id: string;
  expires_at_ms: number;
  last_command_sequence: number;
}

interface CommandRow extends SqlRow {
  room_session_id: string;
  command_id: string;
  command_json: string;
  ack_json: string;
  phase: ControlAckPhase;
  expected_state_revision: number;
}

interface GrantRow extends SqlRow {
  grant_id: string;
  room_session_id: string;
  runtime_session_id: string;
  event_id: string;
  scope: MediaGrantScope;
  expires_at_ms: number;
  status: "active" | "revoked" | "expired";
}

interface ViewerAttachment {
  role: "viewer";
  viewerId: string;
  socketId: string;
  signalGrantId: string | null;
  signalCount: number;
}

interface MonitorAttachment {
  role: "monitor";
  roomSessionId: string;
  tokenHash: string;
  socketId: string;
  signalGrantId: string | null;
  signalCount: number;
}

type SocketAttachment = ViewerAttachment | MonitorAttachment;

export interface MonitorClaimSuccess {
  ok: true;
  room_name: typeof ROOM_NAME;
  room_session_id: string;
  producer_token: string;
  expires_at_ms: number;
}

export interface MonitorClaimBusy {
  ok: false;
  error: "monitor_busy";
  retry_at_ms: number;
  server_time_ms: number;
  retry_after_ms: number;
}

export type MonitorClaimResult = MonitorClaimSuccess | MonitorClaimBusy;

interface RoomStatus {
  room_name: typeof ROOM_NAME;
  room_session_id: string | null;
  monitor_online: boolean;
  producer_lease_expires_at_ms: number | null;
  viewer_count: number;
  max_viewers: typeof MAX_VIEWERS;
  controller: ControllerInfo | null;
  active_media_grant: ActiveMediaGrant | null;
  server_time_ms: number;
}

interface ControllerInfo {
  viewer_id: string;
  lease_id: string;
  expires_at_ms: number;
}

interface MediaGrantWire {
  type: "media_grant";
  room_session_id: string;
  grant: {
    grant_id: string;
    event_id: string;
    scope: MediaGrantScope;
    expires_at_ms: number;
    status: "active" | "revoked" | "expired";
  };
  audience: "all_viewers";
  reason: string | null;
}

type StateAuthority =
  | { status: "fresh"; row: LatestStateRow; state: DemoStateEnvelope }
  | { status: "missing" | "stale" };

export class DemoRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  async claimMonitor(nowMs = Date.now()): Promise<MonitorClaimResult> {
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    this.expireDueSync(nowMs);

    const current = this.producerLease();
    if (current !== null && current.expires_at_ms > nowMs) {
      await this.scheduleNextAlarm(nowMs);
      return {
        ok: false,
        error: "monitor_busy",
        retry_at_ms: current.expires_at_ms,
        server_time_ms: nowMs,
        retry_after_ms: current.expires_at_ms - nowMs,
      };
    }

    this.failPendingCommands(nowMs, "room_session_replaced");
    this.revokeActiveGrants(nowMs, "room_session_replaced", "revoked");
    this.closeMonitorSockets(1012, "room_session_replaced");

    const roomSessionId = `room-${crypto.randomUUID()}`;
    const expiresAtMs = nowMs + LEASE_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO room (singleton, room_session_id, created_at_ms)
       VALUES (1, ?, ?)`,
      roomSessionId,
      nowMs,
    );
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO producer_lease
         (singleton, token_hash, room_session_id, expires_at_ms, socket_id)
       VALUES (1, ?, ?, ?, NULL)`,
      tokenHash,
      roomSessionId,
      expiresAtMs,
    );
    this.ctx.storage.sql.exec("DELETE FROM latest_state");
    this.ctx.storage.sql.exec("DELETE FROM latest_pose");
    this.ctx.storage.sql.exec("DELETE FROM controller_lease");
    this.ctx.storage.sql.exec("DELETE FROM commands");
    this.ctx.storage.sql.exec("DELETE FROM media_grant_audience");
    this.ctx.storage.sql.exec("DELETE FROM media_grants");

    this.broadcastStateUnavailable("not_published");
    this.broadcastControllerStatus(nowMs);
    this.broadcastPresence(nowMs);
    await this.scheduleNextAlarm(nowMs);
    return {
      ok: true,
      room_name: ROOM_NAME,
      room_session_id: roomSessionId,
      producer_token: token,
      expires_at_ms: expiresAtMs,
    };
  }

  async getStatus(nowMs = Date.now()): Promise<RoomStatus> {
    this.expireDueSync(nowMs);
    await this.scheduleNextAlarm(nowMs);
    const room = this.room();
    const lease = this.producerLease();
    return {
      room_name: ROOM_NAME,
      room_session_id: room?.room_session_id ?? null,
      monitor_online: this.monitorOnline(nowMs),
      producer_lease_expires_at_ms: lease?.expires_at_ms ?? null,
      viewer_count: this.viewerSockets().length,
      max_viewers: MAX_VIEWERS,
      controller: this.controllerInfo(nowMs),
      active_media_grant: this.activeGrant(nowMs),
      server_time_ms: nowMs,
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return jsonResponse({ error: "websocket_upgrade_required" }, 426);
    }

    const nowMs = Date.now();
    this.expireDueSync(nowMs);
    if (url.pathname === "/ws/monitor") {
      const response = await this.acceptMonitor(request, nowMs);
      await this.scheduleNextAlarm(nowMs);
      return response;
    }
    if (url.pathname === "/ws/viewer") {
      const response = this.acceptViewer(request, nowMs);
      await this.scheduleNextAlarm(nowMs);
      return response;
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment === null) {
      ws.close(1011, "missing_attachment");
      return;
    }
    if (typeof message !== "string") {
      sendJson(ws, { type: "protocol_error", code: "binary_frames_forbidden" });
      ws.close(1003, "binary_frames_forbidden");
      return;
    }
    if (new TextEncoder().encode(message).byteLength > MAX_JSON_BYTES) {
      sendJson(ws, { type: "protocol_error", code: "message_too_large" });
      ws.close(1009, "message_too_large");
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      sendJson(ws, { type: "protocol_error", code: "invalid_json" });
      return;
    }
    if (containsForbiddenRawMedia(value)) {
      sendJson(ws, { type: "protocol_error", code: "raw_media_forbidden" });
      return;
    }

    const nowMs = Date.now();
    this.expireDueSync(nowMs);
    if (attachment.role === "monitor") {
      this.handleMonitorMessage(ws, attachment, value, nowMs);
    } else {
      this.handleViewerMessage(ws, attachment, value, nowMs);
    }
    await this.scheduleNextAlarm(nowMs);
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    this.handleSocketGone(ws, Date.now());
    await this.scheduleNextAlarm(Date.now());
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({
      message: "relay_websocket_error",
      error: error instanceof Error ? error.message : String(error),
    }));
    this.handleSocketGone(ws, Date.now());
    await this.scheduleNextAlarm(Date.now());
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    this.expireDueSync(nowMs);
    await this.scheduleNextAlarm(nowMs);
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_session_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS producer_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        token_hash TEXT NOT NULL,
        room_session_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        socket_id TEXT
      );
      CREATE TABLE IF NOT EXISTS latest_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_session_id TEXT NOT NULL,
        runtime_session_id TEXT NOT NULL,
        state_revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS latest_pose (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_session_id TEXT NOT NULL,
        runtime_session_id TEXT NOT NULL,
        frame_sequence INTEGER NOT NULL,
        pose_json TEXT NOT NULL,
        received_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS controller_lease (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        room_session_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        last_command_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS commands (
        room_session_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        command_json TEXT NOT NULL,
        ack_json TEXT NOT NULL,
        phase TEXT NOT NULL,
        expected_state_revision INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        PRIMARY KEY (room_session_id, command_id)
      );
      CREATE TABLE IF NOT EXISTS media_grants (
        grant_id TEXT PRIMARY KEY,
        room_session_id TEXT NOT NULL,
        runtime_session_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_grant_audience (
        grant_id TEXT NOT NULL,
        viewer_id TEXT NOT NULL,
        PRIMARY KEY (grant_id, viewer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_media_grants_active
        ON media_grants (status, expires_at_ms);
      INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at_ms)
        VALUES (1, ${Date.now()});
    `);
  }

  private async acceptMonitor(request: Request, nowMs: number): Promise<Response> {
    const protocols = parseProtocols(request.headers.get("Sec-WebSocket-Protocol"));
    const tokenProtocol = protocols.find((item) => item.startsWith(TOKEN_PROTOCOL_PREFIX));
    if (!protocols.includes(MONITOR_PROTOCOL) || tokenProtocol === undefined) {
      return jsonResponse({ error: "monitor_protocol_required" }, 400);
    }
    const token = tokenProtocol.slice(TOKEN_PROTOCOL_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(token)) return jsonResponse({ error: "invalid_token" }, 401);
    const providedHash = await sha256Hex(token);
    const lease = this.producerLease();
    if (
      lease === null
      || lease.expires_at_ms <= nowMs
      || !(await timingSafeHexEqual(providedHash, lease.token_hash))
    ) return jsonResponse({ error: "invalid_or_expired_token" }, 401);

    this.revokeActiveGrants(nowMs, "monitor_reconnected", "revoked");
    this.failPendingCommands(nowMs, "monitor_reconnected");
    this.ctx.storage.sql.exec(
      `UPDATE producer_lease SET socket_id = NULL
        WHERE singleton = 1 AND room_session_id = ? AND token_hash = ?`,
      lease.room_session_id,
      lease.token_hash,
    );
    this.closeMonitorSockets(1012, "monitor_reconnected");
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, ["monitor"]);
    const socketId = `socket-${crypto.randomUUID()}`;
    const attachment: MonitorAttachment = {
      role: "monitor",
      roomSessionId: lease.room_session_id,
      tokenHash: lease.token_hash,
      socketId,
      signalGrantId: null,
      signalCount: 0,
    };
    server.serializeAttachment(attachment);
    const connectedExpiresAtMs = nowMs + LEASE_TTL_MS;
    this.ctx.storage.sql.exec(
      `UPDATE producer_lease SET socket_id = ?, expires_at_ms = ?
        WHERE singleton = 1 AND room_session_id = ? AND token_hash = ?`,
      socketId,
      connectedExpiresAtMs,
      lease.room_session_id,
      lease.token_hash,
    );
    sendJson(server, {
      type: "monitor_ready",
      room_name: ROOM_NAME,
      room_session_id: lease.room_session_id,
      expires_at_ms: connectedExpiresAtMs,
      viewer_count: this.viewerSockets().length,
      max_viewers: MAX_VIEWERS,
      controller: this.controllerInfo(nowMs),
      heartbeat_interval_ms: HEARTBEAT_INTERVAL_MS,
      server_time_ms: nowMs,
    });
    this.broadcastPresence(nowMs);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": MONITOR_PROTOCOL },
    });
  }

  private acceptViewer(request: Request, nowMs: number): Response {
    const protocols = parseProtocols(request.headers.get("Sec-WebSocket-Protocol"));
    if (!protocols.includes(VIEWER_PROTOCOL)) {
      return jsonResponse({ error: "viewer_protocol_required" }, 400);
    }
    if (this.viewerSockets().length >= MAX_VIEWERS) {
      return jsonResponse({ error: "viewer_limit_reached", max_viewers: MAX_VIEWERS }, 503);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const viewerId = `viewer-${crypto.randomUUID()}`;
    this.ctx.acceptWebSocket(server, ["viewer", `viewer:${viewerId}`]);
    const attachment: ViewerAttachment = {
      role: "viewer",
      viewerId,
      socketId: `socket-${crypto.randomUUID()}`,
      signalGrantId: null,
      signalCount: 0,
    };
    server.serializeAttachment(attachment);
    const room = this.room();
    const activeGrant = this.activeGrantRow(nowMs);
    if (activeGrant !== null) {
      this.addGrantAudience(activeGrant.grant_id, viewerId);
    }
    sendJson(server, {
      type: "viewer_ready",
      room_name: ROOM_NAME,
      viewer_id: viewerId,
      room_session_id: room?.room_session_id ?? null,
      monitor_online: this.monitorOnline(nowMs),
      viewer_count: this.viewerSockets().length,
      max_viewers: MAX_VIEWERS,
      controller: this.controllerInfo(nowMs),
      server_time_ms: nowMs,
    });
    this.sendLatestState(server, viewerId, nowMs);
    this.sendLatestPose(server, nowMs);
    if (activeGrant !== null && this.viewerInGrantAudience(activeGrant.grant_id, viewerId)) {
      sendJson(server, this.mediaGrantWire(activeGrant, "active", null));
    }
    this.broadcastPresence(nowMs);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": VIEWER_PROTOCOL },
    });
  }

  private handleMonitorMessage(
    ws: WebSocket,
    attachment: MonitorAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!this.isCurrentMonitor(attachment, nowMs)) {
      sendJson(ws, { type: "protocol_error", code: "stale_monitor_session" });
      ws.close(1008, "stale_monitor_session");
      return;
    }
    if (isExactObject(value, ["room_session_id", "type"])
      && value.type === "monitor_heartbeat") {
      this.handleMonitorHeartbeat(ws, attachment, value.room_session_id, nowMs);
      return;
    }
    if (isExactObject(value, ["room_session_id", "type"])
      && value.type === "monitor_release") {
      if (value.room_session_id !== attachment.roomSessionId) {
        sendJson(ws, { type: "protocol_error", code: "stale_room_session" });
        return;
      }
      this.releaseMonitor(attachment, nowMs, "monitor_released");
      ws.close(1000, "monitor_released");
      return;
    }
    if (isExactObject(value, ["room_session_id", "type"])
      && value.type === "control_revoke") {
      this.handleMonitorControlRevoke(ws, attachment, value.room_session_id, nowMs);
      return;
    }
    if (isExactObject(value, ["schema_version", "room_session_id", "runtime_session_id", "state_revision", "timestamp_ms", "state"])
      && value.schema_version === DEMO_STATE_SCHEMA_VERSION) {
      this.handleState(ws, attachment, value, nowMs);
      return;
    }
    if (isExactObject(value, [
      "frame_sequence",
      "keypoints",
      "landmark_quality",
      "person_detected",
      "room_session_id",
      "runtime_session_id",
      "schema_version",
      "source_height",
      "source_width",
      "timestamp_ms",
    ]) && value.schema_version === POSE_FRAME_SCHEMA_VERSION) {
      this.handlePose(ws, attachment, value, nowMs);
      return;
    }
    if (isExactObject(value, [
      "command_id",
      "phase",
      "reason",
      "room_session_id",
      "state_revision",
      "timestamp_ms",
      "type",
    ]) && value.type === "control_ack") {
      this.handleControlAck(ws, attachment, value, nowMs);
      return;
    }
    if (isExactObject(value, [
      "event_id",
      "expires_in_ms",
      "room_session_id",
      "runtime_session_id",
      "scope",
      "type",
    ]) && value.type === "media_grant_request") {
      this.handleGrantRequest(ws, attachment, value, nowMs);
      return;
    }
    if (isExactObject(value, ["grant_id", "room_session_id", "type"])
      && value.type === "media_grant_revoke") {
      this.handleGrantRevoke(ws, attachment, value, nowMs);
      return;
    }
    if (isExactObject(value, [
      "grant_id",
      "room_session_id",
      "schema_version",
      "signal",
      "signal_type",
      "target_id",
    ]) && value.schema_version === MEDIA_SIGNAL_SCHEMA_VERSION) {
      this.handleMediaSignal(ws, attachment, value, nowMs);
      return;
    }
    sendJson(ws, { type: "protocol_error", code: "invalid_monitor_message" });
  }

  private handleViewerMessage(
    ws: WebSocket,
    attachment: ViewerAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (isExactObject(value, ["room_session_id", "type"])
      && value.type === "control_claim") {
      this.handleControlClaim(ws, attachment, value.room_session_id, nowMs);
      return;
    }
    if (isExactObject(value, ["lease_id", "room_session_id", "type"])
      && value.type === "control_heartbeat") {
      this.handleControlHeartbeat(ws, attachment, value.room_session_id, value.lease_id, nowMs);
      return;
    }
    if (isExactObject(value, ["lease_id", "room_session_id", "type"])
      && value.type === "control_release") {
      this.handleControlRelease(ws, attachment, value.room_session_id, value.lease_id, nowMs);
      return;
    }
    if (isExactObject(value, [
      "command",
      "command_id",
      "command_sequence",
      "expected_state_revision",
      "expires_at_ms",
      "issued_at_ms",
      "room_session_id",
      "schema_version",
    ]) && value.schema_version === CONTROL_COMMAND_SCHEMA_VERSION) {
      this.handleControlCommand(ws, attachment, value, nowMs);
      return;
    }
    if (isExactObject(value, [
      "grant_id",
      "room_session_id",
      "schema_version",
      "signal",
      "signal_type",
      "target_id",
    ]) && value.schema_version === MEDIA_SIGNAL_SCHEMA_VERSION) {
      this.handleMediaSignal(ws, attachment, value, nowMs);
      return;
    }
    sendJson(ws, { type: "protocol_error", code: "invalid_viewer_message" });
  }

  private handleMonitorHeartbeat(
    ws: WebSocket,
    attachment: MonitorAttachment,
    roomSessionId: unknown,
    nowMs: number,
  ): void {
    if (roomSessionId !== attachment.roomSessionId) {
      sendJson(ws, { type: "protocol_error", code: "stale_room_session" });
      return;
    }
    const expiresAtMs = nowMs + LEASE_TTL_MS;
    this.ctx.storage.sql.exec(
      `UPDATE producer_lease SET expires_at_ms = ?
        WHERE singleton = 1 AND room_session_id = ? AND token_hash = ? AND socket_id = ?`,
      expiresAtMs,
      attachment.roomSessionId,
      attachment.tokenHash,
      attachment.socketId,
    );
    sendJson(ws, {
      type: "monitor_heartbeat_ack",
      room_session_id: attachment.roomSessionId,
      expires_at_ms: expiresAtMs,
    });
    this.broadcastPresence(nowMs);
  }

  private handleState(
    ws: WebSocket,
    attachment: MonitorAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!validateDemoState(value, attachment.roomSessionId, true)) {
      sendJson(ws, { type: "protocol_error", code: "invalid_demo_state" });
      return;
    }
    if (value.timestamp_ms > nowMs + MAX_CLOCK_SKEW_MS) {
      sendJson(ws, { type: "protocol_error", code: "state_timestamp_in_future" });
      return;
    }
    const previousRow = this.latestState();
    const previous = previousRow === null ? null : parseStoredState(previousRow);
    const sessionChanged = previous !== null
      && previous.runtime_session_id !== value.runtime_session_id;
    if (
      !sessionChanged
      && previousRow !== null
      && value.state_revision <= previousRow.state_revision
    ) {
      if (
        value.state_revision === previousRow.state_revision
        && canonicalJson(value) === previousRow.state_json
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE latest_state SET received_at_ms = ? WHERE singleton = 1",
          nowMs,
        );
        this.broadcastState(value, nowMs);
        sendJson(ws, {
          type: "state_accepted",
          room_session_id: value.room_session_id,
          state_revision: value.state_revision,
        });
        return;
      }
      sendJson(ws, {
        type: "protocol_error",
        code: value.state_revision === previousRow.state_revision
          ? "state_revision_conflict"
          : "non_increasing_state_revision",
      });
      return;
    }
    const sceneChanged = previous !== null && previous.state.scene_id !== value.state.scene_id;
    const sourceChanged = previous !== null
      && previous.state.source_generation !== value.state.source_generation;
    if (sessionChanged) {
      this.ctx.storage.sql.exec("DELETE FROM latest_pose");
      this.failPendingCommands(nowMs, "runtime_session_changed");
    }
    if (
      sessionChanged
      || sceneChanged
      || sourceChanged
      || value.state.scene_id === "bathroom"
      || value.state.capture.status !== "active"
    ) {
      const reason = sessionChanged
        ? "runtime_session_changed"
        : sceneChanged
          ? "scene_changed"
          : sourceChanged
            ? "media_source_changed"
            : value.state.scene_id === "bathroom"
              ? "bathroom_privacy_lock"
              : "capture_not_active";
      this.revokeActiveGrants(nowMs, reason, "revoked");
    } else {
      this.revokeGrantIfAuthorityLost(value, nowMs);
    }

    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO latest_state
         (singleton, room_session_id, runtime_session_id, state_revision, state_json, received_at_ms)
       VALUES (1, ?, ?, ?, ?, ?)`,
      value.room_session_id,
      value.runtime_session_id,
      value.state_revision,
      canonicalJson(value),
      nowMs,
    );
    this.broadcastState(value, nowMs);
    sendJson(ws, {
      type: "state_accepted",
      room_session_id: value.room_session_id,
      state_revision: value.state_revision,
    });
  }

  private handlePose(
    ws: WebSocket,
    attachment: MonitorAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    const authority = this.authoritativeState(nowMs);
    if (authority.status !== "fresh") {
      sendJson(ws, {
        type: "protocol_error",
        code: authority.status === "stale" ? "state_stale" : "state_required_before_pose",
      });
      return;
    }
    if (!validatePoseFrame(value, attachment.roomSessionId, authority.row.runtime_session_id)) {
      sendJson(ws, { type: "protocol_error", code: "invalid_pose_frame" });
      return;
    }
    const previous = this.latestPose();
    if (
      previous !== null
      && previous.runtime_session_id === value.runtime_session_id
      && value.frame_sequence <= previous.frame_sequence
    ) {
      if (
        value.frame_sequence === previous.frame_sequence
        && canonicalJson(value) === previous.pose_json
      ) {
        this.ctx.storage.sql.exec(
          "UPDATE latest_pose SET received_at_ms = ? WHERE singleton = 1",
          nowMs,
        );
        sendJson(ws, {
          type: "pose_accepted",
          room_session_id: value.room_session_id,
          frame_sequence: value.frame_sequence,
        });
        return;
      }
      sendJson(ws, {
        type: "protocol_error",
        code: value.frame_sequence === previous.frame_sequence
          ? "frame_sequence_conflict"
          : "non_increasing_frame_sequence",
      });
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO latest_pose
         (singleton, room_session_id, runtime_session_id, frame_sequence, pose_json, received_at_ms)
       VALUES (1, ?, ?, ?, ?, ?)`,
      value.room_session_id,
      value.runtime_session_id,
      value.frame_sequence,
      canonicalJson(value),
      nowMs,
    );
    this.broadcastToViewers(value);
    sendJson(ws, {
      type: "pose_accepted",
      room_session_id: value.room_session_id,
      frame_sequence: value.frame_sequence,
    });
  }

  private handleControlClaim(
    ws: WebSocket,
    attachment: ViewerAttachment,
    roomSessionId: unknown,
    nowMs: number,
  ): void {
    const room = this.room();
    if (
      room === null
      || roomSessionId !== room.room_session_id
      || !this.monitorOnline(nowMs)
    ) {
      sendJson(ws, {
        type: "control_claim_result",
        status: "unavailable",
        room_session_id: room?.room_session_id ?? null,
        lease: null,
      });
      return;
    }
    const existing = this.controllerLease();
    if (existing !== null && existing.expires_at_ms > nowMs) {
      if (existing.viewer_id !== attachment.viewerId) {
        sendJson(ws, {
          type: "control_claim_result",
          status: "busy",
          room_session_id: room.room_session_id,
          lease: null,
        });
        return;
      }
      const expiresAtMs = nowMs + LEASE_TTL_MS;
      this.ctx.storage.sql.exec(
        "UPDATE controller_lease SET expires_at_ms = ? WHERE singleton = 1",
        expiresAtMs,
      );
      sendJson(ws, {
        type: "control_claim_result",
        status: "granted",
        room_session_id: room.room_session_id,
        lease: { lease_id: existing.lease_id, expires_at_ms: expiresAtMs },
      });
      this.broadcastControllerStatus(nowMs);
      return;
    }

    const leaseId = `lease-${crypto.randomUUID()}`;
    const expiresAtMs = nowMs + LEASE_TTL_MS;
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO controller_lease
         (singleton, room_session_id, viewer_id, lease_id, expires_at_ms, last_command_sequence)
       VALUES (1, ?, ?, ?, ?, 0)`,
      room.room_session_id,
      attachment.viewerId,
      leaseId,
      expiresAtMs,
    );
    sendJson(ws, {
      type: "control_claim_result",
      status: "granted",
      room_session_id: room.room_session_id,
      lease: { lease_id: leaseId, expires_at_ms: expiresAtMs },
    });
    this.broadcastControllerStatus(nowMs);
  }

  private handleControlHeartbeat(
    ws: WebSocket,
    attachment: ViewerAttachment,
    roomSessionId: unknown,
    leaseId: unknown,
    nowMs: number,
  ): void {
    const controller = this.controllerLease();
    if (
      controller === null
      || controller.expires_at_ms <= nowMs
      || controller.room_session_id !== roomSessionId
      || controller.viewer_id !== attachment.viewerId
      || controller.lease_id !== leaseId
    ) {
      sendJson(ws, { type: "protocol_error", code: "controller_lease_invalid" });
      return;
    }
    const expiresAtMs = nowMs + LEASE_TTL_MS;
    this.ctx.storage.sql.exec(
      "UPDATE controller_lease SET expires_at_ms = ? WHERE singleton = 1",
      expiresAtMs,
    );
    sendJson(ws, {
      type: "control_heartbeat_ack",
      room_session_id: controller.room_session_id,
      lease_id: controller.lease_id,
      expires_at_ms: expiresAtMs,
    });
    this.broadcastControllerStatus(nowMs);
  }

  private handleControlRelease(
    ws: WebSocket,
    attachment: ViewerAttachment,
    roomSessionId: unknown,
    leaseId: unknown,
    nowMs: number,
  ): void {
    const controller = this.controllerLease();
    if (
      controller === null
      || controller.room_session_id !== roomSessionId
      || controller.viewer_id !== attachment.viewerId
      || controller.lease_id !== leaseId
    ) {
      sendJson(ws, { type: "protocol_error", code: "controller_lease_invalid" });
      return;
    }
    this.terminateControllerLease(controller, nowMs, "controller_released");
  }

  private handleMonitorControlRevoke(
    ws: WebSocket,
    attachment: MonitorAttachment,
    roomSessionId: unknown,
    nowMs: number,
  ): void {
    if (roomSessionId !== attachment.roomSessionId) {
      sendJson(ws, { type: "protocol_error", code: "stale_room_session" });
      return;
    }
    const controller = this.controllerLease();
    if (controller?.room_session_id === attachment.roomSessionId) {
      this.terminateControllerLease(controller, nowMs, "control_revoked_by_monitor");
      return;
    }
    this.failPendingCommandsForRoom(
      attachment.roomSessionId,
      nowMs,
      "control_revoked_by_monitor",
    );
    this.broadcastControllerStatus(nowMs);
  }

  private handleControlCommand(
    ws: WebSocket,
    attachment: ViewerAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!validateControlCommand(value)) {
      sendJson(ws, { type: "protocol_error", code: "invalid_control_command" });
      return;
    }
    const existing = this.command(value.room_session_id, value.command_id);
    if (existing !== null) {
      if (existing.command_json !== canonicalJson(value)) {
        this.sendRejectedAck(ws, value, nowMs, "command_id_conflict");
        return;
      }
      const ack = parseStoredAck(existing.ack_json);
      if (ack !== null) sendJson(ws, ack);
      return;
    }
    const controller = this.controllerLease();
    if (
      controller === null
      || controller.expires_at_ms <= nowMs
      || controller.viewer_id !== attachment.viewerId
      || controller.room_session_id !== value.room_session_id
    ) {
      this.recordRejectedCommand(value, nowMs, "controller_lease_required");
      return;
    }
    if (value.command_sequence !== controller.last_command_sequence + 1) {
      this.recordRejectedCommand(value, nowMs, "invalid_command_sequence");
      return;
    }
    this.ctx.storage.sql.exec(
      "UPDATE controller_lease SET last_command_sequence = ? WHERE singleton = 1",
      value.command_sequence,
    );
    if (
      value.issued_at_ms > nowMs + MAX_CLOCK_SKEW_MS
      || value.expires_at_ms <= nowMs
      || value.expires_at_ms <= value.issued_at_ms
      || value.expires_at_ms - value.issued_at_ms > MAX_COMMAND_LIFETIME_MS
    ) {
      this.recordRejectedCommand(value, nowMs, "command_expired_or_invalid_time");
      return;
    }
    const authority = this.authoritativeState(nowMs);
    if (authority.status !== "fresh") {
      this.recordRejectedCommand(
        value,
        nowMs,
        authority.status === "stale" ? "state_stale" : "state_unavailable",
      );
      return;
    }
    if (authority.row.state_revision !== value.expected_state_revision) {
      this.recordRejectedCommand(value, nowMs, "state_revision_mismatch");
      return;
    }
    const safetyReason = commandSafetyRejection(value, authority.state);
    if (safetyReason !== null) {
      this.recordRejectedCommand(value, nowMs, safetyReason);
      return;
    }
    const monitor = this.currentMonitorSocket(nowMs);
    if (monitor === null) {
      this.recordRejectedCommand(value, nowMs, "monitor_offline");
      return;
    }

    const ack = makeAck(value, "received", nowMs, null, null);
    this.recordCommand(value, ack, nowMs);
    this.broadcastToViewers(ack);
    sendJson(monitor, value);
  }

  private handleControlAck(
    ws: WebSocket,
    attachment: MonitorAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!validateControlAck(value) || value.room_session_id !== attachment.roomSessionId) {
      sendJson(ws, { type: "protocol_error", code: "invalid_control_ack" });
      return;
    }
    const command = this.command(value.room_session_id, value.command_id);
    if (command === null) {
      sendJson(ws, { type: "protocol_error", code: "unknown_command_id" });
      return;
    }
    if (isTerminalAck(command.phase)) {
      const stored = parseStoredAck(command.ack_json);
      if (stored !== null) sendJson(ws, stored);
      return;
    }
    if (!validAckTransition(command.phase, value.phase)) {
      sendJson(ws, { type: "protocol_error", code: "invalid_ack_transition" });
      return;
    }
    if (value.phase === "applied") {
      const latest = this.latestState();
      if (
        value.state_revision === null
        || latest === null
        || value.state_revision < command.expected_state_revision
        || value.state_revision > latest.state_revision
      ) {
        sendJson(ws, { type: "protocol_error", code: "invalid_applied_revision" });
        return;
      }
    }
    this.ctx.storage.sql.exec(
      `UPDATE commands SET ack_json = ?, phase = ?, updated_at_ms = ?
        WHERE room_session_id = ? AND command_id = ?`,
      canonicalJson(value),
      value.phase,
      nowMs,
      value.room_session_id,
      value.command_id,
    );
    this.broadcastToViewers(value);
    if (isTerminalAck(value.phase)) this.pruneTerminalCommands();
  }

  private handleGrantRequest(
    ws: WebSocket,
    attachment: MonitorAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!validateMediaGrantRequest(value)
      || value.room_session_id !== attachment.roomSessionId) {
      sendJson(ws, { type: "protocol_error", code: "invalid_media_grant_request" });
      return;
    }
    const authority = this.authoritativeState(nowMs);
    if (authority.status !== "fresh") {
      sendJson(ws, {
        type: "protocol_error",
        code: authority.status === "stale" ? "state_stale" : "state_required_before_grant",
      });
      return;
    }
    const rejection = grantRejection(value, authority.state);
    if (rejection !== null) {
      sendJson(ws, { type: "protocol_error", code: rejection });
      return;
    }
    const previousDeadline = this.eventGrantDeadline(value);
    if (previousDeadline !== null && previousDeadline <= nowMs) {
      sendJson(ws, { type: "protocol_error", code: "event_grant_window_expired" });
      return;
    }
    const current = this.activeGrantRow(nowMs);
    if (
      current !== null
      && current.room_session_id === value.room_session_id
      && current.runtime_session_id === value.runtime_session_id
      && current.event_id === value.event_id
      && current.scope === value.scope
      && (previousDeadline === null || current.expires_at_ms <= previousDeadline)
    ) {
      this.broadcastGrantWire(current, this.mediaGrantWire(current, "active", null));
      return;
    }
    this.revokeActiveGrants(nowMs, "grant_replaced", "revoked");
    const grantId = `grant-${crypto.randomUUID()}`;
    const expiresAtMs = Math.min(
      nowMs + value.expires_in_ms,
      previousDeadline ?? Number.POSITIVE_INFINITY,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO media_grants
         (grant_id, room_session_id, runtime_session_id, event_id, scope,
          expires_at_ms, status, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
      grantId,
      value.room_session_id,
      value.runtime_session_id,
      value.event_id,
      value.scope,
      expiresAtMs,
      nowMs,
    );
    const row = this.grant(grantId);
    if (row === null) {
      sendJson(ws, { type: "protocol_error", code: "grant_persistence_failed" });
      return;
    }
    for (const viewer of this.viewerSockets()) {
      const viewerAttachment = readAttachment(viewer);
      if (viewerAttachment?.role === "viewer") {
        this.addGrantAudience(grantId, viewerAttachment.viewerId);
      }
    }
    const wire = this.mediaGrantWire(row, "active", null);
    this.broadcastGrantWire(row, wire);
  }

  private handleGrantRevoke(
    ws: WebSocket,
    attachment: MonitorAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!validateMediaGrantRevoke(value)
      || value.room_session_id !== attachment.roomSessionId) {
      sendJson(ws, { type: "protocol_error", code: "invalid_media_grant_revoke" });
      return;
    }
    const grant = this.grant(value.grant_id);
    if (grant === null || grant.room_session_id !== value.room_session_id) {
      sendJson(ws, { type: "protocol_error", code: "unknown_media_grant" });
      return;
    }
    if (grant.status === "active") {
      this.ctx.storage.sql.exec(
        "UPDATE media_grants SET status = 'revoked', updated_at_ms = ? WHERE grant_id = ?",
        nowMs,
        grant.grant_id,
      );
      this.broadcastGrantWire(grant, this.mediaGrantWire(grant, "revoked", "monitor_revoked"));
      this.clearGrantAudience(grant.grant_id);
    }
  }

  private handleMediaSignal(
    ws: WebSocket,
    attachment: SocketAttachment,
    value: unknown,
    nowMs: number,
  ): void {
    if (!validateMediaSignal(value)) {
      sendJson(ws, { type: "protocol_error", code: "invalid_media_signal" });
      return;
    }
    const grant = this.activeGrantRow(nowMs);
    if (
      grant === null
      || grant.grant_id !== value.grant_id
      || grant.room_session_id !== value.room_session_id
    ) {
      sendJson(ws, { type: "protocol_error", code: "media_grant_inactive" });
      return;
    }
    const actorViewerId = attachment.role === "viewer"
      ? attachment.viewerId
      : value.target_id === "monitor" ? null : value.target_id;
    if (actorViewerId !== null && !this.viewerInGrantAudience(grant.grant_id, actorViewerId)) {
      sendJson(ws, { type: "protocol_error", code: "viewer_not_in_grant_audience" });
      return;
    }
    if (!consumeSignalBudget(ws, attachment, grant.grant_id)) {
      sendJson(ws, { type: "protocol_error", code: "media_signal_limit_reached" });
      return;
    }
    if (attachment.role === "monitor") {
      if (value.target_id === "monitor") {
        sendJson(ws, { type: "protocol_error", code: "invalid_media_target" });
        return;
      }
      const target = this.viewerSocket(value.target_id);
      if (target === null) {
        sendJson(ws, { type: "protocol_error", code: "viewer_not_connected" });
        return;
      }
      sendJson(target, createForwardedMediaSignal(value, "monitor"));
      return;
    }
    if (value.target_id !== "monitor") {
      sendJson(ws, { type: "protocol_error", code: "invalid_media_target" });
      return;
    }
    const monitor = this.currentMonitorSocket(nowMs);
    if (monitor === null) {
      sendJson(ws, { type: "protocol_error", code: "monitor_offline" });
      return;
    }
    sendJson(monitor, createForwardedMediaSignal(value, attachment.viewerId));
  }

  private releaseMonitor(
    attachment: MonitorAttachment,
    nowMs: number,
    reason: string,
  ): void {
    const lease = this.producerLease();
    if (
      lease === null
      || lease.room_session_id !== attachment.roomSessionId
      || lease.token_hash !== attachment.tokenHash
      || lease.socket_id !== attachment.socketId
    ) return;
    this.ctx.storage.sql.exec("DELETE FROM producer_lease");
    this.ctx.storage.sql.exec("DELETE FROM latest_pose");
    this.revokeActiveGrants(nowMs, reason, "revoked");
    this.failPendingCommands(nowMs, reason);
    this.broadcastStateUnavailable("monitor_offline");
    this.broadcastPresence(nowMs);
  }

  private handleSocketGone(ws: WebSocket, nowMs: number): void {
    const attachment = readAttachment(ws);
    if (attachment === null) return;
    if (attachment.role === "monitor") {
      this.releaseMonitor(attachment, nowMs, "monitor_disconnected");
      return;
    }
    const controller = this.controllerLease();
    if (controller?.viewer_id === attachment.viewerId) {
      this.terminateControllerLease(controller, nowMs, "controller_disconnected");
    }
    this.ctx.storage.sql.exec(
      "DELETE FROM media_grant_audience WHERE viewer_id = ?",
      attachment.viewerId,
    );
    this.broadcastPresence(nowMs);
  }

  private expireDueSync(nowMs: number): void {
    this.expirePendingCommands(nowMs);
    const lease = this.producerLease();
    if (lease !== null && lease.expires_at_ms <= nowMs) {
      this.ctx.storage.sql.exec("DELETE FROM producer_lease");
      this.ctx.storage.sql.exec("DELETE FROM latest_pose");
      this.revokeActiveGrants(nowMs, "producer_lease_expired", "revoked");
      this.failPendingCommands(nowMs, "producer_lease_expired");
      this.closeMonitorSockets(1008, "producer_lease_expired");
      this.broadcastStateUnavailable("monitor_offline");
      this.broadcastPresence(nowMs);
    }
    const controller = this.controllerLease();
    if (controller !== null && controller.expires_at_ms <= nowMs) {
      this.terminateControllerLease(controller, nowMs, "controller_lease_expired");
    }
    if (this.monitorOnline(nowMs)) this.expireStaleState(nowMs);
    const expired = this.ctx.storage.sql.exec<GrantRow>(
      "SELECT * FROM media_grants WHERE status = 'active' AND expires_at_ms <= ?",
      nowMs,
    ).toArray();
    for (const grant of expired) {
      this.ctx.storage.sql.exec(
        "UPDATE media_grants SET status = 'expired', updated_at_ms = ? WHERE grant_id = ?",
        nowMs,
        grant.grant_id,
      );
      this.broadcastGrantWire(grant, this.mediaGrantWire(grant, "expired", "grant_expired"));
      this.clearGrantAudience(grant.grant_id);
    }
    this.pruneTerminalCommands();
    this.pruneInactiveGrantAudience();
  }

  private async scheduleNextAlarm(nowMs: number): Promise<void> {
    const times: number[] = [];
    const producer = this.producerLease();
    if (producer !== null) times.push(producer.expires_at_ms);
    const controller = this.controllerLease();
    if (controller !== null) times.push(controller.expires_at_ms);
    const grant = this.activeGrantRow(nowMs);
    if (grant !== null) times.push(grant.expires_at_ms);
    const state = this.latestState();
    if (
      state !== null
      && state.received_at_ms > 0
      && this.monitorOnline(nowMs)
    ) times.push(state.received_at_ms + LATEST_STATE_TTL_MS);
    for (const command of this.pendingCommands()) {
      try {
        const value: unknown = JSON.parse(command.command_json);
        if (validateControlCommand(value)) times.push(value.expires_at_ms);
      } catch {
        // A malformed persisted command is failed by expirePendingCommands.
      }
    }
    if (times.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(nowMs + 1, Math.min(...times)));
  }

  private revokeGrantIfAuthorityLost(state: DemoStateEnvelope, nowMs: number): void {
    const grant = this.activeGrantRow(nowMs);
    if (grant === null) return;
    const decision = state.state.care.decision;
    const valid = grant.runtime_session_id === state.runtime_session_id
      && state.state.runtime.status === "ready"
      && state.state.capture.status === "active"
      && state.state.capture.remote_video === "available"
      && state.state.scene_id !== "bathroom"
      && decision?.decision_id === grant.event_id
      && decision.privacy_mode !== "hidden"
      && (grant.scope === "kitchen_moment"
        ? state.state.scene_id === "kitchen" && state.state.care.consent === "granted"
        : state.state.scene_id === "fall"
          && decision.alarm !== null);
    if (!valid) this.revokeActiveGrants(nowMs, "grant_authority_lost", "revoked");
  }

  private revokeActiveGrants(
    nowMs: number,
    reason: string,
    status: "revoked" | "expired",
  ): void {
    const grants = this.ctx.storage.sql.exec<GrantRow>(
      "SELECT * FROM media_grants WHERE status = 'active'",
    ).toArray();
    for (const grant of grants) {
      this.ctx.storage.sql.exec(
        "UPDATE media_grants SET status = ?, updated_at_ms = ? WHERE grant_id = ?",
        status,
        nowMs,
        grant.grant_id,
      );
      this.broadcastGrantWire(grant, this.mediaGrantWire(grant, status, reason));
      this.clearGrantAudience(grant.grant_id);
    }
  }

  private terminateControllerLease(
    controller: ControllerLeaseRow,
    nowMs: number,
    reason: string,
  ): void {
    this.failPendingCommandsForRoom(controller.room_session_id, nowMs, reason);
    this.ctx.storage.sql.exec(
      `DELETE FROM controller_lease
        WHERE room_session_id = ? AND viewer_id = ? AND lease_id = ?`,
      controller.room_session_id,
      controller.viewer_id,
      controller.lease_id,
    );
    this.broadcastControllerStatus(nowMs);
  }

  private expireStaleState(nowMs: number): void {
    const row = this.latestState();
    if (
      row !== null
      && row.received_at_ms > 0
      && nowMs - row.received_at_ms >= LATEST_STATE_TTL_MS
    ) this.markStateStale(row, nowMs);
  }

  private authoritativeState(nowMs: number): StateAuthority {
    const row = this.latestState();
    if (row === null) return { status: "missing" };
    if (
      row.received_at_ms <= 0
      || nowMs - row.received_at_ms >= LATEST_STATE_TTL_MS
    ) {
      this.markStateStale(row, nowMs);
      return { status: "stale" };
    }
    const state = parseStoredState(row);
    if (state === null) {
      this.markStateStale(row, nowMs);
      return { status: "stale" };
    }
    return { status: "fresh", row, state };
  }

  private markStateStale(row: LatestStateRow, nowMs: number): void {
    if (row.received_at_ms <= 0) return;
    this.ctx.storage.sql.exec(
      `UPDATE latest_state SET received_at_ms = 0
        WHERE singleton = 1 AND room_session_id = ? AND received_at_ms = ?`,
      row.room_session_id,
      row.received_at_ms,
    );
    this.ctx.storage.sql.exec("DELETE FROM latest_pose");
    this.revokeActiveGrants(nowMs, "state_stale", "revoked");
    this.failPendingCommandsForRoom(row.room_session_id, nowMs, "state_stale");
    this.broadcastStateUnavailable("stale");
  }

  private failPendingCommands(nowMs: number, reason: string): void {
    for (const command of this.pendingCommands()) {
      this.failCommand(command, nowMs, reason);
    }
    this.pruneTerminalCommands();
  }

  private failPendingCommandsForRoom(
    roomSessionId: string,
    nowMs: number,
    reason: string,
  ): void {
    for (const command of this.pendingCommands(roomSessionId)) {
      this.failCommand(command, nowMs, reason);
    }
    this.pruneTerminalCommands();
  }

  private pendingCommands(roomSessionId?: string): CommandRow[] {
    return roomSessionId === undefined
      ? this.ctx.storage.sql.exec<CommandRow>(
        "SELECT * FROM commands WHERE phase IN ('received', 'awaiting_local_confirmation')",
      ).toArray()
      : this.ctx.storage.sql.exec<CommandRow>(
        `SELECT * FROM commands
          WHERE room_session_id = ?
            AND phase IN ('received', 'awaiting_local_confirmation')`,
        roomSessionId,
      ).toArray();
  }

  private expirePendingCommands(nowMs: number): void {
    for (const command of this.pendingCommands()) {
      let value: unknown = null;
      try {
        value = JSON.parse(command.command_json);
      } catch {
        // Invalid persisted commands are failed closed below.
      }
      if (!validateControlCommand(value) || value.expires_at_ms <= nowMs) {
        this.failCommand(command, nowMs, "command_expired");
      }
    }
    this.pruneTerminalCommands();
  }

  private failCommand(command: CommandRow, nowMs: number, reason: string): void {
    const ack: ControlAck = {
      type: "control_ack",
      room_session_id: command.room_session_id,
      command_id: command.command_id,
      phase: "failed",
      timestamp_ms: nowMs,
      state_revision: null,
      reason,
    };
    this.ctx.storage.sql.exec(
      `UPDATE commands SET phase = 'failed', ack_json = ?, updated_at_ms = ?
        WHERE room_session_id = ? AND command_id = ?`,
      canonicalJson(ack),
      nowMs,
      command.room_session_id,
      command.command_id,
    );
    this.broadcastToViewers(ack);
  }

  private pruneTerminalCommands(): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM commands WHERE rowid IN (
        SELECT rowid FROM commands
          WHERE phase IN ('applied', 'rejected', 'failed')
          ORDER BY updated_at_ms DESC, rowid DESC
          LIMIT -1 OFFSET ?
      )`,
      MAX_TERMINAL_COMMAND_HISTORY,
    );
  }

  private pruneInactiveGrantAudience(): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM media_grant_audience
        WHERE grant_id IN (
          SELECT grant_id FROM media_grants WHERE status != 'active'
        )`,
    );
  }

  private sendLatestState(ws: WebSocket, viewerId: string, nowMs: number): void {
    if (!this.monitorOnline(nowMs)) {
      sendJson(ws, { type: "state_unavailable", reason: "monitor_offline" });
      return;
    }
    const row = this.latestState();
    if (row === null) {
      sendJson(ws, { type: "state_unavailable", reason: "not_published" });
      return;
    }
    if (row.received_at_ms <= 0 || nowMs - row.received_at_ms >= LATEST_STATE_TTL_MS) {
      sendJson(ws, { type: "state_unavailable", reason: "stale" });
      return;
    }
    const value = parseStoredState(row);
    if (value === null) {
      sendJson(ws, { type: "state_unavailable", reason: "stale" });
      return;
    }
    sendJson(ws, this.projectStateForViewer(value, viewerId, nowMs));
  }

  private sendLatestPose(ws: WebSocket, nowMs: number): void {
    if (!this.monitorOnline(nowMs)) return;
    const row = this.latestPose();
    if (row === null || nowMs - row.received_at_ms > LATEST_POSE_TTL_MS) return;
    const state = this.latestState();
    if (state === null || state.runtime_session_id !== row.runtime_session_id) return;
    const value = parseStoredPose(row, state.room_session_id, state.runtime_session_id);
    if (value !== null) sendJson(ws, value);
  }

  private projectStateForViewer(
    value: DemoStateEnvelope,
    viewerId: string,
    nowMs: number,
  ): DemoStateEnvelope {
    const grant = this.activeGrantRow(nowMs);
    if (grant === null || !this.viewerInGrantAudience(grant.grant_id, viewerId)) {
      return withMediaGrant(value, null);
    }
    return withMediaGrant(value, {
      grant_id: grant.grant_id,
      event_id: grant.event_id,
      scope: grant.scope,
      expires_at_ms: grant.expires_at_ms,
      status: "active",
    });
  }

  private broadcastState(value: DemoStateEnvelope, nowMs: number): void {
    for (const ws of this.viewerSockets()) {
      const attachment = readAttachment(ws);
      if (attachment?.role === "viewer") {
        sendJson(ws, this.projectStateForViewer(value, attachment.viewerId, nowMs));
      }
    }
  }

  private sendRejectedAck(
    ws: WebSocket,
    command: ControlCommand,
    nowMs: number,
    reason: string,
  ): void {
    sendJson(ws, makeAck(command, "rejected", nowMs, null, reason));
  }

  private recordCommand(command: ControlCommand, ack: ControlAck, nowMs: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO commands
         (room_session_id, command_id, command_json, ack_json, phase,
          expected_state_revision, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      command.room_session_id,
      command.command_id,
      canonicalJson(command),
      canonicalJson(ack),
      ack.phase,
      command.expected_state_revision,
      nowMs,
      nowMs,
    );
  }

  private recordRejectedCommand(
    command: ControlCommand,
    nowMs: number,
    reason: string,
  ): void {
    const ack = makeAck(command, "rejected", nowMs, null, reason);
    this.recordCommand(command, ack, nowMs);
    this.broadcastToViewers(ack);
    this.pruneTerminalCommands();
  }

  private broadcastPresence(nowMs: number): void {
    const room = this.room();
    this.broadcastAll({
      type: "viewer_presence",
      room_session_id: room?.room_session_id ?? null,
      viewer_count: this.viewerSockets().length,
      max_viewers: MAX_VIEWERS,
      monitor_online: this.monitorOnline(nowMs),
      server_time_ms: nowMs,
    });
  }

  private broadcastControllerStatus(nowMs: number): void {
    const room = this.room();
    this.broadcastAll({
      type: "controller_status",
      room_session_id: room?.room_session_id ?? null,
      controller: this.controllerInfo(nowMs),
      server_time_ms: nowMs,
    });
  }

  private broadcastStateUnavailable(reason: "monitor_offline" | "stale" | "not_published"): void {
    this.broadcastToViewers({ type: "state_unavailable", reason });
  }

  private broadcastAll(value: unknown): void {
    for (const ws of [...this.viewerSockets(), ...this.monitorSockets()]) sendJson(ws, value);
  }

  private broadcastGrantWire(grant: GrantRow, wire: MediaGrantWire): void {
    for (const ws of this.monitorSockets()) sendJson(ws, wire);
    for (const ws of this.viewerSockets()) {
      const attachment = readAttachment(ws);
      if (
        attachment?.role === "viewer"
        && this.viewerInGrantAudience(grant.grant_id, attachment.viewerId)
      ) sendJson(ws, wire);
    }
  }

  private broadcastToViewers(value: unknown): void {
    for (const ws of this.viewerSockets()) sendJson(ws, value);
  }

  private viewerSockets(): WebSocket[] {
    return this.ctx.getWebSockets("viewer");
  }

  private monitorSockets(): WebSocket[] {
    return this.ctx.getWebSockets("monitor");
  }

  private viewerSocket(viewerId: string): WebSocket | null {
    return this.ctx.getWebSockets(`viewer:${viewerId}`)[0] ?? null;
  }

  private closeMonitorSockets(code: number, reason: string): void {
    for (const ws of this.monitorSockets()) {
      try {
        ws.close(code, reason);
      } catch {
        // A delayed close is harmless; SQLite remains authoritative.
      }
    }
  }

  private currentMonitorSocket(nowMs: number): WebSocket | null {
    if (!this.monitorOnline(nowMs)) return null;
    const lease = this.producerLease();
    if (lease === null) return null;
    for (const ws of this.monitorSockets()) {
      const attachment = readAttachment(ws);
      if (
        attachment?.role === "monitor"
        && attachment.roomSessionId === lease.room_session_id
        && attachment.tokenHash === lease.token_hash
        && attachment.socketId === lease.socket_id
      ) return ws;
    }
    return null;
  }

  private monitorOnline(nowMs: number): boolean {
    return this.currentMonitorSocketWithoutOnlineCheck(nowMs) !== null;
  }

  private currentMonitorSocketWithoutOnlineCheck(nowMs: number): WebSocket | null {
    const lease = this.producerLease();
    if (lease === null || lease.expires_at_ms <= nowMs) return null;
    for (const ws of this.monitorSockets()) {
      const attachment = readAttachment(ws);
      if (
        attachment?.role === "monitor"
        && attachment.roomSessionId === lease.room_session_id
        && attachment.tokenHash === lease.token_hash
        && attachment.socketId === lease.socket_id
      ) return ws;
    }
    return null;
  }

  private isCurrentMonitor(attachment: MonitorAttachment, nowMs: number): boolean {
    const lease = this.producerLease();
    return lease !== null
      && lease.expires_at_ms > nowMs
      && lease.room_session_id === attachment.roomSessionId
      && lease.token_hash === attachment.tokenHash
      && lease.socket_id === attachment.socketId;
  }

  private room(): RoomRow | null {
    return firstRow(this.ctx.storage.sql.exec<RoomRow>("SELECT * FROM room WHERE singleton = 1"));
  }

  private producerLease(): ProducerLeaseRow | null {
    return firstRow(this.ctx.storage.sql.exec<ProducerLeaseRow>(
      "SELECT * FROM producer_lease WHERE singleton = 1",
    ));
  }

  private latestState(): LatestStateRow | null {
    return firstRow(this.ctx.storage.sql.exec<LatestStateRow>(
      "SELECT * FROM latest_state WHERE singleton = 1",
    ));
  }

  private latestPose(): LatestPoseRow | null {
    return firstRow(this.ctx.storage.sql.exec<LatestPoseRow>(
      "SELECT * FROM latest_pose WHERE singleton = 1",
    ));
  }

  private controllerLease(): ControllerLeaseRow | null {
    return firstRow(this.ctx.storage.sql.exec<ControllerLeaseRow>(
      "SELECT * FROM controller_lease WHERE singleton = 1",
    ));
  }

  private controllerInfo(nowMs: number): ControllerInfo | null {
    const controller = this.controllerLease();
    if (controller === null || controller.expires_at_ms <= nowMs) return null;
    return {
      viewer_id: controller.viewer_id,
      lease_id: controller.lease_id,
      expires_at_ms: controller.expires_at_ms,
    };
  }

  private command(roomSessionId: string, commandId: string): CommandRow | null {
    return firstRow(this.ctx.storage.sql.exec<CommandRow>(
      "SELECT * FROM commands WHERE room_session_id = ? AND command_id = ?",
      roomSessionId,
      commandId,
    ));
  }

  private grant(grantId: string): GrantRow | null {
    return firstRow(this.ctx.storage.sql.exec<GrantRow>(
      "SELECT * FROM media_grants WHERE grant_id = ?",
      grantId,
    ));
  }

  private eventGrantDeadline(request: MediaGrantRequest): number | null {
    const row = firstRow(this.ctx.storage.sql.exec<SqlRow & { deadline_ms: number | null }>(
      `SELECT MIN(expires_at_ms) AS deadline_ms FROM media_grants
        WHERE room_session_id = ? AND event_id = ? AND scope = ?`,
      request.room_session_id,
      request.event_id,
      request.scope,
    ));
    return typeof row?.deadline_ms === "number" ? row.deadline_ms : null;
  }

  private addGrantAudience(grantId: string, viewerId: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO media_grant_audience (grant_id, viewer_id)
       VALUES (?, ?)`,
      grantId,
      viewerId,
    );
  }

  private clearGrantAudience(grantId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM media_grant_audience WHERE grant_id = ?",
      grantId,
    );
  }

  private viewerInGrantAudience(grantId: string, viewerId: string): boolean {
    const row = this.ctx.storage.sql.exec<SqlRow>(
      `SELECT 1 AS present FROM media_grant_audience
        WHERE grant_id = ? AND viewer_id = ? LIMIT 1`,
      grantId,
      viewerId,
    ).toArray()[0];
    return row !== undefined;
  }

  private activeGrantRow(nowMs: number): GrantRow | null {
    return firstRow(this.ctx.storage.sql.exec<GrantRow>(
      `SELECT * FROM media_grants
        WHERE status = 'active' AND expires_at_ms > ?
        ORDER BY expires_at_ms DESC LIMIT 1`,
      nowMs,
    ));
  }

  private activeGrant(nowMs: number): ActiveMediaGrant | null {
    const grant = this.activeGrantRow(nowMs);
    return grant === null ? null : {
      grant_id: grant.grant_id,
      event_id: grant.event_id,
      scope: grant.scope,
      expires_at_ms: grant.expires_at_ms,
      status: "active",
    };
  }

  private mediaGrantWire(
    grant: GrantRow,
    status: "active" | "revoked" | "expired",
    reason: string | null,
  ): MediaGrantWire {
    return {
      type: "media_grant",
      room_session_id: grant.room_session_id,
      grant: {
        grant_id: grant.grant_id,
        event_id: grant.event_id,
        scope: grant.scope,
        expires_at_ms: grant.expires_at_ms,
        status,
      },
      audience: "all_viewers",
      reason,
    };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (!originAllowed(origin, env.ALLOWED_ORIGINS)) {
      return jsonWithCors({ error: "origin_not_allowed" }, 403, origin);
    }
    if (request.method === "OPTIONS") {
      return corsPreflight(origin);
    }
    try {
      const room = env.DEMO_ROOM.getByName(ROOM_NAME);
      if (request.method === "GET" && url.pathname === "/health") {
        return jsonWithCors({ ok: true, room_name: ROOM_NAME }, 200, origin);
      }
      if (request.method === "GET" && url.pathname === "/api/status") {
        return jsonWithCors(await room.getStatus(), 200, origin);
      }
      if (request.method === "POST" && url.pathname === "/api/monitor/claim") {
        const body = await request.arrayBuffer();
        if (body.byteLength > 0) {
          return jsonWithCors({ error: "request_body_forbidden" }, 400, origin);
        }
        const result = await room.claimMonitor();
        if (!result.ok) {
          return jsonWithCors({
            error: result.error,
            retry_at_ms: result.retry_at_ms,
            server_time_ms: result.server_time_ms,
            retry_after_ms: result.retry_after_ms,
          }, 409, origin);
        }
        return jsonWithCors({
          room_name: result.room_name,
          room_session_id: result.room_session_id,
          producer_token: result.producer_token,
          expires_at_ms: result.expires_at_ms,
        }, 201, origin, { "Cache-Control": "no-store" });
      }
      if (
        request.method === "GET"
        && (url.pathname === "/ws/monitor" || url.pathname === "/ws/viewer")
      ) return room.fetch(request);
      return jsonWithCors({ error: "not_found" }, 404, origin);
    } catch (error) {
      console.error(JSON.stringify({
        message: "relay_request_failed",
        method: request.method,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return jsonWithCors({ error: "internal_error" }, 500, origin);
    }
  },
} satisfies ExportedHandler<Env>;

function grantRejection(
  request: MediaGrantRequest,
  state: DemoStateEnvelope | null,
): string | null {
  if (state === null) return "state_required_before_grant";
  if (
    request.room_session_id !== state.room_session_id
    || request.runtime_session_id !== state.runtime_session_id
  ) return "stale_grant_session";
  if (state.state.scene_id === "bathroom") return "bathroom_privacy_lock";
  if (state.state.runtime.status !== "ready") return "authority_runtime_degraded";
  if (
    state.state.capture.status !== "active"
    || state.state.capture.remote_video !== "available"
  ) return "remote_video_unavailable";
  const decision = state.state.care.decision;
  if (decision?.decision_id !== request.event_id) return "event_authority_mismatch";
  if (decision.privacy_mode === "hidden") return "decision_privacy_hidden";
  if (request.scope === "kitchen_moment") {
    return state.state.scene_id === "kitchen" && state.state.care.consent === "granted"
      ? null
      : "kitchen_consent_required";
  }
  return state.state.scene_id === "fall"
    && decision.alarm !== null
    ? null
    : "authoritative_fall_required";
}

function commandSafetyRejection(
  command: ControlCommand,
  state: DemoStateEnvelope,
): string | null {
  const body = command.command;
  if (
    (body.name === "submit_response"
      || body.name === "confirm_alarm"
      || body.name === "confirm_action_card"
      || body.name === "confirm_family_notification"
      || body.name === "replay_voice")
    && body.decision_id !== state.state.care.decision?.decision_id
  ) return "decision_id_mismatch";
  if (body.name === "confirm_alarm" && state.state.care.decision?.alarm === null) {
    return "alarm_not_current";
  }
  if (
    body.name === "confirm_action_card"
    && (
      state.state.care.decision?.alarm !== null
      || state.state.care.decision?.action_card?.status !== "pending"
    )
  ) return "action_card_not_current";
  if (
    body.name === "confirm_family_notification"
    && (
      state.state.care.decision?.alarm !== null
      || state.state.care.decision?.action_card !== null
      || !state.state.care.decision?.family_notification
      || (state.state.care.decision.state !== "family_notification_required"
        && state.state.care.decision.state !== "urgent_attention")
    )
  ) return "family_notification_not_current";
  if (state.state.care.decision?.alarm === null || state.state.care.decision === null) return null;
  if (
    body.name === "reset_demo"
    || body.name === "stop_capture"
    || body.name === "select_source"
    || (body.name === "select_scene" && body.scene_id !== state.state.scene_id)
    || (body.name === "run_demo_scenario" && body.scenario === "normal")
  ) return "authoritative_alarm_locked";
  return null;
}

function makeAck(
  command: ControlCommand,
  phase: ControlAckPhase,
  timestampMs: number,
  stateRevision: number | null,
  reason: string | null,
): ControlAck {
  return {
    type: "control_ack",
    room_session_id: command.room_session_id,
    command_id: command.command_id,
    phase,
    timestamp_ms: timestampMs,
    state_revision: stateRevision,
    reason,
  };
}

function validAckTransition(from: ControlAckPhase, to: ControlAckPhase): boolean {
  if (from === "received") {
    return to === "awaiting_local_confirmation" || isTerminalAck(to);
  }
  if (from === "awaiting_local_confirmation") return isTerminalAck(to);
  return false;
}

function isTerminalAck(phase: ControlAckPhase): boolean {
  return phase === "applied" || phase === "rejected" || phase === "failed";
}

function parseStoredState(row: LatestStateRow): DemoStateEnvelope | null {
  try {
    const value: unknown = JSON.parse(row.state_json);
    return validateDemoState(value, row.room_session_id, true) ? value : null;
  } catch {
    return null;
  }
}

function parseStoredPose(
  row: LatestPoseRow,
  roomSessionId: string,
  runtimeSessionId: string,
): PoseFrame | null {
  try {
    const value: unknown = JSON.parse(row.pose_json);
    return validatePoseFrame(value, roomSessionId, runtimeSessionId) ? value : null;
  } catch {
    return null;
  }
}

function parseStoredAck(json: string): ControlAck | null {
  try {
    const value: unknown = JSON.parse(json);
    return validateControlAck(value) ? value : null;
  } catch {
    return null;
  }
}

function firstRow<T extends SqlRow>(cursor: SqlStorageCursor<T>): T | null {
  return cursor.toArray()[0] ?? null;
}

function consumeSignalBudget(
  ws: WebSocket,
  attachment: SocketAttachment,
  grantId: string,
): boolean {
  if (attachment.signalGrantId !== grantId) {
    attachment.signalGrantId = grantId;
    attachment.signalCount = 0;
  }
  if (attachment.signalCount >= MAX_SIGNAL_MESSAGES_PER_GRANT) return false;
  attachment.signalCount += 1;
  ws.serializeAttachment(attachment);
  return true;
}

function readAttachment(ws: WebSocket): SocketAttachment | null {
  const value: unknown = ws.deserializeAttachment();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("role" in value) || !("socketId" in value)
    || !("signalGrantId" in value) || !("signalCount" in value)) return null;
  if (typeof value.socketId !== "string") return null;
  if (value.signalGrantId !== null && typeof value.signalGrantId !== "string") return null;
  if (!Number.isSafeInteger(value.signalCount) || (value.signalCount as number) < 0) return null;
  if (value.role === "viewer" && "viewerId" in value && typeof value.viewerId === "string") {
    return {
      role: "viewer",
      viewerId: value.viewerId,
      socketId: value.socketId,
      signalGrantId: value.signalGrantId,
      signalCount: value.signalCount as number,
    };
  }
  if (
    value.role === "monitor"
    && "roomSessionId" in value
    && "tokenHash" in value
    && typeof value.roomSessionId === "string"
    && typeof value.tokenHash === "string"
  ) {
    return {
      role: "monitor",
      roomSessionId: value.roomSessionId,
      tokenHash: value.tokenHash,
      socketId: value.socketId,
      signalGrantId: value.signalGrantId,
      signalCount: value.signalCount as number,
    };
  }
  return null;
}

function parseProtocols(header: string | null): string[] {
  return header === null
    ? []
    : header.split(",").map((value) => value.trim()).filter((value) => value.length > 0);
}

function sendJson(ws: WebSocket, value: unknown): void {
  try {
    ws.send(JSON.stringify(value));
  } catch {
    // A disconnect races normal broadcasts; close handlers own cleanup.
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function timingSafeHexEqual(left: string, right: string): Promise<boolean> {
  const leftBytes = hexToBytes(left);
  const rightBytes = hexToBytes(right);
  if (leftBytes === null || rightBytes === null || leftBytes.length !== rightBytes.length) return false;
  return crypto.subtle.timingSafeEqual(leftBytes, rightBytes);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[a-f0-9]+$/i.test(value)) return null;
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

function originAllowed(origin: string | null, configured: string): boolean {
  if (origin === null || configured === "*") return true;
  return configured.split(",").map((value) => value.trim()).includes(origin);
}

function corsPreflight(origin: string | null): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

function jsonResponse(value: unknown, status: number): Response {
  return Response.json(value, { status });
}

function jsonWithCors(
  value: unknown,
  status: number,
  origin: string | null,
  additional: HeadersInit = {},
): Response {
  return Response.json(value, {
    status,
    headers: { ...corsHeaders(origin), ...additional },
  });
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Sec-WebSocket-Protocol",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
