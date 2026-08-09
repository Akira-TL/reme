import AlarmRoundedIcon from "@mui/icons-material/AlarmRounded";
import ArrowForwardIosRoundedIcon from "@mui/icons-material/ArrowForwardIosRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import CameraFrontRoundedIcon from "@mui/icons-material/CameraFrontRounded";
import CameraRearRoundedIcon from "@mui/icons-material/CameraRearRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DashboardRoundedIcon from "@mui/icons-material/DashboardRounded";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import EventBusyRoundedIcon from "@mui/icons-material/EventBusyRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FavoriteRoundedIcon from "@mui/icons-material/FavoriteRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import GroupsRoundedIcon from "@mui/icons-material/GroupsRounded";
import HealthAndSafetyRoundedIcon from "@mui/icons-material/HealthAndSafetyRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import MicRoundedIcon from "@mui/icons-material/MicRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import PauseCircleRoundedIcon from "@mui/icons-material/PauseCircleRounded";
import PlayCircleRoundedIcon from "@mui/icons-material/PlayCircleRounded";
import PrivacyTipRoundedIcon from "@mui/icons-material/PrivacyTipRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import ScreenShareRoundedIcon from "@mui/icons-material/ScreenShareRounded";
import SensorsRoundedIcon from "@mui/icons-material/SensorsRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import VolumeUpRoundedIcon from "@mui/icons-material/VolumeUpRounded";
import {
  BottomNavigation,
  BottomNavigationAction,
  Button,
  Dialog,
  Drawer,
  IconButton,
  Switch,
  useMediaQuery,
} from "@mui/material";
import { useEffect, useMemo, useReducer, useState } from "react";
import { relayAvailabilityCopy } from "./config.js";
import {
  createFamilyTimelineState,
  reduceFamilyTimeline,
} from "./familyTimeline.js";
import { SkeletonStage } from "./SkeletonStage.jsx";
import {
  buildWeekDays,
  dateKeyFromTimestamp,
  filterTimelineEventsByDate,
  shiftDateKey,
  timelineDateHeading,
} from "./timelineDates.js";
import { useAlertEffects } from "./useAlertEffects.js";
import { useViewerMedia } from "./useViewerMedia.js";
import { useViewerRelay } from "./useViewerRelay.js";
import {
  hasPendingCommand,
  selectActiveMediaGrant,
} from "./viewerState.js";

const SCENE_COPY = Object.freeze({
  living: { label: "客厅日常", room: "客厅", Icon: HomeRoundedIcon },
  kitchen: { label: "厨房时光", room: "厨房", Icon: RestaurantRoundedIcon },
  bathroom: { label: "浴室隐私", room: "浴室", Icon: LockRoundedIcon },
  fall: { label: "夜间守护", room: "深夜客厅", Icon: ShieldRoundedIcon },
});

const CAPTURE_COPY = Object.freeze({
  idle: "采集未开始",
  awaiting_local_confirmation: "等待 Monitor 本机确认",
  starting: "正在启动采集",
  active: "采集运行中",
  stopping: "正在停止采集",
  error: "采集异常",
});

const RUNTIME_COPY = Object.freeze({
  offline: "本地运行时离线",
  connecting: "正在连接本地运行时",
  ready: "本地运行时就绪",
  degraded: "本地运行时降级",
  error: "本地运行时异常",
});

const UNAVAILABLE_COPY = Object.freeze({
  monitor_offline: "Monitor 已离线，当前状态不可用",
  stale: "Relay 判定状态已过期，等待新的权威快照",
  not_published: "Monitor 尚未发布当前权威状态",
  protocol_invalid: "Relay 消息不符合协议，旧状态已停止使用",
});

const ACK_COPY = Object.freeze({
  sent: "已发送，等待 Relay 回执",
  received: "Relay 已接收",
  awaiting_local_confirmation: "等待 Monitor 本机确认",
  applied: "权威状态已应用",
  rejected: "命令被拒绝",
  failed: "命令执行失败",
});

const COMMAND_COPY = Object.freeze({
  select_scene: "切换场景",
  select_source: "选择媒体源",
  start_capture: "开始采集",
  stop_capture: "停止采集",
  run_demo_scenario: "运行演示",
  reset_demo: "重置演示",
  start_conversation: "发起问询",
  submit_response: "提交本人回应",
  confirm_alarm: "确认告警",
  replay_voice: "重播语音",
  unknown: "远程命令",
});

