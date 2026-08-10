import AlarmRoundedIcon from "@mui/icons-material/AlarmRounded";
import AcUnitRoundedIcon from "@mui/icons-material/AcUnitRounded";
import ArrowForwardIosRoundedIcon from "@mui/icons-material/ArrowForwardIosRounded";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import BedRoundedIcon from "@mui/icons-material/BedRounded";
import CalendarMonthRoundedIcon from "@mui/icons-material/CalendarMonthRounded";
import CameraFrontRoundedIcon from "@mui/icons-material/CameraFrontRounded";
import CameraRearRoundedIcon from "@mui/icons-material/CameraRearRounded";
import ChairRoundedIcon from "@mui/icons-material/ChairRounded";
import ChatBubbleOutlineRoundedIcon from "@mui/icons-material/ChatBubbleOutlineRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import ChevronLeftRoundedIcon from "@mui/icons-material/ChevronLeftRounded";
import ChevronRightRoundedIcon from "@mui/icons-material/ChevronRightRounded";
import CleaningServicesRoundedIcon from "@mui/icons-material/CleaningServicesRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import DashboardRoundedIcon from "@mui/icons-material/DashboardRounded";
import DirectionsWalkRoundedIcon from "@mui/icons-material/DirectionsWalkRounded";
import DoorFrontRoundedIcon from "@mui/icons-material/DoorFrontRounded";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import EventBusyRoundedIcon from "@mui/icons-material/EventBusyRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FavoriteRoundedIcon from "@mui/icons-material/FavoriteRounded";
import FiberManualRecordRoundedIcon from "@mui/icons-material/FiberManualRecordRounded";
import FolderRoundedIcon from "@mui/icons-material/FolderRounded";
import GroupsRoundedIcon from "@mui/icons-material/GroupsRounded";
import HealthAndSafetyRoundedIcon from "@mui/icons-material/HealthAndSafetyRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import LightbulbRoundedIcon from "@mui/icons-material/LightbulbRounded";
import LocalLaundryServiceRoundedIcon from "@mui/icons-material/LocalLaundryServiceRounded";
import MicRoundedIcon from "@mui/icons-material/MicRounded";
import NightsStayRoundedIcon from "@mui/icons-material/NightsStayRounded";
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
import ShowerRoundedIcon from "@mui/icons-material/ShowerRounded";
import SpeakerRoundedIcon from "@mui/icons-material/SpeakerRounded";
import SoupKitchenRoundedIcon from "@mui/icons-material/SoupKitchenRounded";
import SubdirectoryArrowRightRoundedIcon from "@mui/icons-material/SubdirectoryArrowRightRounded";
import TuneRoundedIcon from "@mui/icons-material/TuneRounded";
import TipsAndUpdatesRoundedIcon from "@mui/icons-material/TipsAndUpdatesRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import VolumeUpRoundedIcon from "@mui/icons-material/VolumeUpRounded";
import WbSunnyRoundedIcon from "@mui/icons-material/WbSunnyRounded";
import WbTwilightRoundedIcon from "@mui/icons-material/WbTwilightRounded";
import WindowRoundedIcon from "@mui/icons-material/WindowRounded";
import KitchenRoundedIcon from "@mui/icons-material/KitchenRounded";
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
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { getDecisionUrls, requestMimoDiarySummary } from "../services/decisionClient.js";
import { relayAvailabilityCopy } from "./config.js";
import {
  familyCareMessage,
  familyCarePresentationKind,
  familyMediaAuthorization,
  isFamilyAlarm,
  isPendingFamilyActionCard,
} from "./familyAuthority.js";
import {
  isFamilyConfirmationTimedOut,
  resolveFamilyConfirmationError,
  selectFamilyAcknowledgementCommand,
} from "./familyConfirmation.js";
import { deriveFamilyTruth } from "./familyPresentation.js";
import {
  createFamilyTimelineState,
  reduceFamilyTimeline,
} from "./familyTimeline.js";
import {
  FAMILY_TIMELINE_DISPLAY_DAYS,
  FAMILY_TIMELINE_DISPLAY_END_DATE,
  FAMILY_TIMELINE_MOCK_DAYPARTS,
  FAMILY_TIMELINE_MOCK_END_DATE,
  FAMILY_TIMELINE_REALTIME_CUTOFF_MS,
  getFamilyTimelineMockDay,
  isFamilyTimelineDisplayDate,
} from "./familyTimelineMock.js";
import {
  buildMimoDiarySummaryRequest,
  parseMimoDiarySummaryResponse,
} from "./familyTimelineMimoSummary.js";
import { SkeletonStage } from "./SkeletonStage.jsx";
import {
  buildWeekDays,
  dateKeyFromTimestamp,
  filterTimelineEventsByDate,
  shiftDateKey,
  timelineDateHeading,
  timelineDateLongHeading,
} from "./timelineDates.js";
import { useAlertEffects } from "./useAlertEffects.js";
import { useViewerMedia } from "./useViewerMedia.js";
import { useViewerRelay } from "./useViewerRelay.js";
import { useRtcConfiguration } from "./useRtcConfiguration.js";
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

