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

const CARE_LABELS = Object.freeze({
  idle: "日常关怀",
  checking: "正在确认情况",
  emergency: "需要关注的安全事件",
  resolved: "关怀事件已处理",
});

const EVENT_PRIORITY = Object.freeze({
  acknowledgement: 100,
  care: 90,
  media: 80,
  consent: 70,
  scene: 60,
  capture: 50,
  runtime: 40,
  sync: 10,
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
  source = "demo_state",
  stateRevision = null,
  sceneId = null,
}) {
  return Object.freeze({
    id,
    kind,
    label,
    title,
    detail,
    timestampMs: timelineTimestamp(timestampMs),
    tone,
    source,
    stateRevision,
    sceneId,
    priority: EVENT_PRIORITY[kind] || 0,
  });
}

function snapshotMetadata(snapshot) {
  return {
    source: "demo_state",
    stateRevision: snapshot.state_revision,
    sceneId: snapshot.state.scene_id,
  };
}

function projectSnapshot(snapshot) {
  const state = snapshot.state;
  return Object.freeze({
    sceneId: state.scene_id,
    captureStatus: state.capture.status,
    captureError: state.capture.error,
    runtimeStatus: state.runtime.status,
    runtimeDetail: state.runtime.detail,
    carePhase: state.care.phase,
    careDecisionId: state.care.decision_id,
    careConsent: state.care.consent,
    careMessage: state.care.message,
    mediaGrantId: state.media_grant?.grant_id || null,
    mediaGrantScope: state.media_grant?.scope || null,
  });
}

function baselineDetail(current) {
  return [
    SCENE_LABELS[current.sceneId] || "场景待确认",
    CAPTURE_LABELS[current.captureStatus] || "采集状态待确认",
    RUNTIME_LABELS[current.runtimeStatus] || "本地能力待确认",
    CARE_LABELS[current.carePhase] || "关怀状态待确认",
  ].join(" · ");
}

function initialEvent(snapshot, current) {
  const emergency = current.carePhase === "emergency";
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:sync`,
    kind: "sync",
    label: "开始同步",
    title: emergency ? "已同步一项需要关注的安全事件" : "已同步家中端当前状态",
    detail: current.careMessage || baselineDetail(current),
    timestampMs: snapshot.timestamp_ms,
    tone: emergency ? "danger" : "neutral",
    ...snapshotMetadata(snapshot),
  });
}

function careEvent(snapshot, previous, current) {
  const phaseChanged = current.carePhase !== previous.carePhase;
  const activeDecisionChanged = current.carePhase !== "idle"
    && current.careDecisionId !== previous.careDecisionId;
  const activeMessageChanged = current.carePhase !== "idle"
    && current.careMessage !== previous.careMessage;
  if (!phaseChanged && !activeDecisionChanged && !activeMessageChanged) return null;

  const copy = {
    idle: {
      title: "关怀流程已回到日常状态",
      detail: "家中端已结束上一项关怀流程。",
      tone: "success",
    },
    checking: {
      title: "家中端正在确认情况",
      detail: "等待本人回应或家中端给出下一步状态。",
      tone: "warning",
    },
    emergency: {
      title: "收到需要关注的安全事件",
      detail: "请按家中端发布的最新权威状态及时关注。",
      tone: "danger",
    },
    resolved: {
      title: "本次关怀事件已处理",
      detail: "家中端已将本次关怀流程标记为处理完成。",
      tone: "success",
    },
  }[current.carePhase];
  if (!copy) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:care`,
    kind: "care",
    label: "关怀",
    title: copy.title,
    detail: current.careMessage || copy.detail,
    timestampMs: snapshot.timestamp_ms,
    tone: copy.tone,
    ...snapshotMetadata(snapshot),
  });
}