function formatTime(timestampMs) {
  if (!Number.isFinite(timestampMs)) return "—";
  return new Date(timestampMs).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(value) {
  if (!value) return "—";
  return value.length > 14 ? `…${value.slice(-12)}` : value;
}

function secondsRemaining(deadlineMs, nowMs) {
  if (!Number.isFinite(deadlineMs)) return 0;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

function unavailableCopy(relay) {
  if (relay.latestProtocolError && relay.unavailableReason === "protocol_invalid") {
    return `协议校验失败：${relay.latestProtocolError}`;
  }
  return UNAVAILABLE_COPY[relay.unavailableReason] || "当前权威状态不可用";
}

function readStoredBoolean(key, fallback) {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function useStoredBoolean(key, fallback) {
  const [value, setValue] = useState(() => readStoredBoolean(key, fallback));
  useEffect(() => {
    try {
      window.localStorage.setItem(key, String(value));
    } catch {
      // A private browsing policy may reject storage; the switch still works for this page.
    }
  }, [key, value]);
  return [value, setValue];
}

function ConnectionBanner({ relay, grant, nowMs }) {
  const remaining = grant ? secondsRemaining(grant.expires_at_ms, nowMs) : 0;
  return (
    <aside className={`public-room-banner ${grant ? "is-live" : ""}`} role="status">
      <div className="public-room-label">
        <GroupsRoundedIcon />
        <span><b>固定公开演示房间</b><small>任何打开 Viewer 的人都可加入</small></span>
      </div>
      <div className="public-room-stats">
        <span><b>{relay.viewerCount}</b> / {relay.maxViewers} 在线</span>
        <span className={grant ? "is-video-live" : ""}>
          {grant
            ? `原画开放 ${remaining}s · 全部 Viewer 可见`
            : relay.unavailableReason ? "当前权威状态不可用" : "日常仅同步骨架与状态"}
        </span>
      </div>
    </aside>
  );
}

function StatusCard({ snapshot, relay }) {
  const sceneId = snapshot?.state.scene_id || "living";
  const care = snapshot?.state.care;
  const runtime = snapshot?.state.runtime;
  const capture = snapshot?.state.capture;
  const status = (() => {
    if (relay.unavailableReason && care?.phase === "emergency") return {
      tone: "danger",
      Icon: EmergencyRoundedIcon,
      title: "上次紧急告警 · 当前状态已过期",
      body: `${care.message || "曾收到权威紧急告警"}；${unavailableCopy(relay)}。请勿把它当作当前现场状态。`,
    };
    if (relay.unavailableReason) return {
      tone: "offline",
      Icon: HealthAndSafetyRoundedIcon,
      title: "当前状态不可用",
      body: `${unavailableCopy(relay)}；不会继续把上一次“正常”状态显示为最新事实。`,
    };
    if (!relay.monitorOnline) return {
      tone: "offline",
      Icon: ShieldRoundedIcon,
      title: "等待家中 Monitor 上线",
      body: "连接恢复前不展示旧骨架、旧原画或旧控制结果。",
    };
    if (care?.phase === "emergency") return {
      tone: "danger",
      Icon: EmergencyRoundedIcon,
      title: "紧急告警：请立即关注",
      body: care.message || "权威安全规则已升级，本次状态不能由远程命令降低。",
    };
    if (care?.phase === "checking") return {
      tone: "warning",
      Icon: AlarmRoundedIcon,
      title: "正在先询问本人",
      body: care.message || "问询阶段保持骨架显示，等待本人回应。",
    };
    if (sceneId === "bathroom") return {
      tone: "privacy",
      Icon: LockRoundedIcon,
      title: "当前状态：隐私保护中",
      body: "浴室硬隐私门已开启，任何 Viewer 命令都不能开放原画。",
    };
    if (["degraded", "error", "offline"].includes(runtime?.status)) return {
      tone: "warning",
      Icon: HealthAndSafetyRoundedIcon,
      title: RUNTIME_COPY[runtime?.status] || "能力暂不可用",
      body: runtime?.detail || "故障状态保持可见，不使用模拟结果替代感知事实。",
    };
    return {
      tone: "normal",
      Icon: CheckCircleRoundedIcon,
      title: "当前状态：一切正常",
      body: capture?.status === "active"
        ? "家中设备正在本地处理，只同步必要状态与匿名骨架。"
        : CAPTURE_COPY[capture?.status] || "等待权威状态。",
    };
  })();
  const StatusIcon = status.Icon;
  return (
    <article className={`family-status-card is-${status.tone}`}>
      <span className="family-status-icon"><StatusIcon /></span>
      <div><h2>{status.title}</h2><p>{status.body}</p></div>
    </article>
  );
}

function HomePage({
  relay,
  snapshot,
  pose,
  media,
  activeGrant,
  highPrivacyEnabled,
  localNowMs,
  relayNowMs,
}) {
  const sceneId = snapshot?.state.scene_id || "living";
  return (
    <main className="viewer-page viewer-home-page">
      <SkeletonStage
        sceneId={sceneId}
        pose={pose}
        videoRef={media.videoRef}
        mediaStatus={media.status}
        revealVideo={Boolean(activeGrant && !highPrivacyEnabled)}
        highPrivacyEnabled={highPrivacyEnabled}
        grant={activeGrant}
        localNowMs={localNowMs}
        relayConnected={relay.connection === "connected" && relay.monitorOnline && !relay.unavailableReason}
        runtimeStatus={snapshot?.state.runtime.status}
        onRetryPlayback={media.retryPlayback}
      />
      {activeGrant && (
        <div className={`grant-disclosure ${highPrivacyEnabled ? "is-hidden-locally" : ""}`}>
          <VideocamRoundedIcon />
          <div>
            <b>{highPrivacyEnabled ? "本页已主动隐藏授权原画" : "事件期原画已向全部在线 Viewer 开放"}</b>
            <span>{secondsRemaining(activeGrant.expires_at_ms, relayNowMs)} 秒后自动关闭 · {media.error || "RTP 不经过 Relay 存储"}</span>
          </div>
        </div>
      )}
      <StatusCard snapshot={snapshot} relay={relay} />
      {sceneId === "kitchen" && snapshot?.state.care.consent === "granted" && (
        <article className="care-moment-card">
          <span><RestaurantRoundedIcon /></span>
          <div><small>本人已授权</small><b>外婆分享了厨房里的生活片段</b><p>授权只属于当前事件；过期或切换场景后自动关闭。</p></div>
          <CheckCircleRoundedIcon className="care-moment-check" />
        </article>
      )}
    </main>
  );
}

const TIMELINE_ICONS = Object.freeze({
  sync: SensorsRoundedIcon,
  care: HealthAndSafetyRoundedIcon,
  media: VideocamRoundedIcon,
  consent: PrivacyTipRoundedIcon,
  scene: HomeRoundedIcon,
  capture: CameraFrontRoundedIcon,
  runtime: HealthAndSafetyRoundedIcon,
  acknowledgement: CheckCircleRoundedIcon,
});

function TimelineEventCard({ event }) {
  const [expanded, setExpanded] = useState(false);
  const EventIcon = TIMELINE_ICONS[event.kind] || CalendarMonthRoundedIcon;
  const dateTime = event.timestampMs > 0
    ? new Date(event.timestampMs).toISOString()
    : undefined;
  const details = [
    {
      label: "数据来源",
      value: event.source === "command_ack" ? "Relay 命令回执" : "Relay 权威快照",
    },
    ...(Number.isSafeInteger(event.stateRevision)
      ? [{ label: "状态版本", value: `revision ${event.stateRevision}` }]
      : []),
    ...(event.sceneId
      ? [{ label: "演示场景", value: SCENE_COPY[event.sceneId]?.label || event.sceneId }]
      : []),
  ];
  return (
    <article className={`timeline-event-card is-${event.tone}`}>
      <button
        className="timeline-event-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="timeline-event-marker"><EventIcon /></span>
        <span className="timeline-event-time"><time dateTime={dateTime}>{formatTime(event.timestampMs)}</time><small>{event.label}</small></span>
        <span className="timeline-event-copy"><b>{event.title}</b><span>{event.detail}</span></span>
        <ExpandMoreRoundedIcon className={expanded ? "is-expanded" : ""} />
      </button>
      {expanded && (
        <div className="timeline-event-details">
          {details.map((detail) => (
            <div key={detail.label}><span>{detail.label}</span><b>{detail.value}</b></div>
          ))}
          <p>只记录本次公开演示会话中的结构化状态，不包含原始画面、音频或骨架正文。</p>
        </div>
      )}
    </article>
  );
}

function TimelinePage({ timeline, relay, selectedDateKey, onSelectDate, nowMs }) {
  const weekDays = buildWeekDays(selectedDateKey, nowMs);
  const todayKey = dateKeyFromTimestamp(nowMs);
  const events = filterTimelineEventsByDate(timeline.events, selectedDateKey);
  const interrupted = Boolean(
    relay.unavailableReason
      || !relay.monitorOnline
      || relay.connection !== "connected",
  );
  const canGoForward = shiftDateKey(selectedDateKey, 7) <= todayKey;
  const changeWeek = (offset) => {
    const candidate = shiftDateKey(selectedDateKey, offset * 7);
    onSelectDate(candidate > todayKey ? todayKey : candidate);
  };
  return (
    <main className="viewer-page timeline-page">
      <section className="timeline-calendar" aria-label="选择时间线日期">
        <div className="timeline-week-controls">
          <IconButton onClick={() => changeWeek(-1)} aria-label="查看上一周"><ChevronLeftRoundedIcon /></IconButton>
          <div><CalendarMonthRoundedIcon /><span>{timelineDateHeading(selectedDateKey, nowMs)}</span></div>
          <IconButton onClick={() => changeWeek(1)} disabled={!canGoForward} aria-label="查看下一周"><ChevronRightRoundedIcon /></IconButton>
        </div>
        <div className="timeline-weekdays">
          {weekDays.map((day) => (
            <button
              type="button"
              key={day.key}
              className={`${day.selected ? "is-selected" : ""} ${day.today ? "is-today" : ""}`}
              disabled={day.disabled}
              aria-pressed={day.selected}
              onClick={() => onSelectDate(day.key)}
            >
              <span>周{day.weekday}</span>
              <b>{day.day}</b>
              {day.today && <small>今</small>}
            </button>
          ))}
        </div>
      </section>

      <aside className={`timeline-session-note ${interrupted ? "is-interrupted" : ""}`}>
        {interrupted ? <RefreshRoundedIcon /> : <LockRoundedIcon />}
        <div>
          <b>{interrupted ? "同步已中断，以下不是当前现场" : "仅显示当前房间会话"}</b>
          <span>{interrupted
            ? "保留本页此前收到的记录；恢复后继续追加权威更新。"
            : "公开演示不保存跨天家庭历史；刷新或换房间后清空。"}</span>
        </div>
        <strong>{events.length} 条</strong>
      </aside>

      {events.length > 0 ? (
        <section className="timeline-event-section">
          <div className="timeline-section-heading"><div><h2>{timelineDateHeading(selectedDateKey, nowMs)}</h2><p>点击条目可查看来源与状态版本</p></div><span>最新在前</span></div>
          <div className="timeline-event-list">
            {events.map((event) => <TimelineEventCard event={event} key={event.id} />)}
          </div>
        </section>
      ) : (
        <section className="timeline-empty-state" role="status">
          <span><EventBusyRoundedIcon /></span>
          <h2>{selectedDateKey === todayKey
            ? interrupted ? "正在连接家中端" : "等待本次会话事件"
            : "这一天没有可用记录"}</h2>
          <p>{selectedDateKey === todayKey
            ? interrupted
              ? "收到第一个权威状态后，时间线会从这里开始。"
              : "Monitor 发布新的权威状态后，关键变化会出现在这里。"
            : "跨天历史服务尚未接入，因此不会用演示文案填充真实时间线。"}</p>
        </section>
      )}
    </main>
  );
}

function DashboardPage({ relay, snapshot, activeGrant, nowMs }) {
  const sceneId = snapshot?.state.scene_id || "living";
  const scene = SCENE_COPY[sceneId];
  return (
    <main className="viewer-page dashboard-page">
      <section className="dashboard-summary">
        <h2>本次同步摘要</h2>
        <div className="summary-metrics">
          <div><GroupsRoundedIcon /><b>{relay.viewerCount}</b><span>在线 Viewer</span></div>
          <div><DashboardRoundedIcon /><b>{relay.unavailableReason ? "不可用" : snapshot?.state_revision ?? "—"}</b><span>状态 revision</span></div>
          <div><VideocamRoundedIcon /><b>{activeGrant ? `${secondsRemaining(activeGrant.expires_at_ms, nowMs)}s` : "关闭"}</b><span>原画窗口</span></div>
        </div>
        <p><LockRoundedIcon /> 固定公开演示房间；这些数字不是医疗指标或准确率。</p>
      </section>
      <section className="dashboard-section">
        <h2>当前能力</h2>
        <div className="capability-grid">
          <article><scene.Icon /><div><b>{scene.label}</b><span>当前场景</span></div></article>
          <article><HealthAndSafetyRoundedIcon /><div><b>{RUNTIME_COPY[snapshot?.state.runtime.status] || "等待状态"}</b><span>{snapshot?.state.runtime.capability || "unavailable"}</span></div></article>
          <article><VideocamRoundedIcon /><div><b>{CAPTURE_COPY[snapshot?.state.capture.status] || "等待状态"}</b><span>{snapshot?.state.capture.source_kind || "未选择媒体源"}</span></div></article>
          <article><TuneRoundedIcon /><div><b>{relay.controller ? "控制租约使用中" : "控制权可接管"}</b><span>{relay.controller ? shortId(relay.controller.viewer_id) : "单一 30 秒租约"}</span></div></article>
        </div>
      </section>
      <section className="dashboard-section">
        <h2>连接与失败可见性</h2>
        <div className="truth-list">
          <div><span className={relay.connection === "connected" ? "truth-dot is-ok" : "truth-dot"} /><p><b>Relay</b><small>{relay.connection === "connected" ? "已连接" : "断线重连中"}</small></p></div>
          <div><span className={relay.monitorOnline ? "truth-dot is-ok" : "truth-dot"} /><p><b>Monitor producer</b><small>{relay.monitorOnline ? "在线" : "离线，已撤销原画与控制"}</small></p></div>
          <div><span className={snapshot?.state.runtime.status === "ready" ? "truth-dot is-ok" : "truth-dot"} /><p><b>本地运行时</b><small>{snapshot?.state.runtime.detail || RUNTIME_COPY[snapshot?.state.runtime.status] || "未发布"}</small></p></div>
        </div>
      </section>
    </main>
  );
}

function SettingsRow({ icon: Icon, title, detail, action, muted = false }) {
  return (
    <div className={`settings-row ${muted ? "is-muted" : ""}`}>
      <span className="settings-row-icon"><Icon /></span>
      <div><b>{title}</b><p>{detail}</p></div>
      <span className="settings-row-action">{action}</span>
    </div>
  );
}

function SettingsPage({ relay, highPrivacyEnabled, setHighPrivacyEnabled, notificationsEnabled, setNotificationsEnabled }) {
  return (
    <main className="viewer-page settings-page">
      <section className="home-profile-card">
        <span><HomeRoundedIcon /></span>
        <div><h2>外婆家</h2><p>{relay.viewerCount} 位 Viewer 已连接</p><b><i /> {relay.monitorOnline ? "Monitor 运行中" : "Monitor 已离线"}</b></div>
        <ArrowForwardIosRoundedIcon />
      </section>
      <section className="settings-group">
        <h2>隐私与授权</h2>
        <div className="settings-card">
          <SettingsRow
            icon={PrivacyTipRoundedIcon}
            title="高隐私显示"
            detail="开启后，本页主动隐藏已经合法授权的原画"
            action={<Switch checked={highPrivacyEnabled} onChange={(event) => setHighPrivacyEnabled(event.target.checked)} slotProps={{ input: { "aria-label": "高隐私显示" } }} />}
          />
          <SettingsRow icon={LockRoundedIcon} title="本地处理" detail="默认只接收匿名骨架与结构化状态" action={<b className="setting-state is-on">已开启</b>} />
          <SettingsRow icon={GroupsRoundedIcon} title="分享授权" detail="事件期原画向全部在线 Viewer 开放" action={<ArrowForwardIosRoundedIcon />} />
        </div>
      </section>
      <section className="settings-group">
        <h2>关怀与提醒</h2>
        <div className="settings-card">
          <SettingsRow
            icon={NotificationsActiveRoundedIcon}
            title="风险提醒"
            detail="真实控制本页声音、震动与闪烁"
            action={<Switch checked={notificationsEnabled} onChange={(event) => setNotificationsEnabled(event.target.checked)} slotProps={{ input: { "aria-label": "风险提醒" } }} />}
          />
          <SettingsRow icon={ShieldRoundedIcon} title="安全规则" detail="Viewer 不能取消或降低权威告警" action={<b className="setting-state">只读</b>} />
          <SettingsRow icon={GroupsRoundedIcon} title="公开房间" detail={`${relay.viewerCount}/${relay.maxViewers} 在线 · 无身份认证`} action={<ArrowForwardIosRoundedIcon />} />
        </div>
      </section>
      <section className="settings-group">
        <h2>连接</h2>
        <div className="settings-card compact-settings-card">
          <SettingsRow icon={DashboardRoundedIcon} title="房间会话" detail={shortId(relay.roomSessionId)} action={<span />} muted={!relay.roomSessionId} />
          <SettingsRow icon={VideocamRoundedIcon} title="事件期媒体" detail={relayAvailabilityCopy()} action={<span />} />
        </div>
      </section>
    </main>
  );
}

function CommandButton({ icon: Icon, children, onClick, disabled, tone = "default" }) {
  return <Button className={`command-button is-${tone}`} startIcon={<Icon />} onClick={onClick} disabled={disabled}>{children}</Button>;
}

function ControlDrawer({ open, onClose, relay, snapshot, nowMs, onIssue, issueError }) {
  const desktop = useMediaQuery("(min-width: 900px)");
  const pending = hasPendingCommand(relay);
  const disabled = !relay.ownsControl || !snapshot || pending;
  const decisionId = snapshot?.state.care.decision_id;
  const leaseSeconds = relay.ownsControl ? secondsRemaining(relay.lease?.expires_at_ms, nowMs) : 0;
  return (
    <Drawer
      anchor={desktop ? "right" : "bottom"}
      open={open}
      onClose={onClose}
      slotProps={{ paper: { className: `control-drawer ${desktop ? "is-desktop" : "is-mobile"}` } }}
    >
      <header className="control-drawer-header">
        <div><small>REMOTE DEMO CONTROL</small><h2>远程路演控制</h2><p>命令只在 Monitor 权威状态回写后生效。</p></div>
        <IconButton onClick={onClose} aria-label="关闭控制抽屉"><CloseRoundedIcon /></IconButton>
      </header>
      <section className={`controller-lease-card ${relay.ownsControl ? "is-owned" : ""}`}>
        <span><TuneRoundedIcon /></span>
        <div>
          <b>{relay.ownsControl ? `你正在控制 · ${leaseSeconds}s` : relay.controller ? "另一位 Viewer 正在控制" : "控制权当前可接管"}</b>
          <p>{relay.controller ? `控制者 ${shortId(relay.controller.viewer_id)}` : "单一控制租约，页面隐藏时自动释放"}</p>
        </div>
        {relay.ownsControl
          ? <Button variant="outlined" onClick={relay.releaseControl}>释放</Button>
          : <Button variant="contained" onClick={relay.claimControl} disabled={!relay.monitorOnline || Boolean(relay.controller)}>接管控制</Button>}
      </section>
      {issueError && <div className="command-error" role="alert">{issueError}</div>}
      {pending && <div className="command-pending"><span /> 有命令尚未进入终态，请以 ACK 和权威状态为准</div>}

      <section className="control-section">
        <h3>场景</h3>
        <div className="command-grid four-columns">
          {Object.entries(SCENE_COPY).map(([sceneId, scene]) => (
            <CommandButton key={sceneId} icon={scene.Icon} disabled={disabled} onClick={() => onIssue({ name: "select_scene", scene_id: sceneId })}>{scene.label}</CommandButton>
          ))}
        </div>
      </section>
      <section className="control-section">
        <h3>媒体源与采集</h3>
        <div className="command-grid two-columns">
          <CommandButton icon={CameraFrontRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "select_source", source_id: "camera-user" })}>前置摄像头</CommandButton>
          <CommandButton icon={CameraRearRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "select_source", source_id: "camera-environment" })}>后置摄像头</CommandButton>
          <CommandButton icon={ScreenShareRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "select_source", source_id: "display" })}>窗口/屏幕</CommandButton>
          <CommandButton icon={FolderRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "select_source", source_id: "file" })}>本地视频文件</CommandButton>
          <CommandButton icon={PlayCircleRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "start_capture" })}>开始采集</CommandButton>
          <CommandButton icon={PauseCircleRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "stop_capture" })}>停止采集</CommandButton>
        </div>
        <p className="control-note">屏幕、文件与首次摄像头授权必须在 Monitor 本机确认，Viewer 不会假装已成功。</p>
      </section>
      <section className="control-section">
        <h3>路演场景与问询</h3>
        <div className="command-grid two-columns">
          <CommandButton icon={CheckCircleRoundedIcon} disabled={disabled} tone="safe" onClick={() => onIssue({ name: "run_demo_scenario", scenario: "normal" })}>触发正常演示</CommandButton>
          <CommandButton icon={EmergencyRoundedIcon} disabled={disabled} tone="danger" onClick={() => onIssue({ name: "run_demo_scenario", scenario: "fall" })}>触发跌倒演示</CommandButton>
          <CommandButton icon={MicRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "start_conversation", scenario: "proactive_check_in" })}>发起安全问询</CommandButton>
          <CommandButton icon={RestaurantRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "start_conversation", scenario: "kitchen_share" })}>询问厨房分享</CommandButton>
          <CommandButton icon={RefreshRoundedIcon} disabled={disabled} onClick={() => onIssue({ name: "reset_demo" })}>重置演示</CommandButton>
        </div>
      </section>
      <section className="control-section">
        <h3>本人回应与告警</h3>
        {!decisionId && <p className="control-note">当前没有可回应的 decision，相关命令保持禁用。</p>}
        <div className="command-grid two-columns">
          <CommandButton icon={CheckCircleRoundedIcon} disabled={disabled || !decisionId} tone="safe" onClick={() => onIssue({ name: "submit_response", decision_id: decisionId, response: "safe" })}>本人安全</CommandButton>
          <CommandButton icon={EmergencyRoundedIcon} disabled={disabled || !decisionId} tone="danger" onClick={() => onIssue({ name: "submit_response", decision_id: decisionId, response: "need_help" })}>本人需要帮助</CommandButton>
          <CommandButton icon={VideocamRoundedIcon} disabled={disabled || !decisionId} onClick={() => onIssue({ name: "submit_response", decision_id: decisionId, response: "consent_granted" })}>同意分享</CommandButton>
          <CommandButton icon={LockRoundedIcon} disabled={disabled || !decisionId} onClick={() => onIssue({ name: "submit_response", decision_id: decisionId, response: "consent_denied" })}>拒绝分享</CommandButton>
          <CommandButton icon={ShieldRoundedIcon} disabled={disabled || !decisionId} onClick={() => onIssue({ name: "confirm_alarm", decision_id: decisionId })}>确认告警</CommandButton>
          <CommandButton icon={VolumeUpRoundedIcon} disabled={disabled || !decisionId} onClick={() => onIssue({ name: "replay_voice", decision_id: decisionId })}>重播语音</CommandButton>
        </div>
      </section>
      <section className="control-section ack-section">
        <h3>命令回执</h3>
        {relay.acks.length === 0
          ? <p className="empty-acks">尚未发送远程命令</p>
          : relay.acks.slice(0, 6).map((ack) => (
            <article className={`ack-row is-${ack.phase}`} key={ack.command_id}>
              <span />
              <div><b>{COMMAND_COPY[ack.command_name] || COMMAND_COPY.unknown}</b><p>{ACK_COPY[ack.phase] || ack.phase}{ack.reason ? ` · ${ack.reason}` : ""}</p></div>
              <time>{formatTime(ack.timestamp_ms)}</time>
            </article>
          ))}
      </section>
    </Drawer>
  );
}

