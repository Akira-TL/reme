import { useEffect, useState } from "react";

const TRIGGER_LABELS = {
  visual_confirm: "画面确认跌倒",
  voice_intent: "语音求助",
  elder_report: "老人求助",
  check_in_timeout: "呼叫无回应",
  unclear_response: "无法确认状态",
  family_unresponsive: "家属未确认",
};

function CountdownBar({ deadline }) {
  const [fraction, setFraction] = useState(1);

  useEffect(() => {
    if (!deadline) return undefined;
    let frame = 0;
    function tick() {
      const remaining = Math.max(0, deadline.expiresAt - Date.now());
      setFraction(deadline.timeoutMs > 0 ? remaining / deadline.timeoutMs : 0);
      if (remaining > 0) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [deadline]);

  if (!deadline) return null;
  const seconds = Math.ceil((deadline.timeoutMs * fraction) / 1000);
  return (
    <div className="danger-countdown" role="timer" aria-label={`回应倒计时还剩 ${seconds} 秒`}>
      <div className="danger-countdown-track">
        <i style={{ transform: `scaleX(${Math.max(0, Math.min(1, fraction))})` }} aria-hidden="true" />
      </div>
      <b>{seconds}s</b>
    </div>
  );
}

export function DangerLayer({ decisionRuntime }) {
  const { decision, deadline, alarm, respondSafe, respondNeedHelp, confirmAlarm } = decisionRuntime;
  const [resolvedToast, setResolvedToast] = useState(null);

  useEffect(() => {
    if (decision?.state !== "resolved") return undefined;
    const showTimer = window.setTimeout(() => setResolvedToast(decision), 0);
    const hideTimer = window.setTimeout(() => setResolvedToast(null), 2000);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, [decision]);

  const checkIn = !alarm && decision?.state === "check_in_required" ? decision : null;
  const confirmHints = [];
  if (checkIn?.confirm_channels?.includes("voice")) confirmHints.push("语音确认");
  if (checkIn?.confirm_channels?.includes("frame")) confirmHints.push("画面确认");

  return (
    <>
      {checkIn && (
        <section className="danger-checkin" role="alertdialog" aria-label="安全确认">
          <p className="danger-checkin-message">{checkIn.elder_message || "检测到异常，您现在还好吗？"}</p>
          <CountdownBar deadline={deadline?.decisionId === checkIn.decision_id ? deadline : null} />
          <div className="danger-actions">
            <button type="button" className="danger-button danger-button-safe" onClick={respondSafe}>
              我没事
            </button>
            <button type="button" className="danger-button danger-button-help" onClick={respondNeedHelp}>
              需要帮助
            </button>
          </div>
          {confirmHints.length > 0 && (
            <small className="danger-checkin-hint">正在{confirmHints.join(" / ")}，无需额外操作</small>
          )}
        </section>
      )}

      {alarm && (
        <section className="danger-alarm" role="alertdialog" aria-modal="true" aria-label="紧急告警">
          <span className="danger-alarm-trigger">{TRIGGER_LABELS[alarm.trigger] || "紧急状况"}</span>
          <h2 className="danger-alarm-message">
            {alarm.decision?.family_notification || "检测到紧急状况，请立即确认长辈状态"}
          </h2>
          <button type="button" className="danger-button danger-button-ack" onClick={confirmAlarm}>
            已收到，马上处理
          </button>
        </section>
      )}

      {resolvedToast && (
        <div className="danger-resolved-toast" role="status">
          {resolvedToast.elder_message || resolvedToast.family_notification || "状态已确认，本次关注解除"}
        </div>
      )}
    </>
  );
}
