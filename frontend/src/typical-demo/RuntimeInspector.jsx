import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import PsychologyRoundedIcon from "@mui/icons-material/PsychologyRounded";
import SensorsRoundedIcon from "@mui/icons-material/SensorsRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button } from "@mui/material";
import { describePosture } from "../adapters/perception";

const RUNTIME_LABELS = {
  offline: "离线",
  starting: "启动中",
  running: "运行中",
  input_unavailable: "输入降级",
  degraded: "降级",
  stopped: "已停止",
};

const DECISION_LABELS = {
  normal: "正常观察",
  observe: "继续观察",
  check_in_required: "需要主动询问",
  family_notification_required: "需要通知家属",
  urgent_attention: "需要紧急关注",
  resolved: "事件已化解",
  degraded: "决策降级",
};

const TRANSITION_LABELS = {
  normal_transition: "正常动作变化",
  fall_like_transition: "跌倒式动作候选",
  uncertain_transition: "不确定动作变化",
};

function StatusRow({ icon, title, status, detail, online }) {
  return (
    <div className="runtime-row">
      <span className={`runtime-row-icon ${online ? "is-online" : ""}`}>{icon}</span>
      <div>
        <small>{title}</small>
        <strong>{status}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function RuntimeInspector({ scene, camera, live, fallPhase }) {
  const runtime = live.runtime || {};
  const posture = live.posture;
  const transition = live.transition;
  const decision = live.decision?.decision;
  const perceptionOnline = ["starting", "running", "input_unavailable"].includes(runtime.state);
  const decisionOnline = live.decision?.connection === "open";
  const mimoSource = decision?.source === "mimo" ? "MiMo 推理" : decision ? "确定性规则" : "等待事件";

  return (
    <aside className="runtime-inspector" aria-label="ABC 单机链路验收">
      <header>
        <span>ABC 单机链路</span>
        <h2>实时验收面板</h2>
        <p>同一台电脑运行 A 感知、B 决策和 C 页面；这里显示真实连接和事件，不伪装离线状态。</p>
      </header>

      <div className="runtime-flow" aria-label="数据流向">
        <b>C 摄像头</b><i>→</i><b>A 感知</b><i>→</i><b>B / MiMo</b><i>→</i><b>C 展示</b>
      </div>

      <StatusRow
        icon={<VideocamRoundedIcon />}
        title="C · 浏览器输入"
        status={camera.cameraReady ? "摄像头已连接" : "等待摄像头"}
        detail={camera.error || `当前场景：${scene.title}`}
        online={camera.cameraReady}
      />
      <StatusRow
        icon={<SensorsRoundedIcon />}
        title="A · 姿态感知"
        status={RUNTIME_LABELS[runtime.state] || runtime.state || "等待连接"}
        detail={posture ? `${describePosture(posture.posture)} · 置信度 ${Math.round((posture.posture_confidence || 0) * 100)}%` : runtime.reason || "等待 17 节点姿态事件"}
        online={perceptionOnline}
      />
      <StatusRow
        icon={<HubRoundedIcon />}
        title="A · 动作转变"
        status={transition ? TRANSITION_LABELS[transition.transition] || transition.transition : "等待转变事件"}
        detail={transition ? `置信度 ${Math.round((transition.transition_confidence || 0) * 100)}%` : "静态姿态不会被直接当作跌倒"}
        online={Boolean(transition)}
      />
      <StatusRow
        icon={<PsychologyRoundedIcon />}
        title="B · 决策与 MiMo"
        status={decisionOnline ? DECISION_LABELS[decision?.state] || "决策流已连接" : "决策服务未连接"}
        detail={decision ? `${mimoSource} · ${decision.elder_message || decision.family_notification || "已生成关怀决策"}` : live.decision?.reason || "等待 A 的姿态或转变事件"}
        online={decisionOnline}
      />

      <div className={`acceptance-result ${live.active ? "is-online" : ""}`}>
        {live.active ? <CheckCircleRoundedIcon /> : <span />}
        <div>
          <small>当前验收状态</small>
          <strong>{live.active ? "ABC 实时链路已接管" : "正在等待 ABC 链路"}</strong>
          <p>{live.active ? `场景 ${scene.id} 正在真实运行，当前阶段：${fallPhase}` : "请确认 A、B 服务和摄像头权限均正常"}</p>
        </div>
      </div>

      {decision?.state === "check_in_required" && (
        <Button variant="contained" color="success" fullWidth onClick={live.respondSafe}>
          我没事，回应 B 的询问
        </Button>
      )}
      {decision?.alarm && (
        <Button variant="contained" color="error" fullWidth onClick={live.confirmAlarm}>
          确认家属已收到告警
        </Button>
      )}
    </aside>
  );
}
