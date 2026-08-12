export const FAMILY_TIMELINE_MOCK_START_DATE = "2026-08-04";
export const FAMILY_TIMELINE_MOCK_END_DATE = "2026-08-11";
export const FAMILY_TIMELINE_DISPLAY_END_DATE = "2026-08-11";
export const FAMILY_TIMELINE_REALTIME_CUTOFF = "2026-08-12T00:00:00+08:00";
export const FAMILY_TIMELINE_REALTIME_CUTOFF_MS = Date.parse(FAMILY_TIMELINE_REALTIME_CUTOFF);

const MOCK_CUTOFF_DAY = 12;
const MOCK_CUTOFF_HOUR = 0;

const WEEKDAY_COPY = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);

export const FAMILY_TIMELINE_MOCK_DAYPARTS = Object.freeze([
  Object.freeze({ id: "night", label: "深夜", range: "00:00–05:59", icon: "moon" }),
  Object.freeze({ id: "early", label: "清晨", range: "06:00–09:59", icon: "sun" }),
  Object.freeze({ id: "morning", label: "上午", range: "10:00–11:59", icon: "sun" }),
  Object.freeze({ id: "afternoon", label: "午后", range: "12:00–17:59", icon: "sunset" }),
  Object.freeze({ id: "evening", label: "夜晚", range: "18:00–23:59", icon: "moon" }),
]);

function relatedAt(hour, minute, title) {
  return Object.freeze({ hour, minute, title });
}

function activityAt(hour, minute, icon, title, { related = [], detail = null } = {}) {
  return Object.freeze({
    hour,
    minute,
    icon,
    title,
    kind: "activity",
    related: Object.freeze(related),
    detail,
  });
}

function deviceAt(hour, minute, icon, title, { related = [], detail = null } = {}) {
  return Object.freeze({
    hour,
    minute,
    icon,
    title,
    kind: "device",
    related: Object.freeze(related),
    detail,
  });
}

function dailySchedule(sections) {
  return Object.freeze(Object.fromEntries(
    Object.entries(sections).map(([key, entries]) => [key, Object.freeze(entries)]),
  ));
}

