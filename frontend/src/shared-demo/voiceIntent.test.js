import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAlarmDeliveryAck,
  estimatePromptLeadMs,
  planRestoredFallCheckIn,
  prepareFallRecoveryForNewSession,
  reconcileFallWithAuthoritativeAlarm,
  recognizeDangerVoice,
  selectControlReleaseAction,
  selectFailClosedFallEvent,
  selectFallInterruptionAction,
  selectFallCheckInStartAction,
  selectFallExitAction,
  selectFallResolutionAction,
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

test("a fall detected after the page is already hidden skips the throttled check-in", () => {
  assert.equal(selectFallCheckInStartAction("hidden"), "escalate");
  assert.equal(selectFallCheckInStartAction("visible"), "prompt");
  assert.equal(selectFallCheckInStartAction("prerender"), "prompt");
});

test("visibility preserves a future checking deadline and escalates only after expiry", () => {
  const checking = {
    phase: "checking",
    eventId: "fall-123",
    deadlineMs: 10_000,
  };
  assert.equal(selectFallInterruptionAction({
    kind: "visibility",
    fall: checking,
    nowMs: 9_999,
    visibilityState: "hidden",
  }), "preserve");
  assert.equal(selectFallInterruptionAction({
    kind: "visibility",
    fall: checking,
    nowMs: 10_000,
    visibilityState: "hidden",
  }), "escalate");
  assert.equal(selectFallInterruptionAction({
    kind: "visibility",
    fall: checking,
    nowMs: 10_001,
    visibilityState: "hidden",
  }), "escalate");
});

test("initially hidden restored check-ins keep their absolute deadline", () => {
  const checking = {
    phase: "checking",
    eventId: "fall-restored",
    deadlineMs: 10_000,
  };
  for (const visibilityState of ["hidden", "visible", "prerender"]) {
    assert.deepEqual(planRestoredFallCheckIn({
      fall: checking,
      nowMs: 9_250,
      visibilityState,
    }), { action: "schedule", delayMs: 750 });
  }
  assert.deepEqual(planRestoredFallCheckIn({
    fall: checking,
    nowMs: 10_000,
    visibilityState: "hidden",
  }), { action: "escalate", delayMs: null });
  assert.deepEqual(planRestoredFallCheckIn({
    fall: { ...checking, deadlineMs: null },
    nowMs: 9_250,
    visibilityState: "hidden",
  }), { action: "escalate", delayMs: null });
  assert.deepEqual(planRestoredFallCheckIn({
    fall: { ...checking, phase: "resolved" },
    nowMs: 9_250,
    visibilityState: "hidden",
  }), { action: "none", delayMs: null });
});

test("visible reconciliation escalates an expired check-in and pagehide always fails closed", () => {
  const checking = {
    phase: "checking",
    eventId: "fall-123",
    deadlineMs: 10_000,
  };
  assert.equal(selectFallInterruptionAction({
    kind: "visibility",
    fall: checking,
    nowMs: 10_000,
    visibilityState: "visible",
  }), "escalate");
  assert.equal(selectFallInterruptionAction({
    kind: "pagehide",
    fall: checking,
    nowMs: 9_000,
  }), "escalate");
  assert.equal(selectFallInterruptionAction({
    kind: "visibility",
    fall: { ...checking, phase: "resolved" },
    nowMs: 11_000,
    visibilityState: "visible",
  }), "none");
});

test("a recovered fall is pending in the new lease and expires before WebSocket readiness", () => {
  const checking = {
    phase: "checking",
    eventId: "fall-123",
    deadlineMs: 10_000,
    trigger: "fall_transition",
    message: "刚才的动作有些突然，您还好吗？",
    delivery: "accepted",
  };
  assert.deepEqual(prepareFallRecoveryForNewSession(checking, 9_999), {
    ...checking,
    delivery: "pending",
  });
  assert.deepEqual(prepareFallRecoveryForNewSession(checking, 10_000), {
    ...checking,
    phase: "escalated",
    deadlineMs: null,
    trigger: "check_in_timeout",
    message: "完整问询窗口没有收到回应，规则已进入告警状态。",
    delivery: "pending",
  });
  assert.equal(prepareFallRecoveryForNewSession(null, 10_000), null);
});

