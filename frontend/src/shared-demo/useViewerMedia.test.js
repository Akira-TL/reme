import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIceCandidate } from "./useViewerMedia.js";

test("ICE normalization always emits the exact nullable wire shape", () => {
  assert.deepEqual(normalizeIceCandidate({
    candidate: "candidate:1",
    sdpMid: undefined,
    sdpMLineIndex: 0,
  }), {
    candidate: "candidate:1",
    sdpMid: null,
    sdpMLineIndex: 0,
    usernameFragment: null,
  });
});

test("ICE normalization uses toJSON without leaking extension keys", () => {
  assert.deepEqual(normalizeIceCandidate({
    toJSON() {
      return {
        candidate: "candidate:2",
        sdpMid: "0",
        sdpMLineIndex: 1,
        usernameFragment: "ufrag",
        address: "private",
      };
    },
  }), {
    candidate: "candidate:2",
    sdpMid: "0",
    sdpMLineIndex: 1,
    usernameFragment: "ufrag",
  });
});