const DAILY_MOMENTS = Object.freeze({
  4: dailySchedule({
    night: [
      deviceAt(0, 10, "night", "就寝模式开启：卧室灯关闭，空调调至 27℃"),
      activityAt(0, 18, "bed", "卧室进入长时卧姿记录", {
        related: [relatedAt(2, 42, "卧姿位置变化"), relatedAt(5, 51, "床边出现起身动作")],
        detail: "Mock 姿态只确认卧姿与起身变化，不据此断言已经入睡。",
      }),
    ],
    early: [
      deviceAt(5, 54, "light", "卧室灯光按起床场景渐亮"),
      activityAt(6, 2, "walk", "从卧室走向洗漱区"),
      deviceAt(6, 10, "shower", "热水器切换为洗漱用水模式"),
      deviceAt(6, 46, "speaker", "客厅音响播放早间新闻"),
      activityAt(7, 15, "kitchen", "厨房出现早餐准备活动", {
        related: [relatedAt(7, 32, "餐桌前坐下")],
      }),
    ],
    morning: [
      deviceAt(9, 48, "aircon", "客厅空调关闭"),
      activityAt(10, 12, "seat", "客厅坐姿与短时起身", {
        related: [relatedAt(10, 44, "走到窗边查看")],
      }),
      deviceAt(10, 55, "fridge", "冰箱门打开：取出酸奶"),
      activityAt(11, 26, "kitchen", "厨房加热午餐", {
        related: [relatedAt(11, 43, "餐桌前落座")],
      }),
    ],
    afternoon: [
      activityAt(12, 20, "seat", "餐后在客厅坐下"),
      deviceAt(13, 10, "light", "客厅灯光关闭"),
      activityAt(14, 5, "bed", "卧室平躺休息", {
        related: [relatedAt(14, 48, "从床边起身")],
      }),
      deviceAt(16, 20, "door", "门锁上锁：离家模式启动"),
      deviceAt(17, 18, "door", "入户门开锁：回家模式启动"),
      deviceAt(17, 22, "fridge", "冰箱门打开：放入一袋生菜和番茄"),
    ],
    evening: [
      deviceAt(18, 10, "light", "厨房与餐厅灯光开启"),
      activityAt(18, 30, "kitchen", "灶台前持续站立与手部活动", {
        related: [relatedAt(19, 2, "餐桌前坐下")],
      }),
      deviceAt(19, 5, "speaker", "客厅音响播放戏曲"),
      deviceAt(20, 14, "shower", "沐浴场景启动：浴室隐私模式开启"),
      activityAt(20, 42, "walk", "浴室门打开后回到卧室"),
      deviceAt(22, 36, "night", "就寝场景启动：全屋灯光关闭"),
    ],
  }),
  5: dailySchedule({
    night: [
      deviceAt(0, 2, "night", "就寝模式保持运行"),
      activityAt(1, 36, "walk", "卧室到洗漱区短距离走动", {
        related: [relatedAt(1, 44, "回到床边"), relatedAt(5, 58, "卧室起身")],
      }),
    ],
    early: [
      deviceAt(6, 1, "light", "卧室和走廊夜灯关闭"),
      activityAt(6, 18, "window", "窗边短暂停留"),
      deviceAt(6, 26, "aircon", "客厅空调开启至 26℃"),
      deviceAt(6, 39, "fridge", "冰箱门打开：取出牛奶和鸡蛋"),
      activityAt(6, 48, "kitchen", "厨房早餐流程", {
        related: [relatedAt(7, 10, "餐桌前坐下"), relatedAt(7, 38, "收拾餐桌")],
      }),
    ],
    morning: [
      deviceAt(9, 12, "door", "门锁上锁：外出散步"),
      deviceAt(10, 4, "door", "入户门开锁：已回家"),
      activityAt(10, 18, "seat", "客厅坐下休息"),
      deviceAt(11, 16, "speaker", "音响播放天气与午间节目"),
    ],
    afternoon: [
      activityAt(12, 8, "kitchen", "厨房午餐收尾活动"),
      deviceAt(13, 22, "aircon", "卧室空调进入午休模式"),
      activityAt(13, 31, "bed", "卧室平躺片段", {
        related: [relatedAt(14, 22, "从床边起身")],
      }),
      activityAt(15, 34, "window", "阳台附近站立与手部活动"),
      deviceAt(17, 6, "light", "客厅灯光根据环境亮度开启"),
    ],
    evening: [
      deviceAt(18, 2, "fridge", "冰箱门打开：取出豆腐和青菜"),
      deviceAt(18, 11, "kitchen", "“做饭”场景启动：烟机与灶具联动"),
      activityAt(18, 18, "kitchen", "灶台前站立与手部活动", {
        related: [relatedAt(18, 56, "餐桌前坐下")],
      }),
      deviceAt(20, 8, "shower", "沐浴场景启动：仅保留门磁与热水器事件"),
      deviceAt(21, 3, "speaker", "卧室音响播放轻音乐"),
      deviceAt(22, 48, "night", "就寝模式开启"),
    ],
  }),
  6: dailySchedule({
    night: [
      deviceAt(0, 20, "night", "就寝模式：空调静音运行"),
      activityAt(0, 28, "bed", "卧室长时卧姿", {
        related: [relatedAt(3, 18, "卧姿位置变化"), relatedAt(5, 46, "床边坐起")],
      }),
    ],
    early: [
      deviceAt(5, 50, "light", "卧室窗帘开启 40%"),
      activityAt(6, 4, "walk", "卧室内短距离走动"),
      deviceAt(6, 15, "shower", "热水器启动洗漱模式"),
      deviceAt(6, 42, "speaker", "厨房音响播放广播"),
      activityAt(7, 2, "kitchen", "厨房准备早餐", {
        related: [relatedAt(7, 28, "餐桌前坐下")],
      }),
    ],
    morning: [
      deviceAt(9, 30, "laundry", "洗衣机完成轻柔洗程序"),
      activityAt(9, 38, "walk", "阳台与客厅之间往返"),
      deviceAt(10, 52, "fridge", "冰箱门打开：取出排骨与玉米"),
      deviceAt(11, 0, "kitchen", "炖汤场景启动：烟机低档运行"),
      activityAt(11, 8, "kitchen", "厨房持续站立与手部活动"),
    ],
    afternoon: [
      activityAt(12, 36, "seat", "餐桌前坐姿片段"),
      deviceAt(13, 18, "aircon", "客厅空调调至 25℃"),
      activityAt(14, 11, "bed", "卧室平躺休息", {
        related: [relatedAt(15, 2, "卧室起身")],
      }),
      deviceAt(16, 12, "speaker", "音响播放评书"),
      activityAt(17, 18, "kitchen", "厨房查看炖煮进度"),
    ],
    evening: [
      deviceAt(18, 6, "kitchen", "厨房计时器结束并关闭灶具"),
      activityAt(18, 24, "seat", "餐桌前坐下"),
      deviceAt(19, 30, "light", "客厅灯光切换为阅读模式"),
      activityAt(19, 38, "seat", "客厅阅读姿态"),
      deviceAt(21, 22, "shower", "沐浴场景启动：浴室隐私模式开启"),
      deviceAt(23, 2, "night", "全屋就寝模式开启"),
    ],
  }),
  7: dailySchedule({
    night: [
      deviceAt(0, 8, "night", "就寝模式运行：卧室灯关闭"),
      activityAt(0, 16, "bed", "卧室卧姿记录", {
        related: [relatedAt(4, 50, "床边坐起"), relatedAt(5, 6, "回到卧姿")],
      }),
    ],
    early: [
      activityAt(6, 26, "bed", "从床边起身"),
      deviceAt(6, 34, "light", "卧室灯光开启"),
      deviceAt(6, 48, "fridge", "冰箱门打开：取出馒头与牛奶"),
      activityAt(7, 1, "kitchen", "厨房早餐加热"),
      deviceAt(8, 12, "door", "门锁上锁：外出晨练"),
    ],
    morning: [
      deviceAt(9, 36, "door", "入户门开锁：晨练后回家"),
      deviceAt(9, 40, "aircon", "回家模式：客厅空调开启"),
      activityAt(9, 48, "seat", "客厅坐下"),
      deviceAt(10, 18, "speaker", "音响播放地方戏"),
      activityAt(11, 22, "kitchen", "厨房午餐准备"),
    ],
    afternoon: [
      activityAt(12, 24, "seat", "餐桌前坐姿"),
      deviceAt(13, 6, "light", "客厅主灯关闭"),
      activityAt(13, 20, "bed", "卧室午休姿态", {
        related: [relatedAt(14, 36, "从床边起身")],
      }),
      deviceAt(15, 8, "door", "门铃触发：亲友到访"),
      activityAt(15, 16, "seat", "客厅出现两处坐姿区域"),
    ],
    evening: [
      deviceAt(18, 20, "door", "门锁闭合：访客离开"),
      deviceAt(18, 38, "fridge", "冰箱门打开：放入水果"),
      activityAt(19, 10, "walk", "客厅与阳台间走动"),
      deviceAt(20, 6, "shower", "沐浴场景启动：视频采集保持关闭"),
      deviceAt(21, 16, "speaker", "卧室音响播放睡前节目"),
      deviceAt(22, 40, "night", "就寝模式开启"),
    ],
  }),
  8: dailySchedule({
    night: [
      deviceAt(0, 6, "night", "周末就寝模式延后开启"),
      activityAt(0, 14, "bed", "卧室长时卧姿", {
        related: [relatedAt(3, 42, "卧姿位置变化"), relatedAt(6, 18, "床边起身")],
      }),
    ],
    early: [
      deviceAt(6, 22, "light", "卧室窗帘与灯光联动开启"),
      activityAt(6, 40, "walk", "进入洗漱区"),
      deviceAt(6, 52, "shower", "热水器切换洗漱模式"),
      deviceAt(7, 16, "fridge", "冰箱门打开：取出面包和水果"),
      activityAt(7, 24, "kitchen", "厨房早餐准备"),
    ],
    morning: [
      deviceAt(9, 18, "cleaning", "扫地机器人完成客厅清扫"),
      activityAt(9, 46, "seat", "客厅坐姿活动"),
      deviceAt(10, 10, "speaker", "音响播放周末音乐"),
      deviceAt(11, 6, "door", "门铃触发：女儿到访"),
      activityAt(11, 12, "walk", "玄关到客厅多人移动"),
    ],
    afternoon: [
      deviceAt(12, 2, "kitchen", "多人用餐场景：餐厅灯光开启"),
      activityAt(12, 18, "seat", "餐桌区域多处坐姿"),
      deviceAt(14, 12, "aircon", "客厅空调调至 25℃"),
      activityAt(15, 8, "seat", "客厅交谈姿态"),
      deviceAt(17, 40, "door", "门锁闭合：家人离开"),
    ],
    evening: [
      deviceAt(18, 6, "fridge", "冰箱门打开：放入家人带来的水果"),
      activityAt(18, 28, "kitchen", "厨房整理与清洁"),
      deviceAt(19, 22, "speaker", "客厅音响恢复个人播放列表"),
      deviceAt(20, 18, "shower", "沐浴场景启动：浴室进入高隐私"),
      activityAt(21, 10, "seat", "卧室坐姿片段"),
      deviceAt(22, 54, "night", "就寝模式开启"),
    ],
  }),
  9: dailySchedule({
    night: [
      deviceAt(0, 4, "night", "就寝模式运行：空调 27℃、灯光关闭"),
      activityAt(0, 12, "bed", "卧室长时卧姿记录", {
        related: [relatedAt(3, 6, "卧姿位置变化"), relatedAt(5, 58, "床边坐起")],
      }),
    ],
    early: [
      deviceAt(6, 0, "light", "起床场景：卧室灯光渐亮"),
      activityAt(6, 12, "walk", "卧室到洗漱区短距离走动"),
      deviceAt(6, 20, "shower", "热水器进入洗漱模式"),
      deviceAt(6, 48, "speaker", "客厅音响播放早间广播"),
      activityAt(7, 12, "bed", "从床边起身"),
      activityAt(7, 18, "walk", "卧室内短距离走动"),
      activityAt(7, 36, "kitchen", "厨房持续站立与手部活动", {
        related: [relatedAt(7, 52, "厨房短暂停留")],
      }),
      activityAt(8, 10, "seat", "客厅坐下"),
      activityAt(9, 22, "window", "起身去窗边"),
      activityAt(9, 41, "walk", "客厅少量走动"),
    ],
    morning: [
      activityAt(10, 0, "kitchen", "厨房短时活动"),
      deviceAt(10, 42, "fridge", "冰箱门打开：取出番茄和鸡蛋"),
      deviceAt(10, 49, "fridge", "冰箱门再次打开：取出并清洗生菜"),
      deviceAt(10, 56, "kitchen", "“做饭”场景启动：烟机与灶具联动"),
      activityAt(11, 2, "kitchen", "灶台前持续站立与手部活动", {
        related: [relatedAt(11, 18, "在水槽与灶台间移动"), relatedAt(11, 31, "餐盘摆上餐桌")],
      }),
    ],
    afternoon: [
      activityAt(12, 8, "seat", "餐桌前坐姿片段"),
      deviceAt(12, 46, "cleaning", "洗碗机启动快速洗程序"),
      activityAt(13, 28, "bed", "卧室平躺休息", {
        related: [relatedAt(14, 16, "卧室起身")],
      }),
      activityAt(15, 4, "seat", "客厅坐姿活动"),
      deviceAt(16, 22, "aircon", "客厅空调调至 26℃"),
      activityAt(17, 34, "kitchen", "厨房持续站立与手部活动"),
    ],
    evening: [
      deviceAt(18, 8, "light", "餐厅灯光开启"),
      activityAt(18, 26, "seat", "餐桌前坐下"),
      deviceAt(19, 18, "speaker", "客厅音响播放戏曲"),
      deviceAt(20, 26, "shower", "沐浴场景启动：浴室隐私模式开启"),
      activityAt(20, 58, "walk", "离开浴室并回到卧室"),
      deviceAt(22, 42, "night", "就寝模式开启：灯光与音响关闭"),
    ],
  }),
  10: dailySchedule({
    night: [
      deviceAt(0, 18, "night", "卧室就寝模式运行"),
      activityAt(0, 26, "bed", "卧室卧姿记录", {
        related: [relatedAt(4, 12, "卧姿位置变化"), relatedAt(6, 8, "床边起身")],
      }),
    ],
    early: [
      deviceAt(6, 12, "light", "走廊与洗漱区灯光开启"),
      activityAt(6, 20, "walk", "进入洗漱区"),
      deviceAt(6, 44, "fridge", "冰箱门打开：取出豆浆"),
      activityAt(7, 0, "kitchen", "厨房早餐加热"),
      deviceAt(8, 38, "cleaning", "扫地机器人开始全屋清扫"),
    ],
    morning: [
      activityAt(9, 16, "walk", "卧室与阳台间往返"),
      deviceAt(9, 44, "laundry", "洗衣机启动日常洗程序"),
      activityAt(10, 18, "seat", "客厅坐姿活动"),
      deviceAt(11, 12, "speaker", "音响播放午间新闻"),
      activityAt(11, 36, "kitchen", "厨房午餐准备"),
    ],
    afternoon: [
      deviceAt(12, 22, "kitchen", "灶具与烟机关闭"),
      activityAt(12, 34, "seat", "餐桌前坐下"),
      activityAt(13, 42, "bed", "卧室平躺片段", {
        related: [relatedAt(14, 30, "从卧室起身")],
      }),
      deviceAt(15, 26, "laundry", "洗衣完成提醒"),
      activityAt(15, 34, "walk", "阳台晾晒动作"),
      deviceAt(17, 12, "aircon", "客厅空调开启至 26℃"),
    ],
    evening: [
      deviceAt(18, 4, "fridge", "冰箱门打开：取出剩余蔬菜"),
      activityAt(18, 20, "kitchen", "厨房晚餐准备"),
      deviceAt(19, 36, "light", "客厅切换阅读灯光"),
      activityAt(19, 44, "seat", "客厅阅读姿态"),
      deviceAt(21, 4, "shower", "沐浴场景启动：视觉采集关闭"),
      deviceAt(22, 50, "night", "就寝模式开启"),
    ],
  }),
  11: dailySchedule({
    night: [
      deviceAt(0, 12, "night", "就寝模式：卧室空调低风运行"),
      activityAt(0, 20, "bed", "卧室长时卧姿", {
        related: [relatedAt(2, 24, "卧姿位置变化"), relatedAt(5, 38, "床边坐起")],
      }),
    ],
    early: [
      deviceAt(5, 42, "light", "卧室灯光渐亮"),
      activityAt(5, 54, "walk", "前往洗漱区"),
      deviceAt(6, 22, "speaker", "厨房音响播放天气"),
      deviceAt(6, 34, "fridge", "冰箱门打开：查看冷藏食材"),
      activityAt(6, 46, "kitchen", "厨房早餐准备"),
      deviceAt(8, 2, "door", "门锁上锁：外出采购"),
    ],
    morning: [
      deviceAt(9, 28, "door", "入户门开锁：采购后回家"),
      deviceAt(9, 34, "fridge", "冰箱门打开：放入青菜、豆腐和水果"),
      activityAt(9, 48, "walk", "厨房与储物区间往返"),
      deviceAt(10, 16, "aircon", "客厅空调开启"),
      activityAt(11, 18, "kitchen", "厨房午餐准备"),
    ],
    afternoon: [
      activityAt(12, 26, "seat", "餐桌前坐姿"),
      deviceAt(13, 4, "light", "客厅灯光关闭"),
      activityAt(13, 16, "bed", "卧室午休姿态", {
        related: [relatedAt(14, 8, "从床边起身")],
      }),
      deviceAt(15, 2, "speaker", "音响播放评书"),
      activityAt(16, 28, "window", "窗边与阳台短暂停留"),
    ],
    evening: [
      deviceAt(18, 0, "light", "厨房和餐厅灯光开启"),
      deviceAt(18, 8, "kitchen", "“做饭”场景启动：烟机开启"),
      activityAt(18, 16, "kitchen", "灶台前站立与手部活动", {
        related: [relatedAt(18, 52, "餐桌前坐下")],
      }),
      deviceAt(20, 6, "shower", "沐浴场景启动：隐私模式保持高"),
      deviceAt(21, 18, "speaker", "卧室音响播放睡前广播"),
      deviceAt(22, 46, "night", "就寝模式开启"),
    ],
  }),
});