const FAMILY_UNAVAILABLE_COPY = Object.freeze({
  monitor_offline: "家中端已离线，当前状态不可用",
  stale: "同步状态已过期，正在等待家中端更新",
  not_published: "家中端尚未同步当前状态",
  protocol_invalid: "公开演示连接异常，旧状态已停止使用",
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
  acknowledge_alarm: "确认告警",
  confirm_alarm: "确认告警",
  confirm_action_card: "确认行动卡",
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

function captureCopy(status, familySurface = false) {
  if (familySurface && status === "awaiting_local_confirmation") {
    return "等待家中端确认";
  }
  return CAPTURE_COPY[status];
}

function unavailableCopy(relay, familySurface = false) {
  if (relay.latestProtocolError && relay.unavailableReason === "protocol_invalid") {
    return familySurface
      ? `公开演示连接校验失败：${relay.latestProtocolError}`
      : `协议校验失败：${relay.latestProtocolError}`;
  }
  const copy = familySurface ? FAMILY_UNAVAILABLE_COPY : UNAVAILABLE_COPY;
  return copy[relay.unavailableReason] || "当前权威状态不可用";
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

function ConnectionBanner({ relay, grant, nowMs, familySurface = false, rtcError = null }) {
  const remaining = grant ? secondsRemaining(grant.expires_at_ms, nowMs) : 0;
  return (
    <aside className={`public-room-banner ${grant ? "is-live" : ""}`}>
      <span className="viewer-sr-only" role="status">
        {grant ? "事件期原画授权已生效，并会按时自动关闭。" : ""}
      </span>
      <div className="public-room-label">
        <GroupsRoundedIcon />
        <span>
          <b>{familySurface ? "公开演示连接" : "固定公开演示房间"}</b>
          <small>{familySurface ? "无账号验证 · 任何拿到链接的人可加入" : "任何打开 Viewer 的人都可加入"}</small>
        </span>
      </div>
      <div className="public-room-stats">
        <span>
          {familySurface
            ? <><b>{relay.viewerCount}</b> 个在线访问端</>
            : <><b>{relay.viewerCount}</b> / {relay.maxViewers} 在线</>}
        </span>
        <span className={grant ? "is-video-live" : ""}>
          {grant
            ? familySurface
              ? `临时原画 ${remaining}s · 全部在线 Viewer 可见`
              : `原画开放 ${remaining}s · 全部 Viewer 可见`
            : relay.unavailableReason
              ? "当前权威状态不可用"
              : rtcError
                ? "RTC 配置不可用 · 原画保持关闭"
              : "日常仅同步骨架与必要状态"}
        </span>
      </div>
    </aside>
  );
}

function StatusCard({ snapshot, relay, decision, familySurface = false }) {
  const truth = deriveFamilyTruth(snapshot, relay);
  const sceneId = truth.sceneId;
  const careMessage = familyCareMessage(decision);
  const presentationKind = familyCarePresentationKind(decision);
  const runtime = snapshot?.state.runtime;
  const capture = snapshot?.state.capture;
  const status = (() => {
    if (relay.unavailableReason
      && presentationKind === "alarm") return {
      tone: "danger",
      Icon: EmergencyRoundedIcon,
      title: "紧急告警仍待处理 · 现场传输不可用",
      body: `${careMessage || "后端已发布权威紧急告警"}；${unavailableCopy(relay, familySurface)}。告警不会因浏览器离线而被取消。`,
    };
    if (relay.unavailableReason) return {
      tone: "offline",
      Icon: HealthAndSafetyRoundedIcon,
      title: "当前状态不可用",
      body: `${unavailableCopy(relay, familySurface)}；不会继续把上一次“正常”状态显示为最新事实。`,
    };
    if (!relay.monitorOnline) return {
      tone: "offline",
      Icon: ShieldRoundedIcon,
      title: familySurface ? "等待家中端上线" : "等待家中 Monitor 上线",
      body: familySurface
        ? "连接恢复前不展示旧骨架、旧原画或旧处理结果。"
        : "连接恢复前不展示旧骨架、旧原画或旧控制结果。",
    };
    if (presentationKind === "alarm") return {
      tone: "danger",
      Icon: EmergencyRoundedIcon,
      title: "紧急告警：请立即关注",
      body: careMessage || (familySurface
        ? "安全规则已升级，家属端不能取消或降低本次告警。"
        : "权威安全规则已升级，本次状态不能由远程命令降低。"),
    };
    if (presentationKind === "action_card") return {
      tone: "warning",
      Icon: TipsAndUpdatesRoundedIcon,
      title: "家属行动卡待处理",
      body: careMessage || "本人已同意把具体生活需要同步给家属；这不是安全告警。",
    };
    if (presentationKind === "notification") return {
      tone: "warning",
      Icon: HealthAndSafetyRoundedIcon,
      title: "家属收到普通关怀通知",
      body: careMessage || "这条通知不附带行动卡或安全告警。",
    };
    if (["check_in_required", "consent_required"].includes(decision?.state)) return {
      tone: "warning",
      Icon: AlarmRoundedIcon,
      title: "正在先询问本人",
      body: careMessage || "问询阶段保持骨架显示，等待本人回应。",
    };
    if (sceneId === "bathroom") return {
      tone: "privacy",
      Icon: LockRoundedIcon,
      title: "当前状态：隐私保护中",
      body: familySurface
        ? "浴室隐私保护已开启，家属端无法请求或开放现场原画。"
        : "浴室硬隐私门已开启，任何 Viewer 命令都不能开放原画。",
    };
    if (["degraded", "error", "offline"].includes(runtime?.status)) return {
      tone: "warning",
      Icon: HealthAndSafetyRoundedIcon,
      title: RUNTIME_COPY[runtime?.status] || "能力暂不可用",
      body: runtime?.detail || "故障状态保持可见，不使用模拟结果替代感知事实。",
    };
    if (runtime?.status !== "ready") return {
      tone: "offline",
      Icon: HealthAndSafetyRoundedIcon,
      title: RUNTIME_COPY[runtime?.status] || "正在等待本地感知",
      body: runtime?.detail || "本地能力尚未给出可靠结果，不显示正常结论。",
    };
    if (capture?.status !== "active") return {
      tone: capture?.status === "error" ? "warning" : "offline",
      Icon: VideocamRoundedIcon,
      title: captureCopy(capture?.status, familySurface) || "正在等待可靠输入",
      body: capture?.error || "现场输入尚未就绪，不显示正常结论。",
    };
    if (!truth.quietStateReady) return {
      tone: "offline",
      Icon: HealthAndSafetyRoundedIcon,
      title: "正在等待权威状态",
      body: "当前信息不足，不显示正常结论或现场空间。",
    };
    return {
      tone: "normal",
      Icon: CheckCircleRoundedIcon,
      title: "关怀链路运行中",
      body: "当前未收到需要行动的权威事件；这不等于对现场安全作出保证。",
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
  familySurface = false,
  familyAcknowledgementControl = null,
  decision = null,
}) {
  const sceneId = deriveFamilyTruth(snapshot, relay).sceneId;
  const mediaAuthorization = familyMediaAuthorization(relay.familyEvent);
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
            <b>{highPrivacyEnabled
              ? "本页已主动隐藏授权原画"
              : "事件期原画已向全部在线 Viewer 开放"}</b>
            <span>{secondsRemaining(activeGrant.expires_at_ms, relayNowMs)} 秒后自动关闭 · {media.error || (familySurface ? "本页不保存；RTP 不经过 Relay 存储" : "RTP 不经过 Relay 存储")}</span>
          </div>
        </div>
      )}
      <StatusCard snapshot={snapshot} relay={relay} decision={decision} familySurface={familySurface} />
      {familyAcknowledgementControl}
      {sceneId === "kitchen"
        && mediaAuthorization?.status === "active"
        && mediaAuthorization.scope === "kitchen_moment" && (
        <article className="care-moment-card">
          <span><RestaurantRoundedIcon /></span>
          <div><small>本人已授权</small><b>外婆分享了厨房里的生活片段</b><p>授权只属于当前事件；过期或切换场景后自动关闭。</p></div>
          <CheckCircleRoundedIcon className="care-moment-check" />
        </article>
      )}
      {familySurface && (
        <div className="family-home-dashboard">
          <DashboardContent
            relay={relay}
            snapshot={snapshot}
            activeGrant={activeGrant}
            nowMs={relayNowMs}
            familySurface
          />
        </div>
      )}
    </main>
  );
}

function FamilyActionCard({
  decision,
  pending,
  applied,
  blocked,
  error,
  onConfirm,
}) {
  const card = decision?.action_card;
  if (familyCarePresentationKind(decision) !== "action_card" || !card) return null;
  const canConfirm = card.status === "pending";
  const label = applied
    ? "已确认收到行动卡"
    : pending
      ? "正在提交确认…"
      : blocked
        ? "其他访问端正在处理"
        : "确认收到并开始处理";
  return (
    <article className="care-moment-card family-action-card">
      <span><TipsAndUpdatesRoundedIcon /></span>
      <div>
        <small>非紧急家庭待办 · {card.status === "pending" ? "待确认" : "已更新"}</small>
        <b>{card.event}</b>
        {card.elder_quote && <p>本人原话：{card.elder_quote}</p>}
        <p>关怀判断：{card.system_judgment}</p>
        <p>建议动作：{card.suggested_action} · {card.time_window}</p>
        {canConfirm && (
          <Button
            size="small"
            variant="contained"
            disabled={pending || applied || blocked}
            onClick={() => onConfirm(decision.decision_id, "confirm_action_card")}
          >
            {label}
          </Button>
        )}
        {error && <p className="family-confirm-error" role="alert">{error}</p>}
      </div>
    </article>
  );
}

const TIMELINE_ICONS = Object.freeze({
  assessment: AutoAwesomeRoundedIcon,
  judgment: AutoAwesomeRoundedIcon,
  notification: NotificationsActiveRoundedIcon,
  action_card: TipsAndUpdatesRoundedIcon,
  alarm: EmergencyRoundedIcon,
  care: HealthAndSafetyRoundedIcon,
  media: VideocamRoundedIcon,
  consent: PrivacyTipRoundedIcon,
  acknowledgement: CheckCircleRoundedIcon,
});

const TIMELINE_ALARM_TRIGGER_COPY = Object.freeze({
  elder_report: "本人明确求助",
  voice_intent: "语音确认求助",
  visual_confirm: "危险画面确认",
  check_in_timeout: "安全询问无回应",
  unclear_response: "无法确认本人状态",
  family_unresponsive: "家属未确认",
});

const TIMELINE_SOURCE_COPY = Object.freeze({
  rule: { short: "安全规则", detail: "确定性安全规则" },
  mimo: { short: "MiMo", detail: "MiMo 综合关怀判断" },
  mock: { short: "演示", detail: "演示脚本（非实时模型）" },
  record: { short: "回放", detail: "已记录的关怀决策回放" },
  degraded: { short: "降级", detail: "本地降级策略" },
  backend: { short: "Backend", detail: "Backend 权威家庭状态" },
});

const TIMELINE_UNCERTAINTY_COPY = Object.freeze({
  low: "低",
  medium: "中",
  high: "高",
  unknown: "未知",
});

function visualContextCopy(visualContext) {
  if (!visualContext?.sentToMimo) return "未向 MiMo 发送视觉上下文";
  if (visualContext.type === "keyframes") {
    return Number.isSafeInteger(visualContext.sampleCount)
      ? `已使用 ${visualContext.sampleCount} 张最小关键帧`
      : "已使用最小关键帧";
  }
  return "已使用最小事件短片";
}

function TimelineEventCard({ event }) {
  const [expanded, setExpanded] = useState(false);
  const EventIcon = TIMELINE_ICONS[event.kind] || CalendarMonthRoundedIcon;
  const dateTime = event.timestampMs > 0
    ? new Date(event.timestampMs).toISOString()
    : undefined;
  const details = [
    ...(event.assessmentSource
      ? [{
        label: "判断来源",
        value: TIMELINE_SOURCE_COPY[event.assessmentSource]?.detail || event.assessmentSource,
      }]
      : []),
    ...(event.uncertainty
      ? [{
        label: "判断不确定性",
        value: TIMELINE_UNCERTAINTY_COPY[event.uncertainty] || "未知",
      }]
      : []),
    ...(event.visualContext
      ? [{ label: "视觉上下文", value: visualContextCopy(event.visualContext) }]
      : []),
    {
      label: "数据来源",
      value: event.source === "command_ack"
        ? "Relay 命令回执"
        : event.source === "mock_fixture"
          ? "固定 Mock 演示数据（非真实家庭历史）"
          : "Relay 权威快照",
    },
    ...(Number.isSafeInteger(event.stateRevision)
      ? [{ label: "状态版本", value: `revision ${event.stateRevision}` }]
      : []),
    ...(event.sceneLabel
      ? [{ label: "家中端上下文", value: event.sceneLabel }]
      : []),
    ...(event.captureLabel
      ? [{ label: "采集状态", value: event.captureLabel }]
      : []),
    ...(event.runtimeLabel
      ? [{ label: "本地能力", value: event.runtimeLabel }]
      : []),
    ...(event.actionCard
      ? [
          { label: "系统判断", value: event.actionCard.system_judgment },
          { label: "处理时效", value: event.actionCard.time_window },
        ]
      : []),
    ...(event.alarm
      ? [
          {
            label: "告警触发",
            value: TIMELINE_ALARM_TRIGGER_COPY[event.alarm.trigger] || event.alarm.trigger,
          },
          { label: "告警通道", value: event.alarm.channels.join("、") },
        ]
      : []),
  ];
  const sourceChip = event.assessmentSource
    ? TIMELINE_SOURCE_COPY[event.assessmentSource]?.short || event.assessmentSource
    : null;
  return (
    <article className={`timeline-event-card kind-${event.kind} is-${event.tone} ${event.source === "mock_fixture" ? "is-mock" : ""}`}>
      <button
        className="timeline-event-summary"
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="timeline-event-marker"><EventIcon /></span>
        <span className="timeline-event-content">
          <span className="timeline-event-meta">
            <span className="timeline-event-time"><time dateTime={dateTime}>{formatTime(event.timestampMs)}</time><small>{event.label}</small></span>
            {event.statusLabel && <strong>{event.statusLabel}</strong>}
          </span>
          <span className="timeline-event-copy">
            <b>{event.title}</b>
            {event.detail && event.detail !== event.title && <span><em>判断依据</em>{event.detail}</span>}
          </span>
          {(sourceChip || event.uncertainty || event.visualContext?.sentToMimo) && (
            <span className="timeline-event-chips" aria-label="判断标签">
              {sourceChip && <small>{sourceChip}</small>}
              {event.uncertainty && <small>不确定性 {TIMELINE_UNCERTAINTY_COPY[event.uncertainty] || "未知"}</small>}
              {event.visualContext?.sentToMimo && <small>{event.visualContext.type === "clip" ? "最小短片" : "最小关键帧"}</small>}
            </span>
          )}
          {(event.suggestedAction || event.progress) && (
            <span className="timeline-event-actions">
              {event.suggestedAction && (
                <span><TipsAndUpdatesRoundedIcon /><small>建议动作</small><b>{event.suggestedAction}</b></span>
              )}
              {event.progress && (
                <span><CheckCircleRoundedIcon /><small>处理进展</small><b>{event.progress}</b></span>
              )}
            </span>
          )}
        </span>
        <ExpandMoreRoundedIcon className={expanded ? "is-expanded" : ""} />
      </button>
      {expanded && (
        <div className="timeline-event-details">
          {details.map((detail) => (
            <div key={detail.label}><span>{detail.label}</span><b>{detail.value}</b></div>
          ))}
          <p>{event.kind === "alarm"
            ? "这是确定性安全规则发布的告警；MiMo 不能降低、取消或延迟它。"
            : event.kind === "action_card"
              ? "这是本人明确表达并授权告知家人后生成的非紧急待办，不是医疗诊断或安全告警。"
              : "关怀判词只解释本次结构化结论，不等于医疗诊断，也不会自动变成行动卡或告警。"}</p>
        </div>
      )}
    </article>
  );
}

const REME_ACTIVITY_ICONS = Object.freeze({
  aircon: AcUnitRoundedIcon,
  bed: BedRoundedIcon,
  cleaning: CleaningServicesRoundedIcon,
  door: DoorFrontRoundedIcon,
  fridge: KitchenRoundedIcon,
  walk: DirectionsWalkRoundedIcon,
  kitchen: SoupKitchenRoundedIcon,
  laundry: LocalLaundryServiceRoundedIcon,
  light: LightbulbRoundedIcon,
  night: NightsStayRoundedIcon,
  seat: ChairRoundedIcon,
  shower: ShowerRoundedIcon,
  speaker: SpeakerRoundedIcon,
  window: WindowRoundedIcon,
});

function RemeActivityRow({ entry }) {
  const [expanded, setExpanded] = useState(false);
  const ActivityIcon = REME_ACTIVITY_ICONS[entry.icon] || DirectionsWalkRoundedIcon;
  const dateTime = new Date(entry.timestampMs).toISOString();
  return (
    <article className={`reme-life-event ${entry.kind === "device" ? "is-device" : "is-activity"}`}>
      <button
        type="button"
        className="reme-life-event-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="reme-life-event-icon"><ActivityIcon /></span>
        <time dateTime={dateTime}>{formatTime(entry.timestampMs)}</time>
        <span className="reme-life-event-title">{entry.title}</span>
        <ArrowForwardIosRoundedIcon className={expanded ? "is-expanded" : ""} />
      </button>
      {expanded && (
        <div className="reme-life-event-detail">
          <b>{entry.label} · 非真实家庭历史</b>
          <p>{entry.detail} {entry.kind === "device"
            ? "设备名称与状态均为固定演示数据。"
            : "不包含原始画面、音频或可识别人物影像。"}</p>
          {entry.related.length > 0 && (
            <ul>
              {entry.related.map((related) => (
                <li key={`${entry.id}:${related.timestampMs}`}>
                  <time dateTime={new Date(related.timestampMs).toISOString()}>{formatTime(related.timestampMs)}</time>
                  <span>{related.title}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </article>
  );
}

function RemeCareThread({ event }) {
  const [expanded, setExpanded] = useState(false);
  const [materialExpanded, setMaterialExpanded] = useState(false);
  const response = event.linkedResponse;
  const material = event.familyMaterial;
  const dateTime = new Date(event.timestampMs).toISOString();
  const responseDateTime = response ? new Date(response.timestampMs).toISOString() : null;
  const materialDateTime = material ? new Date(material.deliveredAtMs).toISOString() : null;
  return (
    <article className={`reme-care-thread is-${event.tone} ${response ? "has-response" : ""}`}>
      <button
        type="button"
        className="reme-care-card"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="reme-care-icon"><FavoriteRoundedIcon /></span>
        <span className="reme-care-copy">
          <span className="reme-care-meta"><time dateTime={dateTime}>{formatTime(event.timestampMs)}</time><b>主动关怀</b></span>
          <strong>{event.title}</strong>
          {event.checkIn && (
            <span className="reme-care-question-copy">
              <VolumeUpRoundedIcon />
              <span><small>MiMo 发问</small><b>“{event.checkIn.prompt}”</b></span>
            </span>
          )}
          <small className="reme-care-basis">依据：{event.detail} · 不确定性{TIMELINE_UNCERTAINTY_COPY[event.uncertainty] || "未知"}</small>
        </span>
        <span className="reme-care-status">{event.statusLabel}</span>
      </button>
      {expanded && (
        <div className="reme-care-details">
          <div><span>判断来源</span><b>{TIMELINE_SOURCE_COPY[event.assessmentSource]?.detail || "演示脚本"}</b></div>
          <div><span>建议动作</span><b>{event.suggestedAction}</b></div>
          <div><span>处理进展</span><b>{event.progress}</b></div>
          <p>关怀判断不等于医疗诊断；本卡只展示固定 Mock 结构化结论，不包含原始画面或完整对话。</p>
        </div>
      )}
      {response && (
        <button
          type="button"
          className="reme-care-response"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <SubdirectoryArrowRightRoundedIcon className="reme-care-connector" />
          <span><ChatBubbleOutlineRoundedIcon /></span>
          <time dateTime={responseDateTime}>{formatTime(response.timestampMs)}</time>
          <b>{response.title}</b>
          <ArrowForwardIosRoundedIcon className={expanded ? "is-expanded" : ""} />
        </button>
      )}
      {material && (
        <>
          <button
            type="button"
            className="reme-care-material"
            aria-expanded={materialExpanded}
            onClick={() => setMaterialExpanded((value) => !value)}
          >
            <span className="reme-care-material-icon"><AutoAwesomeRoundedIcon /></span>
            <span className="reme-care-material-copy"><small>MiMo 已整理</small><b>{material.label}</b></span>
            <span className="reme-care-material-meta">
              <small><VideocamRoundedIcon />{material.attachment.durationSeconds} 秒</small>
              <em>{material.deliveryStatus}</em>
            </span>
            <ArrowForwardIosRoundedIcon className={materialExpanded ? "is-expanded" : ""} />
          </button>
          {materialExpanded && (
            <div className="reme-care-material-details">
              <p>{material.summary}</p>
              <div><span>问候对话</span><b>1 问 1 答</b></div>
              <div><span>姿态依据</span><b>{material.evidence}</b></div>
              <div><span>随附片段</span><b>{material.attachment.label} · {material.attachment.durationSeconds} 秒 · Mock</b></div>
              <div><span>整理来源</span><b>{material.modelLabel}</b></div>
              <div><span>送达对象</span><b>{material.recipient}</b></div>
              <div><span>家属送达</span><b><time dateTime={materialDateTime}>{formatTime(material.deliveredAtMs)}</time> · {material.deliveryStatus}</b></div>
              {material.facts.length > 0 && (
                <ol className="reme-care-material-facts" aria-label="全屋设备事实">
                  {material.facts.map((fact) => <li key={fact}>{fact}</li>)}
                </ol>
              )}
              <small>演示材料只保留结构化摘要和匿名骨架短片元数据，不代表真实视频已上传或形成跨会话家庭档案。</small>
            </div>
          )}
        </>
      )}
    </article>
  );
}

function isRemeCareEntry(entry) {
  return !["activity", "device"].includes(entry.kind);
}

function RemeDaypartSection({ section, filter, expanded, onToggle }) {
  const entries = filter === "care"
    ? section.entries.filter(isRemeCareEntry)
    : filter === "device"
      ? section.entries.filter((entry) => entry.kind === "device")
      : section.entries;
  if (entries.length === 0) return null;
  const DaypartIcon = section.icon === "moon"
    ? NightsStayRoundedIcon
    : section.icon === "sunset" ? WbTwilightRoundedIcon : WbSunnyRoundedIcon;
  const filteredCount = filter === "care"
    ? `${section.careCount} 次关怀`
    : filter === "device" ? `${section.deviceCount} 条设备` : `${section.count} 条`;
  const contentId = `reme-daypart-${section.id}`;
  return (
    <section className={`reme-daypart ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <button
        type="button"
        className="reme-daypart-heading"
        aria-expanded={expanded}
        aria-controls={contentId}
        onClick={onToggle}
      >
        <span className="reme-daypart-icon"><DaypartIcon /></span>
        <span className="reme-daypart-name">{section.label}</span>
        <span className="reme-daypart-range">{section.range}</span>
        <span className="reme-daypart-count">· {filteredCount}</span>
        {!expanded && section.careCount > 0 && filter === "all" && (
          <span className="reme-daypart-care-count">含 {section.careCount} 次关怀</span>
        )}
        <ExpandMoreRoundedIcon className={expanded ? "is-expanded" : ""} />
      </button>
      {expanded && (
        <div className="reme-daypart-events" id={contentId}>
          {entries.map((entry) => (
            entry.kind === "assessment"
              ? <RemeCareThread event={entry} key={entry.id} />
              : ["activity", "device"].includes(entry.kind)
                ? <RemeActivityRow entry={entry} key={entry.id} />
                : <TimelineEventCard event={entry} key={entry.id} />
          ))}
        </div>
      )}
    </section>
  );
}

function buildRealtimeRemeDay(dateKey) {
  const descriptor = FAMILY_TIMELINE_DISPLAY_DAYS.find((day) => day.dateKey === dateKey);
  if (!descriptor) return null;
  return {
    ...descriptor,
    source: "realtime",
    coverageHours: 0,
    totalCount: 0,
    activityCount: 0,
    deviceCount: 0,
    careCount: 0,
    sections: FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => ({
      ...daypart,
      count: 0,
      activityCount: 0,
      deviceCount: 0,
      careCount: 0,
      entries: [],
    })),
  };
}

function shanghaiDaypartId(timestampMs) {
  const hour = new Date(timestampMs + 8 * 60 * 60 * 1000).getUTCHours();
  if (hour < 6) return "night";
  if (hour < 10) return "early";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function eligibleRealtimeEvents(day, liveEvents) {
  if (day.sourceMode === "mock") return [];
  return liveEvents.filter((event) => (
    Number.isFinite(event.timestampMs)
    && event.timestampMs > 0
    && (day.sourceMode !== "hybrid" || event.timestampMs >= FAMILY_TIMELINE_REALTIME_CUTOFF_MS)
  ));
}

function mergeRealtimeIntoRemeDay(day, realtimeEvents) {
  const byDaypart = new Map(FAMILY_TIMELINE_MOCK_DAYPARTS.map((daypart) => [daypart.id, []]));
  for (const event of realtimeEvents) {
    byDaypart.get(shanghaiDaypartId(event.timestampMs))?.push(event);
  }
  const sections = day.sections.map((section) => {
    const entries = [...section.entries, ...(byDaypart.get(section.id) || [])]
      .sort((left, right) => left.timestampMs - right.timestampMs || left.id.localeCompare(right.id));
    return {
      ...section,
      entries,
      count: entries.reduce((total, entry) => total + (entry.count || 1), 0),
      activityCount: entries.filter((entry) => entry.kind === "activity")
        .reduce((total, entry) => total + (entry.count || 1), 0),
      deviceCount: entries.filter((entry) => entry.kind === "device")
        .reduce((total, entry) => total + (entry.count || 1), 0),
      careCount: entries.filter(isRemeCareEntry).length,
    };
  });
  return {
    ...day,
    sections,
    realtimeCount: realtimeEvents.length,
    totalCount: sections.reduce((total, section) => total + section.count, 0),
    activityCount: sections.reduce((total, section) => total + section.activityCount, 0),
    deviceCount: sections.reduce((total, section) => total + section.deviceCount, 0),
    careCount: sections.reduce((total, section) => total + section.careCount, 0),
  };
}

function RemeDateStrip({ selectedDateKey, onSelectDate }) {
  return (
    <section className="reme-week-strip" aria-label="8 天 Reme 记录日期">
      <div className="reme-week-days">
        {FAMILY_TIMELINE_DISPLAY_DAYS.map((day) => (
          <button
            type="button"
            key={day.dateKey}
            className={`${day.dateKey === selectedDateKey ? "is-selected" : ""} is-${day.sourceMode}`}
            aria-pressed={day.dateKey === selectedDateKey}
            onClick={() => onSelectDate(day.dateKey)}
          >
            <span>周{day.weekday}</span>
            <b>{day.day}</b>
            {day.sourceMode !== "mock" && <small>{day.sourceMode === "hybrid" ? "混" : "实"}</small>}
            {day.dateKey === selectedDateKey && <FiberManualRecordRoundedIcon />}
          </button>
        ))}
      </div>
    </section>
  );
}

function RemeSourceBoundary({ day, realtimeCount, interrupted }) {
  const copy = day.sourceMode === "mock"
    ? {
        title: "演示历史 · 明确标注 Mock",
        detail: "8 月 4—9 日用于完整展示 Reme 能记住什么，不冒充真实家庭历史。",
        status: "Mock",
      }
    : day.sourceMode === "hybrid"
      ? {
          title: "今天中午是数据来源交接点",
          detail: "8 月 10 日 12:00 前保留 Mock；12:00 后只展示 Backend / Relay 的真实记录，没有数据就留空。",
          status: interrupted ? "实时中断" : `${realtimeCount} 条实时`,
        }
      : {
          title: "实时记录 · 不再补 Mock",
          detail: "这里仅展示 Backend / Relay 实际送达的内容；尚未发生或尚未接入的能力会保持空白。",
          status: interrupted ? "实时中断" : `${realtimeCount} 条实时`,
        };
  return (
    <aside className={`reme-source-boundary is-${day.sourceMode} ${interrupted && day.sourceMode !== "mock" ? "is-interrupted" : ""}`}>
      <SensorsRoundedIcon />
      <div><b>{copy.title}</b><span>{copy.detail}</span></div>
      <strong>{copy.status}</strong>
    </aside>
  );
}

const MIMO_DIARY_UNCERTAINTY_COPY = Object.freeze({
  low: "低不确定性",
  medium: "中等不确定性",
  high: "高不确定性",
});

function mimoDiaryUnavailableCopy(error) {
  if (error?.code === "mimo_invalid_diary_summary") {
    return "MiMo 返回内容未通过 JSON 结构校验，本次结果未采用。";
  }
  if (["mimo_unavailable", "mimo_summary_disabled"].includes(error?.code)) {
    return "MiMo 摘要服务尚未连接，当前不显示替代摘要。";
  }
  return "暂时无法连接 MiMo 摘要接口，当前不显示替代摘要。";
}

function RemeTimeline({ day, onSelectDate, liveEvents, interrupted }) {
  const [filter, setFilter] = useState("all");
  const [expandedDayparts, setExpandedDayparts] = useState(() => new Set(["early", "morning"]));
  const { httpBase } = useMemo(() => getDecisionUrls(), []);
  const realtimeEvents = eligibleRealtimeEvents(day, liveEvents);
  const displayDay = mergeRealtimeIntoRemeDay(day, realtimeEvents);
  const diaryRequestJson = JSON.stringify(buildMimoDiarySummaryRequest(day, realtimeEvents));
  const diaryRequest = JSON.parse(diaryRequestJson);
  const noDiaryEvents = diaryRequest.events.length === 0;
  const [daySummary, setDaySummary] = useState(() => ({
    requestKey: null,
    status: "loading",
    data: null,
    message: "MiMo 正在读取今天的结构化生活记录。",
  }));

  useEffect(() => {
    const controller = new AbortController();
    const requestPayload = JSON.parse(diaryRequestJson);
    let active = true;
    if (requestPayload.events.length === 0) {
      return () => {
        active = false;
        controller.abort();
      };
    }
    const timeoutId = window.setTimeout(() => {
      setDaySummary({
        requestKey: diaryRequestJson,
        status: "loading",
        data: null,
        message: "MiMo 正在读取今天的结构化生活记录。",
      });
      requestMimoDiarySummary(httpBase, requestPayload, controller.signal)
        .then(parseMimoDiarySummaryResponse)
        .then((summary) => {
          if (!active) return;
          if (summary.date !== requestPayload.date) {
            throw new TypeError("MiMo 摘要日期与请求不一致");
          }
          setDaySummary({ requestKey: diaryRequestJson, status: "live", data: summary, message: "" });
        })
        .catch((error) => {
          if (!active || error?.name === "AbortError") return;
          setDaySummary({
            requestKey: diaryRequestJson,
            status: "unavailable",
            data: null,
            message: mimoDiaryUnavailableCopy(error),
          });
        });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [diaryRequestJson, httpBase]);

  const summaryIsCurrent = daySummary.requestKey === diaryRequestJson;
  const summaryState = noDiaryEvents ? "empty" : summaryIsCurrent ? daySummary.status : "loading";
  const liveSummary = summaryState === "live" ? daySummary.data : null;
  const summaryHeadline = liveSummary
    ? liveSummary.headline
    : summaryState === "loading"
      ? "正在生成本日动态摘要…"
      : summaryState === "empty" ? "等待真实记录形成今日摘要" : "本日动态摘要暂不可用";
  const summaryCopy = liveSummary
    ? liveSummary.summary
    : summaryState === "loading"
      ? "MiMo 正在读取今天的结构化生活记录。"
      : summaryState === "empty" ? "尚未收到真实记录；这里不会用 Mock 摘要填充。" : daySummary.message;
  const summaryStatus = summaryState === "live"
    ? "MiMo 实时生成"
    : summaryState === "loading" ? "正在生成" : summaryState === "empty" ? "等待记录" : "MiMo 未连接";

  const selectFilter = (nextFilter) => {
    setFilter(nextFilter);
    if (nextFilter === "all") {
      setExpandedDayparts(new Set(["early", "morning"]));
      return;
    }
    const countKey = nextFilter === "device" ? "deviceCount" : "careCount";
    setExpandedDayparts(new Set(
      displayDay.sections.filter((section) => section[countKey] > 0).map((section) => section.id),
    ));
  };
  const toggleDaypart = (daypartId) => {
    setExpandedDayparts((current) => {
      const next = new Set(current);
      if (next.has(daypartId)) next.delete(daypartId);
      else next.add(daypartId);
      return next;
    });
  };

  return (
    <main className="viewer-page timeline-page reme-timeline-page">
      <RemeDateStrip selectedDateKey={day.dateKey} onSelectDate={onSelectDate} />
      <RemeSourceBoundary
        day={day}
        realtimeCount={displayDay.realtimeCount}
        interrupted={interrupted}
      />

      <section
        className="reme-mimo-summary"
        aria-labelledby="reme-day-summary-title"
        aria-live="polite"
        aria-atomic="true"
        data-summary-schema={liveSummary?.schema_version || "pending"}
      >
          <div className="reme-mimo-summary-heading">
            <span className="reme-mimo-summary-label"><AutoAwesomeRoundedIcon /><b>MiMo 本日动态摘要</b></span>
            <span className={`reme-mimo-summary-status is-${summaryState}`}><FiberManualRecordRoundedIcon />{summaryStatus}</span>
          </div>
          <h2 id="reme-day-summary-title">{summaryHeadline}</h2>
          <p>{summaryCopy}</p>
          {liveSummary?.highlights.length > 0 && (
            <ol className="reme-mimo-highlights" aria-label="MiMo 提取的重点片段">
              {liveSummary.highlights.map((item) => (
                <li key={`${item.time}:${item.text}`}><time>{item.time}</time><span>{item.text}</span></li>
              ))}
            </ol>
          )}
          {liveSummary?.care_note && <p className="reme-mimo-care-note">关怀进展 · {liveSummary.care_note}</p>}
          <div className="reme-mimo-summary-footer">
            {liveSummary ? (
              <time dateTime={new Date(liveSummary.generated_at_ms).toISOString()}>生成于 {formatTime(liveSummary.generated_at_ms)}</time>
            ) : <span>未使用 Mock 摘要</span>}
            <span>{liveSummary
              ? `已吸收 ${liveSummary.input_event_count} 条结构化${day.sourceMode === "mock" ? "演示" : day.sourceMode === "hybrid" ? "混合" : "实时"}记录 · ${liveSummary.model} · ${MIMO_DIARY_UNCERTAINTY_COPY[liveSummary.uncertainty]}`
              : day.sourceMode === "mock"
                ? `已准备 ${diaryRequest.events.length} 条结构化演示记录`
                : day.sourceMode === "hybrid"
                  ? `已准备 ${diaryRequest.events.length} 条结构化记录 · 12:00 前为 Mock`
                  : `已收到 ${diaryRequest.events.length} 条结构化实时记录`}</span>
          </div>
      </section>

      <section className="reme-day-summary" aria-label="今日记录统计">
        <div className="reme-day-statistics">
          <span>{day.sourceMode === "mock" ? "24 小时演示" : day.sourceMode === "hybrid" ? "上午演示 · 午后实时" : "实时记录"}</span>
          <p><b>{displayDay.totalCount}</b> 个生活片段</p>
        </div>
        <div className="reme-source-mix" aria-label="记录来源">
          <span><DirectionsWalkRoundedIcon /><b>{displayDay.activityCount}</b> 人体与空间</span>
          <span><SensorsRoundedIcon /><b>{displayDay.deviceCount}</b> 全屋设备</span>
          <span><FavoriteRoundedIcon /><b>{displayDay.careCount}</b> 主动关怀</span>
        </div>
        <div className="reme-timeline-filter" role="group" aria-label="筛选时间线记录">
          <button type="button" className={filter === "all" ? "is-selected" : ""} aria-pressed={filter === "all"} onClick={() => selectFilter("all")}>全部 <b>{displayDay.totalCount}</b></button>
          <button type="button" className={filter === "device" ? "is-selected" : ""} aria-pressed={filter === "device"} onClick={() => selectFilter("device")}>设备 <b>{displayDay.deviceCount}</b></button>
          <button type="button" className={filter === "care" ? "is-selected" : ""} aria-pressed={filter === "care"} onClick={() => selectFilter("care")}>关怀 <b>{displayDay.careCount}</b></button>
        </div>
      </section>

      <div className="reme-dayparts">
        {displayDay.sections.map((section) => (
          <RemeDaypartSection
            key={section.id}
            section={section}
            filter={filter}
            expanded={expandedDayparts.has(section.id)}
            onToggle={() => toggleDaypart(section.id)}
          />
        ))}
      </div>

      {day.sourceMode !== "mock" && (
        <section className={`reme-realtime-window ${interrupted ? "is-interrupted" : ""}`} role="status">
          <FiberManualRecordRoundedIcon />
          <div>
            <b>{interrupted
              ? "实时同步暂时中断"
              : displayDay.realtimeCount > 0 ? "真实记录正在进入时间线" : "尚未收到真实记录"}</b>
            <span>{interrupted
              ? "已收到的记录只作过期展示；连接恢复后继续追加。"
              : displayDay.realtimeCount > 0
                ? "这些记录来自当前 Backend / Relay，不属于 Mock 历史。"
                : "这里不会为了填满时间线而补写 Mock 数据。"}</span>
          </div>
          <strong>{day.sourceMode === "hybrid" ? "12:00 后" : "全天"}</strong>
        </section>
      )}
    </main>
  );
}

function TimelinePage({ timeline, relay, selectedDateKey, onSelectDate, nowMs }) {
  const todayKey = dateKeyFromTimestamp(nowMs);
  const selectableThrough = todayKey > FAMILY_TIMELINE_DISPLAY_END_DATE
    ? todayKey
    : FAMILY_TIMELINE_DISPLAY_END_DATE;
  const weekDays = buildWeekDays(selectedDateKey, nowMs, selectableThrough);
  const liveEvents = filterTimelineEventsByDate(timeline.events, selectedDateKey);
  const events = [...liveEvents]
    .sort((left, right) => right.timestampMs - left.timestampMs || left.id.localeCompare(right.id));
  const mockDay = getFamilyTimelineMockDay(selectedDateKey);
  const remeDay = mockDay || (isFamilyTimelineDisplayDate(selectedDateKey)
    ? buildRealtimeRemeDay(selectedDateKey)
    : null);
  const interrupted = Boolean(
    relay.unavailableReason
      || !relay.monitorOnline
      || relay.connection !== "connected",
  );
  const canGoForward = shiftDateKey(selectedDateKey, 7) <= selectableThrough;
  const changeWeek = (offset) => {
    const candidate = shiftDateKey(selectedDateKey, offset * 7);
    onSelectDate(candidate > selectableThrough ? selectableThrough : candidate);
  };
  if (remeDay) {
    return (
      <RemeTimeline
        key={remeDay.dateKey}
        day={remeDay}
        onSelectDate={onSelectDate}
        liveEvents={liveEvents}
        interrupted={interrupted}
      />
    );
  }
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

      <section className="timeline-care-intro" aria-label="主动关怀说明">
        <span><AutoAwesomeRoundedIcon /></span>
        <div><small>reme · remember me</small><h2>记住每一次值得关心的变化</h2><p>把可靠事件变成可行动的关怀判断，并标明来源、证据边界与不确定性。</p></div>
      </section>

      <aside className={`timeline-session-note ${interrupted ? "is-interrupted" : ""}`}>
        {interrupted ? <RefreshRoundedIcon /> : <LockRoundedIcon />}
        <div>
          <b>{interrupted ? "同步已中断，以下不是当前现场" : "当前关怀记录 · 仅本次会话"}</b>
          <span>{interrupted
            ? "保留本页此前收到的记录；恢复后继续追加权威更新。"
            : "公开演示不保存跨天家庭历史；刷新或换房间后清空。"}</span>
        </div>
        <strong>{events.length} 条</strong>
      </aside>

      {events.length > 0 ? (
        <section className="timeline-event-section">
          <div className="timeline-section-heading"><div><h2>主动关怀记录</h2><p>{timelineDateHeading(selectedDateKey, nowMs)} · 点击查看判断来源、不确定性与隐私边界</p></div><span>最新在前</span></div>
          <div className="timeline-event-list">
            {events.map((event) => <TimelineEventCard event={event} key={event.id} />)}
          </div>
        </section>
      ) : (
        <section className="timeline-empty-state" role="status">
          <span><EventBusyRoundedIcon /></span>
          <h2>{selectedDateKey === todayKey
            ? interrupted ? "家中端暂未连接" : "等待可靠的关怀判断"
            : "这一天没有可用记录"}</h2>
          <p>{selectedDateKey === todayKey
            ? interrupted
              ? "恢复同步后，新的关怀判断会继续出现在这里。"
              : "发现可靠事件后，MiMo 或确定性安全规则才会生成一条有来源的判断。"
            : "跨天历史服务尚未接入，因此不会用演示文案填充真实时间线。"}</p>
        </section>
      )}
    </main>
  );
}

function DashboardContent({ relay, snapshot, activeGrant, nowMs, familySurface = false }) {
  const sceneId = deriveFamilyTruth(snapshot, relay).sceneId;
  const scene = sceneId ? SCENE_COPY[sceneId] : null;
  const SceneIcon = scene?.Icon || SensorsRoundedIcon;
  return (
    <>
      <section className="dashboard-summary">
        <h2>本次同步摘要</h2>
        <div className="summary-metrics">
          <div><GroupsRoundedIcon /><b>{relay.viewerCount}</b><span>{familySurface ? "在线访问端" : "在线 Viewer"}</span></div>
          <div><DashboardRoundedIcon /><b>{relay.unavailableReason ? "不可用" : snapshot?.state_revision ?? "—"}</b><span>{familySurface ? "同步版本" : "状态 revision"}</span></div>
          <div><VideocamRoundedIcon /><b>{activeGrant ? `${secondsRemaining(activeGrant.expires_at_ms, nowMs)}s` : "关闭"}</b><span>原画窗口</span></div>
        </div>
        <p><LockRoundedIcon /> {familySurface
          ? "公开演示连接无账号验证；这些数字不是医疗指标或准确率。"
          : "固定公开演示房间；这些数字不是医疗指标或准确率。"}</p>
      </section>
      <section className="dashboard-section">
        <h2>当前能力</h2>
        <div className="capability-grid">
          <article><SceneIcon /><div><b>{scene?.label || "等待权威状态"}</b><span>{scene ? "当前场景" : "现场未知"}</span></div></article>
          <article><HealthAndSafetyRoundedIcon /><div><b>{RUNTIME_COPY[snapshot?.state.runtime.status] || "等待状态"}</b><span>{snapshot?.state.runtime.capability || "unavailable"}</span></div></article>
          <article><VideocamRoundedIcon /><div><b>{captureCopy(snapshot?.state.capture.status, familySurface) || "等待状态"}</b><span>{snapshot?.state.capture.source_kind || "未选择媒体源"}</span></div></article>
          {familySurface
            ? <article><PrivacyTipRoundedIcon /><div><b>无账号验证</b><span>任何拿到链接的人可加入</span></div></article>
            : <article><TuneRoundedIcon /><div><b>{relay.controller ? "控制租约使用中" : "控制权可接管"}</b><span>{relay.controller ? shortId(relay.controller.viewer_id) : "单一 30 秒租约"}</span></div></article>}
        </div>
      </section>
      <section className="dashboard-section">
        <h2>连接与失败可见性</h2>
        <div className="truth-list">
          <div><span className={relay.connection === "connected" ? "truth-dot is-ok" : "truth-dot"} /><p><b>{familySurface ? "公开演示连接" : "Relay"}</b><small>{relay.connection === "connected" ? "已连接" : "断线重连中"}</small></p></div>
          <div><span className={relay.monitorOnline ? "truth-dot is-ok" : "truth-dot"} /><p><b>{familySurface ? "家中端" : "Monitor producer"}</b><small>{relay.monitorOnline ? "在线" : familySurface ? "离线，已停止显示现场状态" : "离线，已撤销原画与控制"}</small></p></div>
          <div><span className={snapshot?.state.runtime.status === "ready" ? "truth-dot is-ok" : "truth-dot"} /><p><b>{familySurface ? "本地感知" : "本地运行时"}</b><small>{snapshot?.state.runtime.detail || RUNTIME_COPY[snapshot?.state.runtime.status] || "未发布"}</small></p></div>
        </div>
      </section>
    </>
  );
}

function DashboardPage(props) {
  return <main className="viewer-page dashboard-page"><DashboardContent {...props} /></main>;
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

function SettingsPage({
  relay,
  highPrivacyEnabled,
  setHighPrivacyEnabled,
  notificationsEnabled,
  setNotificationsEnabled,
  familySurface = false,
}) {
  return (
    <main className="viewer-page settings-page">
      <section className="home-profile-card">
        <span><HomeRoundedIcon /></span>
        <div><h2>外婆家</h2><p>{familySurface ? `${relay.viewerCount} 个在线访问端` : `${relay.viewerCount} 位 Viewer 已连接`}</p><b className={relay.monitorOnline ? "is-online" : "is-offline"}><i /> {relay.monitorOnline ? (familySurface ? "家中端在线" : "Monitor 运行中") : (familySurface ? "家中端离线" : "Monitor 已离线")}</b></div>
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
          <SettingsRow icon={VideocamRoundedIcon} title="MiMo 视觉上下文" detail="跌倒确认等事件需要时，家中端可按需选定单帧或短片送 MiMo（非连续上传）" action={<b className="setting-state">按需</b>} />
          <SettingsRow icon={MicRoundedIcon} title="家中端问询语音" detail="麦克风默认禁用，仅在问询窗口录制；问询语音按需送 MiMo，本页不接收家中麦克风流" action={<b className="setting-state">按需</b>} />
          <SettingsRow icon={GroupsRoundedIcon} title="分享授权" detail="事件期原画仅在限时授权内向全部在线 Viewer 开放" action={<ArrowForwardIosRoundedIcon />} />
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
          <SettingsRow icon={ShieldRoundedIcon} title="安全规则" detail={familySurface ? "本页不能取消或降低权威告警" : "Viewer 不能取消或降低权威告警"} action={<b className="setting-state">只读</b>} />
          <SettingsRow icon={GroupsRoundedIcon} title={familySurface ? "公开演示连接" : "公开房间"} detail={`${relay.viewerCount}/${relay.maxViewers} 在线 · ${familySurface ? "无账号验证" : "无身份认证"}`} action={<ArrowForwardIosRoundedIcon />} />
        </div>
      </section>
      <section className="settings-group">
        <h2>连接</h2>
        <div className="settings-card compact-settings-card">
          <SettingsRow icon={DashboardRoundedIcon} title={familySurface ? "演示会话" : "房间会话"} detail={shortId(relay.roomSessionId)} action={<span />} muted={!relay.roomSessionId} />
          <SettingsRow icon={VideocamRoundedIcon} title="事件期媒体" detail={familySurface ? "演示媒体；未配置 TURN 时仅限本机或局域网" : relayAvailabilityCopy()} action={<span />} />
        </div>
      </section>
    </main>
  );
}

function CommandButton({ icon: Icon, children, onClick, disabled, tone = "default" }) {
  return <Button className={`command-button is-${tone}`} startIcon={<Icon />} onClick={onClick} disabled={disabled}>{children}</Button>;
}

function ControlDrawer({ open, onClose, relay, snapshot, decision, nowMs, onIssue, issueError }) {
  const desktop = useMediaQuery("(min-width: 900px)");
  const pending = hasPendingCommand(relay);
  const disabled = !relay.ownsControl || !snapshot || pending;
  const decisionId = decision?.decision_id;
  const alarmActive = isFamilyAlarm(decision);
  const actionCardPending = isPendingFamilyActionCard(decision);
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
          <CommandButton icon={ShieldRoundedIcon} disabled={disabled || !decisionId || !alarmActive} onClick={() => onIssue({ name: "acknowledge_alarm", decision_id: decisionId })}>确认告警</CommandButton>
          <CommandButton icon={TipsAndUpdatesRoundedIcon} disabled={disabled || !decisionId || !actionCardPending} onClick={() => onIssue({ name: "confirm_action_card", decision_id: decisionId })}>确认行动卡</CommandButton>
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

function EmergencyDialog({
  open,
  onClose,
  decision,
  activeGrant,
  nowMs,
  ownsControl,
  controllerBlocked = false,
  onIssue,
  onFamilyConfirm,
  familyConfirmPending = false,
  familyConfirmApplied = false,
  familyConfirmError = "",
  familySurface = false,
  soundBlocked,
  onRetrySound,
}) {
  if (!isFamilyAlarm(decision)) return null;
  const message = familyCareMessage(decision)
    || "权威规则已升级并通知家属，请尽快确认。";
  const familyConfirmLabel = familyConfirmApplied
    ? "已确认收到告警"
    : familyConfirmPending
      ? "正在提交处理确认…"
      : controllerBlocked
        ? "其他访问端正在处理"
        : ownsControl ? "确认已收到告警" : "确认并处理";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      aria-labelledby="reme-emergency-title"
      aria-describedby="reme-emergency-message"
      slotProps={{ paper: { className: "emergency-dialog" } }}
    >
      <IconButton className="emergency-close" onClick={onClose} aria-label="收起紧急提醒"><CloseRoundedIcon /></IconButton>
      <span className="emergency-dialog-mark"><EmergencyRoundedIcon /></span>
      <small>紧急风险提醒</small>
      <h2 id="reme-emergency-title">检测到需要关注的安全事件</h2>
      <p id="reme-emergency-message">{message}</p>
      <div className="emergency-dialog-context">
        <AlarmRoundedIcon />
        <div>
          <b>{activeGrant ? `原画开放还剩 ${secondsRemaining(activeGrant.expires_at_ms, nowMs)} 秒` : "当前保持匿名骨架"}</b>
          <span>{familySurface ? "公开演示连接无账号验证；限时授权原画对全部在线 Viewer 可见" : "固定公开房间内全部在线 Viewer 可见授权原画"}</span>
        </div>
      </div>
      {familySurface ? (
        <>
          <Button
            variant="contained"
            color="error"
            startIcon={<ShieldRoundedIcon />}
            disabled={!decision.decision_id || familyConfirmPending || familyConfirmApplied || controllerBlocked}
            onClick={() => onFamilyConfirm(decision.decision_id, "acknowledge_alarm")}
          >
            {familyConfirmLabel}
          </Button>
          {familyConfirmError && <p className="family-confirm-error" role="alert">{familyConfirmError}</p>}
          <small className="emergency-control-note">
            {controllerBlocked
              ? "已有其他访问端取得短时处理权限；告警仍保持可见。"
              : "确认时会先取得短时处理权限，再提交本次告警回执；不会开放场景或媒体控制。"}
          </small>
        </>
      ) : (
        <>
          <Button variant="contained" color="error" startIcon={<ShieldRoundedIcon />} disabled={!ownsControl || !decision.decision_id} onClick={() => onIssue({ name: "acknowledge_alarm", decision_id: decision.decision_id })}>确认已收到告警</Button>
          <Button variant="outlined" startIcon={<VolumeUpRoundedIcon />} disabled={!ownsControl || !decision.decision_id} onClick={() => onIssue({ name: "replay_voice", decision_id: decision.decision_id })}>重播现场问询</Button>
        </>
      )}
      {soundBlocked && <Button variant="text" onClick={onRetrySound}>点击启用本页告警声音</Button>}
      {!familySurface && !ownsControl && <small className="emergency-control-note">接管控制后才能提交处理命令；告警本身始终可见。</small>}
    </Dialog>
  );
}

export function ViewerApp({ surface = "family" }) {
  const familySurface = surface === "family";
  const relay = useViewerRelay();
  const rtc = useRtcConfiguration();
  const {
    claimControl,
    controller,
    ownsControl,
    releaseControl,
    sendCommand,
    viewerId,
  } = relay;
  const [activeTab, setActiveTab] = useState("home");
  const [selectedTimelineDate, setSelectedTimelineDate] = useState(() => {
    const currentDateKey = dateKeyFromTimestamp(Date.now());
    if (!familySurface) return currentDateKey;
    return isFamilyTimelineDisplayDate(currentDateKey)
      ? currentDateKey
      : FAMILY_TIMELINE_MOCK_END_DATE;
  });
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [issueError, setIssueError] = useState("");
  const [familyConfirmFailure, setFamilyConfirmFailure] = useState(null);
  const [pendingFamilyConfirmation, setPendingFamilyConfirmation] = useState(null);
  const [sentFamilyConfirmation, setSentFamilyConfirmation] = useState(null);
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
  const careDecision = relay.familyEventStale ? null : relay.familyEvent?.care || null;
  useEffect(() => {
    dispatchTimeline({
      type: "observe",
      roomSessionId: relay.roomSessionId,
      snapshot,
      familyEvent: relay.familyEvent,
      acks: relay.acks,
    });
  }, [relay.acks, relay.familyEvent, relay.roomSessionId, snapshot]);
  const relayNowMs = nowMs + (relay.serverTimeOffsetMs || 0);
  const sceneId = deriveFamilyTruth(snapshot, relay).sceneId
    || (familySurface ? null : "living");
  const activeGrant = useMemo(
    () => rtc.configuration.mode === "unavailable"
      ? null
      : selectActiveMediaGrant(relay, relayNowMs),
    [relay, relayNowMs, rtc.configuration.mode],
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
    rtcConfiguration: rtc.configuration,
  });
  const currentAlarm = isFamilyAlarm(careDecision) ? careDecision.alarm : null;
  const emergency = Boolean(currentAlarm);
  const decisionId = careDecision?.decision_id || null;
  const familyAcknowledgementCommand = selectFamilyAcknowledgementCommand(careDecision);
  const alertEffects = useAlertEffects({
    enabled: notificationsEnabled,
    alarm: currentAlarm,
    decisionId,
  });

  const currentSentFamilyConfirmation = sentFamilyConfirmation?.decisionId === decisionId
    && sentFamilyConfirmation?.commandName === familyAcknowledgementCommand
    ? sentFamilyConfirmation
    : null;
  const currentPendingFamilyConfirmation = pendingFamilyConfirmation?.decisionId === decisionId
    && pendingFamilyConfirmation?.commandName === familyAcknowledgementCommand
    ? pendingFamilyConfirmation
    : null;
  const familyConfirmAck = currentSentFamilyConfirmation
    ? relay.acks.find((ack) => ack.command_id === sentFamilyConfirmation.commandId) || null
    : null;
  const familyConfirmTimedOut = isFamilyConfirmationTimedOut({
    sent: currentSentFamilyConfirmation,
    ack: familyConfirmAck,
    nowMs,
  });
  const familyConfirmPending = Boolean(
    currentPendingFamilyConfirmation
      || (currentSentFamilyConfirmation
        && !familyConfirmTimedOut
        && !["applied", "rejected", "failed"].includes(familyConfirmAck?.phase)),
  );
  const familyConfirmApplied = Boolean(
    currentSentFamilyConfirmation && familyConfirmAck?.phase === "applied",
  );
  const familyConfirmAckError = ["rejected", "failed"].includes(familyConfirmAck?.phase)
    ? familyConfirmAck.reason || "处理确认未能提交，请重试"
    : "";
  const familyControllerBlocked = Boolean(
    controller
      && controller.viewer_id !== viewerId
      && !ownsControl,
  );

  const sendFamilyConfirmation = useCallback((targetDecisionId, commandName) => {
    const result = sendCommand({
      name: commandName,
      decision_id: targetDecisionId,
    });
    if (result.ok) {
      setFamilyConfirmFailure(null);
      setSentFamilyConfirmation({
        decisionId: targetDecisionId,
        commandName,
        commandId: result.commandId,
        sentAtMs: Date.now(),
      });
    } else {
      setFamilyConfirmFailure({
        decisionId: targetDecisionId,
        message: result.reason || "处理确认未能提交，请重试",
      });
    }
    return result;
  }, [sendCommand]);

  useEffect(() => {
    if (!familySurface || !currentSentFamilyConfirmation || !familyConfirmTimedOut) return undefined;
    const timedOutConfirmation = currentSentFamilyConfirmation;
    const timer = window.setTimeout(() => {
      setSentFamilyConfirmation((current) => (
        current?.commandId === timedOutConfirmation.commandId ? null : current
      ));
      setFamilyConfirmFailure({
        decisionId: timedOutConfirmation.decisionId,
        message: "未收到处理回执，已释放处理权限，请重试",
      });
      if (ownsControl) releaseControl();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    currentSentFamilyConfirmation,
    familyConfirmTimedOut,
    familySurface,
    ownsControl,
    releaseControl,
  ]);

  useEffect(() => {
    if (!familySurface || !pendingFamilyConfirmation) return undefined;
    let settlePending = null;
    if (
      relay.stateStale
      || relay.unavailableReason
      || pendingFamilyConfirmation.decisionId !== decisionId
      || pendingFamilyConfirmation.commandName !== familyAcknowledgementCommand
    ) {
      settlePending = () => {
        setPendingFamilyConfirmation(null);
        setFamilyConfirmFailure({
          decisionId,
          message: "当前待处理状态已变化，请按最新状态处理",
        });
      };
    } else if (ownsControl) {
      const targetDecisionId = pendingFamilyConfirmation.decisionId;
      const commandName = pendingFamilyConfirmation.commandName;
      settlePending = () => {
        setPendingFamilyConfirmation(null);
        const result = sendFamilyConfirmation(targetDecisionId, commandName);
        if (!result.ok) releaseControl();
      };
    } else if (familyControllerBlocked) {
      settlePending = () => {
        setPendingFamilyConfirmation(null);
        setFamilyConfirmFailure({
          decisionId: pendingFamilyConfirmation.decisionId,
          message: "其他访问端正在处理，请稍后查看最新状态",
        });
      };
    } else if (nowMs - pendingFamilyConfirmation.requestedAtMs > 5_000) {
      settlePending = () => {
        setPendingFamilyConfirmation(null);
        setFamilyConfirmFailure({
          decisionId: pendingFamilyConfirmation.decisionId,
          message: "暂未取得处理权限，请重试",
        });
      };
    }
    if (!settlePending) return undefined;
    const timer = window.setTimeout(settlePending, 0);
    return () => window.clearTimeout(timer);
  }, [
    decisionId,
    familyAcknowledgementCommand,
    familyControllerBlocked,
    familySurface,
    nowMs,
    ownsControl,
    pendingFamilyConfirmation,
    relay.stateStale,
    relay.unavailableReason,
    releaseControl,
    sendFamilyConfirmation,
  ]);

  useEffect(() => {
    if (!familySurface || !sentFamilyConfirmation || !ownsControl) return;
    if (!["applied", "rejected", "failed"].includes(familyConfirmAck?.phase)) return;
    releaseControl();
  }, [
    familyConfirmAck?.phase,
    familySurface,
    ownsControl,
    releaseControl,
    sentFamilyConfirmation,
  ]);

  useEffect(() => {
    if (
      familySurface
      && ownsControl
      && !currentPendingFamilyConfirmation
      && !currentSentFamilyConfirmation
    ) releaseControl();
  }, [
    currentPendingFamilyConfirmation,
    currentSentFamilyConfirmation,
    familySurface,
    ownsControl,
    releaseControl,
  ]);

  const requestFamilyConfirmation = (targetDecisionId, commandName) => {
    setFamilyConfirmFailure(null);
    setSentFamilyConfirmation(null);
    if (
      !targetDecisionId
      || relay.stateStale
      || relay.unavailableReason
      || commandName !== familyAcknowledgementCommand
    ) {
      setFamilyConfirmFailure({
        decisionId: targetDecisionId || decisionId,
        message: "当前没有可确认的待处理事项",
      });
      return;
    }
    if (ownsControl) {
      sendFamilyConfirmation(targetDecisionId, commandName);
      return;
    }
    if (controller) {
      setFamilyConfirmFailure({
        decisionId: targetDecisionId,
        message: "其他访问端正在处理，请稍后查看最新状态",
      });
      return;
    }
    if (!claimControl()) {
      setFamilyConfirmFailure({
        decisionId: targetDecisionId,
        message: "公开演示连接暂不可用，请检查家中端连接后重试",
      });
      return;
    }
    setPendingFamilyConfirmation({
      decisionId: targetDecisionId,
      commandName,
      requestedAtMs: nowMs,
    });
  };

  const issueCommand = (command) => {
    const result = relay.sendCommand(command);
    setIssueError(result.ok ? "" : result.reason);
    if (!result.ok && !familySurface) setDrawerOpen(true);
    return result;
  };

  const pageHeader = (() => {
    if (activeTab === "home") return {
      title: familySurface ? "家" : "外婆家",
      subtitle: relay.unavailableReason
        ? `${familySurface ? "家属端" : "Viewer"} · 当前状态不可用，等待恢复`
        : `${SCENE_COPY[sceneId]?.label || "家庭关怀"} · ${relay.connection === "connected" ? (familySurface ? "家属端已连接" : "Relay 已连接") : "正在重连"}`,
    };
    if (activeTab === "timeline") return {
      title: familySurface ? "reme" : "主动关怀",
      subtitle: familySurface
        ? `remember me · ${timelineDateLongHeading(selectedTimelineDate)}`
        : `外婆 · ${timelineDateHeading(selectedTimelineDate, nowMs)} · MiMo 关怀时间线`,
    };
    if (activeTab === "dashboard") return {
      title: "关怀看板",
      subtitle: familySurface ? "外婆 · 家属端关怀摘要" : "外婆 · 本次公开演示",
    };
    return { title: "设置", subtitle: "管理本页显示与提醒" };
  })();

  return (
    <div
      className={`viewer-app ${familySurface ? "is-family-surface" : "is-demo-surface"} ${activeTab === "timeline" ? "is-timeline-tab" : ""} ${alertEffects.flashActive ? "is-flashing" : ""}`}
      data-app-role={familySurface ? "family" : "viewer-demo"}
    >
      <div className="alert-flash-layer" aria-hidden="true" />
      <ConnectionBanner
        relay={relay}
        grant={activeGrant}
        nowMs={relayNowMs}
        familySurface={familySurface}
        rtcError={rtc.error}
      />
      <div className="viewer-shell">
        <header className="viewer-header">
          <div><h1>{pageHeader.title}</h1><p>{pageHeader.subtitle}</p></div>
          {!familySurface && (
            <IconButton className="viewer-control-trigger" onClick={() => setDrawerOpen(true)} aria-label="打开远程控制">
              <TuneRoundedIcon />
              {relay.ownsControl && <span />}
            </IconButton>
          )}
        </header>

        {relay.unavailableReason && activeTab !== "timeline" && (
          <aside className="viewer-state-unavailable" role="alert">
            <HealthAndSafetyRoundedIcon />
            <div><b>现场传输状态不可用</b><span>{unavailableCopy(relay, familySurface)}；后端已发布的关怀事件仍单独保留。</span></div>
          </aside>
        )}

        {activeTab === "home" && (
          <HomePage
            relay={relay}
            snapshot={snapshot}
            pose={relay.pose}
            media={media}
            activeGrant={activeGrant}
            highPrivacyEnabled={highPrivacyEnabled}
            localNowMs={nowMs}
            relayNowMs={relayNowMs}
            familySurface={familySurface}
            decision={careDecision}
            familyAcknowledgementControl={familySurface ? (
              <>
                <FamilyActionCard
                  decision={careDecision}
                  pending={familyConfirmPending}
                  applied={familyConfirmApplied}
                  blocked={familyControllerBlocked}
                  error={familyAcknowledgementCommand === "confirm_action_card"
                    ? resolveFamilyConfirmationError({
                        failure: familyConfirmFailure,
                        decisionId,
                        ackError: familyConfirmAckError,
                      })
                    : ""}
                  onConfirm={requestFamilyConfirmation}
                />
              </>
            ) : null}
          />
        )}
        {activeTab === "timeline" && (
          <TimelinePage
            timeline={timeline}
            relay={relay}
            selectedDateKey={selectedTimelineDate}
            onSelectDate={setSelectedTimelineDate}
            nowMs={nowMs}
          />
        )}
        {activeTab === "dashboard" && <DashboardPage relay={relay} snapshot={snapshot} activeGrant={activeGrant} nowMs={relayNowMs} familySurface={familySurface} />}
        {activeTab === "settings" && (
          <SettingsPage
            relay={relay}
            highPrivacyEnabled={highPrivacyEnabled}
            setHighPrivacyEnabled={setHighPrivacyEnabled}
            notificationsEnabled={notificationsEnabled}
            setNotificationsEnabled={setNotificationsEnabled}
            familySurface={familySurface}
          />
        )}

        <BottomNavigation className="viewer-bottom-nav" showLabels value={activeTab} onChange={(_, value) => setActiveTab(value)}>
          {familySurface ? [
            <BottomNavigationAction key="home" label="家" value="home" icon={<HomeRoundedIcon />} />,
            <BottomNavigationAction key="timeline" label="reme" value="timeline" icon={<FavoriteRoundedIcon />} />,
            <BottomNavigationAction key="settings" label="设置" value="settings" icon={<SettingsRoundedIcon />} />,
          ] : [
            <BottomNavigationAction key="home" label="首页" value="home" icon={<HomeRoundedIcon />} />,
            <BottomNavigationAction key="timeline" label="时间线" value="timeline" icon={<CalendarMonthRoundedIcon />} />,
            <BottomNavigationAction key="dashboard" label="看板" value="dashboard" icon={<FavoriteRoundedIcon />} />,
            <BottomNavigationAction key="settings" label="设置" value="settings" icon={<SettingsRoundedIcon />} />,
          ]}
        </BottomNavigation>
      </div>

      {!familySurface && (
        <button className={`floating-control-button ${relay.ownsControl ? "is-owned" : ""}`} type="button" onClick={() => setDrawerOpen(true)}>
          <TuneRoundedIcon /><span>{relay.ownsControl ? "远程控制中" : "打开路演控制"}</span>
        </button>
      )}

      {!familySurface && <ControlDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} relay={relay} snapshot={snapshot} decision={careDecision} nowMs={relayNowMs} onIssue={issueCommand} issueError={issueError} />}
      <EmergencyDialog
        open={Boolean(emergency && decisionId !== dismissedEmergency)}
        onClose={() => setDismissedEmergency(decisionId)}
        decision={careDecision}
        activeGrant={activeGrant}
        nowMs={relayNowMs}
        ownsControl={relay.ownsControl}
        controllerBlocked={familyControllerBlocked}
        onIssue={issueCommand}
        onFamilyConfirm={requestFamilyConfirmation}
        familyConfirmPending={familyConfirmPending}
        familyConfirmApplied={familyConfirmApplied}
        familyConfirmError={resolveFamilyConfirmationError({
          failure: familyConfirmFailure,
          decisionId,
          ackError: familyConfirmAckError,
        })}
        familySurface={familySurface}
        soundBlocked={alertEffects.soundBlocked}
        onRetrySound={alertEffects.retrySound}
      />
    </div>
  );
}
