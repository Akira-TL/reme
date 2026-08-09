export const FAMILY_TIMELINE_MOCK_START_DATE = "2026-08-04";
export const FAMILY_TIMELINE_MOCK_END_DATE = "2026-08-11";

const WEEKDAY_COPY = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);

export const FAMILY_TIMELINE_MOCK_DAYPARTS = Object.freeze([
  Object.freeze({ id: "early", label: "清晨", range: "06:00–09:59", icon: "sun" }),
  Object.freeze({ id: "morning", label: "上午", range: "10:00–11:59", icon: "sun" }),
  Object.freeze({ id: "afternoon", label: "午后", range: "12:00–17:59", icon: "sunset" }),
]);

const ACTIVITY_OFFSETS = Object.freeze([2, 4, 1, 3, 5, 0, 2, 4]);

const ACTIVITY_TEMPLATES = Object.freeze({
  early: Object.freeze([
    Object.freeze({ hour: 7, minute: 12, icon: "bed", title: "从床边起身" }),
    Object.freeze({ hour: 7, minute: 18, icon: "walk", title: "卧室内短距离走动" }),
    Object.freeze({
      hour: 7,
      minute: 36,
      icon: "kitchen",
      title: "厨房持续站立与手部活动",
      related: Object.freeze([
        Object.freeze({ hour: 7, minute: 52, title: "厨房短暂停留" }),
      ]),
    }),
    Object.freeze({ hour: 8, minute: 10, icon: "seat", title: "客厅坐下" }),
    Object.freeze({ hour: 9, minute: 22, icon: "window", title: "起身去窗边" }),
    Object.freeze({ hour: 9, minute: 41, icon: "walk", title: "客厅少量走动" }),
  ]),
  morning: Object.freeze([
    Object.freeze({ hour: 10, minute: 0, icon: "kitchen", title: "厨房短时活动" }),
    Object.freeze({
      hour: 10,
      minute: 16,
      icon: "seat",
      title: "客厅坐姿活动",
      related: Object.freeze([
        Object.freeze({ hour: 10, minute: 42, title: "客厅短时起身" }),
        Object.freeze({ hour: 11, minute: 5, title: "室内少量走动" }),
      ]),
    }),
    Object.freeze({ hour: 11, minute: 40, icon: "kitchen", title: "厨房出现短时活动" }),
  ]),
  afternoon: Object.freeze([
    Object.freeze({ hour: 12, minute: 18, icon: "seat", title: "客厅坐姿活动" }),
    Object.freeze({ hour: 14, minute: 6, icon: "walk", title: "室内短距离走动" }),
    Object.freeze({ hour: 16, minute: 20, icon: "window", title: "窗边短暂停留" }),
    Object.freeze({ hour: 17, minute: 34, icon: "kitchen", title: "厨房持续站立与手部活动" }),
  ]),
});

function dateKeyForDay(day) {
  return `2026-08-${String(day).padStart(2, "0")}`;
}

function timestamp(day, hour, minute) {
  return new Date(2026, 7, day, hour, minute, 0, 0).getTime();
}

