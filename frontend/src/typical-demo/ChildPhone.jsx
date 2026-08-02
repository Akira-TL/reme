import CallRoundedIcon from "@mui/icons-material/CallRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import { Button } from "@mui/material";
import { FALL_PHASES } from "./scenes";
import { SceneViewport } from "./SceneViewport";

function PhoneStatusIcon({ sceneId, danger }) {
  if (danger) return <EmergencyRoundedIcon />;
  if (sceneId === "bathroom") return <LockRoundedIcon />;
  if (sceneId === "kitchen") return <RestaurantRoundedIcon />;
  return <ShieldRoundedIcon />;
}

export function ChildPhone({
  scene,
  fallPhase,
  fallStateOverride = null,
  emergencyNote = null,
  kitchenShared,
  canvasRef,
  camera,
  viewMode,
  familyViewOpen,
  familyVideoAllowed,
  onToggleFamilyView,
  onContact,
  onSafe,
}) {
  const danger = scene.id === "fall" && fallPhase !== "idle";
  const emergency = scene.id === "fall" && ["emergency", "contacting", "resolved"].includes(fallPhase);
  const fallState = fallStateOverride || FALL_PHASES[fallPhase];
  const title = scene.id === "fall" && danger ? fallState.status : scene.phoneTitle;
  const body = scene.id === "fall" && danger ? fallState.message : scene.phoneBody;

  return (
    <section className="phone-column" aria-label="子女设备端">
      <div className={`phone-shell ${emergency ? "has-emergency" : ""}`}>
        <div className="phone-statusbar"><b>9:41</b><span className="dynamic-island" /><span>▮▮ ᯤ ▰</span></div>
        <div className="phone-header"><b>外婆家</b><span>⌄</span><i /></div>

        <SceneViewport
          sceneId={scene.id}
          canvasRef={canvasRef}
          cameraReady={camera.cameraReady}
          viewMode={viewMode}
          segmentationReady={camera.segmentationReady}
          skeletonSource={camera.skeletonSource}
          compact
        />

        <div className="family-view-control">
          <Button
            size="small"
            variant={familyViewOpen && familyVideoAllowed ? "contained" : "outlined"}
            startIcon={familyViewOpen && familyVideoAllowed
              ? <VisibilityOffRoundedIcon />
              : <VisibilityRoundedIcon />}
            disabled={!familyVideoAllowed}
            onClick={onToggleFamilyView}
          >
            {scene.id === "bathroom"
              ? "隐私场景仅骨架"
              : familyViewOpen && familyVideoAllowed
                ? "关闭现场画面"
                : familyVideoAllowed ? "主动查看现场" : "等待隐私授权"}
          </Button>
          <small>{viewMode === "video_skeleton" ? "原视频 + A 骨架" : "默认仅显示 A 骨架"}</small>
        </div>

        <div className={`phone-care-card ${danger ? "is-danger" : `is-${scene.tone}`}`}>
          <span><PhoneStatusIcon sceneId={scene.id} danger={danger} /></span>
          <div><strong>{title}</strong><p>{body}</p></div>
        </div>

        {scene.id === "kitchen" && (
          <div className={`phone-moment ${kitchenShared ? "is-shared" : ""}`}>
            <div className="moment-visual"><RestaurantRoundedIcon /></div>
            <div>
              <small>{kitchenShared ? "刚刚收到" : "等待长辈确认"}</small>
              <b>{kitchenShared ? "奶奶的包饺子记忆" : "发现一个生活片段"}</b>
              <p>{kitchenShared ? "已整理关键步骤与现场片段" : "确认前不会向你展示或保存"}</p>
            </div>
            {kitchenShared && <CheckCircleRoundedIcon className="shared-check" />}
          </div>
        )}

        {scene.id !== "kitchen" && (
          <div className="phone-timeline">
            <h3>家庭时间线</h3>
            <div><i /><time>刚刚</time><span>{scene.id === "bathroom" ? "进入隐私保护" : danger ? "收到异常动作候选" : "检测到正常活动"}</span></div>
            <div><i /><time>13:10</time><span>检测到睡醒</span></div>
            <div><i /><time>12:00</time><span>检测到吃饭</span></div>
          </div>
        )}

        <nav className="phone-nav">
          <span className="active"><HomeRoundedIcon /><small>首页</small></span>
          <span><span className="heart-icon">♡</span><small>看板</small></span>
          <span><SettingsRoundedIcon /><small>设置</small></span>
        </nav>

        {emergency && (
          <div className="emergency-sheet" role="alertdialog" aria-label="紧急风险提醒">
            <div className="emergency-mark"><EmergencyRoundedIcon /></div>
            <small>紧急风险提醒</small>
            <h3>{fallState.status}</h3>
            <p>{fallState.message}</p>
            <div className="emergency-video-note">
              <LockRoundedIcon /> {emergencyNote || "预授权紧急画面已临时开放"}
            </div>
            {fallPhase === "emergency" && (
              <>
                <Button variant="contained" color="error" startIcon={<CallRoundedIcon />} onClick={onContact}>联系紧急联系人</Button>
                <Button variant="text" onClick={onSafe}>老人已确认安全</Button>
              </>
            )}
            {fallPhase === "contacting" && (
              <div className="calling-state"><i /> {fallStateOverride ? fallState.message : "正在呼叫王阿姨…"}</div>
            )}
            {fallPhase === "resolved" && (
              <div className="resolved-state">
                <CheckCircleRoundedIcon /> {fallStateOverride ? fallState.message : "王阿姨已确认前往"}
              </div>
            )}
          </div>
        )}
      </div>
      <strong className="column-label">子女设备端 · 实时同步</strong>
    </section>
  );
}
