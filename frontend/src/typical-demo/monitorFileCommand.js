export function resolvePendingFileCommandId({
  commandId,
  pendingCommands,
  roomSessionId,
  nowMs = Date.now(),
}) {
  if (typeof commandId !== "string" || !commandId
    || typeof roomSessionId !== "string" || !roomSessionId
    || !Array.isArray(pendingCommands)
    || !Number.isFinite(nowMs)) return null;
  const pending = pendingCommands.find((item) => item?.command_id === commandId);
  if (!pending
    || pending.room_session_id !== roomSessionId
    || !Number.isFinite(pending.expires_at_ms)
    || pending.expires_at_ms <= nowMs
    || pending.command?.name !== "select_source"
    || pending.command.source_id !== "file") return null;
  return commandId;
}
