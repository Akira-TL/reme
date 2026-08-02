import { DurableObject } from "cloudflare:workers";

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
        )
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

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (attachment === null) {
      rejectSocket(ws, "invalid_socket_state", 1011);
      return;
    }

    if (attachment.role === "viewer") {
      rejectSocket(ws, "viewer_read_only", 1008);
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

    const lease = this.currentLease(Date.now());
    if (
      lease === null ||
      !constantTimeHexEqual(lease.token_hash, attachment.tokenHash) ||
      lease.session_id !== attachment.sessionId
    ) {
      rejectSocket(ws, "controller_lease_expired", 1008);
      return;
    }

    const decoded = parseJson(message);
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

    const validation = validateFrame(decoded, attachment.sessionId);
    if (!validation.ok) {
      rejectSocket(ws, validation.error, 1008);
      return;
    }

    if (
      attachment.latestFrame !== null &&
      validation.frame.sequence <= attachment.latestFrame.sequence
    ) {
      rejectSocket(ws, "non_increasing_sequence", 1008);
      return;
    }

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

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // The lease intentionally remains until its short expiry to allow controller reconnect.
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    // Hibernation attachment and SQLite lease remain the authoritative recoverable state.
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
    this.ctx.storage.sql.exec(
      `INSERT INTO control_lease
         (singleton, token_hash, session_id, expires_at_ms)
       VALUES (1, ?, ?, ?)`,
      tokenHash,
      sessionId,
      leaseExpiresAtMs,
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
    this.ctx.acceptWebSocket(server, ["viewer"]);
    server.serializeAttachment({ role: "viewer" } satisfies ViewerAttachment);

    const now = Date.now();
    const latestFrame = this.currentLease(now) === null
      ? null
      : this.latestControllerFrame(now);
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
      this.ctx.storage.sql.exec("DELETE FROM control_lease WHERE singleton = 1");
      for (const socket of this.ctx.getWebSockets("controller")) {
        socket.close(1008, "controller_lease_expired");
      }
      return null;
    }
    return lease;
  }

  private dropLease(tokenHash: string): void {
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

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => actualKeys.includes(key));
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
  if (isExactObject(value, ["role"]) && value.role === "viewer") {
    return { role: "viewer" };
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
