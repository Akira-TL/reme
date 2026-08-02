import { useEffect, useRef, useState } from "react";
import { Button } from "@mui/material";
import { drawSkeleton, resizeCanvas } from "../utils/pose";
import { useViewerLink } from "./useViewerLink";

// 家属端旁观页：任意多开、跨设备；只看不驱动，唯一的写操作是"确认收到"。

const STATE_LABELS = {
  normal: "一切正常",
  observe: "持续观察中",
  check_in_required: "正在向老人确认安全",
  consent_required: "正在征求老人授权",
  family_notification_required: "需要您关注",
  urgent_attention: "紧急关注",
  resolved: "事件已化解",
  degraded: "服务降级",
};

const POSTURE_LABELS = {
  standing: "站立",
  sitting: "坐姿",
  lying: "躺卧",
  bending_or_crouching: "弯腰/蹲下",
  unknown: "未知",
};

const MOTION_LABELS = {
  still: "静止",
  low: "轻微活动",
  medium: "中等活动",
  high: "剧烈活动",
  unknown: "活动未知",
};

const TRANSITION_LABELS = {
  fall_like_transition: "疑似跌倒转变",
  normal_transition: "正常动作转变",
  uncertain_transition: "不确定转变",
};

const TRIGGER_LABELS = {
  elder_report: "老人求助",
  voice_intent: "语音求助",
  visual_confirm: "画面确认跌倒",
  check_in_timeout: "呼叫无回应",
  unclear_response: "无法确认状态",
  family_unresponsive: "家属未确认",
};

const SOURCE_LABELS = { mimo: "MiMo 判断", rule: "规则", record: "回放", degraded: "降级" };

const ALERT_STATES = new Set(["family_notification_required", "urgent_attention"]);
const SKELETON_STALE_MS = 2000;

function connectionDot(connection) {
  if (connection === "open") return "is-on";
  if (connection === "connecting") return "is-warm";
  return "is-off";
}

// 使用侧以 key={decision.decision_id} 渲染：决策更替即重建实例，
// 惰性初始值保证首帧就是本决策的完整时长，不闪现上一决策的陈旧文案。
function CountdownHint({ decision }) {
  const applicable = Boolean(
    decision?.need_dialogue && Number.isFinite(decision.response_timeout_ms),
  );
  const [remainingMs, setRemainingMs] = useState(() =>
    applicable ? decision.response_timeout_ms : null,
  );
  useEffect(() => {
    if (!applicable) return undefined;
    const expiresAt = performance.now() + decision.response_timeout_ms;
    const timer = window.setInterval(() => {
      setRemainingMs(Math.max(0, expiresAt - performance.now()));
    }, 250);
    return () => window.clearInterval(timer);
  }, [applicable, decision]);
  if (!applicable || remainingMs === null) return null;
  return (
    <p className="viewer-countdown">
      {remainingMs > 0
        ? `等待老人回应 ${Math.ceil(remainingMs / 1000)}s（超时由老人端上报升级）`
        : "回应窗口已过，等待老人端升级结果…"}
    </p>
  );
}

