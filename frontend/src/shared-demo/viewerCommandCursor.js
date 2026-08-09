function emptyCursor() {
  return { roomSessionId: null, leaseId: null, next: 1 };
}

export function synchronizeCommandCursor(cursor, { roomSessionId, leaseId }) {
  if (typeof roomSessionId !== "string" || !roomSessionId
    || typeof leaseId !== "string" || !leaseId) return emptyCursor();
  if (cursor?.roomSessionId === roomSessionId && cursor?.leaseId === leaseId) {
    return cursor;
  }
  return { roomSessionId, leaseId, next: 1 };
}
