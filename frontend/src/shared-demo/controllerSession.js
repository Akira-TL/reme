export const CONTROLLER_SESSION_STORAGE_KEY = "reme.controller-session.v1";

const CONTROLLER_SESSION_VERSION = 1;
const MAX_LEASE_AHEAD_MS = 120_000;
const SESSION_KEYS = Object.freeze([
  "version",
  "token",
  "sessionId",
  "leaseExpiresAtMs",
  "sceneId",
]);
const UPDATE_KEYS = new Set(["leaseExpiresAtMs", "sceneId"]);
const SCENE_IDS = new Set(["living", "kitchen", "bathroom", "fall"]);
const RECONNECT_DELAYS_MS = Object.freeze([500, 1_000, 2_000, 4_000, 5_000]);

function resolveStorage(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : now;
  return Number.isFinite(value) ? value : Number.NaN;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, expectedKeys) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => expectedKeys.includes(key));
}

function normalizeSession(value, nowMs) {
  if (!hasExactKeys(value, SESSION_KEYS)) return null;
  if (value.version !== CONTROLLER_SESSION_VERSION) return null;
  if (typeof value.token !== "string" || !/^[a-f0-9]{64}$/.test(value.token)) return null;
  if (
    typeof value.sessionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.sessionId)
  ) {
    return null;
  }
  if (
    !Number.isFinite(nowMs)
    || !Number.isFinite(value.leaseExpiresAtMs)
    || value.leaseExpiresAtMs <= nowMs
    || value.leaseExpiresAtMs > nowMs + MAX_LEASE_AHEAD_MS
  ) {
    return null;
  }
  if (typeof value.sceneId !== "string" || !SCENE_IDS.has(value.sceneId)) return null;

  return {
    version: CONTROLLER_SESSION_VERSION,
    token: value.token,
    sessionId: value.sessionId,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
    sceneId: value.sceneId,
  };
}

function removeStoredSession(storage) {
  try {
    storage?.removeItem?.(CONTROLLER_SESSION_STORAGE_KEY);
    return storage !== null;
  } catch {
    return false;
  }
}

/**
 * Reads the short-lived controller lease from sessionStorage. Invalid, expired,
 * or unexpectedly shaped records are removed rather than partially accepted.
 */
export function readControllerSession({ storage, now = Date.now } = {}) {
  const target = resolveStorage(storage);
  if (target === null) return null;

  let serialized;
  try {
    serialized = target.getItem(CONTROLLER_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (serialized === null) return null;

  let decoded;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    removeStoredSession(target);
    return null;
  }

  const normalized = normalizeSession(decoded, resolveNow(now));
  if (normalized === null) removeStoredSession(target);
  return normalized;
}

/**
 * Stores only the strict lease/session record. The raw control key is never an
 * accepted field and therefore cannot be persisted by this helper.
 */
export function writeControllerSession(value, { storage, now = Date.now } = {}) {
  const target = resolveStorage(storage);
  if (target === null) return null;
  const normalized = normalizeSession(value, resolveNow(now));
  if (normalized === null) return null;

  try {
    target.setItem(CONTROLLER_SESSION_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Updates only the renewable expiry and/or selected demo scene on an existing,
 * still-valid record.
 */
export function updateControllerSession(patch, { storage, now = Date.now } = {}) {
  if (!isObject(patch)) return null;
  const patchKeys = Object.keys(patch);
  if (
    patchKeys.length === 0
    || patchKeys.some((key) => !UPDATE_KEYS.has(key))
  ) {
    return null;
  }

  const existing = readControllerSession({ storage, now });
  if (existing === null) return null;
  return writeControllerSession(
    { ...existing, ...patch },
    { storage, now },
  );
}

export function clearControllerSession({ storage } = {}) {
  const target = resolveStorage(storage);
  if (target === null) return false;
  return removeStoredSession(target);
}

/** Zero-based retry attempt: 0.5s, 1s, 2s, 4s, then a 5s cap. */
export function controllerReconnectDelayMs(attempt) {
  const normalizedAttempt = Number.isFinite(attempt)
    ? Math.max(0, Math.floor(attempt))
    : 0;
  return RECONNECT_DELAYS_MS[Math.min(normalizedAttempt, RECONNECT_DELAYS_MS.length - 1)];
}
