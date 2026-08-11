const WEEKDAY_COPY = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);
export const CALENDAR_WEEKDAYS = Object.freeze(["一", "二", "三", "四", "五", "六", "日"]);

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

export function monthKeyFromDateKey(key) {
  return dateFromKey(key) ? key.slice(0, 7) : "";
}

export function shiftMonthKey(monthKey, offset) {
  if (typeof monthKey !== "string" || !/^\d{4}-\d{2}$/.test(monthKey) || !Number.isInteger(offset)) {
    return "";
  }
  const date = dateFromKey(`${monthKey}-01`);
  if (!date) return "";
  date.setMonth(date.getMonth() + offset, 1);
  return dateKeyFromTimestamp(date.getTime()).slice(0, 7);
}

export function buildCalendarMonth(
  monthKey,
  selectedDateKey,
  nowMs = Date.now(),
  markedDateKeys = [],
) {
  const todayKey = dateKeyFromTimestamp(nowMs);
  const fallbackMonthKey = monthKeyFromDateKey(selectedDateKey)
    || monthKeyFromDateKey(todayKey);
  const normalizedMonthKey = shiftMonthKey(monthKey || fallbackMonthKey, 0) || fallbackMonthKey;
  const monthStart = dateFromKey(`${normalizedMonthKey}-01`);
  const mondayOffset = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - mondayOffset);
  const marked = new Set(markedDateKeys);
  const days = Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    const key = dateKeyFromTimestamp(date.getTime());
    return Object.freeze({
      key,
      day: date.getDate(),
      month: date.getMonth() + 1,
      inMonth: key.startsWith(`${normalizedMonthKey}-`),
      selected: key === selectedDateKey,
      today: key === todayKey,
      disabled: key > todayKey,
      marked: marked.has(key),
    });
  });
  return Object.freeze({
    monthKey: normalizedMonthKey,
    label: `${monthStart.getFullYear()}年${monthStart.getMonth() + 1}月`,
    weekdays: CALENDAR_WEEKDAYS,
    days: Object.freeze(days),
    canGoNext: normalizedMonthKey < todayKey.slice(0, 7),
  });
}

export function buildWeekDays(selectedDateKey, nowMs = Date.now(), maxDateKey = null) {
  const selected = dateFromKey(selectedDateKey) || new Date(nowMs);
  selected.setHours(12, 0, 0, 0);
  const todayKey = dateKeyFromTimestamp(nowMs);
  const selectableThrough = dateFromKey(maxDateKey) ? maxDateKey : todayKey;
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
      disabled: key > selectableThrough,
    };
  });
}

export function filterTimelineEventsByDate(events, dateKey) {
  return events.filter((event) => (
    event.dateKey || dateKeyFromTimestamp(event.timestampMs)
  ) === dateKey);
}

export function timelineDateHeading(dateKey, nowMs = Date.now()) {
  const date = dateFromKey(dateKey);
  if (!date) return "选择日期";
  const prefix = dateKey === dateKeyFromTimestamp(nowMs)
    ? "今天"
    : `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${prefix} · 星期${WEEKDAY_COPY[date.getDay()]}`;
}

export function timelineDateLongHeading(dateKey) {
  const date = dateFromKey(dateKey);
  if (!date) return "选择日期";
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 · 星期${WEEKDAY_COPY[date.getDay()]}`;
}
