export const FAMILY_TIMELINE_LIMIT = 12;

const MAX_SEEN_ACKS = 48;

const SCENE_LABELS = Object.freeze({
  living: "客厅日常",
  kitchen: "厨房时光",
  bathroom: "浴室隐私",
  fall: "夜间守护",
});

const CAPTURE_LABELS = Object.freeze({
  idle: "采集未开始",
  awaiting_local_confirmation: "等待家中端确认采集",
  starting: "正在启动采集",
  active: "采集运行中",
  stopping: "正在停止采集",
  error: "采集异常",
});

const RUNTIME_LABELS = Object.freeze({
  offline: "本地运行时离线",
  connecting: "正在连接本地运行时",
  ready: "本地运行时就绪",
  degraded: "本地运行时降级",
  error: "本地运行时异常",
});

const ASSESSMENT_SOURCE_LABELS = Object.freeze({
  rule: "安全规则判断",
  mimo: "MiMo 关怀判断",
  mock: "演示判断",
  record: "回放判断",
  degraded: "降级判断",
});

const ASSESSMENT_STATUS = Object.freeze({
  observing: { label: "安静观察", tone: "neutral" },
  awaiting_response: { label: "等待回应", tone: "warning" },
  family_notified: { label: "建议关怀", tone: "warning" },
  resolved: { label: "已经处理", tone: "success" },
  degraded: { label: "信息不足", tone: "warning" },
});

const EVENT_PRIORITY = Object.freeze({
  acknowledgement: 100,
  assessment: 90,
  care: 80,
  consent: 70,
  media: 60,
});

function timelineTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function timelineEvent({
  id,
  kind,
  label,
  title,
  detail,
  timestampMs,
  tone = "neutral",
  statusLabel = null,
  suggestedAction = null,
  progress = null,
  assessmentSource = null,
  uncertainty = null,
  visualContext = null,
  source = "demo_state",
  stateRevision = null,
  sceneId = null,
  captureStatus = null,
  runtimeStatus = null,
}) {
  return Object.freeze({
    id,
    kind,
    label,
    title,
    detail,
    timestampMs: timelineTimestamp(timestampMs),
    tone,
    statusLabel,
    suggestedAction,
    progress,
    assessmentSource,
    uncertainty,
    visualContext,
    source,
    stateRevision,
    sceneId,
    sceneLabel: SCENE_LABELS[sceneId] || null,
    captureStatus,
    captureLabel: CAPTURE_LABELS[captureStatus] || null,
    runtimeStatus,
    runtimeLabel: RUNTIME_LABELS[runtimeStatus] || null,
    priority: EVENT_PRIORITY[kind] || 0,
  });
}

function snapshotMetadata(snapshot, current) {
  return {
    source: "demo_state",
    stateRevision: snapshot.state_revision,
    sceneId: current.sceneId,
    captureStatus: current.captureStatus,
    runtimeStatus: current.runtimeStatus,
  };
}

function cloneAssessment(value) {
  if (!value) return null;
  return Object.freeze({
    verdict: value.verdict,
    basis: value.basis,
    uncertainty: value.uncertainty,
    source: value.source,
    action: value.action,
    suggestedAction: value.suggested_action,
    status: value.status,
    visualContext: Object.freeze({
      sentToMimo: value.visual_context.sent_to_mimo,
      type: value.visual_context.type,
      sampleCount: value.visual_context.sample_count,
    }),
  });
}

function projectSnapshot(snapshot) {
  const state = snapshot.state;
  return Object.freeze({
    sceneId: state.scene_id,
    captureStatus: state.capture.status,
    runtimeStatus: state.runtime.status,
    carePhase: state.care.phase,
    careDecisionId: state.care.decision_id,
    careConsent: state.care.consent,
    careMessage: state.care.message,
    careAssessment: cloneAssessment(state.care.assessment),
    mediaGrantId: state.media_grant?.grant_id || null,
    mediaGrantScope: state.media_grant?.scope || null,
  });
}

function assessmentSignature(assessment) {
  return assessment ? JSON.stringify(assessment) : null;
}