function dateKeyForDay(day) {
  return `2026-08-${String(day).padStart(2, "0")}`;
}

function timestamp(day, hour, minute) {
  return Date.parse(`${dateKeyForDay(day)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`);
}

function isBeforeRealtimeCutoff(day, hour) {
  return day < MOCK_CUTOFF_DAY || (day === MOCK_CUTOFF_DAY && hour < MOCK_CUTOFF_HOUR);
}

function daypartIdForHour(hour) {
  if (hour < 6) return "night";
  if (hour < 10) return "early";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
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
  checkInPrompt = "您还好吗？需要我帮忙吗？",
  material = null,
}) {
  const dateKey = dateKeyForDay(day);
  const linkedResponse = response ? mockResponse({ day, ...response }) : null;
  const checkIn = linkedResponse ? Object.freeze({
    prompt: checkInPrompt,
    timestampMs: timestamp(day, hour, minute),
    source: "mimo_mock",
  }) : null;
  const materialConfig = material || {};
  const familyMaterial = linkedResponse ? Object.freeze({
    id: `mock-material:${dateKey}:${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
    label: materialConfig.label || "MiMo 关怀材料",
    summary: materialConfig.summary
      || `${title}；${linkedResponse.title}。MiMo 已把本次一问一答与最小证据整理为家属材料。`,
    evidence: materialConfig.evidence || basis,
    dialogueTurns: 2,
    deliveredAtMs: linkedResponse.timestampMs + 60_000,
    deliveryStatus: materialConfig.deliveryStatus || "已送达此家属端",
    recipient: materialConfig.recipient || "当前家属端",
    modelLabel: "MiMo 演示脚本（非实时模型）",
    attachment: Object.freeze({
      label: materialConfig.attachmentLabel || "匿名骨架短片",
      durationSeconds: materialConfig.durationSeconds || 12,
      privacyMode: "skeleton",
      source: "mock_fixture",
    }),
    facts: Object.freeze(materialConfig.facts || []),
    source: "mock_fixture",
  }) : null;
  return Object.freeze({
    id: `mock:${dateKey}:${String(hour).padStart(2, "0")}${String(minute).padStart(2, "0")}`,
    kind: "assessment",
    label: "Mock 主动关怀",
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
    linkedResponse,
    checkIn,
    familyMaterial,
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

const ALL_FAMILY_TIMELINE_MOCK_EVENTS = [
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
    daypartId: "morning",
    hour: 11,
    minute: 36,
    title: "午饭准备完成，MiMo 邀请把今天的菜分享给女儿",
    basis: "Mock 多源记录显示冰箱取出番茄、鸡蛋和生菜，烟机与灶具联动结束；菜名只采用本人随后确认的回答。",
    suggestedAction: "先询问本人是否愿意分享，再整理最小必要材料",
    progress: "本人已同意并完成家庭分享",
    response: { hour: 11, minute: 39, title: "本人回应：做了番茄炒蛋和蒜蓉生菜，发给女儿吧" },
    statusLabel: "已分享",
    sceneId: "kitchen",
    uncertainty: "low",
    checkInPrompt: "午饭做好了吗？要不要把今天的菜告诉女儿？",
    material: {
      label: "今日午饭 · 家庭分享",
      summary: "本人确认今天做了番茄炒蛋和蒜蓉生菜，并同意发给女儿。MiMo 将一问一答、匿名厨房骨架片段和全屋设备事件整理成家庭分享卡。",
      evidence: "Mock 姿态片段 + 冰箱、烟机、灶具事件 + 本人明确回应",
      recipient: "女儿",
      deliveryStatus: "已发给女儿",
      attachmentLabel: "匿名厨房骨架片段",
      durationSeconds: 18,
      facts: [
        "10:42 冰箱取出番茄和鸡蛋",
        "10:49 取出并清洗生菜",
        "10:56 烟机与灶具联动开启",
      ],
    },
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
];

export const FAMILY_TIMELINE_MOCK_EVENTS = Object.freeze(
  ALL_FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => {
    const date = new Date(event.timestampMs);
    return isBeforeRealtimeCutoff(date.getDate(), date.getHours());
  }),
);

function mockMoment(day, daypartId, template, templateIndex) {
  const dateKey = dateKeyForDay(day);
  const related = Object.freeze((template.related || []).map((item) => Object.freeze({
    title: item.title,
    timestampMs: timestamp(day, item.hour, item.minute),
  })));
  const isDevice = template.kind === "device";
  return Object.freeze({
    id: `mock-${isDevice ? "device" : "activity"}:${dateKey}:${daypartId}:${templateIndex}`,
    kind: template.kind,
    label: isDevice ? "Mock 全屋设备" : "Mock 生活片段",
    title: template.title,
    detail: template.detail || (isDevice
      ? "固定 Mock 设备日志；不由照片、姿态或人物身份推断。"
      : related.length > 0
        ? `把同一段连续活动中的 ${related.length + 1} 个相邻变化收在一行。`
        : "固定 Mock 只记录房间、姿态与移动变化，不推断当时的具体意图。"),
    icon: template.icon,
    related,
    timestampMs: timestamp(day, template.hour, template.minute),
    dateKey,
    daypartId,
    count: 1 + related.length,
    tone: "neutral",
    sourceChannel: isDevice ? "mock_device_event" : "mock_pose_observation",
    source: "mock_fixture",
  });
}

function buildMockDay(day) {
  const dateKey = dateKeyForDay(day);
  const careEvents = FAMILY_TIMELINE_MOCK_EVENTS.filter((event) => event.dateKey === dateKey);
  const templates = Object.values(DAILY_MOMENTS[day]).flat();
  const sections = FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => {
    const moments = templates
      .map((template, templateIndex) => ({ template, templateIndex }))
      .filter(({ template }) => (
        isBeforeRealtimeCutoff(day, template.hour)
        && daypartIdForHour(template.hour) === daypart.id
      ))
      .map(({ template, templateIndex }) => mockMoment(day, daypart.id, template, templateIndex));
    const entries = [
      ...moments,
      ...careEvents.filter((event) => event.daypartId === daypart.id),
    ]
      .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
    return Object.freeze({
      ...daypart,
      count: entries.reduce((total, entry) => total + entry.count, 0),
      activityCount: entries.filter((entry) => entry.kind === "activity")
        .reduce((total, entry) => total + entry.count, 0),
      deviceCount: entries.filter((entry) => entry.kind === "device")
        .reduce((total, entry) => total + entry.count, 0),
      careCount: entries.filter((entry) => entry.kind === "assessment").length,
      entries: Object.freeze(entries),
    });
  });
  const date = new Date(`${dateKey}T12:00:00+08:00`);
  return Object.freeze({
    dateKey,
    day,
    weekday: WEEKDAY_COPY[date.getDay()],
    source: "mock_fixture",
    fixtureOwner: "frontend_bundle",
    sourceMode: "mock",
    coverageHours: 24,
    coverageStatus: "complete",
    revision: 0,
    totalCount: sections.reduce((total, section) => total + section.count, 0),
    activityCount: sections.reduce((total, section) => total + section.activityCount, 0),
    deviceCount: sections.reduce((total, section) => total + section.deviceCount, 0),
    careCount: careEvents.length,
    sections: Object.freeze(sections),
  });
}

export const FAMILY_TIMELINE_MOCK_DAYS = Object.freeze(
  Array.from({ length: 8 }, (_, dayIndex) => buildMockDay(4 + dayIndex)),
);

export const FAMILY_TIMELINE_DISPLAY_DAYS = Object.freeze(
  Array.from({ length: 8 }, (_, dayIndex) => {
    const day = 4 + dayIndex;
    const date = new Date(2026, 7, day, 12, 0, 0, 0);
    return Object.freeze({
      dateKey: dateKeyForDay(day),
      day,
      weekday: WEEKDAY_COPY[date.getDay()],
      sourceMode: "mock",
    });
  }),
);

export function getFamilyTimelineMockDay(dateKey) {
  return FAMILY_TIMELINE_MOCK_DAYS.find((day) => day.dateKey === dateKey) || null;
}

export function isFamilyTimelineMockDate(dateKey) {
  return dateKey >= FAMILY_TIMELINE_MOCK_START_DATE
    && dateKey <= FAMILY_TIMELINE_MOCK_END_DATE;
}

export function isFamilyTimelineDisplayDate(dateKey) {
  return dateKey >= FAMILY_TIMELINE_MOCK_START_DATE
    && dateKey <= FAMILY_TIMELINE_DISPLAY_END_DATE;
}
