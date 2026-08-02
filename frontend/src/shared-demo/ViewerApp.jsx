import { useCallback, useEffect, useRef, useState } from "react";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import FavoriteRoundedIcon from "@mui/icons-material/FavoriteRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import VerifiedUserRoundedIcon from "@mui/icons-material/VerifiedUserRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import { SkeletonStage } from "./SkeletonStage.jsx";
import {
  selectActiveMediaGrant,
  selectViewerPresentation,
  selectViewerScene,
} from "./state.js";
import { useViewerMedia } from "./useViewerMedia.js";
import { useViewerRelay } from "./useViewerRelay.js";

const SCENE_COPY = Object.freeze({
  living: {
    index: "01",
    eyebrow: "DAILY CARE",
    name: "日常活动",
    title: "保留空间感，\n不暴露清晰人像。",
    description: "固定客厅元素只用于表达通用活动空间；它不是对现场家具的识别、复原或数字孪生。",
  },
  kitchen: {
    index: "02",
    eyebrow: "FAMILY HEARTBEAT",
    name: "做饭心跳",
    title: "看见生活节奏，\n分享仍由本人决定。",
    description: "厨房环境是固定抽象示意。只有收到实验活动事件后才显示判定，收到同意与媒体授权后才接收短期画面。",
  },
  bathroom: {
    index: "03",
    eyebrow: "PRIVACY FIRST",
    name: "完全隐私",
    title: "最私密的空间，\n只留下必要骨架。",
    description: "本场景强制纯骨架和安全背景；任何环境模式或媒体授权都不会在此页面打开原始画面。",
  },
  fall: {
    index: "04",
    eyebrow: "SAFETY CHECK-IN",
    name: "跌倒关怀",
    title: "先询问，再按规则\n把告警送达家属。",
    description: "当前动作规则是演示启发式，不代表临床准确率。问询阶段始终保持骨架，只有升级告警与有效授权同时成立才接收现场画面。",
  },
});

const ACTIVITY_PHASE_COPY = Object.freeze({
  sampling: ["正在观察", "等待下一次最小视觉样本"],
  candidate: ["活动候选", "当前证据尚不足以形成家庭心跳"],
  confirmed: ["实验识别已确认", "已形成一次做饭活动事件"],
  unavailable: ["实验识别不可用", "继续显示骨架，不将场景切换冒充识别"],
});

const SHARE_STATE_COPY = Object.freeze({
  local_only: "仅监控端草稿",
  consent_pending: "等待本人决定",
  consented: "本人已同意分享",
  denied: "本人已拒绝分享",
  expired: "分享草稿已过期",
});

function shortId(value) {
  if (!value) return "—";
  return value.length > 18 ? `…${value.slice(-16)}` : value;
}

function connectionCopy(connection) {
  if (connection === "connected") return "中继已连接";
  if (connection === "connecting") return "正在连接中继";
  return "连接中断，自动重试";
}

