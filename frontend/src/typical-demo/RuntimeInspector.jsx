import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import HubRoundedIcon from "@mui/icons-material/HubRounded";
import PsychologyRoundedIcon from "@mui/icons-material/PsychologyRounded";
import SensorsRoundedIcon from "@mui/icons-material/SensorsRounded";
import VideocamRoundedIcon from "@mui/icons-material/VideocamRounded";
import { Button } from "@mui/material";
import { describePosture } from "../adapters/perception";
import { describeSkeletonSource, getCameraHealth, getLinkHealth, getModelHealth } from "./runtimeStatus";

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
  const perceptionOnline = runtime.state === "running";
  const decisionOnline = live.decision?.connection === "open";
  const cameraHealth = getCameraHealth(camera);
  const modelHealth = getModelHealth(camera);
  const linkHealth = getLinkHealth(live);
  const inputOnline = cameraHealth.state === "online" && modelHealth.state === "online";
  const inputStatus = inputOnline
    ? "摄像头与 GPU 已就绪"
    : cameraHealth.state === "degraded" ? cameraHealth.label : modelHealth.label;
  const inputDetail = `${describeSkeletonSource(camera.skeletonSource)} · ${cameraHealth.detail} · ${modelHealth.detail}`;
  const mimoSource = decision?.source === "mimo" ? "MiMo 推理" : decision ? "确定性规则" : "等待事件";

  return (
    <aside className="runtime-inspector" aria-label="统一运行时单机链路验收">
      <header>
        <span>统一后端链路</span>
        <h2>实时验收面板</h2>
        <p>同一台电脑运行统一后端与前端页面；感知和决策通过进程内通讯连接。</p>
      </header>

      <div className="runtime-flow" aria-label="数据流向">
        <b>浏览器摄像头</b><i>→</i><b>本地感知</b><i>→</i><b>进程内决策 / MiMo</b><i>→</i><b>页面展示</b>
      </div>

      <StatusRow
        icon={<VideocamRoundedIcon />}
        title="浏览器输入与 GPU"
        status={inputStatus}
        detail={inputDetail}
        online={inputOnline}
      />
      <StatusRow
        icon={<SensorsRoundedIcon />}
        title="后端 · 姿态感知"
        status={RUNTIME_LABELS[runtime.state] || runtime.state || "等待连接"}
        detail={posture ? `${describePosture(posture.posture)} · 置信度 ${Math.round((posture.posture_confidence || 0) * 100)}%` : runtime.reason || "等待 17 节点姿态事件"}
        online={perceptionOnline}
      />
      <StatusRow
        icon={<HubRoundedIcon />}
        title="后端 · 动作转变"
        status={transition ? TRANSITION_LABELS[transition.transition] || transition.transition : "等待转变事件"}
        detail={transition ? `置信度 ${Math.round((transition.transition_confidence || 0) * 100)}%` : "静态姿态不会被直接当作跌倒"}
        online={Boolean(transition)}
      />
      <StatusRow
        icon={<PsychologyRoundedIcon />}
        title="后端 · 决策与 MiMo"
        status={decisionOnline ? DECISION_LABELS[decision?.state] || "决策流已连接" : "统一后端决策流未连接"}
        detail={decision ? `${mimoSource} · ${decision.elder_message || decision.family_notification || "已生成关怀决策"}` : live.decision?.reason || "等待感知姿态或转变事件"}
        online={decisionOnline}
      />

      <div className={`acceptance-result ${linkHealth.state === "online" ? "is-online" : ""}`}>
        {linkHealth.state === "online" ? <CheckCircleRoundedIcon /> : <span />}
        <div>
          <small>当前验收状态</small>
          <strong>{linkHealth.label}</strong>
          <p>{linkHealth.state === "online" ? `场景 ${scene.id} 正在真实运行，当前阶段：${fallPhase}` : linkHealth.detail}</p>
        </div>
      </div>

      {decision?.state === "check_in_required" && (
        <Button variant="contained" color="success" fullWidth onClick={live.respondSafe}>
          我没事，回应安全询问
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
