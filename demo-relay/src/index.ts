import { DurableObject } from "cloudflare:workers";

import {
  handleActivityRecognition,
  type ActivityRecognitionAttemptStart,
  type ActivityRecognitionEvidence,
  type ActivityVerdict,
} from "./activity";
import {
  handleDangerVoice,
  type DangerVoiceAttemptFinish,
  type DangerVoiceAttemptStart,
} from "./voice";
import {
  handleSceneRecognition,
  type SceneRecognitionAttemptFinish,
  type SceneRecognitionAttemptStart,
} from "./scene";
import {
  createForwardedMediaSignal,
  DEMO_EVENT_SCHEMA_VERSION,
  isExactObject,
  isOpaqueId,
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
const SCENE_RECOGNITION_WINDOW_MS = 60_000;
const MAX_SCENE_RECOGNITIONS_PER_WINDOW = 6;
const SCENE_RECOGNITION_INFLIGHT_STALE_MS = 10_000;
const ACTIVITY_COOKING_MIN_CONFIDENCE = 0.65;
const ACTIVITY_EVIDENCE_MAX_GAP_MS = 10_000;
const ACTIVITY_RECEIPT_TTL_MS = 15_000;
const ACTIVITY_RECOGNITION_INFLIGHT_STALE_MS = 10_000;

function kitchenActivityEventId(eventSequence: number): string {
  return `activity-${eventSequence}`;
}

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

interface DangerVoiceAttemptRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  event_id: string;
  alarm_event_sequence: number;
  attempts: number;
  inflight_request_id: string | null;
  inflight_started_at_ms: number | null;
}

interface SceneRecognitionBudgetRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  window_started_at_ms: number;
  attempts: number;
  inflight_request_id: string | null;
  inflight_started_at_ms: number | null;
}

interface ActivityRecognitionRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  consecutive: number;
  last_observed_at_ms: number;
  receipt_id: string | null;
  receipt_expires_at_ms: number | null;
  receipt_confidence: number | null;
  receipt_after_event_sequence: number | null;
  verified_event_sequence: number | null;
  inflight_attempt_id: string | null;
  inflight_started_at_ms: number | null;
}

interface DangerWatchdogRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  event_id: string;
  deadline_ms: number;
  status: "checking" | "escalated" | "resolved";
}

type AlarmStateEvent = Extract<DemoEvent, { event_type: "alarm_state" }>;

interface AlarmEventStateRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  event_json: string;
}