function EmergencyDialog({ open, onClose, care, activeGrant, nowMs, ownsControl, onIssue, soundBlocked, onRetrySound, stale }) {
  if (!care) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth slotProps={{ paper: { className: "emergency-dialog" } }}>
      <IconButton className="emergency-close" onClick={onClose} aria-label="收起紧急提醒"><CloseRoundedIcon /></IconButton>
      <span className="emergency-dialog-mark"><EmergencyRoundedIcon /></span>
      <small>{stale ? "历史紧急告警 · 当前状态不可用" : "紧急风险提醒"}</small>
      <h2>{stale ? "上次检测到需要关注的安全事件" : "检测到需要关注的安全事件"}</h2>
      <p>{care.message || "权威规则已升级并通知家属，请尽快确认。"}</p>
      {stale && <p role="status">该告警被安全锁存，但已不是当前现场状态；请等待新的权威快照。</p>}
      <div className="emergency-dialog-context">
        <AlarmRoundedIcon />
        <div><b>{activeGrant ? `原画开放还剩 ${secondsRemaining(activeGrant.expires_at_ms, nowMs)} 秒` : "当前保持匿名骨架"}</b><span>固定公开房间内全部在线 Viewer 可见授权原画</span></div>
      </div>
      <Button variant="contained" color="error" startIcon={<ShieldRoundedIcon />} disabled={stale || !ownsControl || !care.decision_id} onClick={() => onIssue({ name: "confirm_alarm", decision_id: care.decision_id })}>确认已收到告警</Button>
      <Button variant="outlined" startIcon={<VolumeUpRoundedIcon />} disabled={stale || !ownsControl || !care.decision_id} onClick={() => onIssue({ name: "replay_voice", decision_id: care.decision_id })}>重播现场问询</Button>
      {soundBlocked && <Button variant="text" onClick={onRetrySound}>点击启用本页告警声音</Button>}
      {!ownsControl && <small className="emergency-control-note">接管控制后才能提交处理命令；告警本身始终可见。</small>}
    </Dialog>
  );
}

