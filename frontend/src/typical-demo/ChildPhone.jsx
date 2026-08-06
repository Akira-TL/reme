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
  kitchenNotification,
  canvasRef,
  camera,
  viewMode,
  familyViewOpen,
  autoFamilyViewOpen = false,
  familyVideoAllowed,
  onToggleFamilyView,
  onContact,
  onSafe,
}) {
  const danger = scene.id === "fall" && fallPhase !== "idle";
  const emergency = scene.id === "fall" && ["emergency", "resolved"].includes(fallPhase);
  const fallState = fallStateOverride || FALL_PHASES[fallPhase];
  const title = scene.id === "fall" && danger
    ? fallState.status
    : scene.id === "kitchen"
      ? kitchenShared ? "收到奶奶分享" : "外婆家一切正常"
      : scene.phoneTitle;
  const body = scene.id === "fall" && danger
    ? fallState.message
    : scene.id === "kitchen"
      ? kitchenShared ? kitchenNotification : "暂无新的家庭动态"
      : scene.phoneBody;
  const liveVideoVisible = familyVideoAllowed && (familyViewOpen || autoFamilyViewOpen);

  return (
    <section className="phone-column" aria-label="家属端">
      <div className={`phone-shell ${emergency ? "has-emergency" : ""}`}>
        <div className="phone-statusbar"><b>9:41</b><span className="dynamic-island" /><span>▮▮ ᯤ ▰</span></div>
        <div className="phone-header"><b>外婆家</b><span>⌄</span><i /></div>

        <SceneViewport
          sceneId={scene.id}
          backgroundImage={scene.backgroundImage}
          aspectRatio={camera.aspectRatio}
          canvasRef={canvasRef}
          cameraReady={camera.cameraReady}
          cameraError={camera.cameraError}
          modelReady={camera.modelReady}
          modelError={camera.modelError}
          inferenceBackend={camera.inferenceBackend}
          viewMode={viewMode}
          skeletonSource={camera.skeletonSource}
          compact
        />

        <div className="family-view-control">
          <Button
            size="small"
            variant={liveVideoVisible ? "contained" : "outlined"}
            startIcon={liveVideoVisible && !autoFamilyViewOpen
              ? <VisibilityOffRoundedIcon />
              : <VisibilityRoundedIcon />}
            disabled={!familyVideoAllowed || !camera.cameraReady || autoFamilyViewOpen}
            onClick={onToggleFamilyView}
          >
            {scene.id === "bathroom"
              ? "浴室始终保护隐私"
              : !familyVideoAllowed
                ? "等待家中设备连接"
                : autoFamilyViewOpen
                  ? scene.id === "kitchen" ? "厨房场景显示原画" : "跌倒后自动开放原画"
                  : familyViewOpen
                  ? "收起现场画面"
                  : "查看现场画面"}
          </Button>
          <small>{viewMode === "video_skeleton" ? "现场画面已叠加姿态识别" : "默认只显示姿态画面"}</small>
        </div>

        <div className={`phone-care-card ${danger ? "is-danger" : `is-${scene.tone}`}`}>
          <span><PhoneStatusIcon sceneId={scene.id} danger={danger} /></span>
          <div><strong>{title}</strong><p>{body}</p></div>
        </div>

        {scene.id === "kitchen" && kitchenShared && (
          <div className="phone-moment is-shared">
            <div className="moment-visual"><RestaurantRoundedIcon /></div>
            <div>
              <small>刚刚收到</small>
              <b>奶奶分享了包包子的生活片段</b>
              <p>{kitchenNotification}</p>
            </div>
            <CheckCircleRoundedIcon className="shared-check" />
          </div>
        )}

        {scene.id !== "kitchen" && (
          <div className="phone-timeline">
            <h3>家庭时间线</h3>
            <div><i /><time>刚刚</time><span>{scene.id === "bathroom" ? "已切换为浴室隐私模式" : danger ? "发现一次较大的动作变化" : "家中有正常活动"}</span></div>
            <div><i /><time>13:10</time><span>外婆起身活动</span></div>
            <div><i /><time>12:00</time><span>外婆按时吃了午饭</span></div>
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
              <LockRoundedIcon /> {emergencyNote || "已按预授权临时开放现场画面"}
            </div>
            {fallPhase === "emergency" && (
              <>
                <Button variant="contained" color="error" startIcon={<CallRoundedIcon />} onClick={onContact}>联系紧急联系人</Button>
                <Button variant="text" onClick={onSafe}>老人已确认安全</Button>
              </>
            )}
            {fallPhase === "resolved" && (
              <div className="resolved-state">
                <CheckCircleRoundedIcon /> {fallState.message}
              </div>
            )}
          </div>
        )}
      </div>
      <strong className="column-label">家属端 · 与家中设备同步</strong>
    </section>
  );
}
