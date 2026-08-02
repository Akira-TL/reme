import assert from "node:assert/strict";
import test from "node:test";

import {
  clearControllerSession,
  CONTROLLER_SESSION_STORAGE_KEY,
  controllerReconnectDelayMs,
  readControllerSession,
  updateControllerSession,
  writeControllerSession,
} from "./controllerSession.js";

const NOW_MS = 1_800_000_000_000;

function validSession(overrides = {}) {
  return {
    version: 1,
    token: "a".repeat(64),
    sessionId: "session-7e28e6c3-1234-4abc-9def-0123456789ab",
    leaseExpiresAtMs: NOW_MS + 30_000,
    sceneId: "living",
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
    validSession({ version: 2 }),
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

test("update changes scene and lease expiry on an existing valid record", () => {
  const storage = createStorage(JSON.stringify(validSession()));

  assert.deepEqual(
    updateControllerSession(
      { sceneId: "kitchen", leaseExpiresAtMs: NOW_MS + 45_000 },
      { storage, now: () => NOW_MS },
    ),
    validSession({ sceneId: "kitchen", leaseExpiresAtMs: NOW_MS + 45_000 }),
  );
  assert.deepEqual(
    readControllerSession({ storage, now: () => NOW_MS }),
    validSession({ sceneId: "kitchen", leaseExpiresAtMs: NOW_MS + 45_000 }),
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