function assessmentEvent(snapshot, previous, current) {
  const assessment = current.careAssessment;
  if (!assessment) return null;
  if (
    current.careDecisionId === previous?.careDecisionId
    && assessmentSignature(assessment) === assessmentSignature(previous?.careAssessment)
  ) return null;

  const status = ASSESSMENT_STATUS[assessment.status] || ASSESSMENT_STATUS.degraded;
  const authoritativeEmergency = current.carePhase === "emergency";
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:assessment`,
    kind: "assessment",
    label: ASSESSMENT_SOURCE_LABELS[assessment.source] || "关怀判断",
    title: assessment.verdict,
    detail: assessment.basis,
    timestampMs: snapshot.timestamp_ms,
    tone: authoritativeEmergency ? "danger" : status.tone,
    statusLabel: authoritativeEmergency ? "需要立即关注" : status.label,
    suggestedAction: assessment.suggestedAction,
    progress: status.label,
    assessmentSource: assessment.source,
    uncertainty: assessment.uncertainty,
    visualContext: assessment.visualContext,
    ...snapshotMetadata(snapshot, current),
  });
}

function fallbackCareEvent(snapshot, previous, current) {
  if (current.careAssessment) return null;
  if (current.carePhase === "idle") return null;
  if (
    current.carePhase === previous?.carePhase
    && current.careDecisionId === previous?.careDecisionId
    && current.careMessage === previous?.careMessage
  ) return null;

  const copy = {
    checking: {
      title: "家中端已经发起关怀问候",
      detail: current.careMessage || "正在等待本人回应；当前没有可展示的模型判断依据。",
      tone: "warning",
      statusLabel: "等待回应",
      suggestedAction: "等待本人回应，暂不把情况定性",
      progress: "问候已发出",
    },
    emergency: {
      title: "确定性安全规则已提醒家人",
      detail: current.careMessage || "当前没有可展示的模型判断依据，请及时联系确认。",
      tone: "danger",
      statusLabel: "需要立即关注",
      suggestedAction: "请立即联系本人或前往查看",
      progress: "等待家人处理",
    },
    resolved: {
      title: "本次关怀已经处理",
      detail: current.careMessage || "家中端已将本次关怀流程标记为处理完成。",
      tone: "success",
      statusLabel: "已经处理",
      suggestedAction: "无需继续操作",
      progress: "流程已结束",
    },
  }[current.carePhase];
  if (!copy) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:care`,
    kind: "care",
    label: "关怀进展",
    timestampMs: snapshot.timestamp_ms,
    ...copy,
    ...snapshotMetadata(snapshot, current),
  });
}

