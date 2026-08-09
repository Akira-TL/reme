const MAX_TIMELINE_EVENTS = 80;

const SCENE_COPY = Object.freeze({
  living: "客厅",
  kitchen: "厨房",
  bathroom: "浴室",
  fall: "深夜客厅",
});

const CAPTURE_COPY = Object.freeze({
  idle: "采集未开始",
  awaiting_local_confirmation: "等待 Monitor 本机确认",
  starting: "正在启动采集",
  active: "本地采集运行中",
  stopping: "正在停止采集",
  error: "采集异常",
});

const RUNTIME_COPY = Object.freeze({
  offline: "本地运行时离线",
  connecting: "正在连接本地运行时",
  ready: "本地运行时已就绪",
  degraded: "本地运行时降级",
  error: "本地运行时异常",
});

const WEEKDAY_COPY = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);

function eventDetails(snapshot) {
  return [
    { label: "数据来源", value: "Relay 权威快照" },
    { label: "状态版本", value: `revision ${snapshot.state_revision}` },
    { label: "监测场景", value: SCENE_COPY[snapshot.state.scene_id] || snapshot.state.scene_id },
  ];
}

function timelineEvent(snapshot, kind, copy) {
  return {
    id: [
      snapshot.room_session_id,
      snapshot.runtime_session_id,
      snapshot.state_revision,
      kind,
    ].join(":"),
    occurredAtMs: snapshot.timestamp_ms,
    dateKey: dateKeyFromTimestamp(snapshot.timestamp_ms),
    kind,
    ...copy,
    details: eventDetails(snapshot),
  };
}

function initialEvent(snapshot, restarted = false) {
  const { care, capture, runtime, scene_id: sceneId } = snapshot.state;
  if (care.phase === "emergency" && care.alarm_authoritative) {
    return timelineEvent(snapshot, "care", {
      category: "安全",
      tone: "danger",
      title: "已收到需要关注的安全事件",
      summary: care.message || "权威安全规则已经升级，请家属尽快关注。",
    });
  }
  if (care.phase === "checking") {
    return timelineEvent(snapshot, "care", {
      category: "关怀",
      tone: "warning",
      title: "系统正在先询问本人",
      summary: care.message || "正在等待本人回应，暂不把不确定状态描述为事实。",
    });
  }
  if (sceneId === "bathroom") {
    return timelineEvent(snapshot, "privacy", {
      category: "隐私",
      tone: "privacy",
      title: "浴室隐私保护已开启",
      summary: "当前只同步必要结构化状态，任何 Viewer 命令都不能开放原画。",
    });
  }
  const ready = runtime.status === "ready" && capture.status === "active";
  return timelineEvent(snapshot, "session", {
    category: restarted ? "会话" : "状态",
    tone: ready ? "normal" : "neutral",
    title: restarted ? "新的本地运行时会话已接入" : "本次家庭状态已接入",
    summary: `${SCENE_COPY[sceneId] || sceneId} · ${RUNTIME_COPY[runtime.status] || runtime.status} · ${CAPTURE_COPY[capture.status] || capture.status}`,
  });
}

function careEvent(previous, snapshot) {
  const before = previous.state.care;
  const care = snapshot.state.care;
  const changed = before.phase !== care.phase
    || before.consent !== care.consent
    || before.alarm_authoritative !== care.alarm_authoritative
    || (care.phase !== "idle" && before.decision_id !== care.decision_id);
  if (!changed) return null;

  if (care.phase === "emergency" && care.alarm_authoritative) {
    return timelineEvent(snapshot, "care", {
      category: "安全",
      tone: "danger",
      title: "安全事件已升级",
      summary: care.message || "确定性安全规则已升级，等待家属确认。",
    });
  }
  if (care.phase === "checking") {
    return timelineEvent(snapshot, "care", {
      category: "关怀",
      tone: "warning",
      title: "系统正在先询问本人",
      summary: care.message || "正在等待本人回应，家属端保持关注。",
    });
  }
  if (before.consent !== care.consent && care.consent === "granted") {
    return timelineEvent(snapshot, "care", {
      category: "授权",
      tone: "privacy",
      title: "本人已同意本次事件分享",
      summary: "授权只属于当前事件；过期、换场景或断线后自动关闭。",
    });
  }
  if (before.consent !== care.consent && care.consent === "denied") {
    return timelineEvent(snapshot, "care", {
      category: "授权",
      tone: "neutral",
      title: "本人未同意本次事件分享",
      summary: "家属端继续保持匿名骨架与结构化状态。",
    });
  }
  if (care.phase === "resolved") {
    return timelineEvent(snapshot, "care", {
      category: "关怀",
      tone: "normal",
      title: "本次关怀已经结束",
      summary: care.message || "处理结果已回写到当前权威状态。",
    });
  }
  return timelineEvent(snapshot, "care", {
    category: "关怀",
    tone: "normal",
    title: "关怀状态已回到日常观察",
    summary: care.message || "当前没有需要家属处理的关怀动作。",
  });
}

function mediaGrantEvent(previous, snapshot) {
  const before = previous.state.media_grant;
  const grant = snapshot.state.media_grant;
  if ((before?.grant_id || null) === (grant?.grant_id || null)
    && (before?.status || null) === (grant?.status || null)) return null;
  if (grant?.status === "active") {
    return timelineEvent(snapshot, "privacy", {
      category: "授权",
      tone: "privacy",
      title: "事件期原画授权已开启",
      summary: "原画只在当前授权窗口内传输，Relay 不存储媒体正文。",
    });
  }
  if (!before) return null;
  return timelineEvent(snapshot, "privacy", {
    category: "授权",
    tone: "normal",
    title: "事件期原画授权已关闭",
    summary: "家属端已恢复为匿名骨架与结构化状态。",
  });
}

