import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeCommandCursor } from "./viewerCommandCursor.js";

test("same room and lease retain the next command sequence", () => {
  const cursor = { roomSessionId: "room-1", leaseId: "lease-a", next: 4 };
  assert.equal(synchronizeCommandCursor(cursor, {
    roomSessionId: "room-1",
    leaseId: "lease-a",
  }), cursor);
});

test("release and reclaim under a new lease reset sequence authority", () => {
  const oldCursor = { roomSessionId: "room-1", leaseId: "lease-a", next: 4 };
  assert.deepEqual(synchronizeCommandCursor(oldCursor, {
    roomSessionId: "room-1",
    leaseId: null,
  }), { roomSessionId: null, leaseId: null, next: 1 });
  assert.deepEqual(synchronizeCommandCursor(oldCursor, {
    roomSessionId: "room-1",
    leaseId: "lease-b",
  }), { roomSessionId: "room-1", leaseId: "lease-b", next: 1 });
});

test("a room change resets command sequence even if a lease id is repeated", () => {
  assert.deepEqual(synchronizeCommandCursor({
    roomSessionId: "room-1",
    leaseId: "lease-a",
    next: 3,
  }, {
    roomSessionId: "room-2",
    leaseId: "lease-a",
  }), { roomSessionId: "room-2", leaseId: "lease-a", next: 1 });
});