function consentEvent(snapshot, previous, current) {
  if (current.careConsent === (previous?.careConsent || "none")) return null;
  const copy = {
    none: {
      title: "本次分享授权已经结束",
      detail: "家属端不再显示本次事件的授权原画。",
      tone: "privacy",
      statusLabel: "授权结束",
      progress: "恢复隐私展示",
    },
    pending: {
      title: "已经向本人征求分享授权",
      detail: "本人回应前，原画保持关闭。",
      tone: "warning",
      statusLabel: "等待回应",
      progress: "授权确认中",
    },
    granted: {
      title: "本人同意本次限时分享",
      detail: "授权只适用于当前事件，并会按时自动结束。",
      tone: "success",
      statusLabel: "本人已同意",
      progress: "授权已记录",
    },
    denied: {
      title: "本人没有同意本次分享",
      detail: "原画保持关闭，继续使用隐私化信息。",
      tone: "privacy",
      statusLabel: "保持隐私",
      progress: "授权已拒绝",
    },
  }[current.careConsent];
  if (!copy) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:consent`,
    kind: "consent",
    label: "关怀授权",
    timestampMs: snapshot.timestamp_ms,
    ...copy,
    ...snapshotMetadata(snapshot, current),
  });
}

function mediaEvent(snapshot, previous, current) {
  if (current.mediaGrantId === (previous?.mediaGrantId || null)) return null;
  if (!current.mediaGrantId) {
    return timelineEvent({
      id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:media`,
      kind: "media",
      label: "隐私处理",
      title: "事件期原画已经关闭",
      detail: "家属端恢复为匿名骨架与必要状态。",
      timestampMs: snapshot.timestamp_ms,
      tone: "privacy",
      statusLabel: "原画已关闭",
      progress: "恢复隐私展示",
      ...snapshotMetadata(snapshot, current),
    });
  }
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:media`,
    kind: "media",
    label: "隐私处理",
    title: "事件期原画已经限时开放",
    detail: current.mediaGrantScope === "fall_emergency"
      ? "确定性安全事件授权窗口已经开启，并会按时自动关闭。"
      : "本人授权的生活片段窗口已经开启，并会按时自动关闭。",
    timestampMs: snapshot.timestamp_ms,
    tone: "warning",
    statusLabel: "限时授权中",
    progress: "到期自动关闭",
    ...snapshotMetadata(snapshot, current),
  });
}

function transitionEvents(snapshot, previous, current) {
  return [
    assessmentEvent(snapshot, previous, current),
    fallbackCareEvent(snapshot, previous, current),
    consentEvent(snapshot, previous, current),
    mediaEvent(snapshot, previous, current),
  ].filter(Boolean);
}

function acknowledgementEvents(roomSessionId, acks, seenAckIds) {
  if (!roomSessionId) return { events: [], seenAckIds };
  const seen = new Set(seenAckIds);
  const events = [];
  for (const ack of acks || []) {
    if (
      ack?.phase !== "applied"
      || ack.command_name !== "confirm_alarm"
      || !ack.command_id
      || seen.has(ack.command_id)
    ) continue;
    seen.add(ack.command_id);
    events.push(timelineEvent({
      id: `ack:${roomSessionId}:${ack.command_id}`,
      kind: "acknowledgement",
      label: "处理结果",
      title: "家属已经确认收到告警",
      detail: "家中端已应用本次处理回执。",
      timestampMs: ack.timestamp_ms,
      tone: "success",
      statusLabel: "家属已确认",
      progress: "回执已同步",
      source: "command_ack",
      stateRevision: Number.isSafeInteger(ack.state_revision) ? ack.state_revision : null,
    }));
  }
  return {
    events,
    seenAckIds: [...seen].slice(-MAX_SEEN_ACKS),
  };
}

function sortAndLimit(events) {
  return [...events]
    .sort((left, right) => (
      right.batchOrder - left.batchOrder
      || right.priority - left.priority
      || right.timestampMs - left.timestampMs
      || left.id.localeCompare(right.id)
    ))
    .slice(0, FAMILY_TIMELINE_LIMIT);
}

export function createFamilyTimelineState() {
  return {
    roomSessionId: null,
    lastStateRevision: null,
    lastSnapshot: null,
    seenAckIds: [],
    nextBatchOrder: 1,
    events: [],
  };
}

export function reduceFamilyTimeline(state, action) {
  if (action.type !== "observe") return state;
  const observedRoomSessionId = action.roomSessionId
    || action.snapshot?.room_session_id
    || null;
  let next = state;

  if (observedRoomSessionId && observedRoomSessionId !== state.roomSessionId) {
    next = {
      ...createFamilyTimelineState(),
      roomSessionId: observedRoomSessionId,
    };
  }

  const newEvents = [];
  const snapshot = action.snapshot;
  if (
    snapshot
    && snapshot.room_session_id === next.roomSessionId
    && Number.isSafeInteger(snapshot.state_revision)
    && (
      next.lastStateRevision === null
      || snapshot.state_revision > next.lastStateRevision
    )
  ) {
    const current = projectSnapshot(snapshot);
    newEvents.push(...transitionEvents(snapshot, next.lastSnapshot, current));
    next = {
      ...next,
      lastStateRevision: snapshot.state_revision,
      lastSnapshot: current,
    };
  }

  const acknowledgement = acknowledgementEvents(
    next.roomSessionId,
    action.acks,
    next.seenAckIds,
  );
  newEvents.push(...acknowledgement.events);

  if (
    newEvents.length === 0
    && acknowledgement.seenAckIds.length === next.seenAckIds.length
  ) return next;

  const orderedEvents = newEvents.map((event) => Object.freeze({
    ...event,
    batchOrder: next.nextBatchOrder,
  }));

  return {
    ...next,
    seenAckIds: acknowledgement.seenAckIds,
    nextBatchOrder: next.nextBatchOrder + 1,
    events: sortAndLimit([...orderedEvents, ...next.events]),
  };
}
