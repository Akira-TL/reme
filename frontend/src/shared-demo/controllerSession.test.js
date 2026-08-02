import assert from "node:assert/strict";
import test from "node:test";

import {
  clearControllerSession,
  clearPendingFallRecovery,
  CONTROLLER_SESSION_STORAGE_KEY,
  controllerReconnectDelayMs,
  PENDING_FALL_STORAGE_KEY,
  readControllerSession,
  readPendingFallRecovery,
  updateControllerSession,
  writeControllerSession,
  writePendingFallRecovery,
} from "./controllerSession.js";

const NOW_MS = 1_800_000_000_000;

function validSession(overrides = {}) {
  return {
    version: 2,
    token: "a".repeat(64),
    sessionId: "session-7e28e6c3-1234-4abc-9def-0123456789ab",
    leaseExpiresAtMs: NOW_MS + 30_000,
    sceneId: "living",
    fall: {
      phase: "idle",
      eventId: null,
      deadlineMs: null,
      trigger: null,
      message: "等待真实姿态流中的快速下移与横向转变。",
      delivery: "none",
    },
    ...overrides,
  };
}

function createStorage(initialValue = null) {
  const values = new Map();
  const removals = [];
  if (initialValue !== null) values.set(CONTROLLER_SESSION_STORAGE_KEY, initialValue);
  return {
    removals,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      removals.push(key);
      values.delete(key);
    },
  };
}

test("controller session round-trips the exact short-lived record", () => {
  const storage = createStorage();
  const session = validSession();

  assert.deepEqual(
    writeControllerSession(session, { storage, now: () => NOW_MS }),
    session,
  );
  assert.deepEqual(
    readControllerSession({ storage, now: () => NOW_MS }),
    session,
  );
  assert.deepEqual(
    JSON.parse(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY)),
    session,
  );
});

