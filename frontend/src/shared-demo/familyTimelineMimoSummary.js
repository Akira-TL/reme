export const MIMO_DIARY_REQUEST_SCHEMA = "reme-diary-summary-request/v0-experiment";
export const MIMO_DIARY_RESPONSE_SCHEMA = "reme-diary-summary/v0-experiment";

const RESPONSE_FIELDS = Object.freeze([
  "schema_version",
  "date",
  "headline",
  "summary",
  "highlights",
  "care_note",
  "uncertainty",
  "source",
  "model",
  "generated_at_ms",
  "input_event_count",
  "latency_ms",
  "attempts",
]);

const UNCERTAINTIES = new Set(["low", "medium", "high"]);

function clock(timestampMs) {
  const value = new Date(timestampMs);
  return `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
}

function calendarDate(timestampMs) {
  const value = new Date(timestampMs);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}

function boundedDescription(value) {
  return String(value || "").trim().slice(0, 160);
}

function append(updates, { timestampMs, kind, period, description }) {
  if (!Number.isFinite(timestampMs) || !description) return;
  updates.push({
    timestampMs,
    event: {
      time: clock(timestampMs),
      kind,
      period: period || "当日",
      description: boundedDescription(description),
    },
  });
}

function collectDayEvents(day) {
  const updates = [];
  for (const section of day?.sections || []) {
    for (const entry of section.entries || []) {
      append(updates, {
        timestampMs: entry.timestampMs,
        kind: entry.kind === "device" ? "device" : entry.kind === "activity" ? "activity" : "care",
        period: section.label,
        description: entry.title,
      });
      for (const related of entry.related || []) {
        append(updates, {
          timestampMs: related.timestampMs,
          kind: "activity",
          period: section.label,
          description: related.title,
        });
      }
      if (entry.checkIn) {
        append(updates, {
          timestampMs: entry.checkIn.timestampMs,
          kind: "care",
          period: section.label,
          description: `主动问候：${entry.checkIn.prompt}`,
        });
      }
      if (entry.linkedResponse) {
        append(updates, {
          timestampMs: entry.linkedResponse.timestampMs,
          kind: "response",
          period: section.label,
          description: entry.linkedResponse.title,
        });
      }
      if (entry.familyMaterial) {
        append(updates, {
          timestampMs: entry.familyMaterial.deliveredAtMs,
          kind: "material",
          period: section.label,
          description: `${entry.familyMaterial.label}：${entry.familyMaterial.deliveryStatus}；${entry.familyMaterial.summary}`,
        });
      }
    }
  }
  return updates;
}

function collectLiveEvents(liveEvents, selectedDate) {
  const updates = [];
  for (const entry of liveEvents || []) {
    if (calendarDate(entry.timestampMs) !== selectedDate) continue;
    append(updates, {
      timestampMs: entry.timestampMs,
      kind: entry.kind === "acknowledgement" ? "response" : "care",
      period: "本次会话",
      description: entry.title,
    });
  }
  return updates;
}

export function buildMimoDiarySummaryRequest(day, liveEvents = []) {
  const events = [...collectDayEvents(day), ...collectLiveEvents(liveEvents, day.dateKey)]
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .slice(0, 64)
    .map(({ event }) => Object.freeze(event));
  return Object.freeze({
    schema_version: MIMO_DIARY_REQUEST_SCHEMA,
    date: day.dateKey,
    events: Object.freeze(events),
  });
}

function assertExactFields(value, fields, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new TypeError(`${label} 字段不符合合同`);
  }
}

function boundedText(value, label, maxLength) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maxLength) {
    throw new TypeError(`${label} 不是有效文本`);
  }
  return value.trim();
}

export function parseMimoDiarySummaryResponse(value) {
  assertExactFields(value, RESPONSE_FIELDS, "MiMo 摘要");
  if (value.schema_version !== MIMO_DIARY_RESPONSE_SCHEMA || value.source !== "mimo") {
    throw new TypeError("MiMo 摘要来源或版本无效");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new TypeError("MiMo 摘要日期无效");
  if (!UNCERTAINTIES.has(value.uncertainty)) throw new TypeError("MiMo 摘要不确定性无效");
  if (!Array.isArray(value.highlights) || value.highlights.length > 4) {
    throw new TypeError("MiMo 摘要重点片段无效");
  }
  const highlights = value.highlights.map((item) => {
    assertExactFields(item, ["time", "text"], "MiMo 摘要重点片段");
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.time)) {
      throw new TypeError("MiMo 摘要重点片段时间无效");
    }
    return Object.freeze({ time: item.time, text: boundedText(item.text, "重点片段", 100) });
  });
  if (value.care_note !== null) boundedText(value.care_note, "关怀备注", 160);
  for (const field of ["generated_at_ms", "input_event_count", "latency_ms", "attempts"]) {
    if (!Number.isFinite(value[field]) || value[field] < 0) {
      throw new TypeError(`MiMo 摘要 ${field} 无效`);
    }
  }
  return Object.freeze({
    ...value,
    headline: boundedText(value.headline, "摘要标题", 40),
    summary: boundedText(value.summary, "摘要正文", 240),
    model: boundedText(value.model, "模型名称", 80),
    care_note: value.care_note === null ? null : value.care_note.trim(),
    highlights: Object.freeze(highlights),
  });
}