test("Relay's unresolved alarm wins over stale local safe while newer local terminal state republishes", () => {
  const authoritativeEscalation = {
    event_id: "fall-123",
    phase: "escalated",
    trigger: "check_in_timeout",
    message: "完整问询窗口没有收到回应，已按确定性规则进入告警状态。",
    response_deadline_ms: null,
    media_scope: "fall_emergency",
  };
  assert.deepEqual(reconcileFallWithAuthoritativeAlarm({
    phase: "resolved",
    eventId: "fall-123",
    deadlineMs: null,
    trigger: "fall_transition",
    message: "本人已确认安全，本次事件已关闭。",
    delivery: "pending",
  }, authoritativeEscalation), {
    action: "adopt",
    fall: {
      phase: "escalated",
      eventId: "fall-123",
      deadlineMs: null,
      trigger: "check_in_timeout",
      message: authoritativeEscalation.message,
      delivery: "accepted",
    },
  });

  const localEscalation = {
    phase: "escalated",
    eventId: "fall-123",
    deadlineMs: null,
    trigger: "elder_need_help",
    message: "本人已表示需要帮助，已进入告警状态。",
    delivery: "pending",
  };
  assert.deepEqual(reconcileFallWithAuthoritativeAlarm(localEscalation, {
    ...authoritativeEscalation,
    phase: "checking",
    trigger: "fall_transition",
    response_deadline_ms: 12_000,
    media_scope: "none",
  }), { action: "republish", fall: localEscalation });

  const newerLocalEvent = { ...localEscalation, eventId: "fall-new" };
  assert.deepEqual(reconcileFallWithAuthoritativeAlarm(newerLocalEvent, {
    ...authoritativeEscalation,
    phase: "resolved",
    response_deadline_ms: null,
    media_scope: "none",
  }), { action: "republish", fall: newerLocalEvent });
  const idle = {
    phase: "idle",
    eventId: null,
    deadlineMs: null,
    trigger: null,
    message: "等待真实姿态流中的快速下移与横向转变。",
    delivery: "none",
  };
  assert.deepEqual(reconcileFallWithAuthoritativeAlarm(idle, {
    ...authoritativeEscalation,
    phase: "resolved",
    response_deadline_ms: null,
    media_scope: "none",
  }), { action: "ignore", fall: idle });
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

test("scene and control exits cannot abandon an unclosed or unacknowledged fall", () => {
  assert.equal(selectFallExitAction({
    eventId: null,
    phase: "idle",
    delivery: "none",
  }), "allow");
  assert.equal(selectFallExitAction({
    eventId: "fall-123",
    phase: "checking",
    delivery: "accepted",
  }), "escalate");
  assert.equal(selectFallExitAction({
    eventId: "fall-123",
    phase: "escalated",
    delivery: "accepted",
  }), "block");
  assert.equal(selectFallExitAction({
    eventId: "fall-123",
    phase: "resolved",
    delivery: "pending",
  }), "block");
  assert.equal(selectFallExitAction({
    eventId: "fall-123",
    phase: "resolved",
    delivery: "accepted",
  }), "allow");
  assert.equal(selectFallExitAction({
    eventId: null,
    phase: "idle",
    delivery: "none",
  }, { persistenceHealthy: false }), "block");
});

test("manual safety confirmation respects the absolute deadline and alarm delivery", () => {
  const checking = {
    eventId: "fall-123",
    phase: "checking",
    deadlineMs: 10_000,
    delivery: "accepted",
  };
  assert.equal(selectFallResolutionAction(checking, "fall-123", 9_999), "resolve");
  assert.equal(selectFallResolutionAction(checking, "fall-123", 10_000), "escalate");
  assert.equal(selectFallResolutionAction(checking, "fall-123", 10_001), "escalate");
  assert.equal(selectFallResolutionAction({
    ...checking,
    phase: "escalated",
    deadlineMs: null,
    delivery: "pending",
  }, "fall-123", 10_001), "block");
  assert.equal(selectFallResolutionAction({
    ...checking,
    phase: "escalated",
    deadlineMs: null,
    delivery: "accepted",
  }, "fall-123", 10_001), "resolve");
  assert.equal(selectFallResolutionAction(checking, "fall-other", 9_999), "ignore");
});

test("control release only clears local authority after Relay confirms terminal state", () => {
  assert.equal(selectControlReleaseAction(200), "complete");
  assert.equal(selectControlReleaseAction(204), "complete");
  assert.equal(selectControlReleaseAction(401), "complete");
  assert.equal(selectControlReleaseAction(409), "retry");
  assert.equal(selectControlReleaseAction(500), "retry");
  assert.equal(selectControlReleaseAction(null), "retry");
});

test("only the matching Relay alarm acknowledgement marks delivery accepted", () => {
  const fall = {
    eventId: "fall-123",
    phase: "escalated",
    delivery: "pending",
  };
  const pending = {
    eventId: "fall-123",
    phase: "escalated",
    eventSequence: 2_048,
  };
  assert.deepEqual(applyAlarmDeliveryAck({
    fall,
    pending,
    eventSequence: 2_048,
  }), {
    ...fall,
    delivery: "accepted",
  });
  assert.equal(applyAlarmDeliveryAck({
    fall,
    pending,
    eventSequence: 1_024,
  }), null);
  assert.equal(applyAlarmDeliveryAck({
    fall: { ...fall, phase: "resolved" },
    pending,
    eventSequence: 2_048,
  }), null);
  assert.equal(applyAlarmDeliveryAck({
    fall: { ...fall, eventId: "fall-new" },
    pending,
    eventSequence: 2_048,
  }), null);
});
