import { useEffect, useState } from "react";
import { SkeletonStage } from "./SkeletonStage.jsx";
import { selectViewerPresentation } from "./state.js";
import { useViewerRelay } from "./useViewerRelay.js";

function shortSession(sessionId) {
  if (!sessionId) return "—";
  return sessionId.length > 18 ? `…${sessionId.slice(-16)}` : sessionId;
}

function connectionCopy(connection) {
  if (connection === "connected") return "中继已连接";
  if (connection === "connecting") return "正在连接中继";
  return "连接中断，自动重试";
}

export function ViewerApp() {
  const relay = useViewerRelay();
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);

  const presentation = selectViewerPresentation(relay, nowMs);
  const { ageMs } = presentation;
  const showsSkeleton = presentation.kind === "live" || presentation.kind === "degraded";
  const stageStatus = {
    live: { label: "LIVE", dot: "live-dot" },
    degraded: { label: "DEGRADED", dot: "degraded-dot" },
    unavailable: { label: "NO PERSON", dot: "no-person-dot" },
    stale: { label: "WAITING", dot: "wait-dot" },
    waiting: { label: "WAITING", dot: "wait-dot" },
  }[presentation.kind];

  return (
    <div className="demo-shell viewer-role">
      <header className="demo-header">
        <a className="demo-brand" href="/" aria-label="Reme 评委旁观端首页">
          <span className="brand-mark">R</span>
          <span><b>Reme</b><small>隐私关怀演示</small></span>
        </a>
        <div className="role-lockup">
          <span className="role-pill viewer-pill">评委只读端</span>
          <span className={`connection-pill is-${relay.connection}`}>
            <i />{connectionCopy(relay.connection)}
          </span>
        </div>
      </header>

      <main className="viewer-layout">
        <section className="shared-stage" aria-label="实时隐私骨架画面">
          <div className="stage-grid" />
          <SkeletonStage frame={showsSkeleton ? relay.frame : null} />
          <div className="stage-topline">
            <span><i className={stageStatus.dot} />{stageStatus.label}</span>
            <span>隐私化抽象骨架 · 不含原始视频</span>
          </div>
          {presentation.kind === "degraded" && (
            <div className="quality-notice" role="status">
              <b>关键点质量较低</b>
              <span>部分肢体关键点置信度不足，当前画面已明确降级。</span>
            </div>
          )}
          {!showsSkeleton && (
            <div className="stage-placeholder" role="status">
              <span className="placeholder-person" aria-hidden="true" />
              <b>
                {presentation.kind === "unavailable"
                  ? "未检测到人物"
                  : presentation.kind === "stale"
                    ? "画面暂时中断"
                    : "等待监控端上线"}
              </b>
              <p>
                {presentation.kind === "unavailable"
                  ? "监控端仍在同步，但当前帧没有可靠的人体骨架。"
                  : presentation.kind === "stale"
                    ? "正在保留最后会话并等待新的隐私化骨架帧。"
                    : "监控手机开始采集后，这里会自动显示同一实时抽象骨架。"}
              </p>
            </div>
          )}
          <div className="privacy-ribbon">
            <span aria-hidden="true">◈</span>
            手机本地识别，仅同步 17 个隐私化抽象关键点
          </div>
        </section>

        <aside className="viewer-panel">
          <div className="eyebrow">LIVE DEMO</div>
          <h1>同一个现场，<br />只看见必要的信息。</h1>
          <p className="intro-copy">
            此页面只读订阅监控手机产生的隐私化抽象骨架。不会申请您的摄像头，也不会加载姿态模型。
          </p>

          <dl className="session-facts">
            <div><dt>会话</dt><dd title={relay.frame?.session_id}>{shortSession(relay.frame?.session_id)}</dd></div>
            <div><dt>帧序号</dt><dd>{relay.frame ? `#${relay.frame.sequence}` : "—"}</dd></div>
            <div><dt>最近同步</dt><dd>{ageMs == null ? "等待首帧" : ageMs < 1000 ? "刚刚" : `${Math.floor(ageMs / 1000)} 秒前`}</dd></div>
            <div><dt>数据范围</dt><dd>17 点骨架</dd></div>
          </dl>

          <div className="readonly-note">
            <b>只读边界</b>
            <p>本端没有发布、接管或控制能力。控制入口与评委入口已完全分离。</p>
          </div>
          {relay.rejectedFrames > 0 && (
            <p className="protocol-note" role="status">
              已忽略 {relay.rejectedFrames} 条不符合隐私合同的数据。
            </p>
          )}
        </aside>
      </main>

      <footer className="demo-footer">
        <span>Reme Demo · 非医疗设备</span>
        <span>relay.reme.maniforld.com</span>
      </footer>
    </div>
  );
}
