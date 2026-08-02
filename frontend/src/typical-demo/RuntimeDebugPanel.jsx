import BugReportRoundedIcon from "@mui/icons-material/BugReportRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useState } from "react";
import { describePosture } from "../adapters/perception";

function percent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : "—";
}

function number(value, suffix = "") {
  return Number.isFinite(value) ? `${Math.round(value)}${suffix}` : "—";
}

function DebugValue({ label, value, wide = false }) {
  return (
    <div className={`debug-value ${wide ? "is-wide" : ""}`}>
      <small>{label}</small>
      <strong title={String(value ?? "—")}>{value ?? "—"}</strong>
    </div>
  );
}

export function RuntimeDebugPanel({ camera, live, scene }) {
  const [open, setOpen] = useState(
    () => new URLSearchParams(window.location.search).get("debug") === "1",
  );
  const runtime = live.runtime || {};
  const posture = live.posture;
  const transition = live.transition;
  const decisionRuntime = live.decision || {};
  const decision = decisionRuntime.decision;

  const rawSnapshot = {
    c: {
      scene_id: scene.id,
      camera_ready: camera.cameraReady,
      model_ready: camera.modelReady,
      person_detected: camera.personDetected,
      error: camera.error || null,
    },
    a: {
      runtime,
      posture: posture || null,
      transition: transition || null,
    },
    b: {
      connection: decisionRuntime.connection,
      reason: decisionRuntime.reason || null,
      decision: decision || null,
      history_size: decisionRuntime.history?.length || 0,
    },
  };

  return (
    <div className={`runtime-debug ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className="runtime-debug-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="runtime-debug-panel"
      >
        <BugReportRoundedIcon />
        <span>Debug</span>
        <i className={live.active ? "is-online" : ""} />
      </button>

      {open && (
        <section id="runtime-debug-panel" className="runtime-debug-panel" aria-label="ABC 后端实时调试信息">
          <header>
            <div>
              <small>ABC RUNTIME DEBUG</small>
              <h2>后端实时状态</h2>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭调试面板">
              <CloseRoundedIcon />
            </button>
          </header>

          <div className="debug-section">
            <h3>C · 浏览器输入</h3>
            <div className="debug-grid">
              <DebugValue label="场景" value={scene.id} />
              <DebugValue label="摄像头" value={camera.cameraReady ? "online" : "offline"} />
              <DebugValue label="姿态模型" value={camera.modelReady ? "ready" : "loading / degraded"} />
              <DebugValue label="检测到人物" value={camera.personDetected ? "yes" : "no"} />
              {camera.error && <DebugValue label="C 错误" value={camera.error} wide />}
            </div>
          </div>

          <div className="debug-section">
            <h3>A · 感知运行时</h3>
            <div className="debug-grid">
              <DebugValue label="状态" value={runtime.state || "offline"} />
              <DebugValue label="Session ID" value={runtime.sessionId || "—"} wide />
              <DebugValue label="姿态分类" value={posture ? describePosture(posture.posture) : "等待事件"} />
              <DebugValue label="姿态置信度" value={percent(posture?.posture_confidence)} />
              <DebugValue label="持续时间" value={number(posture?.posture_duration_ms, " ms")} />
              <DebugValue label="运动等级" value={posture?.motion_level || "—"} />
              <DebugValue label="关键点质量" value={posture?.landmark_quality || "—"} />
              <DebugValue label="时间戳" value={number(posture?.timestamp_ms, " ms")} />
              <DebugValue label="动作转变" value={transition?.transition || "等待事件"} wide />
              <DebugValue label="转变置信度" value={percent(transition?.transition_confidence)} />
              <DebugValue label="转变窗口" value={transition ? `${number(transition.start_ms)} → ${number(transition.end_ms)} ms` : "—"} />
              {runtime.reason && <DebugValue label="A 原因" value={runtime.reason} wide />}
            </div>
          </div>

          <div className="debug-section">
            <h3>B · 决策与 MiMo</h3>
            <div className="debug-grid">
              <DebugValue label="WebSocket" value={decisionRuntime.connection || "closed"} />
              <DebugValue label="决策状态" value={decision?.state || "等待决策"} />
              <DebugValue label="决策来源" value={decision?.source || "—"} />
              <DebugValue label="动作" value={decision?.action || "—"} />
              <DebugValue label="风险等级" value={decision?.risk_level ?? "—"} />
              <DebugValue label="隐私模式" value={decision?.privacy_mode || "—"} />
              <DebugValue label="Decision ID" value={decision?.decision_id || "—"} wide />
              <DebugValue label="老人话术" value={decision?.elder_message || "—"} wide />
              <DebugValue label="家属通知" value={decision?.family_notification || "—"} wide />
              {decisionRuntime.reason && <DebugValue label="B 错误" value={decisionRuntime.reason} wide />}
            </div>
          </div>

          <details className="debug-raw">
            <summary>查看原始状态 JSON</summary>
            <pre>{JSON.stringify(rawSnapshot, null, 2)}</pre>
          </details>
        </section>
      )}
    </div>
  );
}
