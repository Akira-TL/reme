import assert from "node:assert/strict";
import test from "node:test";
import { createCookingConfirmationTracker, recognizeCooking } from "./activityRecognition.js";

test("cooking needs two consecutive confident visual verdicts", () => {
  const tracker = createCookingConfirmationTracker();
  assert.deepEqual(tracker.push({ classification: "cooking", confidence: 0.8 }), {
    phase: "candidate",
    consecutive: 1,
    confirmed: false,
  });
  assert.deepEqual(tracker.push({ classification: "cooking", confidence: 0.72 }), {
    phase: "confirmed",
    consecutive: 2,
    confirmed: true,
  });
});

test("uncertain, negative, or low-confidence verdicts reset cooking evidence", () => {
  const tracker = createCookingConfirmationTracker();
  tracker.push({ classification: "cooking", confidence: 0.9 });
  assert.equal(tracker.push({ classification: "uncertain", confidence: 0.9 }).consecutive, 0);
  tracker.push({ classification: "cooking", confidence: 0.9 });
  assert.equal(tracker.push({ classification: "not_cooking", confidence: 0.9 }).confirmed, false);
  tracker.push({ classification: "cooking", confidence: 0.9 });
  assert.equal(tracker.push({ classification: "cooking", confidence: 0.4 }).consecutive, 0);
});

test("activity recognition sends one exact JPEG request and validates the result", async () => {
  let request = null;
  const result = await recognizeCooking(
    "https://relay.example",
    "token-a",
    "jpeg-base64",
    async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({
        ok: true,
        classification: "cooking",
        confidence: 0.8,
        reason: "正在使用锅具",
        model: "mimo-v2.5",
        latency_ms: 850,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  );
  assert.equal(request.url, "https://relay.example/api/activity/recognize");
  assert.equal(request.init.headers.Authorization, "Bearer token-a");
  assert.deepEqual(JSON.parse(request.init.body), { image_b64: "jpeg-base64" });
  assert.equal(result.classification, "cooking");
  assert.equal(result.latencyMs, 850);
});

test("activity recognition exposes relay errors and rejects malformed successes", async () => {
  await assert.rejects(
    recognizeCooking("https://relay.example", "token", "jpeg", async () => (
      new Response(JSON.stringify({ ok: false, error: "mimo_unavailable" }), { status: 503 })
    )),
    (error) => error.code === "mimo_unavailable",
  );
  await assert.rejects(
    recognizeCooking("https://relay.example", "token", "jpeg", async () => (
      new Response(JSON.stringify({
        ok: true,
        classification: "probably",
        confidence: 4,
        reason: "",
        model: "mimo",
      }), { status: 200 })
    )),
    /不符合合同/,
  );
});