function secondsRemaining(deadlineMs, nowMs) {
  if (!Number.isFinite(deadlineMs)) return null;
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

function SceneEnvironment({ sceneId }) {
  if (sceneId === "bathroom") {
    return <div className="scene-environment environment-private" aria-hidden="true" />;
  }
  if (sceneId === "kitchen") {
    return (
      <div className="scene-environment environment-kitchen" aria-hidden="true">
        <img src="/scenes/kitchen.jpg" alt="" />
      </div>
    );
  }
  return (
    <div className={`scene-environment environment-living ${sceneId === "fall" ? "is-night" : ""}`} aria-hidden="true">
      <img src="/scenes/living-room.jpg" alt="" />
    </div>
  );
}

function ActivityCard({ activity }) {
  if (!activity) {
    return (
      <article className="viewer-event-card activity-card is-waiting">
        <div className="event-card-kicker"><i />实验活动识别</div>
        <h2>等待真实活动事件</h2>
        <p>进入厨房本身不会被显示为“正在做饭”；评委端会等待监控端发布实际判定。</p>
      </article>
    );
  }
  const [title, fallback] = ACTIVITY_PHASE_COPY[activity.phase];
  const source = activity.source === "mimo_visual"
    ? "MiMo 最小视觉样本"
    : "手动调试触发（非自动识别）";
  return (
    <article className={`viewer-event-card activity-card is-${activity.phase}`}>
      <div className="event-card-kicker"><i />实验活动识别</div>
      <h2>{title}</h2>
      <p>{activity.reason || fallback}</p>
      <dl className="event-inline-facts">
        <div><dt>来源</dt><dd>{source}</dd></div>
        <div>
          <dt>本次置信度</dt>
          <dd>{activity.confidence == null ? "未提供" : `${Math.round(activity.confidence * 100)}%`}</dd>
        </div>
      </dl>
    </article>
  );
}

function HeartbeatCard({ card }) {
  if (!card) return null;
  return (
    <article className={`viewer-event-card heartbeat-card is-${card.share_state}`}>
      <div className="event-card-kicker"><FavoriteRoundedIcon aria-hidden="true" />家庭心跳</div>
      <h2>{card.title}</h2>
      <p>{card.body}</p>
      <div className="event-card-footer">
        <span>{SHARE_STATE_COPY[card.share_state]}</span>
        <time dateTime={new Date(card.occurred_at_ms).toISOString()}>
          {new Date(card.occurred_at_ms).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </div>
    </article>
  );
}

function createAudioContext(contextRef) {
  if (contextRef.current) return contextRef.current;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  contextRef.current = new AudioContextClass();
  return contextRef.current;
}

async function playAlarmTone(contextRef) {
  const context = createAudioContext(contextRef);
  if (!context) return false;
  try {
    if (context.state === "suspended") await context.resume();
    if (context.state !== "running") return false;
    const startAt = context.currentTime + 0.02;
    for (const offset of [0, 0.24]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(760, startAt + offset);
      oscillator.frequency.exponentialRampToValueAtTime(1040, startAt + offset + 0.14);
      gain.gain.setValueAtTime(0.0001, startAt + offset);
      gain.gain.exponentialRampToValueAtTime(0.16, startAt + offset + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + offset + 0.18);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt + offset);
      oscillator.stop(startAt + offset + 0.2);
    }
    return true;
  } catch {
    return false;
  }
}

function useAlarmEffects(alarm) {
  const contextRef = useRef(null);
  const notifiedRef = useRef(null);
  const [soundBlocked, setSoundBlocked] = useState(false);

  useEffect(() => {
    const unlock = () => {
      const context = createAudioContext(contextRef);
      if (context?.state === "suspended") void context.resume();
    };
    window.addEventListener("pointerdown", unlock, { capture: true, once: true });
    window.addEventListener("keydown", unlock, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
      navigator.vibrate?.(0);
      void contextRef.current?.close?.();
      contextRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!alarm || alarm.phase !== "escalated") return;
    const key = `${alarm.event_id}:${alarm.phase}`;
    if (notifiedRef.current === key) return;
    notifiedRef.current = key;
    navigator.vibrate?.([180, 90, 180]);
    void playAlarmTone(contextRef).then((played) => setSoundBlocked(!played));
  }, [alarm]);

  const retrySound = useCallback(async () => {
    const played = await playAlarmTone(contextRef);
    setSoundBlocked(!played);
    return played;
  }, []);

  return { retrySound, soundBlocked };
}

function AlarmCard({ alarm, nowMs, onRetrySound, soundBlocked }) {
  if (!alarm) return null;
  const checking = alarm.phase === "checking";
  const escalated = alarm.phase === "escalated";
  const remaining = checking ? secondsRemaining(alarm.response_deadline_ms, nowMs) : null;
  return (
    <article
      className={`viewer-event-card alarm-card is-${alarm.phase}`}
      role={escalated ? "alert" : "status"}
      aria-live={escalated ? "assertive" : "polite"}
    >
      <div className="event-card-kicker"><i />{checking ? "安全问询中" : escalated ? "家庭告警已送达" : "本次告警已结束"}</div>
      <h2>{checking ? "正在先询问本人" : escalated ? "可能需要立即关注" : "已收到处理结果"}</h2>
      <p>{alarm.message}</p>
      {checking ? (
        <div className="alarm-countdown">
          <strong>{remaining}</strong>
          <span>秒响应窗口<br />问询阶段不开放原画</span>
        </div>
      ) : null}
      {escalated && soundBlocked ? (
        <button className="alert-sound-action" type="button" onClick={onRetrySound}>
          点击启用本页告警声音
        </button>
      ) : null}
    </article>
  );
}

function MediaStatus({ grant, media, nowMs, alarmActive }) {
  if (!grant) return null;
  const remaining = secondsRemaining(grant.expires_at_ms, nowMs);
  if (media.status === "live") {
    return (
      <div className="media-live-pill" role="status">
        <i />事件授权现场 · {remaining} 秒后自动关闭
      </div>
    );
  }
  const waiting = ["idle", "waiting", "connecting"].includes(media.status);
  return (
    <div className={`media-status-card ${media.status === "failed" ? "is-failed" : ""}`} role="status">
      <b>{waiting ? "已授权，正在建立点对点视频" : "授权视频暂不可用"}</b>
      <span>
        {waiting
          ? `仍以骨架显示，授权还剩 ${remaining} 秒。`
          : media.error || (alarmActive ? "告警保持有效并继续显示骨架。" : "家庭心跳卡保持有效。")}
      </span>
      {media.status === "failed" && media.stream ? (
        <button type="button" onClick={media.retryPlayback}>重试播放</button>
      ) : null}
    </div>
  );
}

export function ViewerApp() {
  const relay = useViewerRelay();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const presentation = selectViewerPresentation(relay, nowMs);
  const scene = selectViewerScene(relay);
  const sceneCopy = SCENE_COPY[scene.scene_id];
  const activeGrant = selectActiveMediaGrant(relay, nowMs);
  const {
    error: mediaError,
    retryPlayback,
    status: mediaStatus,
    stream: mediaStream,
    videoRef,
  } = useViewerMedia({
    socket: relay.socket,
    sendSignal: relay.sendSignal,
    viewerId: relay.viewerId,
    grant: activeGrant,
  });
  const alarmEffects = useAlarmEffects(relay.alarm);
  const { ageMs } = presentation;
  const showsSkeleton = presentation.kind === "live" || presentation.kind === "degraded";
  const videoVisible = Boolean(
    activeGrant && mediaStream && ["connecting", "live"].includes(mediaStatus),
  );
  const alarmActive = relay.alarm?.phase === "escalated";
  const stageStatus = {
    live: { label: "LIVE", dot: "live-dot" },
    degraded: { label: "DEGRADED", dot: "degraded-dot" },
    unavailable: { label: "NO PERSON", dot: "no-person-dot" },
    stale: { label: "WAITING", dot: "wait-dot" },
    waiting: { label: "WAITING", dot: "wait-dot" },
  }[presentation.kind];
  const primaryStatus = (() => {
    if (relay.alarm?.phase === "escalated") {
      return {
        tone: "danger",
        label: "紧急告警：请立即关注",
        detail: videoVisible
          ? "短期授权现场画面已接通；授权到期后会自动回到抽象骨架。"
          : activeGrant
            ? "告警已升级，正在建立短期授权点对点视频；连接失败时仍保持骨架。"
            : "告警已升级；只有短期授权有效且点对点视频接通后才会开放现场画面。",
        Icon: EmergencyRoundedIcon,
      };
    }
    if (relay.alarm?.phase === "checking") {
      return {
        tone: "warning",
        label: "正在进行安全问询",
        detail: "问询阶段保持抽象骨架，等待本人回应后再决定是否升级。",
        Icon: EmergencyRoundedIcon,
      };
    }
    if (scene.scene_id === "bathroom") {
      return {
        tone: "privacy",
        label: "完全隐私模式已开启",
        detail: "本场景强制隐藏环境与原画，只保留必要的抽象骨架。",
        Icon: VisibilityOffRoundedIcon,
      };
    }
    if (["waiting", "stale"].includes(presentation.kind)) {
      return {
        tone: "pending",
        label: "正在等待监控端画面",
        detail: "连接建立后，这里会同步同一组实时骨架和场景事件。",
        Icon: ShieldRoundedIcon,
      };
    }
    if (["degraded", "unavailable"].includes(presentation.kind)) {
      return {
        tone: "warning",
        label: presentation.kind === "degraded" ? "骨架质量较低" : "当前未检测到人物",
        detail: "系统正在明确显示降级状态，不会用假画面替代真实检测结果。",
        Icon: ShieldRoundedIcon,
      };
    }
    if (scene.scene_id === "kitchen") {
      const activityUnavailable = relay.activity?.phase === "unavailable";
      return {
        tone: activityUnavailable
          ? "warning"
          : relay.activity?.phase === "confirmed" ? "normal" : "pending",
        label: activityUnavailable
          ? "做饭识别暂不可用"
          : relay.activity?.phase === "confirmed" ? "已识别到做饭活动" : "正在观察做饭活动",
        detail: activityUnavailable
          ? relay.activity.reason
          : "系统只在连续证据确认后形成家庭心跳，分享仍由本人决定。",
        Icon: RestaurantRoundedIcon,
      };
    }
    return {
      tone: "normal",
      label: "当前状态：一切正常",
      detail: "手机端正在本地处理画面，评委端仅接收抽象骨架。",
      Icon: VerifiedUserRoundedIcon,
    };
  })();
  const PrimaryStatusIcon = primaryStatus.Icon;

  return (
    <div className={`demo-shell viewer-role scene-${scene.scene_id} ${alarmActive ? "has-active-alarm" : ""}`}>
      <header className="demo-header">
        <a className="demo-brand" href="/" aria-label="Reme 评委旁观端首页">
          <span className="brand-mark">R</span>
          <span><b>外婆家</b><small>Reme 隐私关怀演示</small></span>
        </a>
        <div className="role-lockup">
          <span className="role-pill viewer-pill">评委只读端</span>
          <span className={`connection-pill is-${relay.connection}`}>
            <i />{connectionCopy(relay.connection)}
          </span>
        </div>
      </header>

      <main className="viewer-layout">
        <section className="shared-stage" aria-label={`${sceneCopy.name}实时隐私画面`}>
          <SceneEnvironment sceneId={scene.scene_id} />
          <div className="stage-grid" />
          <video
            ref={videoRef}
            className={`authorized-video ${videoVisible ? "is-visible" : ""}`}
            muted
            playsInline
            autoPlay
            aria-label="事件授权的临时现场画面"
          />
          <SkeletonStage frame={showsSkeleton ? relay.frame : null} />
          <div className="stage-topline">
            <span><i className={stageStatus.dot} />{stageStatus.label}</span>
            <span>
              {scene.scene_id === "bathroom"
                ? "完全隐私 · 强制纯骨架"
                : "通用环境抽象 · 不代表真实家具复原"}
            </span>
          </div>
          {presentation.kind === "degraded" ? (
            <div className="quality-notice" role="status">
              <b>关键点质量较低</b>
              <span>部分肢体关键点置信度不足，当前画面已明确降级。</span>
            </div>
          ) : null}
          {!showsSkeleton && !videoVisible ? (
            <div className="stage-placeholder" role="status">
              <VerifiedUserRoundedIcon className="placeholder-status-icon" aria-hidden="true" />
              <b>
                {presentation.kind === "unavailable"
                  ? "未检测到人物"
                  : presentation.kind === "stale"
                    ? "画面暂时中断"
                    : "等待监控端开始采集"}
              </b>
              <p>
                {presentation.kind === "unavailable"
                  ? "监控端仍在同步，但当前帧没有可靠的人体骨架。"
                  : presentation.kind === "stale"
                    ? "通用环境示意可以保留，人物状态明确标为不可用。"
                    : "监控手机开始采集后，这里会自动显示同一实时抽象骨架。"}
              </p>
            </div>
          ) : null}
          <MediaStatus
            grant={activeGrant}
            media={{
              error: mediaError,
              retryPlayback,
              status: mediaStatus,
              stream: mediaStream,
            }}
            nowMs={nowMs}
            alarmActive={alarmActive}
          />
          <div className="privacy-ribbon">
            <ShieldRoundedIcon aria-hidden="true" />
            {videoVisible
              ? "事件授权画面经 WebRTC 点对点接收，不由骨架中继存储"
              : scene.scene_id === "bathroom"
                ? "完全隐私：始终只显示 17 点抽象骨架"
                : "手机本地识别，日常仅同步 17 点抽象骨架"}
          </div>
        </section>

        <aside className="viewer-panel">
          <div className="scene-heading">
            <span className="scene-number">{sceneCopy.index}</span>
            <div>
              <div className="eyebrow">{sceneCopy.eyebrow}</div>
              <span className="scene-name">{sceneCopy.name}</span>
            </div>
          </div>
          <h1>{sceneCopy.title.split("\n").map((line, index) => (
            <span key={line}>{line}{index === 0 ? <br /> : null}</span>
          ))}</h1>
          <p className="intro-copy">{sceneCopy.description}</p>

          <article
            className={`viewer-primary-status is-${primaryStatus.tone}`}
            role={primaryStatus.tone === "danger" ? undefined : "status"}
          >
            <span className="primary-status-icon"><PrimaryStatusIcon /></span>
            <span>
              <small>当前状态</small>
              <strong>{primaryStatus.label}</strong>
              <em>{primaryStatus.detail}</em>
            </span>
          </article>

          <div className="viewer-section-heading">
            <h2>时间线</h2>
            <span>只读实时同步</span>
          </div>

          <div className="viewer-event-stack">
            {scene.scene_id === "kitchen" ? <ActivityCard activity={relay.activity} /> : null}
            {relay.careCard ? <HeartbeatCard card={relay.careCard} /> : null}
            {relay.alarm ? (
              <AlarmCard
                alarm={relay.alarm}
                nowMs={nowMs}
                onRetrySound={alarmEffects.retrySound}
                soundBlocked={alarmEffects.soundBlocked}
              />
            ) : null}
          </div>

          <dl className="session-facts">
            <div><dt>会话</dt><dd title={relay.sessionId}>{shortId(relay.sessionId)}</dd></div>
            <div><dt>评委连接</dt><dd title={relay.viewerId}>{shortId(relay.viewerId)}</dd></div>
            <div><dt>最近同步</dt><dd>{ageMs == null ? "等待首帧" : ageMs < 1000 ? "刚刚" : `${Math.floor(ageMs / 1000)} 秒前`}</dd></div>
            <div><dt>数据范围</dt><dd>{videoVisible ? "短期事件授权" : "17 点骨架"}</dd></div>
          </dl>

          <div className="readonly-note">
            <b>只读边界</b>
            <p>本端不能发布、接管监控或主动申请媒体；只响应监控端签发给当前连接的短期授权。</p>
          </div>
          {relay.rejectedFrames > 0 ? (
            <p className="protocol-note" role="status">
              已忽略 {relay.rejectedFrames} 条不符合隐私合同的数据。
            </p>
          ) : null}
        </aside>
      </main>

      <footer className="demo-footer">
        <span>Reme Demo · 非医疗设备</span>
        <span>relay.reme.maniforld.com</span>
      </footer>
    </div>
  );
}