function mockResponse({ day, hour, minute, title }) {
  const dateKey = dateKeyForDay(day);
  return Object.freeze({
    id: `mock-response:${dateKey}:${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
    kind: "response",
    label: "本人回应",
    title,
    timestampMs: timestamp(day, hour, minute),
    dateKey,
    source: "mock_fixture",
  });
}

function mockAssessment({
  day,
  daypartId,
  hour,
  minute,
  title,
  basis,
  suggestedAction,
  progress,
  response = null,
  statusLabel = response ? "已确认" : "安静观察",
  tone = "neutral",
  uncertainty = "medium",
  sceneId = "living",
}) {
  const dateKey = dateKeyForDay(day);
  return Object.freeze({
    id: `mock:${dateKey}:${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
    kind: "assessment",
    label: "Mock 主动关怀判词",
    title,
    detail: basis,
    timestampMs: timestamp(day, hour, minute),
    dateKey,
    daypartId,
    count: 1,
    tone,
    statusLabel,
    suggestedAction,
    progress,
    linkedResponse: response ? mockResponse({ day, ...response }) : null,
    assessmentSource: "mock",
    uncertainty,
    visualContext: null,
    source: "mock_fixture",
    stateRevision: null,
    sceneId,
    sceneLabel: sceneId === "kitchen" ? "厨房时光" : "客厅日常",
    captureStatus: null,
    captureLabel: null,
    runtimeStatus: null,
    runtimeLabel: null,
    priority: 90,
    batchOrder: 0,
  });
}

export const FAMILY_TIMELINE_MOCK_EVENTS = Object.freeze([
  mockAssessment({
    day: 4,
    daypartId: "morning",
    hour: 10,
    minute: 26,
    title: "坐姿持续了一段时间，已经轻声问候",
    basis: "Mock 姿态窗口显示连续坐姿约 48 分钟；这里只描述姿态变化，原因仍不确定。",
    suggestedAction: "等待本人回应，暂不把原因定性",
    progress: "本人已回应",
    response: { hour: 10, minute: 29, title: "本人回应：在听广播" },
  }),
  mockAssessment({
    day: 4,
    daypartId: "afternoon",
    hour: 15,
    minute: 42,
    title: "午后起身次数比 Mock 基线少",
    basis: "同一 Mock 时段的短距离走动次数较少，但无法据此判断具体原因。",
    suggestedAction: "继续安静观察",
    progress: "没有待处理事项",
    uncertainty: "high",
  }),
  mockAssessment({
    day: 5,
    daypartId: "morning",
    hour: 10,
    minute: 58,
    title: "静坐时间比近期 Mock 习惯更长，已经问候",
    basis: "连续坐姿超过该 Mock 日期同一时段的个人基线；不对身体状态作推断。",
    suggestedAction: "等待本人回应",
    progress: "本人已回应",
    response: { hour: 11, minute: 1, title: "本人回应：正在看电视" },
    tone: "warning",
  }),
  mockAssessment({
    day: 5,
    daypartId: "afternoon",
    hour: 15,
    minute: 5,
    title: "午后活动间隔拉长，已经轻声确认",
    basis: "Mock 行为窗口出现较长的静止间隔，尚不能确认当时在做什么。",
    suggestedAction: "以本人回应为准",
    progress: "本人已回应",
    response: { hour: 15, minute: 9, title: "本人回应：正在休息一下" },
    uncertainty: "high",
  }),
  mockAssessment({
    day: 6,
    daypartId: "morning",
    hour: 10,
    minute: 20,
    title: "上午坐姿片段较集中，先保持安静观察",
    basis: "Mock 窗口里的坐姿比例略高于同一时段基线，仍在正常波动范围内。",
    suggestedAction: "暂不打扰，继续观察",
    progress: "没有待处理事项",
    uncertainty: "low",
  }),
  mockAssessment({
    day: 6,
    daypartId: "afternoon",
    hour: 17,
    minute: 20,
    title: "厨房站立时间较长，已经轻声问候",
    basis: "Mock 厨房场景中出现连续站立和手部活动；仅能判断为厨房活动。",
    suggestedAction: "等待本人说明，不推断具体活动",
    progress: "本人已回应",
    response: { hour: 17, minute: 24, title: "本人回应：一切都好" },
    sceneId: "kitchen",
    uncertainty: "high",
  }),
  mockAssessment({
    day: 7,
    daypartId: "morning",
    hour: 10,
    minute: 35,
    title: "起身后的停留时间较长，已经轻声问候",
    basis: "Mock 姿态序列显示一次较长坐姿，未出现确定性安全规则信号。",
    suggestedAction: "等待本人回应",
    progress: "本人已回应",
    response: { hour: 10, minute: 39, title: "本人回应：在听节目" },
  }),
  mockAssessment({
    day: 7,
    daypartId: "afternoon",
    hour: 15,
    minute: 10,
    title: "下午活动量低于近期 Mock 基线",
    basis: "同一时段的起身次数减少，但原因尚不能确认。",
    suggestedAction: "稍后再做一次轻量确认",
    progress: "等待合适时机",
    statusLabel: "值得留意",
    tone: "warning",
    uncertainty: "high",
  }),
  mockAssessment({
    day: 8,
    daypartId: "morning",
    hour: 10,
    minute: 5,
    title: "连续坐着有些久，已经轻声问候",
    basis: "Mock 姿态窗口记录到约 45 分钟连续坐姿，触发非紧急关怀。",
    suggestedAction: "等待本人回应",
    progress: "本人已回应",
    response: { hour: 10, minute: 12, title: "本人回应：正在听广播" },
    tone: "warning",
  }),
  mockAssessment({
    day: 8,
    daypartId: "afternoon",
    hour: 15,
    minute: 12,
    title: "窗边停留时间比平时稍长，已经确认",
    basis: "Mock 只能确认在窗边持续站立，不能判断停留原因。",
    suggestedAction: "以本人回应为准",
    progress: "本人已回应",
    response: { hour: 15, minute: 16, title: "本人回应：在看看窗外" },
    uncertainty: "high",
  }),
  mockAssessment({
    day: 9,
    daypartId: "morning",
    hour: 10,
    minute: 6,
    title: "坐得有些久，已经轻声问候",
    basis: "连续坐姿约 56 分钟",
    suggestedAction: "等待本人回应，暂不把原因定性",
    progress: "本人已回应",
    response: { hour: 10, minute: 8, title: "本人回应：在听广播" },
    tone: "warning",
  }),
  mockAssessment({
    day: 9,
    daypartId: "afternoon",
    hour: 15,
    minute: 32,
    title: "午后坐姿持续时间比 Mock 基线稍长",
    basis: "同一 Mock 时段出现较长连续坐姿；当前没有足够信息解释原因。",
    suggestedAction: "先保持安静观察",
    progress: "没有待处理事项",
    uncertainty: "high",
  }),
  mockAssessment({
    day: 10,
    daypartId: "morning",
    hour: 10,
    minute: 30,
    title: "上午活动切换稍少，暂不主动打扰",
    basis: "Mock 行为窗口与个人近期同一时段接近，没有确定性异常信号。",
    suggestedAction: "继续保持安静守护",
    progress: "没有待处理事项",
    uncertainty: "low",
  }),
  mockAssessment({
    day: 10,
    daypartId: "afternoon",
    hour: 17,
    minute: 5,
    title: "厨房站立片段较长，已经轻声确认",
    basis: "Mock 厨房上下文中出现连续站立和弯腰；不判断具体菜品或进食结果。",
    suggestedAction: "等待本人说明",
    progress: "本人已回应",
    response: { hour: 17, minute: 9, title: "本人回应：不用担心" },
    sceneId: "kitchen",
    uncertainty: "high",
  }),
  mockAssessment({
    day: 11,
    daypartId: "morning",
    hour: 10,
    minute: 5,
    title: "起身后的静坐间隔略长，已经轻声问候",
    basis: "Mock 行为记忆显示本次坐姿间隔高于同一时段均值，原因未知。",
    suggestedAction: "等待本人回应",
    progress: "本人已回应",
    response: { hour: 10, minute: 9, title: "本人回应：在看新闻" },
  }),
  mockAssessment({
    day: 11,
    daypartId: "afternoon",
    hour: 16,
    minute: 30,
    title: "午后活动节奏放慢，继续安静观察",
    basis: "Mock 周期窗口显示短距离走动减少，但没有可靠信息说明原因。",
    suggestedAction: "维持当前关怀频率",
    progress: "没有待处理事项",
    uncertainty: "high",
  }),
]);

function mockActivity(day, dayIndex, daypartId, template, templateIndex) {
  const offset = ACTIVITY_OFFSETS[dayIndex];
  const minute = template.minute + offset;
  const dateKey = dateKeyForDay(day);
  const related = Object.freeze((template.related || []).map((item) => Object.freeze({
    title: item.title,
    timestampMs: timestamp(day, item.hour, item.minute + offset),
  })));
  return Object.freeze({
    id: `mock-activity:${dateKey}:${daypartId}:${templateIndex}`,
    kind: "activity",
    label: "Mock 生活片段",
    title: template.title,
    detail: related.length > 0
      ? `把同一段连续活动中的 ${related.length + 1} 个相邻变化收在一行。`
      : "固定 Mock 只记录房间与姿态变化，不推断当时的具体意图。",
    icon: template.icon,
    related,
    timestampMs: timestamp(day, template.hour, minute),
    dateKey,
    daypartId,
    count: 1 + related.length,
    tone: "neutral",
    source: "mock_fixture",
  });
}

function buildMockDay(day, dayIndex) {
  const dateKey = dateKeyForDay(day);
  const careEvents = FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => event.dateKey === dateKey);
  const sections = FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => {
    const activities = ACTIVITY_TEMPLATES[daypart.id].map((template, templateIndex) => (
      mockActivity(day, dayIndex, daypart.id, template, templateIndex)
    ));
    const entries = [...activities, ...careEvents.filter((event) => event.daypartId === daypart.id)]
      .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
    return Object.freeze({
      ...daypart,
      count: entries.reduce((total, entry) => total + entry.count, 0),
      careCount: entries.filter((entry) => entry.kind === "assessment").length,
      entries: Object.freeze(entries),
    });
  });
  const date = new Date(2026, 7, day, 12, 0, 0, 0);
  return Object.freeze({
    dateKey,
    day,
    weekday: WEEKDAY_COPY[date.getDay()],
    source: "mock_fixture",
    totalCount: sections.reduce((total, section) => total + section.count, 0),
    careCount: careEvents.length,
    sections: Object.freeze(sections),
  });
}

export const FAMILY_TIMELINE_MOCK_DAYS = Object.freeze(
  Array.from({ length: 8 }, (_, dayIndex) => buildMockDay(4 + dayIndex, dayIndex)),
);

export function getFamilyTimelineMockDay(dateKey) {
  return FAMILY_TIMELINE_MOCK_DAYS.find((day) => day.dateKey === dateKey) || null;
}

export function isFamilyTimelineMockDate(dateKey) {
  return dateKey >= FAMILY_TIMELINE_MOCK_START_DATE
    && dateKey <= FAMILY_TIMELINE_MOCK_END_DATE;
}