function sceneEvent(previous, snapshot) {
  if (previous.state.scene_id === snapshot.state.scene_id) return null;
  const scene = SCENE_COPY[snapshot.state.scene_id] || snapshot.state.scene_id;
  return timelineEvent(snapshot, "scene", {
    category: "环境",
    tone: snapshot.state.scene_id === "bathroom" ? "privacy" : "neutral",
    title: `监测场景已切换为${scene}`,
    summary: snapshot.state.scene_id === "bathroom"
      ? "浴室硬隐私门同步开启，原画保持关闭。"
      : "这是演示控制选择的监测场景，不代表系统具备跨房间追踪能力。",
  });
}

function captureEvent(previous, snapshot) {
  const before = previous.state.capture;
  const capture = snapshot.state.capture;
  if (before.status === capture.status
    && before.source_id === capture.source_id
    && before.remote_video === capture.remote_video) return null;
  const active = capture.status === "active";
  return timelineEvent(snapshot, "device", {
    category: "设备",
    tone: active ? "normal" : capture.status === "error" ? "warning" : "neutral",
    title: active ? "家庭设备开始本地采集" : CAPTURE_COPY[capture.status] || "家庭设备状态已变化",
    summary: capture.error
      || `${capture.source_kind || "未选择媒体源"} · 原画远程能力 ${capture.remote_video}`,
  });
}

function runtimeEvent(previous, snapshot) {
  const before = previous.state.runtime;
  const runtime = snapshot.state.runtime;
  if (before.status === runtime.status
    && before.capability === runtime.capability
    && before.detail === runtime.detail) return null;
  return timelineEvent(snapshot, "runtime", {
    category: "能力",
    tone: runtime.status === "ready" ? "normal" : ["error", "degraded"].includes(runtime.status) ? "warning" : "neutral",
    title: RUNTIME_COPY[runtime.status] || "本地运行时状态已变化",
    summary: runtime.detail || `当前能力：${runtime.capability}`,
  });
}

export function projectTimelineEvents(previous, snapshot) {
  if (!snapshot?.state || !Number.isFinite(snapshot.timestamp_ms)) return [];
  if (!previous) return [initialEvent(snapshot)];
  if (previous.runtime_session_id !== snapshot.runtime_session_id) {
    return [initialEvent(snapshot, true)];
  }
  return [
    careEvent(previous, snapshot),
    mediaGrantEvent(previous, snapshot),
    sceneEvent(previous, snapshot),
    captureEvent(previous, snapshot),
    runtimeEvent(previous, snapshot),
  ].filter(Boolean);
}

export function createTimelineState(roomSessionId = null) {
  return {
    roomSessionId,
    lastSnapshot: null,
    events: [],
  };
}

export function ingestTimelineSnapshot(current, roomSessionId, snapshot) {
  let state = current;
  if (state.roomSessionId !== roomSessionId) state = createTimelineState(roomSessionId);
  if (!roomSessionId || !snapshot || snapshot.room_session_id !== roomSessionId) return state;
  if (state.lastSnapshot
    && state.lastSnapshot.runtime_session_id === snapshot.runtime_session_id
    && snapshot.state_revision < state.lastSnapshot.state_revision) return state;

  const projected = projectTimelineEvents(state.lastSnapshot, snapshot);
  const knownIds = new Set(state.events.map((event) => event.id));
  const additions = projected.filter((event) => !knownIds.has(event.id));
  return {
    roomSessionId,
    lastSnapshot: snapshot,
    events: [...additions, ...state.events].slice(0, MAX_TIMELINE_EVENTS),
  };
}

function pad(value) {
  return String(value).padStart(2, "0");
}

export function dateKeyFromTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "";
  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function dateFromKey(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? date
    : null;
}

export function shiftDateKey(key, days) {
  const date = dateFromKey(key);
  if (!date || !Number.isInteger(days)) return key;
  date.setDate(date.getDate() + days);
  return dateKeyFromTimestamp(date.getTime());
}

export function buildWeekDays(selectedDateKey, nowMs = Date.now()) {
  const selected = dateFromKey(selectedDateKey) || new Date(nowMs);
  selected.setHours(12, 0, 0, 0);
  const todayKey = dateKeyFromTimestamp(nowMs);
  const mondayOffset = (selected.getDay() + 6) % 7;
  const monday = new Date(selected);
  monday.setDate(selected.getDate() - mondayOffset);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const key = dateKeyFromTimestamp(date.getTime());
    return {
      key,
      weekday: WEEKDAY_COPY[date.getDay()],
      day: date.getDate(),
      selected: key === selectedDateKey,
      today: key === todayKey,
      disabled: key > todayKey,
    };
  });
}

export function filterTimelineEventsByDate(events, dateKey) {
  return events.filter((event) => event.dateKey === dateKey);
}

export function timelineDateHeading(dateKey, nowMs = Date.now()) {
  const date = dateFromKey(dateKey);
  if (!date) return "选择日期";
  const prefix = dateKey === dateKeyFromTimestamp(nowMs) ? "今天" : `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${prefix} · 星期${WEEKDAY_COPY[date.getDay()]}`;
}