export function ViewerApp() {
  const link = useViewerLink();
  const canvasRef = useRef(null);
  const [personVisible, setPersonVisible] = useState(false);

  const emergency = Boolean(link.decision && ALERT_STATES.has(link.decision.state));
  const fallCandidate = link.transition?.transition === "fall_like_transition";

  useEffect(() => {
    let frame = 0;
    let lastVisible = null;
    function paint() {
      const canvas = canvasRef.current;
      if (canvas) {
        const { context, width, height } = resizeCanvas(canvas);
        context.clearRect(0, 0, width, height);
        const snapshot = link.skeletonRef.current;
        const fresh =
          snapshot && performance.now() - snapshot.wallTime < SKELETON_STALE_MS;
        if (fresh) {
          const color = emergency || fallCandidate ? "#ff3b30" : "#ff5a00";
          drawSkeleton(context, snapshot.points, width, height, null, color);
        }
        const visible = Boolean(fresh);
        if (visible !== lastVisible) {
          lastVisible = visible;
          setPersonVisible(visible);
        }
      }
      frame = window.requestAnimationFrame(paint);
    }
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [link.skeletonRef, emergency, fallCandidate]);

  const decision = link.decision;
  const sessionTail = link.sessionId ? link.sessionId.slice(-8) : "—";

  return (
    <div className={`viewer-shell ${link.alarm ? "has-alarm" : ""}`}>
      <header className="viewer-header">
        <div>
          <b>Reme</b>
          <span>家属端旁观</span>
        </div>
        <div className="viewer-links">
          <i className={`dot ${connectionDot(link.connectionA)}`} />
          <small>A 感知流</small>
          <i className={`dot ${connectionDot(link.connectionB)}`} />
          <small>B 决策流</small>
          <small className="session-tail">会话 …{sessionTail}</small>
        </div>
      </header>

      {!link.watching ? (
        <main className="viewer-idle">
          <b>等待老人端会话上线</b>
          <p>
            老人端（驱动页）开始实时守护后，这里会自动接入同一会话。 A：
            {link.aStatus?.state || "未连接"} ／ B：{link.bStatus?.state || "未连接"}
          </p>
        </main>
      ) : (
        <main className="viewer-main">
          {(link.bStatus?.state === "degraded" || link.aStatus?.state === "degraded") && (
            <div className="viewer-degraded" role="status">
              守护服务降级：
              {link.bStatus?.state === "degraded"
                ? link.bStatus?.reason || "决策链路部分不可用"
                : link.aStatus?.reason || "感知链路部分不可用"}
            </div>
          )}
          <section className={`viewer-stage ${emergency ? "is-alert" : ""}`}>
            <canvas ref={canvasRef} className="viewer-canvas" />
            {!personVisible && <div className="stage-empty">等待画面：骨架流未就绪或无人</div>}
            <div className="stage-chips">
              {link.posture && (
                <span className="chip">
                  {POSTURE_LABELS[link.posture.posture] || link.posture.posture}
                  {" · "}
                  {MOTION_LABELS[link.posture.motion_level] || link.posture.motion_level}
                </span>
              )}
              {link.transition && (
                <span className={`chip ${fallCandidate ? "chip-danger" : ""}`}>
                  {TRANSITION_LABELS[link.transition.transition] || link.transition.transition}
                </span>
              )}
            </div>
            <small className="stage-privacy">仅骨架同步 · 原始画面不出老人端</small>
          </section>

          <section className={`viewer-card ${emergency ? "is-alert" : ""}`}>
            {!decision ? (
              <p className="card-empty">
                {link.connectionB === "open"
                  ? "已接入决策流，尚未同步到决策。中途加入时早前的决策不会重放，仅新决策实时送达。"
                  : "决策流连接中…（断线窗口内的决策不会补发）"}
              </p>
            ) : (
              <>
                <div className="card-head">
                  <b>{STATE_LABELS[decision.state] || decision.state}</b>
                  <span className="card-source">
                    {SOURCE_LABELS[decision.source] || decision.source}
                    {decision.risk_level != null ? ` · 风险 ${decision.risk_level}` : ""}
                  </span>
                </div>
                {decision.family_notification && (
                  <p className="card-family">{decision.family_notification}</p>
                )}
                {decision.elder_message && (
                  <p className="card-elder">对老人：「{decision.elder_message}」</p>
                )}
                {decision.reason_summary && (
                  <p className="card-reason">{decision.reason_summary}</p>
                )}
                <CountdownHint key={decision.decision_id} decision={decision} />
              </>
            )}
          </section>

          {link.history.length > 1 && (
            <section className="viewer-history">
              {link.history.slice(1).map((item) => (
                <div key={item.decision_id} className="history-row">
                  <span>{STATE_LABELS[item.state] || item.state}</span>
                  <small>{SOURCE_LABELS[item.source] || item.source}</small>
                </div>
              ))}
            </section>
          )}
        </main>
      )}

      {link.alarm && (
        <div className="alarm-overlay" role="alertdialog" aria-label="紧急告警">
          <div className="alarm-panel">
            <b>紧急提醒</b>
            <p>
              {TRIGGER_LABELS[link.alarm.trigger] || "需要立即关注"}
              {link.alarm.decision?.family_notification
                ? `：${link.alarm.decision.family_notification}`
                : ""}
            </p>
            <div className="alarm-actions">
              <Button variant="contained" color="error" onClick={link.confirmAlarm}>
                {link.confirmState === "sending" ? "确认中…" : "确认收到"}
              </Button>
              <Button variant="outlined" color="inherit" onClick={link.muteAlarm}>
                静音
              </Button>
            </div>
            {link.confirmState === "failed" && (
              <small className="alarm-error">确认发送失败，请重试</small>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
