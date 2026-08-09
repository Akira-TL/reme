import assert from "node:assert/strict";
import test from "node:test";
import { submitResponse } from "./decisionClient.js";

test("browser response client cannot synthesize timeout decisions", () => {
  const previousFetch = globalThis.fetch;
  let postCount = 0;
  globalThis.fetch = () => {
    postCount += 1;
    return Promise.reject(new Error("unexpected request"));
  };
  try {
    assert.throws(() => submitResponse("http://localhost", {
      scene_id: "fall",
      decision_id: "decision-1",
      timestamp_ms: 1_000,
      response: "none",
      source: "timeout",
    }), /无效回应类型/);
    assert.equal(postCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
