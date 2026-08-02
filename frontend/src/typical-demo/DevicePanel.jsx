import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import { Button } from "@mui/material";
import { FALL_PHASES } from "./scenes";
import { SceneViewport } from "./SceneViewport";

function StatusSymbol({ sceneId, fallPhase }) {
  if (sceneId === "bathroom") return <LockRoundedIcon />;
  if (sceneId === "kitchen") return <RestaurantRoundedIcon />;
  if (sceneId === "fall" && fallPhase !== "idle") return <EmergencyRoundedIcon />;
  return <ShieldRoundedIcon />;
}

export function DevicePanel({
  scene,
  fallPhase,
  fallStateOverride = null,
  liveActive = false,
  kitchenShared,
  canvasRef,
  camera,
  viewMode,
  onShare,
  onStartFall,
  onSafe,
  onResetFall,
}) {
  const fallState = fallStateOverride || FALL_PHASES[fallPhase];
  const activeStatus = scene.id === "fall" ? fallState.status : scene.status;
  const activeSummary = scene.id === "fall" ? fallState.message : scene.summary;
  const danger = scene.id === "fall" && fallPhase !== "idle";

  return (
    <section className={`device-panel tone-${scene.tone} ${danger ? `fall-${fallPhase}` : ""}`} aria-label="智能设备端">
      <header className="panel-heading">
        <div>
          <span>智能设备端</span>
          <h2>{scene.title}</h2>
        </div>
        <div className="source-state">
          <i className={camera.cameraReady ? "is-online" : ""} />
          {camera.cameraReady ? "电脑摄像头" : "等待摄像头"}
        </div>
      </header>

      <SceneViewport
        sceneId={scene.id}
        canvasRef={canvasRef}
        cameraReady={camera.cameraReady}
        viewMode={viewMode}
        segmentationReady={camera.segmentationReady}
        skeletonSource={camera.skeletonSource}
      />

      <div className={`device-status status-${danger ? "danger" : scene.tone}`}>
        <div className="status-symbol"><StatusSymbol sceneId={scene.id} fallPhase={fallPhase} /></div>
        <div>
          <small>当前状态</small>
          <strong>{activeStatus}</strong>
          <p>{activeSummary}</p>
        </div>
        <span className="processing-label">现场演示 · 本地处理</span>
      </div>

      {scene.id === "kitchen" && (
        <div className="interaction-card memory-card">
          <div className="mimo-avatar">Mi</div>
          <div>
            <b>MiMo 主动关怀</b>
            <p>{kitchenShared ? "已根据奶奶的确认，把包饺子片段同步给孙女。" : "奶奶，孙女可能也想学您包饺子，需要把这段过程发给她吗？"}</p>
          </div>
          {kitchenShared ? (
            <div className="confirmed"><CheckCircleRoundedIcon /> 已确认分享</div>
          ) : (
            <Button variant="contained" onClick={onShare}>同意分享</Button>
          )}
        </div>
      )}

      {scene.id === "bathroom" && (
        <div className="interaction-card privacy-card">
          <LockRoundedIcon />
          <div><b>敏感场景规则已生效</b><p>真人画面、音频、截图与生活片段分享均已关闭。</p></div>
        </div>
      )}

      {scene.id === "fall" && (
        <div className="interaction-card fall-controls">
          <div>
            <b>
              {liveActive
                ? "真实决策流已接管（A 感知 + B 决策）"
                : fallPhase === "idle" ? "准备深夜跌倒演示" : "演示流程正在双端同步"}
            </b>
            <p>
              {liveActive
                ? "跌倒由镜头前动作触发：A 判定候选、B 询问确认并升级家属，本面板按钮即老人的真实回应。"
                : fallPhase === "idle"
                  ? "准备好动作后点击按钮或按空格键。风险判断为可控剧本触发。"
                  : "候选检测不等于真实跌倒结论；当前按演示时序推进。"}
            </p>
          </div>
          <div className="control-actions">
            {!liveActive && fallPhase === "idle" && (
              <Button variant="contained" color="error" onClick={onStartFall}>开始跌倒流程</Button>
            )}
            {["candidate", "checking"].includes(fallPhase) && (
              <Button variant="outlined" color="success" onClick={onSafe}>
                {liveActive ? "我没事（回应 B 的询问）" : "我没事，解除候选"}
              </Button>
            )}
            {!liveActive && !["idle", "candidate", "checking"].includes(fallPhase) && (
              <Button variant="outlined" onClick={onResetFall}>重置场景</Button>
            )}
            {liveActive && ["emergency", "contacting"].includes(fallPhase) && (
              <Button variant="outlined" color="success" onClick={onSafe}>我没事（迟到平安）</Button>
            )}
          </div>
        </div>
      )}

      {camera.error && (
        <button className="camera-error" type="button" onClick={camera.retry}>{camera.error} · 点击重试</button>
      )}
    </section>
  );
}
