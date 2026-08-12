const WEEKDAY_COPY = Object.freeze(["日", "一", "二", "三", "四", "五", "六"]);

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