interface DangerAlarmCheckpointRow {
  [key: string]: SqlStorageValue;
  session_id: string;
  event_id: string;
  event_json: string;
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
          ON media_grant_audience (viewer_id, grant_id);
        CREATE TABLE IF NOT EXISTS danger_voice_attempt (
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          alarm_event_sequence INTEGER NOT NULL CHECK (alarm_event_sequence >= 0),
          attempts INTEGER NOT NULL CHECK (attempts >= 1),
          inflight_request_id TEXT,
          inflight_started_at_ms INTEGER,
          PRIMARY KEY (session_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS danger_watchdog (
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          deadline_ms INTEGER NOT NULL CHECK (deadline_ms >= 0),
          status TEXT NOT NULL CHECK (status IN ('checking', 'escalated', 'resolved')),
          PRIMARY KEY (session_id, event_id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS danger_watchdog_active_idx
          ON danger_watchdog (session_id) WHERE status = 'checking';
        CREATE TABLE IF NOT EXISTS danger_alarm_checkpoint (
          session_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          event_json TEXT NOT NULL,
          PRIMARY KEY (session_id, event_id)
        );
        CREATE TABLE IF NOT EXISTS scene_recognition_budget (
          session_id TEXT PRIMARY KEY,
          window_started_at_ms INTEGER NOT NULL,
          attempts INTEGER NOT NULL CHECK (attempts >= 1),
          inflight_request_id TEXT,
          inflight_started_at_ms INTEGER
        );
        CREATE TABLE IF NOT EXISTS activity_recognition_evidence (
          session_id TEXT PRIMARY KEY,
          consecutive INTEGER NOT NULL CHECK (consecutive >= 0),
          last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= 0),
          receipt_id TEXT UNIQUE,
          receipt_expires_at_ms INTEGER,
          receipt_confidence REAL,
          receipt_after_event_sequence INTEGER,
          verified_event_sequence INTEGER,
          inflight_attempt_id TEXT,
          inflight_started_at_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS activity_receipt_lookup_idx
          ON activity_recognition_evidence (receipt_id, receipt_expires_at_ms);
      `);
      await this.backfillLegacyDangerWatchdog();
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

  async beginActivityRecognitionAttempt(
    tokenHash: string,
  ): Promise<ActivityRecognitionAttemptStart> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) {
      return { ok: false, error: "invalid_control_token" };
    }
    const now = Date.now();
    const lease = this.currentLease(now);
    if (
      lease === null
      || !constantTimeHexEqual(lease.token_hash, tokenHash)
      || this.controllerSocket(lease.session_id) === null
    ) return { ok: false, error: "invalid_control_token" };
    const scene = this.structuredEvent(lease.session_id, "scene_state");
    if (scene?.event_type !== "scene_state" || scene.payload.scene_id !== "kitchen") {
      this.clearActivityRecognitionEvidence(lease.session_id);
      return { ok: false, error: "activity_context_stale" };
    }

    const existing = this.activityRecognitionRow(lease.session_id);
    if (
      existing !== null
      && existing.inflight_attempt_id !== null
      && existing.inflight_started_at_ms !== null
      && now - existing.inflight_started_at_ms < ACTIVITY_RECOGNITION_INFLIGHT_STALE_MS
    ) return { ok: false, error: "activity_request_in_progress" };

    const attemptId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      `INSERT INTO activity_recognition_evidence
         (session_id, consecutive, last_observed_at_ms, receipt_id,
          receipt_expires_at_ms, receipt_confidence, receipt_after_event_sequence,
          verified_event_sequence, inflight_attempt_id, inflight_started_at_ms)
       VALUES (?, 0, 0, NULL, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         inflight_attempt_id = excluded.inflight_attempt_id,
         inflight_started_at_ms = excluded.inflight_started_at_ms`,
      lease.session_id,
      attemptId,
      now,
    );
    return { ok: true, attempt_id: attemptId };
  }

  async cancelActivityRecognitionAttempt(
    tokenHash: string,
    attemptId: string,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !/^[a-f0-9-]{36}$/i.test(attemptId)) return;
    const lease = this.currentLease(Date.now());
    if (lease === null || !constantTimeHexEqual(lease.token_hash, tokenHash)) return;
    this.ctx.storage.sql.exec(
      `UPDATE activity_recognition_evidence
          SET inflight_attempt_id = NULL,
              inflight_started_at_ms = NULL
        WHERE session_id = ? AND inflight_attempt_id = ?`,
      lease.session_id,
      attemptId,
    );
  }

  async finishActivityRecognitionAttempt(
    tokenHash: string,
    attemptId: string,
    verdict: ActivityVerdict,
  ): Promise<ActivityRecognitionEvidence | null> {
    if (
      !/^[a-f0-9]{64}$/.test(tokenHash)
      || !/^[a-f0-9-]{36}$/i.test(attemptId)
      || !this.isActivityVerdict(verdict)
    ) return null;
    const now = Date.now();
    const lease = this.currentLease(now);
    if (
      lease === null
      || !constantTimeHexEqual(lease.token_hash, tokenHash)
      || this.controllerSocket(lease.session_id) === null
    ) return null;
    const scene = this.structuredEvent(lease.session_id, "scene_state");
    const row = this.activityRecognitionRow(lease.session_id);
    if (
      scene?.event_type !== "scene_state"
      || scene.payload.scene_id !== "kitchen"
      || row === null
    ) {
      this.clearActivityRecognitionEvidence(lease.session_id);
      return null;
    }
    if (row.inflight_attempt_id !== attemptId) return null;
    if (
      row.inflight_started_at_ms === null
      || now - row.inflight_started_at_ms > ACTIVITY_RECOGNITION_INFLIGHT_STALE_MS
    ) {
      this.clearActivityRecognitionEvidence(lease.session_id);
      return null;
    }

    const isCooking = verdict.classification === "cooking"
      && verdict.confidence >= ACTIVITY_COOKING_MIN_CONFIDENCE;
    const consecutive = isCooking
      ? row.last_observed_at_ms > 0
        && now - row.last_observed_at_ms <= ACTIVITY_EVIDENCE_MAX_GAP_MS
        ? row.consecutive + 1
        : 1
      : 0;
    const receiptId = consecutive >= 2 ? `activity-receipt-${randomHex(16)}` : null;
    const receiptExpiresAtMs = receiptId === null ? null : now + ACTIVITY_RECEIPT_TTL_MS;
    const eventSequenceFloor = receiptId === null
      ? null
      : this.eventSequence(lease.session_id).last_event_sequence;
    this.ctx.storage.sql.exec(
      `UPDATE activity_recognition_evidence
          SET consecutive = ?,
              last_observed_at_ms = ?,
              receipt_id = ?,
              receipt_expires_at_ms = ?,
              receipt_confidence = ?,
              receipt_after_event_sequence = ?,
              verified_event_sequence = NULL,
              inflight_attempt_id = NULL,
              inflight_started_at_ms = NULL
        WHERE session_id = ? AND inflight_attempt_id = ?`,
      consecutive,
      isCooking ? now : 0,
      receiptId,
      receiptExpiresAtMs,
      receiptId === null ? null : verdict.confidence,
      eventSequenceFloor,
      lease.session_id,
      attemptId,
    );
    return { receipt_id: receiptId, consecutive };
  }

  async beginDangerVoiceAttempt(
    tokenHash: string,
    eventId: string,
    requestId: string,
  ): Promise<DangerVoiceAttemptStart> {
    if (
      !/^[a-f0-9]{64}$/.test(tokenHash)
      || !isOpaqueId(eventId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        requestId,
      )
    ) {
      return { ok: false, error: "invalid_control_token" };
    }
    const now = Date.now();
    const lease = this.currentLease(now);
    if (lease === null || !constantTimeHexEqual(lease.token_hash, tokenHash)) {
      return { ok: false, error: "invalid_control_token" };
    }
    const scene = this.structuredEvent(lease.session_id, "scene_state");
    const alarm = this.structuredEvent(lease.session_id, "alarm_state");
    const watchdog = this.dangerWatchdog(lease.session_id, eventId);
    if (
      alarm?.event_type === "alarm_state"
      && alarm.payload.phase === "checking"
      && alarm.payload.event_id === eventId
      && watchdog?.status === "checking"
      && watchdog.deadline_ms <= now
    ) {
      this.escalateDangerWatchdog(watchdog, now);
      return { ok: false, error: "no_active_danger_event" };
    }
    if (
      scene?.event_type !== "scene_state"
      || scene.payload.scene_id !== "fall"
      || alarm?.event_type !== "alarm_state"
      || alarm.payload.phase !== "checking"
      || alarm.payload.event_id !== eventId
      || alarm.payload.response_deadline_ms === null
      || alarm.payload.response_deadline_ms <= now
    ) {
      return { ok: false, error: "no_active_danger_event" };
    }

    const existing = this.ctx.storage.sql.exec<DangerVoiceAttemptRow>(
      `SELECT session_id, event_id, alarm_event_sequence, attempts,
              inflight_request_id, inflight_started_at_ms
         FROM danger_voice_attempt
        WHERE session_id = ? AND event_id = ?`,
      lease.session_id,
      eventId,
    ).toArray()[0];
    // A row is the lifetime paid-call budget for this event ID. A later
    // alarm_state sequence must not reset it, and upstream failures never refund it.
    if (existing !== undefined) {
      if (
        existing.alarm_event_sequence === alarm.event_sequence
        && existing.inflight_request_id !== null
      ) {
        return { ok: false, error: "voice_request_in_progress" };
      }
      return { ok: false, error: "voice_attempt_limit" };
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO danger_voice_attempt
         (session_id, event_id, alarm_event_sequence, attempts,
          inflight_request_id, inflight_started_at_ms)
       VALUES (?, ?, ?, 1, ?, ?)`,
      lease.session_id,
      eventId,
      alarm.event_sequence,
      requestId,
      now,
    );
    return {
      ok: true,
      session_id: lease.session_id,
      alarm_event_sequence: alarm.event_sequence,
      attempt: 1,
    };
  }

  async finishDangerVoiceAttempt(
    tokenHash: string,
    sessionId: string,
    eventId: string,
    alarmEventSequence: number,
    requestId: string,
  ): Promise<DangerVoiceAttemptFinish> {
    const attempt = this.ctx.storage.sql.exec<DangerVoiceAttemptRow>(
      `SELECT session_id, event_id, alarm_event_sequence, attempts,
              inflight_request_id, inflight_started_at_ms
         FROM danger_voice_attempt
        WHERE session_id = ? AND event_id = ?`,
      sessionId,
      eventId,
    ).toArray()[0];
    if (
      attempt === undefined
      || attempt.alarm_event_sequence !== alarmEventSequence
      || attempt.inflight_request_id !== requestId
    ) {
      return { ok: false, error: "invalid_voice_attempt" };
    }
    this.ctx.storage.sql.exec(
      `UPDATE danger_voice_attempt
          SET inflight_request_id = NULL, inflight_started_at_ms = NULL
        WHERE session_id = ? AND event_id = ? AND inflight_request_id = ?`,
      sessionId,
      eventId,
      requestId,
    );

    const now = Date.now();
    const lease = this.currentLease(now);
    if (
      lease === null
      || lease.session_id !== sessionId
      || !constantTimeHexEqual(lease.token_hash, tokenHash)
    ) {
      return { ok: false, error: "invalid_control_token" };
    }
    const scene = this.structuredEvent(sessionId, "scene_state");
    const alarm = this.structuredEvent(sessionId, "alarm_state");
    const watchdog = this.dangerWatchdog(sessionId, eventId);
    if (watchdog?.status === "checking" && watchdog.deadline_ms <= now) {
      this.escalateDangerWatchdog(watchdog, now);
      return { ok: false, error: "stale_danger_event" };
    }
    if (
      scene?.event_type !== "scene_state"
      || scene.payload.scene_id !== "fall"
      || alarm?.event_type !== "alarm_state"
      || alarm.event_sequence !== alarmEventSequence
      || alarm.payload.event_id !== eventId
      || alarm.payload.phase !== "checking"
      || alarm.payload.response_deadline_ms === null
      || alarm.payload.response_deadline_ms <= now
    ) {
      return { ok: false, error: "stale_danger_event" };
    }
    return { ok: true };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    this.expireAllDueGrants(now);
    const lease = this.leaseRow();
    if (lease !== null && lease.expires_at_ms <= now) {
      this.expireLease(lease, now);
    } else {
      const watchdog = this.activeDangerWatchdog();
      if (watchdog !== null && (
        lease === null
        || lease.session_id !== watchdog.session_id
        || watchdog.deadline_ms <= now
      )) {
        if (this.escalateDangerWatchdog(watchdog, now) === null) {
          throw new Error("danger watchdog could not be escalated");
        }
      }
    }
    await this.scheduleNextAuthorityAlarm();
  }

  async beginSceneRecognitionAttempt(
    tokenHash: string,
    requestId: string,
  ): Promise<SceneRecognitionAttemptStart> {
    if (
      !/^[a-f0-9]{64}$/.test(tokenHash)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
        requestId,
      )
    ) {
      return { ok: false, error: "invalid_control_token" };
    }
    const now = Date.now();
    const lease = this.currentLease(now);
    if (lease === null || !constantTimeHexEqual(lease.token_hash, tokenHash)) {
      return { ok: false, error: "invalid_control_token" };
    }

    const existing = this.ctx.storage.sql.exec<SceneRecognitionBudgetRow>(
      `SELECT session_id, window_started_at_ms, attempts,
              inflight_request_id, inflight_started_at_ms
         FROM scene_recognition_budget
        WHERE session_id = ?`,
      lease.session_id,
    ).toArray()[0];
    if (
      existing !== undefined
      && existing.inflight_request_id !== null
      && existing.inflight_started_at_ms !== null
      && now - existing.inflight_started_at_ms < SCENE_RECOGNITION_INFLIGHT_STALE_MS
    ) {
      return { ok: false, error: "scene_request_in_progress" };
    }

    if (
      existing === undefined
      || now - existing.window_started_at_ms >= SCENE_RECOGNITION_WINDOW_MS
    ) {
      this.ctx.storage.sql.exec(
        `INSERT INTO scene_recognition_budget
           (session_id, window_started_at_ms, attempts,
            inflight_request_id, inflight_started_at_ms)
         VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           window_started_at_ms = excluded.window_started_at_ms,
           attempts = 1,
           inflight_request_id = excluded.inflight_request_id,
           inflight_started_at_ms = excluded.inflight_started_at_ms`,
        lease.session_id,
        now,
        requestId,
        now,
      );
      return { ok: true, session_id: lease.session_id };
    }

    if (existing.attempts >= MAX_SCENE_RECOGNITIONS_PER_WINDOW) {
      return {
        ok: false,
        error: "scene_rate_limited",
        retry_after_ms: Math.max(
          1,
          SCENE_RECOGNITION_WINDOW_MS - (now - existing.window_started_at_ms),
        ),
      };
    }
    this.ctx.storage.sql.exec(
      `UPDATE scene_recognition_budget
          SET attempts = attempts + 1,
              inflight_request_id = ?,
              inflight_started_at_ms = ?
        WHERE session_id = ?`,
      requestId,
      now,
      lease.session_id,
    );
    return { ok: true, session_id: lease.session_id };
  }

  async finishSceneRecognitionAttempt(
    tokenHash: string,
    sessionId: string,
    requestId: string,
  ): Promise<SceneRecognitionAttemptFinish> {
    const attempt = this.ctx.storage.sql.exec<SceneRecognitionBudgetRow>(
      `SELECT session_id, window_started_at_ms, attempts,
              inflight_request_id, inflight_started_at_ms
         FROM scene_recognition_budget
        WHERE session_id = ?`,
      sessionId,
    ).toArray()[0];
    if (attempt === undefined || attempt.inflight_request_id !== requestId) {
      return { ok: false, error: "invalid_scene_attempt" };
    }
    this.ctx.storage.sql.exec(
      `UPDATE scene_recognition_budget
          SET inflight_request_id = NULL,
              inflight_started_at_ms = NULL
        WHERE session_id = ? AND inflight_request_id = ?`,
      sessionId,
      requestId,
    );

    const lease = this.currentLease(Date.now());
    if (
      lease === null
      || lease.session_id !== sessionId
      || !constantTimeHexEqual(lease.token_hash, tokenHash)
    ) {
      return { ok: false, error: "invalid_control_token" };
    }
    return { ok: true };
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
      await this.scheduleNextAuthorityAlarm();
      safeSend(ws, JSON.stringify({ type: "heartbeat_ack", lease_expires_at_ms: leaseExpiresAtMs }));
      return;
    }

    if (isExactObject(decoded, ["type"]) && decoded.type === "release") {
      safeSend(ws, JSON.stringify({ type: "released" }));
      await this.dropLease(attachment.tokenHash);
      return;
    }

    if (validateMediaGrantRequest(decoded)) {
      await this.issueMediaGrant(ws, attachment, decoded, Date.now());
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
      await this.acceptDemoEvent(ws, attachment, decoded);
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
      this.clearActivityRecognitionEvidence(attachment.sessionId);
    } else if (attachment?.role === "viewer") {
      this.removeViewerFromActiveAudiences(attachment.viewerId, Date.now());
    }
  }

  webSocketError(ws: WebSocket, _error: unknown): void {
    const attachment = readAttachment(ws);
    if (attachment?.role === "controller") {
      this.revokeAllActiveGrants(attachment.sessionId, Date.now(), null);
      this.clearActivityRecognitionEvidence(attachment.sessionId);
    } else if (attachment?.role === "viewer") {
      this.removeViewerFromActiveAudiences(attachment.viewerId, Date.now());
    }
  }

  private async acceptDemoEvent(
    ws: WebSocket,
    attachment: ControllerAttachment,
    event: Exclude<DemoEvent, { event_type: "media_grant" }>,
  ): Promise<void> {
    const now = Date.now();
    const activeWatchdog = this.activeDangerWatchdog(attachment.sessionId);
    const unresolvedEscalation = this.authoritativeEscalatedAlarm(attachment.sessionId);
    const eventWatchdog = event.event_type === "alarm_state"
      ? this.dangerWatchdog(attachment.sessionId, event.payload.event_id)
      : null;
    let acceptedCheckingDeadline: number | null = null;

    if (
      event.event_type === "alarm_state"
      && event.payload.phase === "resolved"
      && eventWatchdog !== null
      && eventWatchdog.status === "checking"
      && now >= eventWatchdog.deadline_ms
    ) {
      this.escalateDangerWatchdog(eventWatchdog, now);
      await this.scheduleNextAuthorityAlarm();
      sendSocketError(ws, "danger_deadline_elapsed");
      return;
    }

    if (
      (activeWatchdog !== null || unresolvedEscalation !== null)
      && event.event_type === "scene_state"
      && event.payload.scene_id !== "fall"
    ) {
      if (activeWatchdog !== null && now >= activeWatchdog.deadline_ms) {
        this.escalateDangerWatchdog(activeWatchdog, now);
        await this.scheduleNextAuthorityAlarm();
        sendSocketError(ws, "danger_deadline_elapsed");
      } else {
        sendSocketError(
          ws,
          unresolvedEscalation === null ? "danger_check_in_active" : "danger_alarm_unresolved",
        );
      }
      return;
    }

    if (event.event_type === "alarm_state") {
      if (
        unresolvedEscalation !== null
        && unresolvedEscalation.event.payload.event_id !== event.payload.event_id
      ) {
        sendSocketError(ws, "danger_alarm_unresolved");
        return;
      }
      if (activeWatchdog !== null && activeWatchdog.event_id !== event.payload.event_id) {
        sendSocketError(ws, "danger_check_in_active");
        return;
      }
      if (event.payload.phase === "checking") {
        const deadline = event.payload.response_deadline_ms;
        if (deadline === null || deadline <= now) {
          sendSocketError(ws, "danger_deadline_elapsed");
          return;
        }
        acceptedCheckingDeadline = deadline;
        if (eventWatchdog !== null) {
          if (eventWatchdog.status !== "checking") {
            sendSocketError(ws, "danger_event_reopen_forbidden");
            return;
          }
          if (deadline > eventWatchdog.deadline_ms) {
            sendSocketError(ws, "danger_deadline_extension_forbidden");
            return;
          }
        }
      } else {
        if (eventWatchdog?.status === "resolved" && event.payload.phase !== "resolved") {
          sendSocketError(ws, "danger_state_regression_forbidden");
          return;
        }
        if (eventWatchdog?.status === "escalated" && event.payload.phase === "resolved") {
          const authoritative = this.authoritativeEscalatedAlarm(attachment.sessionId);
          if (
            authoritative === null
            || authoritative.event.payload.event_id !== event.payload.event_id
            || authoritative.event.payload.trigger !== event.payload.trigger
          ) {
            sendSocketError(ws, "danger_stale_resolution");
            return;
          }
        }
      }
    }

    if (
      event.event_type === "alarm_state"
      && event.payload.phase === "escalated"
      && eventWatchdog?.status === "escalated"
    ) {
      if (
        unresolvedEscalation !== null
        && event.payload.trigger === unresolvedEscalation.event.payload.trigger
        && event.payload.response_deadline_ms === null
        && event.payload.media_scope === unresolvedEscalation.event.payload.media_scope
      ) {
        // The watchdog owns the terminal transition. A controller copy is a
        // semantic retry even when its locally allocated sequence is higher.
        safeSend(ws, JSON.stringify({
          type: "event_accepted",
          event_sequence: event.event_sequence,
          event_type: event.event_type,
        }));
      } else {
        // Send the exact persisted authority before the error so the browser
        // can converge its trigger and subsequently close the same alarm.
        if (unresolvedEscalation !== null) {
          safeSend(ws, JSON.stringify(unresolvedEscalation.event));
        }
        sendSocketError(ws, "danger_authoritative_alarm_conflict");
      }
      return;
    }

    const sequence = this.eventSequence(attachment.sessionId);
    if (event.event_sequence <= sequence.last_event_sequence) {
      const authoritative = this.authoritativeEscalationCollision(
        attachment.sessionId,
        event,
      );
      if (authoritative !== null) {
        if (
          event.event_type === "alarm_state"
          && event.payload.trigger === authoritative.payload.trigger
          && event.payload.response_deadline_ms === null
          && event.payload.media_scope === authoritative.payload.media_scope
        ) {
          safeSend(ws, JSON.stringify({
            type: "event_accepted",
            event_sequence: event.event_sequence,
            event_type: event.event_type,
          }));
        } else {
          sendSocketError(ws, "danger_authoritative_alarm_conflict");
        }
        return;
      }
      rejectSocket(ws, "non_increasing_event_sequence", 1008);
      return;
    }

    if (
      event.event_type === "activity_state"
      && event.payload.phase === "confirmed"
      && !this.activityEventMatchesReceipt(event, now)
    ) {
      this.clearActivityRecognitionEvidence(attachment.sessionId);
      safeSend(ws, JSON.stringify({
        type: "error",
        error: "activity_evidence_not_verified",
        event_sequence: event.event_sequence,
        event_type: event.event_type,
      }));
      this.revokeInvalidatedGrants(event, ws);
      return;
    }

    if (event.event_type === "alarm_state" && event.payload.phase === "checking") {
      if (acceptedCheckingDeadline === null) {
        throw new Error("validated checking alarm is missing a deadline");
      }
      const lease = this.leaseRow();
      const scheduledAt = lease !== null && lease.session_id === attachment.sessionId
        ? Math.min(acceptedCheckingDeadline, lease.expires_at_ms)
        : acceptedCheckingDeadline;
      // Do not acknowledge or persist a safety promise until the wakeup exists.
      // If scheduling fails, the controller can retry the same sequence.
      await this.scheduleAlarmIncluding(scheduledAt);
    }

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `UPDATE room_event_sequence
           SET last_event_sequence = ?
         WHERE singleton = 1 AND session_id = ?`,
        event.event_sequence,
        attachment.sessionId,
      );
      this.persistDemoEvent(event);

      if (event.event_type !== "alarm_state") return;
      if (event.payload.phase === "checking") {
        if (acceptedCheckingDeadline === null) {
          throw new Error("validated checking alarm is missing a deadline");
        }
        if (eventWatchdog === null) {
          this.ctx.storage.sql.exec(
            `INSERT INTO danger_watchdog
               (session_id, event_id, deadline_ms, status)
             VALUES (?, ?, ?, 'checking')`,
            attachment.sessionId,
            event.payload.event_id,
            acceptedCheckingDeadline,
          );
        } else if (acceptedCheckingDeadline < eventWatchdog.deadline_ms) {
          this.ctx.storage.sql.exec(
            `UPDATE danger_watchdog
                SET deadline_ms = ?
              WHERE session_id = ? AND event_id = ? AND status = 'checking'`,
            acceptedCheckingDeadline,
            attachment.sessionId,
            event.payload.event_id,
          );
        }
      } else {
        if (eventWatchdog === null) {
          // A reconnect may deliver a terminal alarm before Relay ever saw its
          // checking phase. `deadline_ms` records the authority acceptance time;
          // terminal rows never schedule a deadline alarm.
          this.ctx.storage.sql.exec(
            `INSERT INTO danger_watchdog
               (session_id, event_id, deadline_ms, status)
             VALUES (?, ?, ?, ?)`,
            attachment.sessionId,
            event.payload.event_id,
            now,
            event.payload.phase,
          );
        } else if (eventWatchdog.status !== event.payload.phase) {
          this.ctx.storage.sql.exec(
            `UPDATE danger_watchdog
                SET status = ?
              WHERE session_id = ? AND event_id = ?`,
            event.payload.phase,
            attachment.sessionId,
            event.payload.event_id,
          );
        }
      }
      this.persistDangerAlarmCheckpoint(event);
    });

    if (event.event_type === "scene_state" && event.payload.scene_id !== "kitchen") {
      this.clearActivityRecognitionEvidence(attachment.sessionId);
    } else if (event.event_type === "activity_state") {
      this.bindOrInvalidateActivityFact(event, now);
    }

    if (
      event.event_type === "alarm_state"
      && event.payload.phase !== "checking"
    ) {
      await this.scheduleNextAuthorityAlarm();
    }

    this.broadcastToAllViewers(event);
    safeSend(ws, JSON.stringify({
      type: "event_accepted",
      event_sequence: event.event_sequence,
      event_type: event.event_type,
    }));
    this.revokeInvalidatedGrants(event, ws);
  }

  private async issueMediaGrant(
    ws: WebSocket,
    attachment: ControllerAttachment,
    request: {
      event_id: string;
      scope: MediaGrantScope;
      expires_in_ms: number;
    },
    now: number,
  ): Promise<void> {
    this.expireGrantRows(attachment.sessionId, now);
    const kitchenFact = request.scope === "kitchen_moment"
      ? this.eligibleKitchenFact(attachment.sessionId, request.event_id, now)
      : null;
    if (
      request.scope === "kitchen_moment"
        ? kitchenFact === null
        : !this.isGrantEligible(attachment.sessionId, request.event_id, request.scope, now)
    ) {
      sendSocketError(ws, "media_grant_not_eligible");
      return;
    }
    const existing = this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant_id, session_id, event_id, scope, expires_at_ms, status
         FROM media_grant
        WHERE session_id = ? AND status = 'active'
        LIMIT 1`,
      attachment.sessionId,
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
    if (uniqueViewerIds.length === 0 && request.scope !== "kitchen_moment") {
      sendSocketError(ws, "no_connected_viewers");
      return;
    }

    const grantId = `grant-${randomHex(16)}`;
    const expiresAtMs = now + request.expires_in_ms;
    // The authority wakeup exists before the active grant is made observable.
    // A harmless early wakeup is preferable to a grant without a server clock.
    await this.scheduleAlarmIncluding(expiresAtMs);
    const eventSequence = this.nextServerEventSequence(attachment.sessionId);
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

    this.ctx.storage.transactionSync(() => {
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
    });

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
        this.expireGrantRow(grant, now);
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
      const revokedByActivity = event.event_type === "activity_state"
        && grant.scope === "kitchen_moment"
        && this.eligibleKitchenFact(event.session_id, grant.event_id, now) === null;
      const revokedByAlarm = event.event_type === "alarm_state"
        && grant.scope === "fall_emergency"
        && grant.event_id === event.payload.event_id
        && event.payload.phase !== "escalated";
      if (revokedByScene || revokedByActivity || revokedByAlarm) {
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
    now = Date.now(),
  ): boolean {
    const scene = this.structuredEvent(sessionId, "scene_state");
    if (scope === "kitchen_moment") {
      return this.eligibleKitchenFact(sessionId, eventId, now) !== null;
    }
    const event = this.structuredEvent(sessionId, "alarm_state");
    return scene?.event_type === "scene_state"
      && scene.payload.scene_id === "fall"
      && event?.event_type === "alarm_state"
      && event.payload.event_id === eventId
      && event.payload.phase === "escalated"
      && event.payload.media_scope === "fall_emergency";
  }

  private eligibleKitchenFact(
    sessionId: string,
    activityEventId: string,
    _now: number,
  ): ActivityRecognitionRow | null {
    const scene = this.structuredEvent(sessionId, "scene_state");
    const activity = this.structuredEvent(sessionId, "activity_state");
    const row = this.activityRecognitionRow(sessionId);
    if (
      scene?.event_type !== "scene_state"
      || scene.payload.scene_id !== "kitchen"
      || activity?.event_type !== "activity_state"
      || activity.payload.phase !== "confirmed"
      || activity.payload.source !== "mimo_visual"
      || activity.payload.confidence === null
      || row === null
      || row.verified_event_sequence === null
      || row.verified_event_sequence !== activity.event_sequence
      || row.consecutive < 2
      || kitchenActivityEventId(row.verified_event_sequence) !== activityEventId
    ) return null;
    return row;
  }

  private activityRecognitionRow(sessionId: string): ActivityRecognitionRow | null {
    return this.ctx.storage.sql.exec<ActivityRecognitionRow>(
      `SELECT session_id, consecutive, last_observed_at_ms, receipt_id,
              receipt_expires_at_ms, receipt_confidence,
              receipt_after_event_sequence, verified_event_sequence,
              inflight_attempt_id, inflight_started_at_ms
         FROM activity_recognition_evidence
        WHERE session_id = ?`,
      sessionId,
    ).toArray()[0] ?? null;
  }

  private clearActivityRecognitionEvidence(sessionId: string): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM activity_recognition_evidence WHERE session_id = ?",
      sessionId,
    );
  }

  private bindOrInvalidateActivityFact(
    event: Extract<DemoEvent, { event_type: "activity_state" }>,
    now: number,
  ): void {
    const row = this.activityRecognitionRow(event.session_id);
    const preservesPendingEvidence = event.payload.source === "mimo_visual"
      && (event.payload.phase === "sampling" || event.payload.phase === "candidate")
      && row !== null
      && row.receipt_id === null
      && row.verified_event_sequence === null
      && row.consecutive <= 1;
    if (preservesPendingEvidence) return;

    const matchesReceipt = this.activityEventMatchesReceipt(event, now, row);
    if (!matchesReceipt || row === null) {
      // This event ends the current evidence generation. Delete the entire
      // row so counters and an in-flight attempt cannot cross a stop, hide,
      // scene/activity change, disconnect, or capture restart boundary.
      this.clearActivityRecognitionEvidence(event.session_id);
      return;
    }
    this.ctx.storage.sql.exec(
      `UPDATE activity_recognition_evidence
          SET receipt_id = NULL,
              receipt_expires_at_ms = NULL,
              receipt_confidence = NULL,
              receipt_after_event_sequence = NULL,
              verified_event_sequence = ?
        WHERE session_id = ? AND receipt_id = ?`,
      event.event_sequence,
      event.session_id,
      row.receipt_id,
    );
  }

  private activityEventMatchesReceipt(
    event: Extract<DemoEvent, { event_type: "activity_state" }>,
    now: number,
    row = this.activityRecognitionRow(event.session_id),
  ): boolean {
    return event.payload.phase === "confirmed"
      && event.payload.source === "mimo_visual"
      && event.payload.confidence !== null
      && row !== null
      && row.receipt_id !== null
      && row.receipt_expires_at_ms !== null
      && row.receipt_expires_at_ms > now
      && row.receipt_confidence === event.payload.confidence
      && row.receipt_after_event_sequence !== null
      && event.event_sequence > row.receipt_after_event_sequence
      && row.consecutive >= 2;
  }

  private isActivityVerdict(value: ActivityVerdict): boolean {
    return (
      (value.classification === "cooking"
        || value.classification === "not_cooking"
        || value.classification === "uncertain")
      && Number.isFinite(value.confidence)
      && value.confidence >= 0
      && value.confidence <= 1
      && typeof value.reason === "string"
      && value.reason.length >= 1
      && value.reason.length <= 240
    );
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

  private persistDemoEvent(event: DemoEvent): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO demo_event_state
         (event_type, session_id, event_sequence, event_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(event_type) DO UPDATE SET
         session_id = excluded.session_id,
         event_sequence = excluded.event_sequence,
         event_json = excluded.event_json`,
      event.event_type,
      event.session_id,
      event.event_sequence,
      JSON.stringify(event),
    );
  }

  private dangerAlarmCheckpoint(sessionId: string, eventId: string): AlarmStateEvent | null {
    const row = this.ctx.storage.sql.exec<DangerAlarmCheckpointRow>(
      `SELECT session_id, event_id, event_json
         FROM danger_alarm_checkpoint
        WHERE session_id = ? AND event_id = ?`,
      sessionId,
      eventId,
    ).toArray()[0];
    if (row === undefined) return null;
    const decoded = parseJson(row.event_json);
    return validateDemoEvent(decoded, row.session_id)
      && decoded.event_type === "alarm_state"
      && decoded.payload.event_id === row.event_id
      ? decoded
      : null;
  }

  private persistDangerAlarmCheckpoint(event: AlarmStateEvent): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO danger_alarm_checkpoint
         (session_id, event_id, event_json)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id, event_id) DO UPDATE SET
         event_json = excluded.event_json`,
      event.session_id,
      event.payload.event_id,
      JSON.stringify(event),
    );
  }

  private async backfillLegacyDangerWatchdog(): Promise<void> {
    const row = this.ctx.storage.sql.exec<AlarmEventStateRow>(
      `SELECT session_id, event_json
         FROM demo_event_state
        WHERE event_type = 'alarm_state'
        LIMIT 1`,
    ).toArray()[0];
    if (row === undefined) return;
    const decoded = parseJson(row.event_json);
    if (!validateDemoEvent(decoded, row.session_id) || decoded.event_type !== "alarm_state") {
      return;
    }

    const now = Date.now();
    const legacyCheckingDeadline = decoded.payload.phase === "checking"
      ? decoded.payload.response_deadline_ms
      : null;
    if (decoded.payload.phase === "checking" && legacyCheckingDeadline === null) {
      throw new Error("legacy checking alarm is missing a deadline");
    }
    let watchdog = this.dangerWatchdog(row.session_id, decoded.payload.event_id);
    let checkpoint = watchdog === null
      ? null
      : this.dangerAlarmCheckpoint(watchdog.session_id, watchdog.event_id);
    let forceCheckingEscalation = false;
    let eventToBroadcast: AlarmStateEvent | null = null;
    this.ctx.storage.transactionSync(() => {
      const sequence = this.eventSequence(row.session_id);
      const checkpointSequence = checkpoint?.event_sequence ?? -1;
      const recoveredSequence = Math.max(decoded.event_sequence, checkpointSequence);
      if (sequence.last_event_sequence < recoveredSequence) {
        this.ctx.storage.sql.exec(
          `UPDATE room_event_sequence
              SET last_event_sequence = ?
            WHERE singleton = 1 AND session_id = ?`,
          recoveredSequence,
          row.session_id,
        );
      }

      if (watchdog === null) {
        const deadline = decoded.payload.phase === "checking"
          ? legacyCheckingDeadline
          : now;
        if (deadline === null) {
          throw new Error("legacy checking alarm is missing a deadline");
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO danger_watchdog
             (session_id, event_id, deadline_ms, status)
           VALUES (?, ?, ?, ?)`,
          row.session_id,
          decoded.payload.event_id,
          deadline,
          decoded.payload.phase,
        );
        this.persistDangerAlarmCheckpoint(decoded);
        watchdog = {
          session_id: row.session_id,
          event_id: decoded.payload.event_id,
          deadline_ms: deadline,
          status: decoded.payload.phase,
        };
        checkpoint = decoded;
        return;
      }

      if (watchdog.status === "checking") {
        const checkingCheckpoint = checkpoint?.payload.phase === "checking"
          ? checkpoint
          : null;
        if (decoded.payload.phase === "checking") {
          if (legacyCheckingDeadline === null) {
            throw new Error("legacy checking alarm is missing a deadline");
          }
          const checkpointDeadline = checkingCheckpoint?.payload.response_deadline_ms;
          const deadline = Math.min(
            watchdog.deadline_ms,
            legacyCheckingDeadline,
            checkpointDeadline ?? Number.POSITIVE_INFINITY,
          );
          if (deadline < watchdog.deadline_ms) {
            this.ctx.storage.sql.exec(
              `UPDATE danger_watchdog
                  SET deadline_ms = ?
                WHERE session_id = ? AND event_id = ? AND status = 'checking'`,
              deadline,
              watchdog.session_id,
              watchdog.event_id,
            );
            watchdog = { ...watchdog, deadline_ms: deadline };
          }
          if (legacyCheckingDeadline === deadline) {
            this.persistDangerAlarmCheckpoint(decoded);
            checkpoint = decoded;
          } else {
            const recoveredChecking: AlarmStateEvent = {
              ...decoded,
              event_sequence: this.nextServerEventSequence(watchdog.session_id),
              timestamp_ms: now,
              payload: {
                ...decoded.payload,
                response_deadline_ms: deadline,
              },
            };
            this.persistDemoEvent(recoveredChecking);
            this.persistDangerAlarmCheckpoint(recoveredChecking);
            checkpoint = recoveredChecking;
            eventToBroadcast = recoveredChecking;
          }
          return;
        }

        const checkpointSequenceForTransition = checkingCheckpoint?.event_sequence ?? -1;
        if (
          decoded.payload.phase === "resolved"
          && decoded.event_sequence > checkpointSequenceForTransition
          && decoded.timestamp_ms < watchdog.deadline_ms
        ) {
          this.ctx.storage.sql.exec(
            `UPDATE danger_watchdog
                SET status = 'resolved'
              WHERE session_id = ? AND event_id = ? AND status = 'checking'`,
            watchdog.session_id,
            watchdog.event_id,
          );
          this.persistDangerAlarmCheckpoint(decoded);
          watchdog = { ...watchdog, status: "resolved" };
          checkpoint = decoded;
          return;
        }
        if (
          decoded.payload.phase === "escalated"
          && decoded.event_sequence > checkpointSequenceForTransition
        ) {
          this.ctx.storage.sql.exec(
            `UPDATE danger_watchdog
                SET status = 'escalated'
              WHERE session_id = ? AND event_id = ? AND status = 'checking'`,
            watchdog.session_id,
            watchdog.event_id,
          );
          this.persistDangerAlarmCheckpoint(decoded);
          watchdog = { ...watchdog, status: "escalated" };
          checkpoint = decoded;
          return;
        }
        forceCheckingEscalation = true;
        return;
      }

      if (watchdog.status === "escalated") {
        const escalatedCheckpoint = checkpoint?.payload.phase === "escalated"
          ? checkpoint
          : null;
        if (
          escalatedCheckpoint !== null
          && decoded.payload.phase === "resolved"
          && decoded.event_sequence > escalatedCheckpoint.event_sequence
          && decoded.payload.trigger === escalatedCheckpoint.payload.trigger
        ) {
          this.ctx.storage.sql.exec(
            `UPDATE danger_watchdog
                SET status = 'resolved'
              WHERE session_id = ? AND event_id = ? AND status = 'escalated'`,
            watchdog.session_id,
            watchdog.event_id,
          );
          this.persistDangerAlarmCheckpoint(decoded);
          watchdog = { ...watchdog, status: "resolved" };
          checkpoint = decoded;
          return;
        }
        if (
          decoded.payload.phase === "escalated"
          && (
            escalatedCheckpoint === null
            || (
              decoded.event_sequence >= escalatedCheckpoint.event_sequence
              && decoded.payload.trigger === escalatedCheckpoint.payload.trigger
            )
          )
        ) {
          this.persistDangerAlarmCheckpoint(decoded);
          checkpoint = decoded;
          return;
        }

        const authority = escalatedCheckpoint ?? {
          schema_version: DEMO_EVENT_SCHEMA_VERSION,
          session_id: watchdog.session_id,
          event_sequence: this.nextServerEventSequence(watchdog.session_id),
          timestamp_ms: now,
          event_type: "alarm_state" as const,
          payload: {
            event_id: watchdog.event_id,
            phase: "escalated" as const,
            trigger: "check_in_timeout" as const,
            message: "已存在未结案告警，Relay 已恢复确定性告警状态。",
            response_deadline_ms: null,
            media_scope: "fall_emergency" as const,
          },
        };
        const recoveredEscalation: AlarmStateEvent = escalatedCheckpoint === null
          ? authority
          : {
            ...authority,
            event_sequence: this.nextServerEventSequence(watchdog.session_id),
            timestamp_ms: now,
          };
        this.persistDemoEvent(recoveredEscalation);
        this.persistDangerAlarmCheckpoint(recoveredEscalation);
        checkpoint = recoveredEscalation;
        eventToBroadcast = recoveredEscalation;
        return;
      }

      // Resolved is terminal for an event ID. An older Worker may rewrite the
      // public state, but it must not reopen the same watchdog after rollback.
      if (decoded.payload.phase === "resolved") {
        this.persistDangerAlarmCheckpoint(decoded);
        checkpoint = decoded;
        return;
      }
      const resolvedCheckpoint = checkpoint?.payload.phase === "resolved"
        ? checkpoint
        : null;
      const recoveredResolution: AlarmStateEvent = resolvedCheckpoint === null
        ? {
          ...decoded,
          event_sequence: this.nextServerEventSequence(watchdog.session_id),
          timestamp_ms: now,
          payload: {
            ...decoded.payload,
            event_id: watchdog.event_id,
            phase: "resolved",
            message: "该告警已结案。",
            response_deadline_ms: null,
            media_scope: "none",
          },
        }
        : {
          ...resolvedCheckpoint,
          event_sequence: this.nextServerEventSequence(watchdog.session_id),
          timestamp_ms: now,
        };
      this.persistDemoEvent(recoveredResolution);
      this.persistDangerAlarmCheckpoint(recoveredResolution);
      checkpoint = recoveredResolution;
      eventToBroadcast = recoveredResolution;
    });

    if (forceCheckingEscalation) {
      if (watchdog === null || this.escalateDangerWatchdog(watchdog, now) === null) {
        throw new Error("inconsistent legacy danger check-in could not be escalated");
      }
      await this.scheduleNextAuthorityAlarm();
      return;
    }
    if (eventToBroadcast !== null) this.broadcastToAllViewers(eventToBroadcast);
    if (watchdog === null || watchdog.status !== "checking") {
      await this.scheduleNextAuthorityAlarm();
      return;
    }

    const deadline = watchdog.deadline_ms;
    const lease = this.leaseRow();
    if (
      deadline <= now
      || lease === null
      || lease.session_id !== watchdog.session_id
      || lease.expires_at_ms <= now
    ) {
      if (this.escalateDangerWatchdog(watchdog, now) === null) {
        throw new Error("legacy danger check-in could not be escalated");
      }
      await this.scheduleNextAuthorityAlarm();
      return;
    }
    await this.scheduleAlarmIncluding(Math.min(deadline, lease.expires_at_ms));
  }

  private dangerWatchdog(sessionId: string, eventId: string): DangerWatchdogRow | null {
    return this.ctx.storage.sql.exec<DangerWatchdogRow>(
      `SELECT session_id, event_id, deadline_ms, status
         FROM danger_watchdog
        WHERE session_id = ? AND event_id = ?`,
      sessionId,
      eventId,
    ).toArray()[0] ?? null;
  }

  private activeDangerWatchdog(sessionId?: string): DangerWatchdogRow | null {
    const query = sessionId === undefined
      ? this.ctx.storage.sql.exec<DangerWatchdogRow>(
        `SELECT session_id, event_id, deadline_ms, status
           FROM danger_watchdog
          WHERE status = 'checking'
          ORDER BY deadline_ms ASC
          LIMIT 1`,
      )
      : this.ctx.storage.sql.exec<DangerWatchdogRow>(
        `SELECT session_id, event_id, deadline_ms, status
           FROM danger_watchdog
          WHERE session_id = ? AND status = 'checking'
          ORDER BY deadline_ms ASC
          LIMIT 1`,
        sessionId,
      );
    return query.toArray()[0] ?? null;
  }

  private authoritativeEscalatedAlarm(
    sessionId?: string,
  ): { event: AlarmStateEvent; watchdog: DangerWatchdogRow } | null {
    const query = sessionId === undefined
      ? this.ctx.storage.sql.exec<AlarmEventStateRow>(
        `SELECT session_id, event_json
           FROM demo_event_state
          WHERE event_type = 'alarm_state'
          LIMIT 1`,
      )
      : this.ctx.storage.sql.exec<AlarmEventStateRow>(
        `SELECT session_id, event_json
           FROM demo_event_state
          WHERE event_type = 'alarm_state' AND session_id = ?
          LIMIT 1`,
        sessionId,
      );
    const row = query.toArray()[0];
    if (row === undefined) return null;
    const decoded = parseJson(row.event_json);
    if (
      !validateDemoEvent(decoded, row.session_id)
      || decoded.event_type !== "alarm_state"
      || decoded.payload.phase !== "escalated"
    ) {
      return null;
    }
    const watchdog = this.dangerWatchdog(row.session_id, decoded.payload.event_id);
    if (watchdog?.status !== "escalated") return null;
    return { event: decoded, watchdog };
  }

  private authoritativeEscalationCollision(
    sessionId: string,
    event: Exclude<DemoEvent, { event_type: "media_grant" }>,
  ): AlarmStateEvent | null {
    if (event.event_type !== "alarm_state" || event.payload.phase !== "escalated") return null;
    const alarm = this.structuredEvent(sessionId, "alarm_state");
    const watchdog = this.dangerWatchdog(sessionId, event.payload.event_id);
    return alarm?.event_type === "alarm_state"
      && alarm.event_sequence === event.event_sequence
      && alarm.payload.event_id === event.payload.event_id
      && alarm.payload.phase === "escalated"
      && watchdog?.status === "escalated"
      ? alarm
      : null;
  }

  private escalateDangerWatchdog(watchdog: DangerWatchdogRow, now: number): DemoEvent | null {
    const event = this.ctx.storage.transactionSync((): DemoEvent | null => {
      const current = this.dangerWatchdog(watchdog.session_id, watchdog.event_id);
      if (current === null || current.status !== "checking") return null;

      const escalated: DemoEvent = {
        schema_version: DEMO_EVENT_SCHEMA_VERSION,
        session_id: watchdog.session_id,
        event_sequence: this.nextServerEventSequence(watchdog.session_id),
        timestamp_ms: now,
        event_type: "alarm_state",
        payload: {
          event_id: watchdog.event_id,
          phase: "escalated",
          trigger: "check_in_timeout",
          message: "问询窗口未收到可确认的安全回应，已按确定性规则进入告警状态。",
          response_deadline_ms: null,
          media_scope: "fall_emergency",
        },
      };
      this.ctx.storage.sql.exec(
        `UPDATE danger_watchdog
            SET status = 'escalated'
          WHERE session_id = ? AND event_id = ? AND status = 'checking'`,
        watchdog.session_id,
        watchdog.event_id,
      );
      this.persistDemoEvent(escalated);
      this.persistDangerAlarmCheckpoint(escalated);
      return escalated;
    });
    if (event === null) return null;

    this.broadcastToAllViewers(event);
    for (const socket of this.openSockets("controller")) {
      const attachment = readAttachment(socket);
      if (attachment?.role === "controller" && attachment.sessionId === event.session_id) {
        safeSend(socket, JSON.stringify(event));
      }
    }
    console.log(JSON.stringify({
      event: "danger_watchdog_escalated",
      session_id: watchdog.session_id,
      event_id: watchdog.event_id,
      event_sequence: event.event_sequence,
      deadline_ms: watchdog.deadline_ms,
      escalated_at_ms: now,
      trigger: "check_in_timeout",
    }));
    return event;
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
      this.expireGrantRow(grant, now);
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
    const due = this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant_id, session_id, event_id, scope, expires_at_ms, status
         FROM media_grant
        WHERE session_id = ? AND status = 'active' AND expires_at_ms <= ?
        ORDER BY expires_at_ms ASC`,
      sessionId,
      now,
    ).toArray();
    for (const grant of due) this.expireGrantRow(grant, now);
  }

  private expireAllDueGrants(now: number): void {
    const due = this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant_id, session_id, event_id, scope, expires_at_ms, status
         FROM media_grant
        WHERE status = 'active' AND expires_at_ms <= ?
        ORDER BY expires_at_ms ASC`,
      now,
    ).toArray();
    for (const grant of due) this.expireGrantRow(grant, now);
  }

  private expireGrantRow(grant: GrantRow, now: number): void {
    const changed = this.ctx.storage.sql.exec(
      "UPDATE media_grant SET status = 'expired' WHERE grant_id = ? AND status = 'active'",
      grant.grant_id,
    );
    if (changed.rowsWritten === 0) return;
    const event: DemoEvent = {
      schema_version: DEMO_EVENT_SCHEMA_VERSION,
      session_id: grant.session_id,
      event_sequence: this.nextServerEventSequence(grant.session_id),
      timestamp_ms: now,
      event_type: "media_grant",
      payload: {
        grant_id: grant.grant_id,
        event_id: grant.event_id,
        scope: grant.scope,
        expires_at_ms: grant.expires_at_ms,
        status: "expired",
      },
    };
    this.broadcastToViewerIds(this.grantViewerIds(grant.grant_id), event);
    const controller = this.controllerSocket(grant.session_id);
    if (controller !== null) {
      safeSend(controller, JSON.stringify({ type: "media_grant_revoked", grant: event }));
    }
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

  private removeViewerFromActiveAudiences(viewerId: string, now: number): void {
    const grants = this.ctx.storage.sql.exec<GrantRow>(
      `SELECT grant.grant_id, grant.session_id, grant.event_id, grant.scope,
              grant.expires_at_ms, grant.status
         FROM media_grant AS grant
         JOIN media_grant_audience AS audience
           ON audience.grant_id = grant.grant_id
        WHERE audience.viewer_id = ? AND grant.status = 'active'`,
      viewerId,
    ).toArray();
    this.ctx.storage.sql.exec(
      "DELETE FROM media_grant_audience WHERE viewer_id = ?",
      viewerId,
    );
    for (const grant of grants) {
      if (grant.expires_at_ms <= now) continue;
      const controller = this.controllerSocket(grant.session_id);
      if (controller === null) continue;
      const event: DemoEvent = {
        schema_version: DEMO_EVENT_SCHEMA_VERSION,
        session_id: grant.session_id,
        event_sequence: this.nextServerEventSequence(grant.session_id),
        timestamp_ms: now,
        event_type: "media_grant",
        payload: {
          grant_id: grant.grant_id,
          event_id: grant.event_id,
          scope: grant.scope,
          expires_at_ms: grant.expires_at_ms,
          status: "active",
        },
      };
      safeSend(controller, JSON.stringify({
        type: "media_grant_accepted",
        grant: event,
        viewer_ids: this.grantViewerIds(grant.grant_id),
      }));
    }
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
    const now = Date.now();
    const leaseExpiresAtMs = now + LEASE_TTL_MS;

    if (this.currentLease(now) !== null) {
      return json({ ok: false, error: "controller_locked" }, 423);
    }
    const orphanedChecking = this.activeDangerWatchdog();
    if (
      orphanedChecking !== null
      && this.escalateDangerWatchdog(orphanedChecking, Date.now()) === null
    ) {
      throw new Error("orphaned danger check-in could not be escalated");
    }
    // A new session must never inherit the previous session's scheduled wakeup.
    // Any orphaned check-in is first made authoritative, then carried forward as
    // an unresolved escalation rather than silently erased by the takeover.
    await this.ctx.storage.deleteAlarm();
    if (this.currentLease(Date.now()) !== null) {
      return json({ ok: false, error: "controller_locked" }, 423);
    }
    const rollover = this.authoritativeEscalatedAlarm();
    const currentAlarm: AlarmStateEvent | null = rollover === null
      ? null
      : {
        ...rollover.event,
        session_id: sessionId,
        event_sequence: 0,
      };

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM media_grant_audience");
      this.ctx.storage.sql.exec("DELETE FROM media_grant");
      this.ctx.storage.sql.exec("DELETE FROM danger_voice_attempt");
      this.ctx.storage.sql.exec("DELETE FROM scene_recognition_budget");
      this.ctx.storage.sql.exec("DELETE FROM activity_recognition_evidence");
      this.ctx.storage.sql.exec("DELETE FROM danger_alarm_checkpoint");
      this.ctx.storage.sql.exec("DELETE FROM danger_watchdog");
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
         VALUES (1, ?, ?)`,
        sessionId,
        currentAlarm === null ? -1 : currentAlarm.event_sequence,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO room_frame_sequence (singleton, session_id, last_frame_sequence)
         VALUES (1, ?, -1)`,
        sessionId,
      );
      if (currentAlarm !== null && rollover !== null) {
        this.persistDemoEvent(currentAlarm);
        this.ctx.storage.sql.exec(
          `INSERT INTO danger_watchdog
             (session_id, event_id, deadline_ms, status)
           VALUES (?, ?, ?, 'escalated')`,
          sessionId,
          currentAlarm.payload.event_id,
          rollover.watchdog.deadline_ms,
        );
        this.persistDangerAlarmCheckpoint(currentAlarm);
      }
    });
    if (currentAlarm !== null) this.broadcastToAllViewers(currentAlarm);
    await this.scheduleNextAuthorityAlarm();

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

    await this.dropLease(tokenHash);
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

    const now = Date.now();
    const lease = this.currentLease(now);
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

    if (lease !== null) {
      for (const event of this.replayableEvents(lease.session_id)) {
        safeSend(server, JSON.stringify(event));
      }
      this.attachLateViewerToKitchenGrant(server, viewerId, lease.session_id, now);
    } else {
      const unresolvedEscalation = this.authoritativeEscalatedAlarm();
      if (unresolvedEscalation !== null) {
        safeSend(server, JSON.stringify(unresolvedEscalation.event));
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

  private attachLateViewerToKitchenGrant(
    viewer: WebSocket,
    viewerId: string,
    sessionId: string,
    now: number,
  ): void {
    const controller = this.controllerSocket(sessionId);
    if (controller === null) return;
    const grant = this.activeGrants(sessionId, now).find((candidate) => (
      candidate.scope === "kitchen_moment"
      && this.eligibleKitchenFact(sessionId, candidate.event_id, now) !== null
    ));
    if (grant === undefined || this.grantIncludesViewer(grant.grant_id, viewerId)) return;

    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO media_grant_audience (grant_id, viewer_id) VALUES (?, ?)`,
      grant.grant_id,
      viewerId,
    );
    const event: DemoEvent = {
      schema_version: DEMO_EVENT_SCHEMA_VERSION,
      session_id: sessionId,
      event_sequence: this.nextServerEventSequence(sessionId),
      timestamp_ms: now,
      event_type: "media_grant",
      payload: {
        grant_id: grant.grant_id,
        event_id: grant.event_id,
        scope: grant.scope,
        expires_at_ms: grant.expires_at_ms,
        status: "active",
      },
    };
    safeSend(viewer, JSON.stringify(event));
    safeSend(controller, JSON.stringify({
      type: "media_grant_accepted",
      grant: event,
      viewer_ids: this.grantViewerIds(grant.grant_id),
    }));
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
    const currentAlarm = this.structuredEvent(lease.session_id, "alarm_state");
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
        current_alarm: currentAlarm?.event_type === "alarm_state" ? currentAlarm : null,
      }),
    );

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": CONTROLLER_PROTOCOL },
    });
  }

  private currentLease(now: number): LeaseRow | null {
    const lease = this.leaseRow();

    if (lease !== null && lease.expires_at_ms <= now) {
      this.expireLease(lease, now);
      return null;
    }
    return lease;
  }

  private leaseRow(): LeaseRow | null {
    return this.ctx.storage.sql.exec<LeaseRow>(
      "SELECT token_hash, session_id, expires_at_ms FROM control_lease WHERE singleton = 1",
    ).toArray()[0] ?? null;
  }

  private expireLease(lease: LeaseRow, now: number): void {
    const watchdog = this.activeDangerWatchdog(lease.session_id);
    if (watchdog !== null) this.escalateDangerWatchdog(watchdog, now);
    this.revokeAllActiveGrants(lease.session_id, now, null);
    this.clearActivityRecognitionEvidence(lease.session_id);
    this.ctx.storage.sql.exec(
      "DELETE FROM control_lease WHERE singleton = 1 AND session_id = ?",
      lease.session_id,
    );
    for (const socket of this.ctx.getWebSockets("controller")) {
      socket.close(1008, "controller_lease_expired");
    }
  }

  private async dropLease(tokenHash: string): Promise<void> {
    const lease = this.leaseRow();
    if (lease !== null && constantTimeHexEqual(lease.token_hash, tokenHash)) {
      const now = Date.now();
      const watchdog = this.activeDangerWatchdog(lease.session_id);
      if (watchdog !== null) this.escalateDangerWatchdog(watchdog, now);
      this.revokeAllActiveGrants(lease.session_id, now, null);
      this.clearActivityRecognitionEvidence(lease.session_id);
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
    await this.scheduleNextAuthorityAlarm();
  }

  private openSockets(tag: "controller" | "viewer"): WebSocket[] {
    return this.ctx
      .getWebSockets(tag)
      .filter((socket) => socket.readyState === WebSocket.OPEN);
  }

  private authorityDeadline(): number | null {
    const deadlines: number[] = [];
    const lease = this.leaseRow();
    if (lease !== null) deadlines.push(lease.expires_at_ms);
    const watchdog = this.activeDangerWatchdog();
    if (watchdog !== null) deadlines.push(watchdog.deadline_ms);
    const grant = this.ctx.storage.sql.exec<{ [key: string]: SqlStorageValue; expires_at_ms: number }>(
      `SELECT expires_at_ms
         FROM media_grant
        WHERE status = 'active'
        ORDER BY expires_at_ms ASC
        LIMIT 1`,
    ).toArray()[0];
    if (grant !== undefined) deadlines.push(grant.expires_at_ms);
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  private async scheduleAlarmIncluding(candidateMs: number): Promise<void> {
    const persisted = this.authorityDeadline();
    await this.ctx.storage.setAlarm(
      persisted === null ? candidateMs : Math.min(candidateMs, persisted),
    );
  }

  private async scheduleNextAuthorityAlarm(): Promise<void> {
    const deadline = this.authorityDeadline();
    if (deadline === null) {
      await this.ctx.storage.deleteAlarm();
    } else {
      await this.ctx.storage.setAlarm(deadline);
    }
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
      url.pathname === "/api/danger/voice" ||
      url.pathname === "/api/scene/recognize" ||
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
          {
            beginAttempt: (tokenHash) => stub.beginActivityRecognitionAttempt(tokenHash),
            cancelAttempt: (tokenHash, attemptId) => (
              stub.cancelActivityRecognitionAttempt(tokenHash, attemptId)
            ),
            finishAttempt: (tokenHash, attemptId, verdict) => (
              stub.finishActivityRecognitionAttempt(tokenHash, attemptId, verdict)
            ),
          },
        );
        return withCors(response, origin);
      }
      if (url.pathname === "/api/danger/voice") {
        if (request.method !== "POST") {
          return withCors(json({ ok: false, error: "method_not_allowed" }, 405), origin);
        }
        const response = await handleDangerVoice(request, env, {
          authorizeTokenHash: (tokenHash) => stub.authorizeControlTokenHash(tokenHash),
          beginAttempt: (tokenHash, eventId, requestId) =>
            stub.beginDangerVoiceAttempt(tokenHash, eventId, requestId),
          finishAttempt: (tokenHash, sessionId, eventId, alarmEventSequence, requestId) =>
            stub.finishDangerVoiceAttempt(
              tokenHash,
              sessionId,
              eventId,
              alarmEventSequence,
              requestId,
            ),
        });
        return withCors(response, origin);
      }
      if (url.pathname === "/api/scene/recognize") {
        if (request.method !== "POST") {
          return withCors(json({ ok: false, error: "method_not_allowed" }, 405), origin);
        }
        const response = await handleSceneRecognition(request, env, {
          authorizeTokenHash: (tokenHash) => stub.authorizeControlTokenHash(tokenHash),
          beginAttempt: (tokenHash, requestId) =>
            stub.beginSceneRecognitionAttempt(tokenHash, requestId),
          finishAttempt: (tokenHash, sessionId, requestId) =>
            stub.finishSceneRecognitionAttempt(tokenHash, sessionId, requestId),
        });
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
