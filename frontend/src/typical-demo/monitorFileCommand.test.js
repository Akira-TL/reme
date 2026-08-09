import assert from "node:assert/strict";
import test from "node:test";
import { resolvePendingFileCommandId } from "./monitorFileCommand.js";

function pendingFileCommand(overrides = {}) {
  return {
    command_id: "command-file-1",
    room_session_id: "room-1",
    expires_at_ms: 2_000,
    command: { name: "select_source", source_id: "file" },
    ...overrides,
  };
}

test("keeps only a live file command from the current room", () => {
  assert.equal(resolvePendingFileCommandId({
    commandId: "command-file-1",
    pendingCommands: [pendingFileCommand()],
    roomSessionId: "room-1",
    nowMs: 1_000,
  }), "command-file-1");
});

test("clears a file command removed after reject or picker cancellation", () => {
  assert.equal(resolvePendingFileCommandId({
    commandId: "command-file-1",
    pendingCommands: [],
    roomSessionId: "room-1",
    nowMs: 1_000,
  }), null);
});

test("clears expired and previous-room file commands", () => {
  const command = pendingFileCommand();
  assert.equal(resolvePendingFileCommandId({
    commandId: command.command_id,
    pendingCommands: [command],
    roomSessionId: "room-1",
    nowMs: 2_000,
  }), null);
  assert.equal(resolvePendingFileCommandId({
    commandId: command.command_id,
    pendingCommands: [command],
    roomSessionId: "room-2",
    nowMs: 1_000,
  }), null);
});

test("never retains a non-file command under a stale id", () => {
  assert.equal(resolvePendingFileCommandId({
    commandId: "command-file-1",
    pendingCommands: [pendingFileCommand({
      command: { name: "select_source", source_id: "display" },
    })],
    roomSessionId: "room-1",
    nowMs: 1_000,
  }), null);
});
