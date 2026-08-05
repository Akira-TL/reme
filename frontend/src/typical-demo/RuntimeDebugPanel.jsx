import BugReportRoundedIcon from "@mui/icons-material/BugReportRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import { useState } from "react";
import { describePosture } from "../adapters/perception";

const MIMO_MODEL = import.meta.env.VITE_REME_MIMO_MODEL || "mimo-v2.5";
const MIMO_CONFIGURED = import.meta.env.VITE_REME_MIMO_CONFIGURED === "true";

const SESSION_LABELS = {
  offline: "会话离线",
  starting: "会话启动中",
  running: "会话运行中",
  input_unavailable: "输入通道降级",
  degraded: "会话降级",
  stopped: "会话已停止",
};

const ACTIVITY_LABELS = {
  offline: "无实时输入",
  waiting_input: "等待首帧",
  stale: "帧流已停滞",
  no_person: "当前未检测到完整人体",
  person_detected: "当前检测到人体",
};

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
  const mimoRequest = decisionRuntime.mimoRequest || {};
  const voice = live.voice || {};

  const rawSnapshot = {
    c: {
      scene_id: scene.id,
      camera_ready: camera.cameraReady,
      model_ready: camera.modelReady,
      inference_backend: camera.inferenceBackend || null,
      gpu_renderer: camera.gpuRenderer || null,
      person_detected: camera.personDetected,
      skeleton_source: camera.skeletonSource || null,
      conversation_scenario: scene.conversationScenario || null,
      auto_conversation: Boolean(scene.autoConversation),
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
      mimo_model: MIMO_MODEL,
      mimo_configured: MIMO_CONFIGURED,
      mimo_request: mimoRequest,
      voice,
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
        <section id="runtime-debug-panel" className="runtime-debug-panel" aria-label="统一后端实时调试信息">
          <header>
            <div>
              <small>UNIFIED RUNTIME DEBUG</small>
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
              <DebugValue label="推理后端" value={camera.inferenceBackend || "loading"} />
              <DebugValue label="GPU 渲染器" value={camera.gpuRenderer || "detecting"} wide />
              <DebugValue label="检测到人物" value={camera.personDetected ? "yes" : "no"} />
              <DebugValue label="骨架显示来源" value={camera.skeletonSource || "—"} />
              <DebugValue label="场景对话任务" value={scene.conversationScenario || "disabled"} />
              <DebugValue label="自动对话" value={scene.autoConversation ? "enabled (2.5s)" : "manual / disabled"} />
              {camera.error && <DebugValue label="C 错误" value={camera.error} wide />}
            </div>
          </div>

          <div className="debug-section">
            <h3>A · 感知运行时</h3>
            <div className="debug-grid">
              <DebugValue label="会话状态" value={SESSION_LABELS[runtime.state] || runtime.state || "会话离线"} />
              <DebugValue label="当前活动" value={ACTIVITY_LABELS[runtime.activityState] || "等待状态"} />
              <DebugValue label="输入通道" value={runtime.inputMode || "—"} />
              <DebugValue label="支持输入" value={runtime.acceptedInputs?.join(", ") || "—"} wide />
              <DebugValue label="Session ID" value={runtime.sessionId || "—"} wide />
              <DebugValue label="最新帧" value={runtime.latestFrameIndex ?? "—"} />
              <DebugValue label="帧龄" value={number(runtime.frameAgeMs, " ms")} />
              <DebugValue
                label="A 检测到人物"
                value={runtime.personDetected === true ? "yes" : runtime.personDetected === false ? "no" : "—"}
              />
              <DebugValue label="A 关键点质量" value={runtime.landmarkQuality || "—"} />
              <DebugValue label="姿态分类" value={posture ? describePosture(posture.posture) : "等待事件"} />
              <DebugValue label="分类来源" value={posture?.classification_source || "—"} />
              <DebugValue label="姿态置信度" value={percent(posture?.posture_confidence)} />
              <DebugValue label="持续时间" value={number(posture?.posture_duration_ms, " ms")} />
              <DebugValue label="运动等级" value={posture?.motion_level || "—"} />
              <DebugValue label="关键点质量" value={posture?.landmark_quality || "—"} />
              <DebugValue label="时间戳" value={number(posture?.timestamp_ms, " ms")} />
              <DebugValue label="动作转变" value={transition?.transition || "等待事件"} wide />
              <DebugValue label="转变置信度" value={percent(transition?.transition_confidence)} />
              <DebugValue label="MIL v3 分数" value={percent(transition?.evidence?.fall_mil_probability)} />
              <DebugValue label="MIL 候选门" value={transition?.evidence?.fall_mil_candidate_eligible ? "pass" : "abstain"} />
              <DebugValue label="MIL 已确认" value={transition?.evidence?.fall_mil_confirmed ? "yes" : "no"} />
              <DebugValue label="转变窗口" value={transition ? `${number(transition.start_ms)} → ${number(transition.end_ms)} ms` : "—"} />
              {runtime.reason && <DebugValue label="A 原因" value={runtime.reason} wide />}
            </div>
          </div>

          <div className="debug-section">
            <h3>B · 决策与 MiMo</h3>
            <div className="debug-grid">
              <DebugValue label="WebSocket" value={decisionRuntime.connection || "closed"} />
              <DebugValue label="MiMo 模型" value={MIMO_MODEL} />
              <DebugValue label="MiMo Key" value={MIMO_CONFIGURED ? "configured" : "missing"} />
              <DebugValue label="MiMo 请求状态" value={mimoRequest.status || "idle"} />
              <DebugValue label="MiMo 请求场景" value={mimoRequest.scenario || "—"} />
              <DebugValue label="MiMo 发起时间" value={mimoRequest.requestedAt ? new Date(mimoRequest.requestedAt).toLocaleTimeString() : "—"} />
              <DebugValue label="MiMo 响应时间" value={mimoRequest.respondedAt ? new Date(mimoRequest.respondedAt).toLocaleTimeString() : "—"} />
              <DebugValue label="MiMo 返回来源" value={mimoRequest.source || "—"} />
              <DebugValue label="MiMo Decision ID" value={mimoRequest.decisionId || "—"} wide />
              {mimoRequest.error && <DebugValue label="MiMo 请求错误" value={mimoRequest.error} wide />}
              <DebugValue label="决策状态" value={decision?.state || "等待决策"} />
              <DebugValue label="决策来源" value={decision?.source || "—"} />
              <DebugValue label="动作" value={decision?.action || "—"} />
              <DebugValue label="风险等级" value={decision?.risk_level ?? "—"} />
              <DebugValue label="隐私模式" value={decision?.privacy_mode || "—"} />
              <DebugValue label="Decision ID" value={decision?.decision_id || "—"} wide />
              <DebugValue label="老人话术" value={decision?.elder_message || "—"} wide />
              <DebugValue label="家属通知" value={decision?.family_notification || "—"} wide />
              <DebugValue label="语音能力" value={voice.supported ? "ready" : "unsupported"} />
              <DebugValue label="语音阶段" value={voice.stage || "idle"} />
              <DebugValue label="自动聆听" value={voice.listening ? "recording" : "idle"} />
              <DebugValue label="ASR 模型" value={voice.asrModel || "mimo-v2.5-asr"} />
              <DebugValue label="ASR 延迟" value={number(voice.asrLatencyMs, " ms")} />
              <DebugValue label="TTS 模型" value={voice.ttsModel || "mimo-v2.5-tts"} />
              <DebugValue label="TTS 延迟" value={number(voice.ttsLatencyMs, " ms")} />
              <DebugValue label="识别文本" value={voice.transcript || "—"} wide />
              <DebugValue label="回复意图" value={voice.responseValue || "—"} />
              {voice.error && <DebugValue label="语音错误" value={voice.error} wide />}
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
