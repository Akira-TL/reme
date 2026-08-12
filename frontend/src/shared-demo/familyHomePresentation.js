const FAMILY_HOME_EVENT_SOURCES = new Set(["family_event", "command_ack"]);

const FAMILY_UNAVAILABLE_CARD_COPY = Object.freeze({
  monitor_offline: Object.freeze({
    title: "暂时无法获取最新状态",
    body: "家中设备暂时离线，恢复后会自动更新；不会把旧状态当作当前情况。",
  }),
  stale: Object.freeze({
    title: "最新状态暂时中断",
    body: "正在等待家中设备更新；恢复前不会把旧状态当作当前情况。",
  }),
  not_published: Object.freeze({
    title: "正在等待家中设备",
    body: "家中设备尚未提供本次关怀状态，准备好后会自动更新。",
  }),
  protocol_invalid: Object.freeze({
    title: "家中连接暂时异常",
    body: "系统正在等待可靠的新状态，不会继续显示旧结论。",
  }),
});

function finiteTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function latestFamilyUpdateMs(snapshot, familyEvent) {
  const candidates = [
    finiteTimestamp(snapshot?.timestamp_ms),
    finiteTimestamp(familyEvent?.published_at_ms),
  ].filter((value) => value !== null);
  return candidates.length > 0 ? Math.max(...candidates) : null;
}

export function familyUnavailableCardCopy(reason) {
  return FAMILY_UNAVAILABLE_CARD_COPY[reason] || Object.freeze({
    title: "暂时无法获取最新状态",
    body: "系统正在等待可靠的新状态，恢复后会自动更新。",
  });
}

export function familyGrantBannerCopy({ grant, viewerCount, nowMs, highPrivacyEnabled }) {
  if (!grant || !Number.isFinite(grant.expires_at_ms)) return null;
  const remainingSeconds = Math.max(
    0,
    Math.ceil((grant.expires_at_ms - (Number.isFinite(nowMs) ? nowMs : 0)) / 1_000),
  );
  const audience = Number.isSafeInteger(viewerCount) && viewerCount >= 0 ? viewerCount : 0;
  return Object.freeze({
    title: highPrivacyEnabled ? "事件画面授权中，本页已隐藏" : "清晰画面临时开放",
    expiry: `${remainingSeconds} 秒后自动关闭`,
    audience: `${audience} 个访问端可见`,
  });
}

export function familyUpdateCopy({ snapshot, familyEvent, relay, nowMs }) {
  const latest = latestFamilyUpdateMs(snapshot, familyEvent);
  const unavailable = Boolean(
    relay?.unavailableReason
    || relay?.stateStale
    || !relay?.monitorOnline,
  );
  if (latest === null) {
    return unavailable ? "等待家中设备连接" : "等待首次更新";
  }

  const time = new Date(latest).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (unavailable) return `上次更新 ${time}`;

  const ageMs = Number.isFinite(nowMs) ? Math.max(0, nowMs - latest) : 0;
  if (ageMs < 60_000) return "刚刚更新";
  if (ageMs < 60 * 60_000) return `${Math.floor(ageMs / 60_000)} 分钟前更新`;
  const latestDate = new Date(latest);
  const currentDate = new Date(Number.isFinite(nowMs) ? nowMs : latest);
  const sameDay = latestDate.getFullYear() === currentDate.getFullYear()
    && latestDate.getMonth() === currentDate.getMonth()
    && latestDate.getDate() === currentDate.getDate();
  if (sameDay) return `今天 ${time} 更新`;
  return `${latestDate.getMonth() + 1} 月 ${latestDate.getDate()} 日 ${time} 更新`;
}

export function shouldShowFamilyStage({ snapshot, relay, activeGrant }) {
  if (activeGrant) return true;
  return Boolean(
    snapshot
    && relay?.connection === "connected"
    && relay?.monitorOnline
    && !relay?.unavailableReason
    && !relay?.stateStale
    && snapshot.state?.runtime?.status === "ready"
    && snapshot.state?.capture?.status === "active",
  );
}

export function selectFamilyHomeEvents(events, limit = 3) {
  if (!Array.isArray(events) || !Number.isSafeInteger(limit) || limit <= 0) return [];
  return events
    .filter((event) => (
      event
      && FAMILY_HOME_EVENT_SOURCES.has(event.source)
      && typeof event.title === "string"
      && event.title.trim().length > 0
    ))
    .slice(0, limit);
}