function consentEvent(snapshot, previous, current) {
  if (current.careConsent === previous.careConsent) return null;
  const copy = {
    none: {
      title: "本次分享授权已结束",
      detail: "家属端不再显示本次事件的授权原画。",
      tone: "neutral",
    },
    pending: {
      title: "家中端正在征求分享授权",
      detail: "本人回应前，原画保持关闭。",
      tone: "warning",
    },
    granted: {
      title: "本人已同意本次限时分享",
      detail: "授权只适用于当前事件，并会按时自动结束。",
      tone: "success",
    },
    denied: {
      title: "本人未同意本次分享",
      detail: "原画保持关闭。",
      tone: "privacy",
    },
  }[current.careConsent];
  if (!copy) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:consent`,
    kind: "consent",
    label: "授权",
    title: copy.title,
    detail: copy.detail,
    timestampMs: snapshot.timestamp_ms,
    tone: copy.tone,
    ...snapshotMetadata(snapshot),
  });
}

function mediaEvent(snapshot, previous, current) {
  if (current.mediaGrantId === previous.mediaGrantId) return null;
  if (!current.mediaGrantId) {
    return timelineEvent({
      id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:media`,
      kind: "media",
      label: "隐私",
      title: "事件期原画已关闭",
      detail: "家属端恢复为匿名骨架与必要状态。",
      timestampMs: snapshot.timestamp_ms,
      tone: "privacy",
      ...snapshotMetadata(snapshot),
    });
  }
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:media`,
    kind: "media",
    label: "隐私",
    title: "事件期原画已限时开放",
    detail: current.mediaGrantScope === "fall_emergency"
      ? "安全事件授权窗口已开启，并会按时自动关闭。"
      : "生活片段授权窗口已开启，并会按时自动关闭。",
    timestampMs: snapshot.timestamp_ms,
    tone: "warning",
    ...snapshotMetadata(snapshot),
  });
}

function sceneEvent(snapshot, previous, current) {
  if (current.sceneId === previous.sceneId) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:scene`,
    kind: "scene",
    label: "场景",
    title: `家中端场景更新为${SCENE_LABELS[current.sceneId] || "待确认状态"}`,
    detail: "这是家中端发布的演示场景，不等同于对人员位置的判断。",
    timestampMs: snapshot.timestamp_ms,
    ...snapshotMetadata(snapshot),
  });
}

function captureEvent(snapshot, previous, current) {
  if (
    current.captureStatus === previous.captureStatus
    && current.captureError === previous.captureError
  ) return null;
  const copy = {
    idle: ["家中端采集已停止", "现场输入当前未在采集。", "neutral"],
    awaiting_local_confirmation: ["等待家中端确认采集", "首次授权或敏感来源必须在家中端本机确认。", "warning"],
    starting: ["家中端正在启动采集", "现场输入尚未就绪。", "warning"],
    active: ["家中端采集已开始", "现场输入已由家中端标记为运行中。", "success"],
    stopping: ["家中端正在停止采集", "停止完成前保持能力状态可见。", "warning"],
    error: ["家中端采集出现异常", "现场输入暂不可用。", "danger"],
  }[current.captureStatus];
  if (!copy) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:capture`,
    kind: "capture",
    label: "采集",
    title: copy[0],
    detail: current.captureError || copy[1],
    timestampMs: snapshot.timestamp_ms,
    tone: copy[2],
    ...snapshotMetadata(snapshot),
  });
}

function runtimeEvent(snapshot, previous, current) {
  if (
    current.runtimeStatus === previous.runtimeStatus
    && current.runtimeDetail === previous.runtimeDetail
  ) return null;
  const copy = {
    offline: ["本地运行时已离线", "家中端当前不能发布可靠的处理结果。", "danger"],
    connecting: ["正在连接本地运行时", "本地能力尚未就绪。", "warning"],
    ready: ["本地运行时已就绪", "家中端恢复发布本地处理状态。", "success"],
    degraded: ["本地运行时进入降级状态", "部分本地能力暂不可用。", "warning"],
    error: ["本地运行时出现异常", "不会用模拟结果替代现场处理事实。", "danger"],
  }[current.runtimeStatus];
  if (!copy) return null;
  return timelineEvent({
    id: `state:${snapshot.room_session_id}:${snapshot.state_revision}:runtime`,
    kind: "runtime",
    label: "能力",
    title: copy[0],
    detail: current.runtimeDetail || copy[1],
    timestampMs: snapshot.timestamp_ms,
    tone: copy[2],
    ...snapshotMetadata(snapshot),
  });
}

function transitionEvents(snapshot, previous, current) {
  return [
    careEvent(snapshot, previous, current),
    mediaEvent(snapshot, previous, current),
    consentEvent(snapshot, previous, current),
    sceneEvent(snapshot, previous, current),
    captureEvent(snapshot, previous, current),
    runtimeEvent(snapshot, previous, current),
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
      label: "家属操作",
      title: "家属端已确认收到告警",
      detail: "家中端已应用本次处理确认。",
      timestampMs: ack.timestamp_ms,
      tone: "success",
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
    newEvents.push(...(
      next.lastSnapshot
        ? transitionEvents(snapshot, next.lastSnapshot, current)
        : [initialEvent(snapshot, current)]
    ));
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