test("bad JSON is removed and fails closed", () => {
  const storage = createStorage("{broken");

  assert.equal(readControllerSession({ storage, now: () => NOW_MS }), null);
  assert.equal(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
  assert.deepEqual(storage.removals, [CONTROLLER_SESSION_STORAGE_KEY]);
});

test("unknown versions, extra fields, and raw control keys are rejected", () => {
  const variants = [
    validSession({ version: 1 }),
    validSession({ version: 3 }),
    { ...validSession(), unexpected: true },
    { ...validSession(), controlKey: "must-never-be-stored" },
  ];

  for (const value of variants) {
    const storage = createStorage(JSON.stringify(value));
    assert.equal(readControllerSession({ storage, now: () => NOW_MS }), null);
    assert.equal(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
  }
});

test("invalid tokens, session ids, and scene ids fail closed", () => {
  const variants = [
    validSession({ token: "A".repeat(64) }),
    validSession({ token: "a".repeat(63) }),
    validSession({ sessionId: "" }),
    validSession({ sessionId: "unsafe session/id" }),
    validSession({ sceneId: "bedroom" }),
  ];

  for (const value of variants) {
    const storage = createStorage(JSON.stringify(value));
    assert.equal(readControllerSession({ storage, now: () => NOW_MS }), null);
    assert.equal(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
  }
});

test("fall state is exact, structured, and never accepts voice content", () => {
  const checking = {
    phase: "checking",
    eventId: "fall-123",
    deadlineMs: NOW_MS + 8_000,
    trigger: "fall_transition",
    message: "刚才的动作有些突然，您还好吗？",
    delivery: "pending",
  };
  const storage = createStorage(JSON.stringify(validSession({ sceneId: "fall", fall: checking })));
  assert.deepEqual(
    readControllerSession({ storage, now: () => NOW_MS })?.fall,
    checking,
  );
  for (const trigger of ["visual_confirm", "manual_debug"]) {
    const migratedAlarm = {
      ...checking,
      phase: "escalated",
      deadlineMs: null,
      trigger,
      delivery: "accepted",
    };
    const migratedStorage = createStorage(JSON.stringify(validSession({
      sceneId: "fall",
      fall: migratedAlarm,
    })));
    assert.deepEqual(
      readControllerSession({ storage: migratedStorage, now: () => NOW_MS })?.fall,
      migratedAlarm,
    );
  }

  const invalidFalls = [
    { ...checking, transcript: "我没事" },
    { ...checking, audio_b64: "UklGRg==" },
    { ...checking, deadlineMs: null },
    { ...checking, eventId: "unsafe/event" },
    { ...checking, delivery: "accepted", phase: "idle" },
    { ...checking, phase: "escalated", deadlineMs: NOW_MS + 8_000 },
  ];
  for (const fall of invalidFalls) {
    const invalidStorage = createStorage(JSON.stringify(validSession({ sceneId: "fall", fall })));
    assert.equal(readControllerSession({ storage: invalidStorage, now: () => NOW_MS }), null);
  }

  const mismatchedScene = createStorage(JSON.stringify(validSession({ fall: checking })));
  assert.equal(readControllerSession({ storage: mismatchedScene, now: () => NOW_MS }), null);
});

test("pending fall recovery is versioned, bounded, and contains no authority or voice data", () => {
  const fall = {
    phase: "escalated",
    eventId: "fall-123",
    deadlineMs: null,
    trigger: "check_in_timeout",
    message: "完整问询窗口没有收到回应，规则已进入告警状态。",
    delivery: "pending",
  };
  const storage = createStorage();
  assert.deepEqual(
    writePendingFallRecovery(fall, { storage, now: () => NOW_MS }),
    fall,
  );
  assert.deepEqual(
    readPendingFallRecovery({ storage, now: () => NOW_MS }),
    fall,
  );
  assert.deepEqual(
    JSON.parse(storage.getItem(PENDING_FALL_STORAGE_KEY)),
    { version: 1, savedAtMs: NOW_MS, fall },
  );
  assert.equal(storage.getItem(PENDING_FALL_STORAGE_KEY).includes("token"), false);
  assert.equal(storage.getItem(PENDING_FALL_STORAGE_KEY).includes("transcript"), false);
  assert.equal(storage.getItem(PENDING_FALL_STORAGE_KEY).includes("audio"), false);
});

test("pending fall recovery rejects stale, future, idle, and expanded records", () => {
  const fall = {
    phase: "checking",
    eventId: "fall-123",
    deadlineMs: NOW_MS + 8_000,
    trigger: "fall_transition",
    message: "刚才的动作有些突然，您还好吗？",
    delivery: "pending",
  };
  const variants = [
    { version: 2, savedAtMs: NOW_MS, fall },
    { version: 1, savedAtMs: NOW_MS, fall, token: "never" },
    { version: 1, savedAtMs: NOW_MS, fall: { ...fall, transcript: "我没事" } },
    { version: 1, savedAtMs: NOW_MS - 24 * 60 * 60 * 1_000 - 1, fall },
    { version: 1, savedAtMs: NOW_MS + 60_001, fall },
    { version: 1, savedAtMs: NOW_MS, fall: validSession().fall },
  ];
  for (const value of variants) {
    const storage = createStorage();
    storage.setItem(PENDING_FALL_STORAGE_KEY, JSON.stringify(value));
    assert.equal(readPendingFallRecovery({ storage, now: () => NOW_MS }), null);
    assert.equal(storage.getItem(PENDING_FALL_STORAGE_KEY), null);
  }
});

test("pending fall recovery remains valid at the exact 24-hour boundary", () => {
  const fall = {
    phase: "escalated",
    eventId: "fall-123",
    deadlineMs: null,
    trigger: "check_in_timeout",
    message: "完整问询窗口没有收到回应，规则已进入告警状态。",
    delivery: "pending",
  };
  const storage = createStorage();
  storage.setItem(PENDING_FALL_STORAGE_KEY, JSON.stringify({
    version: 1,
    savedAtMs: NOW_MS - 24 * 60 * 60 * 1_000,
    fall,
  }));
  assert.deepEqual(readPendingFallRecovery({ storage, now: () => NOW_MS }), fall);
});

test("pending fall recovery is cleared independently from the active lease", () => {
  const storage = createStorage(JSON.stringify(validSession()));
  const fall = {
    phase: "resolved",
    eventId: "fall-123",
    deadlineMs: null,
    trigger: "fall_transition",
    message: "本人已确认安全，本次事件已关闭。",
    delivery: "pending",
  };
  writePendingFallRecovery(fall, { storage, now: () => NOW_MS });

  assert.equal(clearPendingFallRecovery({ storage }), true);
  assert.equal(storage.getItem(PENDING_FALL_STORAGE_KEY), null);
  assert.notEqual(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
});

test("only the four demo scene ids are accepted", () => {
  for (const sceneId of ["living", "kitchen", "bathroom", "fall"]) {
    const storage = createStorage(JSON.stringify(validSession({ sceneId })));
    assert.equal(
      readControllerSession({ storage, now: () => NOW_MS })?.sceneId,
      sceneId,
    );
  }
});

test("expired, non-finite, and unexpectedly far-future leases fail closed", () => {
  const variants = [
    validSession({ leaseExpiresAtMs: NOW_MS }),
    validSession({ leaseExpiresAtMs: NOW_MS - 1 }),
    validSession({ leaseExpiresAtMs: null }),
    validSession({ leaseExpiresAtMs: NOW_MS + 120_001 }),
  ];

  for (const value of variants) {
    const storage = createStorage(JSON.stringify(value));
    assert.equal(readControllerSession({ storage, now: () => NOW_MS }), null);
    assert.equal(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
  }

  const storage = createStorage();
  assert.equal(
    writeControllerSession(
      validSession({ leaseExpiresAtMs: Number.POSITIVE_INFINITY }),
      { storage, now: () => NOW_MS },
    ),
    null,
  );
  assert.equal(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
});

test("lease expiry at the two-minute upper boundary remains valid", () => {
  const storage = createStorage();
  const session = validSession({ leaseExpiresAtMs: NOW_MS + 120_000 });

  assert.deepEqual(
    writeControllerSession(session, { storage, now: () => NOW_MS }),
    session,
  );
});

test("update changes scene, lease expiry, and minimal fall state", () => {
  const storage = createStorage(JSON.stringify(validSession()));
  const fall = {
    phase: "escalated",
    eventId: "fall-123",
    deadlineMs: null,
    trigger: "check_in_timeout",
    message: "已进入告警状态，正在同步给评委查看。",
    delivery: "pending",
  };

  assert.deepEqual(
    updateControllerSession(
      { sceneId: "fall", leaseExpiresAtMs: NOW_MS + 45_000, fall },
      { storage, now: () => NOW_MS },
    ),
    validSession({ sceneId: "fall", leaseExpiresAtMs: NOW_MS + 45_000, fall }),
  );
  assert.deepEqual(
    readControllerSession({ storage, now: () => NOW_MS }),
    validSession({ sceneId: "fall", leaseExpiresAtMs: NOW_MS + 45_000, fall }),
  );
});

test("update rejects unknown fields and requires an existing valid record", () => {
  const storage = createStorage(JSON.stringify(validSession()));

  assert.equal(
    updateControllerSession({ controlKey: "never" }, { storage, now: () => NOW_MS }),
    null,
  );
  assert.deepEqual(
    readControllerSession({ storage, now: () => NOW_MS }),
    validSession(),
  );

  const emptyStorage = createStorage();
  assert.equal(
    updateControllerSession({ sceneId: "fall" }, { storage: emptyStorage, now: () => NOW_MS }),
    null,
  );
});

test("clear removes the stored controller session", () => {
  const storage = createStorage(JSON.stringify(validSession()));

  assert.equal(clearControllerSession({ storage }), true);
  assert.equal(storage.getItem(CONTROLLER_SESSION_STORAGE_KEY), null);
});

test("reconnect delay uses deterministic exponential steps with a five-second cap", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 10].map(controllerReconnectDelayMs),
    [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000],
  );
  assert.equal(controllerReconnectDelayMs(-1), 500);
  assert.equal(controllerReconnectDelayMs(Number.NaN), 500);
});