export function ViewerApp() {
  const relay = useViewerRelay();
  const [activeTab, setActiveTab] = useState("home");
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(() => dateKeyFromTimestamp(Date.now()));
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [issueError, setIssueError] = useState("");
  const [dismissedEmergency, setDismissedEmergency] = useState(null);
  const [timeline, dispatchTimeline] = useReducer(
    reduceFamilyTimeline,
    undefined,
    createFamilyTimelineState,
  );
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [highPrivacyEnabled, setHighPrivacyEnabled] = useStoredBoolean("reme.viewer.highPrivacy", true);
  const [notificationsEnabled, setNotificationsEnabled] = useStoredBoolean("reme.viewer.notifications", true);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const snapshot = relay.state;
  useEffect(() => {
    dispatchTimeline({
      type: "observe",
      roomSessionId: relay.roomSessionId,
      snapshot,
      acks: relay.acks,
    });
  }, [relay.acks, relay.roomSessionId, snapshot]);
  const relayNowMs = nowMs + (relay.serverTimeOffsetMs || 0);
  const sceneId = snapshot?.state.scene_id || "living";
  const activeGrant = useMemo(
    () => selectActiveMediaGrant(relay, relayNowMs),
    [relay, relayNowMs],
  );
  const media = useViewerMedia({
    grant: activeGrant,
    authorityKey: activeGrant && snapshot
      ? `${snapshot.runtime_session_id}:${snapshot.state.source_generation}:${activeGrant.grant_id}`
      : null,
    roomSessionId: relay.roomSessionId,
    viewerId: relay.viewerId,
    subscribeMediaSignals: relay.subscribeMediaSignals,
    sendMediaSignal: relay.sendMediaSignal,
  });
  const emergency = snapshot?.state.care.phase === "emergency";
  const emergencyStale = Boolean(emergency && (relay.stateStale || relay.unavailableReason));
  const decisionId = snapshot?.state.care.decision_id;
  const alertEffects = useAlertEffects({
    enabled: notificationsEnabled,
    emergency,
    decisionId,
  });

  const issueCommand = (command) => {
    const result = relay.sendCommand(command);
    setIssueError(result.ok ? "" : result.reason);
    if (!result.ok) setDrawerOpen(true);
    return result;
  };

  const pageHeader = (() => {
    if (activeTab === "home") return {
      title: "外婆家",
      subtitle: relay.unavailableReason
        ? "当前权威状态不可用 · 等待恢复"
        : `${SCENE_COPY[sceneId].label} · ${relay.connection === "connected" ? "Relay 已连接" : "正在重连"}`,
    };
    if (activeTab === "timeline") return {
      title: "时间线",
      subtitle: `外婆 · ${timelineDateHeading(selectedTimelineDate, nowMs)}`,
    };
    if (activeTab === "dashboard") return { title: "关怀看板", subtitle: "外婆 · 本次公开演示" };
    return { title: "设置", subtitle: "管理本页显示与提醒" };
  })();

  return (
    <div className={`viewer-app ${alertEffects.flashActive ? "is-flashing" : ""}`}>
      <div className="alert-flash-layer" aria-hidden="true" />
      <ConnectionBanner relay={relay} grant={activeGrant} nowMs={relayNowMs} />
      <div className="viewer-shell">
        <header className="viewer-header">
          <div><h1>{pageHeader.title}</h1><p>{pageHeader.subtitle}</p></div>
          <IconButton className="viewer-control-trigger" onClick={() => setDrawerOpen(true)} aria-label="打开远程控制">
            <TuneRoundedIcon />
            {relay.ownsControl && <span />}
          </IconButton>
        </header>

        {relay.unavailableReason && (
          <aside className={`viewer-state-unavailable ${emergencyStale ? "is-emergency" : ""}`} role="alert">
            <HealthAndSafetyRoundedIcon />
            <div><b>{emergencyStale ? "历史紧急告警已锁存，当前状态不可用" : "当前状态不可用"}</b><span>{unavailableCopy(relay)}</span></div>
          </aside>
        )}

        {activeTab === "home" && <HomePage relay={relay} snapshot={snapshot} pose={relay.pose} media={media} activeGrant={activeGrant} highPrivacyEnabled={highPrivacyEnabled} localNowMs={nowMs} relayNowMs={relayNowMs} />}
        {activeTab === "timeline" && (
          <TimelinePage
            timeline={timeline}
            relay={relay}
            selectedDateKey={selectedTimelineDate}
            onSelectDate={setSelectedTimelineDate}
            nowMs={nowMs}
          />
        )}
        {activeTab === "dashboard" && <DashboardPage relay={relay} snapshot={snapshot} activeGrant={activeGrant} nowMs={relayNowMs} />}
        {activeTab === "settings" && (
          <SettingsPage
            relay={relay}
            highPrivacyEnabled={highPrivacyEnabled}
            setHighPrivacyEnabled={setHighPrivacyEnabled}
            notificationsEnabled={notificationsEnabled}
            setNotificationsEnabled={setNotificationsEnabled}
          />
        )}

        <BottomNavigation className="viewer-bottom-nav" showLabels value={activeTab} onChange={(_, value) => setActiveTab(value)}>
          <BottomNavigationAction label="首页" value="home" icon={<HomeRoundedIcon />} />
          <BottomNavigationAction label="时间线" value="timeline" icon={<CalendarMonthRoundedIcon />} />
          <BottomNavigationAction label="看板" value="dashboard" icon={<FavoriteRoundedIcon />} />
          <BottomNavigationAction label="设置" value="settings" icon={<SettingsRoundedIcon />} />
        </BottomNavigation>
      </div>

      <button className={`floating-control-button ${relay.ownsControl ? "is-owned" : ""}`} type="button" onClick={() => setDrawerOpen(true)}>
        <TuneRoundedIcon /><span>{relay.ownsControl ? "远程控制中" : "打开路演控制"}</span>
      </button>

      <ControlDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} relay={relay} snapshot={snapshot} nowMs={relayNowMs} onIssue={issueCommand} issueError={issueError} />
      <EmergencyDialog
        open={Boolean(emergency && decisionId !== dismissedEmergency)}
        onClose={() => setDismissedEmergency(decisionId)}
        care={snapshot?.state.care}
        activeGrant={activeGrant}
        nowMs={relayNowMs}
        ownsControl={relay.ownsControl}
        onIssue={issueCommand}
        soundBlocked={alertEffects.soundBlocked}
        onRetrySound={alertEffects.retrySound}
        stale={emergencyStale}
      />
    </div>
  );
}
