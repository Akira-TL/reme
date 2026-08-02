import assert from "node:assert/strict";
import test from "node:test";
import {
  estimatePromptLeadMs,
  recognizeDangerVoice,
  selectFailClosedFallEvent,
  selectFallReconnectAction,
  selectVoiceIntentAction,
} from "./voiceIntent.js";

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("voice intent client sends the exact authenticated WAV request", async () => {
  const signal = new AbortController().signal;
  let request = null;
  const result = await recognizeDangerVoice(
    "https://relay.example.test///",
    "control-token",
    {
      eventId: "fall-123",
      audioB64: "UklGRg==",
      signal,
    },
    async (url, init) => {
      request = { url, init };
      return jsonResponse({
        ok: true,
        intent: "safe",
        transcript: "我没事",
        model: "mimo-v2",
        latency_ms: 321,
      });
    },
  );

  assert.deepEqual(result, {
    intent: "safe",
    transcript: "我没事",
    model: "mimo-v2",
    latencyMs: 321,
  });
  assert.equal(request.url, "https://relay.example.test/api/danger/voice");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(request.init.headers, {
    Authorization: "Bearer control-token",
    "Content-Type": "application/json",
  });
  assert.equal(request.init.signal, signal);
  assert.deepEqual(JSON.parse(request.init.body), {
    event_id: "fall-123",
    audio_b64: "UklGRg==",
    audio_format: "wav",
  });
});

test("voice intent client rejects non-exact success payloads", async () => {
  const base = {
    ok: true,
    intent: "need_help",
    transcript: null,
    model: "mimo-v2",
    latency_ms: 88,
  };
  const invalidPayloads = [
    { ...base, debug: true },
    { ...base, intent: "maybe" },
    { ...base, transcript: "x".repeat(241) },
    { ...base, latency_ms: -1 },
    { ...base, latency_ms: 88.5 },
  ];

  for (const payload of invalidPayloads) {
    await assert.rejects(
      recognizeDangerVoice(
        "https://relay.example.test",
        "control-token",
        { eventId: "fall-123", audioB64: "UklGRg==" },
        async () => jsonResponse(payload),
      ),
      (error) => error?.code === "invalid_voice_intent_response",
    );
  }
});

test("voice intent client rejects oversized audio before fetch", async () => {
  let fetchCalls = 0;
  await assert.rejects(
    recognizeDangerVoice(
      "https://relay.example.test",
      "control-token",
      {
        eventId: "fall-123",
        audioB64: "A".repeat(426_729),
      },
      async () => {
        fetchCalls += 1;
        return jsonResponse(null);
      },
    ),
    /有效 WAV 数据/,
  );
  assert.equal(fetchCalls, 0);
});

test("voice intent client preserves bounded relay failure codes", async () => {
  await assert.rejects(
    recognizeDangerVoice(
      "https://relay.example.test",
      "control-token",
      { eventId: "fall-123", audioB64: "UklGRg==" },
      async () => jsonResponse(
        { error: "mimo_timeout", message: "MiMo timed out" },
        { ok: false, status: 504 },
      ),
    ),
    (error) => error?.code === "mimo_timeout" && error.message === "MiMo timed out",
  );
});

test("late safe intent expires instead of cancelling deterministic escalation", () => {
  const fall = {
    eventId: "fall-123",
    phase: "checking",
    deadlineMs: 8_000,
  };

  assert.equal(selectVoiceIntentAction({
    eventId: "fall-123",
    fall,
    intent: "safe",
    nowMs: 7_999,
  }), "resolve");
  assert.equal(selectVoiceIntentAction({
    eventId: "fall-123",
    fall,
    intent: "safe",
    nowMs: 8_000,
  }), "expire");
  assert.equal(selectVoiceIntentAction({
    eventId: "stale-event",
    fall,
    intent: "need_help",
    nowMs: 1_000,
  }), "ignore");
  assert.equal(selectVoiceIntentAction({
    eventId: "fall-123",
    fall,
    intent: "unclear",
    nowMs: 1_000,
  }), "continue_timeout");
});

test("prompt lead uses metadata when valid and a seven-second fallback otherwise", () => {
  assert.equal(estimatePromptLeadMs(6.501), 6_501);
  assert.equal(estimatePromptLeadMs(Number.NaN), 7_000);
  assert.equal(estimatePromptLeadMs(0), 7_000);
  assert.equal(estimatePromptLeadMs(undefined, 8_250), 8_250);
  assert.throws(() => estimatePromptLeadMs(undefined, -1), /fallbackMs/);
});

test("capture interruption fails closed only for an active fall check-in", () => {
  assert.equal(selectFailClosedFallEvent({
    eventId: "fall-123",
    phase: "checking",
  }), "fall-123");
  assert.equal(selectFailClosedFallEvent({
    eventId: "fall-123",
    phase: "resolved",
  }), null);
  assert.equal(selectFailClosedFallEvent({
    eventId: "fall-123",
    phase: "escalated",
  }), null);
  assert.equal(selectFailClosedFallEvent({
    eventId: "",
    phase: "checking",
  }), null);
  assert.equal(selectFailClosedFallEvent(null), null);
});

test("controller reconnect reconciles fall state against the absolute deadline", () => {
  assert.equal(selectFallReconnectAction({
    eventId: "fall-123",
    phase: "checking",
    deadlineMs: 8_001,
  }, 8_000), "republish_checking");
  assert.equal(selectFallReconnectAction({
    eventId: "fall-123",
    phase: "checking",
    deadlineMs: 8_000,
  }, 8_000), "escalate");
  assert.equal(selectFallReconnectAction({
    eventId: "fall-123",
    phase: "checking",
    deadlineMs: null,
  }, 8_000), "escalate");
  assert.equal(selectFallReconnectAction({
    eventId: "fall-123",
    phase: "escalated",
  }, 8_000), "republish_escalated");
  assert.equal(selectFallReconnectAction({
    eventId: "fall-123",
    phase: "resolved",
  }, 8_000), "republish_resolved");
  assert.equal(selectFallReconnectAction({
    eventId: null,
    phase: "idle",
  }, 8_000), "none");
});
