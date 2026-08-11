import assert from "node:assert/strict";
import test from "node:test";
import { submitResponse } from "./decisionClient.js";

test("scripted acceptance reply uses the Backend-authorized elder response source", async () => {
  const previousFetch = globalThis.fetch;
  let posted = null;
  globalThis.fetch = async (_url, options) => {
    posted = JSON.parse(options.body);
    return {
      ok: true,
      async json() { return { ok: true }; },
    };
  };
  try {
    await submitResponse("http://localhost", {
      scene_id: "living",
      decision_id: "decision-1",
      timestamp_ms: 1_000,
      response: "need_help",
      source: "script",
      text: "牙疼，饭咬不动。",
    });
    assert.deepEqual(posted, {
      schema_version: "reme-interaction-response/v0-experiment",
      scene_id: "living",
      decision_id: "decision-1",
      timestamp_ms: 1_000,
      response: "need_help",
      source: "script",
      text: "牙疼，饭咬不动。",
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("family acknowledgement sources cannot be reused for elder replies", () => {
  assert.throws(() => submitResponse("http://localhost", {
    scene_id: "living",
    decision_id: "decision-1",
    timestamp_ms: 1_000,
    response: "need_help",
    source: "family_input",
  }), /只允许来源 user_input\/script/);
});

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
