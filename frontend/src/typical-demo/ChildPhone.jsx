import BatteryFullRoundedIcon from "@mui/icons-material/BatteryFullRounded";
import CallRoundedIcon from "@mui/icons-material/CallRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CircleRoundedIcon from "@mui/icons-material/CircleRounded";
import EmergencyRoundedIcon from "@mui/icons-material/EmergencyRounded";
import ExpandMoreRoundedIcon from "@mui/icons-material/ExpandMoreRounded";
import FavoriteBorderRoundedIcon from "@mui/icons-material/FavoriteBorderRounded";
import HomeRoundedIcon from "@mui/icons-material/HomeRounded";
import InsightsRoundedIcon from "@mui/icons-material/InsightsRounded";
import LockRoundedIcon from "@mui/icons-material/LockRounded";
import NotificationsActiveRoundedIcon from "@mui/icons-material/NotificationsActiveRounded";
import PrivacyTipRoundedIcon from "@mui/icons-material/PrivacyTipRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import SettingsRoundedIcon from "@mui/icons-material/SettingsRounded";
import ShieldRoundedIcon from "@mui/icons-material/ShieldRounded";
import SignalCellularAltRoundedIcon from "@mui/icons-material/SignalCellularAltRounded";
import VisibilityOffRoundedIcon from "@mui/icons-material/VisibilityOffRounded";
import VisibilityRoundedIcon from "@mui/icons-material/VisibilityRounded";
import WifiRoundedIcon from "@mui/icons-material/WifiRounded";
import {
  BottomNavigation,
  BottomNavigationAction,
  Button,
  FormControlLabel,
  Switch,
} from "@mui/material";
import { useState } from "react";
import {
  isActiveFallDanger,
  shouldShowEmergencySheet,
} from "./phoneState";
import { FALL_PHASES } from "./scenes";
import { SceneViewport } from "./SceneViewport";

function PhoneStatusIcon({ sceneId, danger, resolved }) {
  if (resolved) return <CheckCircleRoundedIcon />;
  if (danger) return <EmergencyRoundedIcon />;
  if (sceneId === "bathroom") return <LockRoundedIcon />;
  if (sceneId === "kitchen") return <RestaurantRoundedIcon />;
  return <ShieldRoundedIcon />;
}

function FamilyDashboard({ scene, danger, resolved }) {
  const statusLabel = resolved ? "风险已解除" : danger ? "正在处理风险" : "状态稳定";
  return (
    <div className="mx-2.5 mt-2 grid gap-2.5 pb-20">
      <div className="rounded-xl border border-orange-100 bg-orange-50 p-3">
        <div className="flex items-center gap-2 text-orange-700">
          <InsightsRoundedIcon fontSize="small" />
          <strong className="text-xs">今日关怀摘要</strong>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-stone-600">
          当前场景为{scene.name}，家中设备持续在本地分析姿态，仅同步必要状态。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-emerald-50 p-3 text-emerald-800">
          <ShieldRoundedIcon fontSize="small" />
          <b className="mt-1 block text-[10px]">{statusLabel}</b>
          <small className="text-[8px] text-emerald-700">实时安全状态</small>
        </div>
        <div className="rounded-xl bg-sky-50 p-3 text-sky-800">
          <FavoriteBorderRoundedIcon fontSize="small" />
          <b className="mt-1 block text-[10px]">3 条生活记录</b>
          <small className="text-[8px] text-sky-700">今日家庭动态</small>
        </div>
      </div>
    </div>
  );
}

function FamilySettings({ privacyEnabled, notificationsEnabled, onPrivacyChange, onNotificationsChange }) {
  return (
    <div className="mx-2.5 mt-2 grid gap-2.5 pb-20">
      <div className="rounded-xl border border-stone-200 bg-stone-50 p-3">
        <div className="flex items-center gap-2 text-stone-800">
          <PrivacyTipRoundedIcon fontSize="small" />
          <strong className="text-xs">隐私与提醒</strong>
        </div>
        <p className="mt-1 text-[9px] leading-relaxed text-stone-500">
          原视频默认关闭；只有主动查看或紧急阶段才临时开放。
        </p>
      </div>
      <div className="rounded-xl border border-stone-200 bg-white px-3 py-1">
        <FormControlLabel
          control={<Switch size="small" checked={privacyEnabled} onChange={onPrivacyChange} />}
          label={<span className="text-[10px]">自动隐私保护</span>}
        />
      </div>
      <div className="rounded-xl border border-stone-200 bg-white px-3 py-1">
        <FormControlLabel
          control={<Switch size="small" checked={notificationsEnabled} onChange={onNotificationsChange} />}
          label={<span className="text-[10px]">紧急提醒通知</span>}
        />
      </div>
    </div>
  );
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
  const [activeTab, setActiveTab] = useState("home");
  const [privacyEnabled, setPrivacyEnabled] = useState(true);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const danger = scene.id === "fall" && isActiveFallDanger(fallPhase);
  const emergency = scene.id === "fall" && shouldShowEmergencySheet(fallPhase);
  const resolved = scene.id === "fall" && fallPhase === "resolved";
  const hasFallState = scene.id === "fall" && fallPhase !== "idle";
  const fallState = fallStateOverride || FALL_PHASES[fallPhase];
  const title = hasFallState
    ? fallState.status
    : scene.id === "kitchen"
      ? kitchenShared ? "收到奶奶分享" : "外婆家一切正常"
      : scene.phoneTitle;
  const body = hasFallState
    ? fallState.message
    : scene.id === "kitchen"
      ? kitchenShared ? kitchenNotification : "暂无新的家庭动态"
      : scene.phoneBody;
  const liveVideoVisible = familyVideoAllowed && (familyViewOpen || autoFamilyViewOpen);

  const visibleTab = emergency ? "home" : activeTab;

  return (
    <section className="phone-column" aria-label="家属端">
      <div className={`phone-shell ${emergency ? "has-emergency" : ""}`}>
        <div className="phone-statusbar">
          <b>9:41</b>
          <span className="dynamic-island" />
          <span className="flex items-center gap-0.5 text-stone-800" aria-label="手机网络与电量状态">
            <SignalCellularAltRoundedIcon sx={{ fontSize: 12 }} />
            <WifiRoundedIcon sx={{ fontSize: 12 }} />
            <BatteryFullRoundedIcon sx={{ fontSize: 13 }} />
          </span>
        </div>
        <div className="phone-header">
          <b>外婆家</b>
          <ExpandMoreRoundedIcon sx={{ fontSize: 17 }} />
          <span className="ml-auto grid h-7 w-7 place-items-center rounded-lg bg-orange-50 text-orange-600">
            <NotificationsActiveRoundedIcon sx={{ fontSize: 17 }} />
          </span>
        </div>

        {visibleTab === "home" && (
          <>
            <SceneViewport
              sceneId={scene.id}
              backgroundImage={scene.backgroundImage}
              aspectRatio={camera.aspectRatio}
              canvasRef={canvasRef}
              cameraReady={camera.cameraReady}
              cameraError={camera.cameraError}
              perceptionState={camera.perceptionState}
              inputMode={camera.inputMode}
              perceptionReason={camera.perceptionReason}
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
                      ? "紧急阶段临时开放原画"
                      : familyViewOpen
                        ? "收起现场画面"
                        : "查看现场画面"}
              </Button>
              <small>{viewMode === "video_skeleton" ? "现场画面叠加后端姿态结果" : "默认只显示后端姿态画面"}</small>
            </div>

            <div className={`phone-care-card ${danger ? "is-danger" : `is-${scene.tone}`}`}>
              <span><PhoneStatusIcon sceneId={scene.id} danger={danger} resolved={resolved} /></span>
              <div><strong>{title}</strong><p>{body}</p></div>
            </div>

            {resolved && (
              <div className="mx-2.5 flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-800">
                <CheckCircleRoundedIcon sx={{ fontSize: 19 }} />
                <div>
                  <b className="block text-[10px]">安全状态已确认</b>
                  <p className="mt-0.5 text-[8px] leading-relaxed text-emerald-700">警报和临时现场画面均已关闭。</p>
                </div>
              </div>
            )}

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
                <div><CircleRoundedIcon className="timeline-dot" /><time>刚刚</time><span>{scene.id === "bathroom" ? "已切换为浴室隐私模式" : danger ? "发现一次较大的动作变化" : resolved ? "老人已确认安全" : "家中有正常活动"}</span></div>
                <div><CircleRoundedIcon className="timeline-dot" /><time>13:10</time><span>外婆起身活动</span></div>
                <div><CircleRoundedIcon className="timeline-dot" /><time>12:00</time><span>外婆按时吃了午饭</span></div>
              </div>
            )}
          </>
        )}

        {visibleTab === "dashboard" && <FamilyDashboard scene={scene} danger={danger} resolved={resolved} />}
        {visibleTab === "settings" && (
          <FamilySettings
            privacyEnabled={privacyEnabled}
            notificationsEnabled={notificationsEnabled}
            onPrivacyChange={(event) => setPrivacyEnabled(event.target.checked)}
            onNotificationsChange={(event) => setNotificationsEnabled(event.target.checked)}
          />
        )}

        <BottomNavigation
          className="phone-nav"
          showLabels
          value={visibleTab}
          onChange={(_, value) => setActiveTab(value)}
        >
          <BottomNavigationAction label="首页" value="home" icon={<HomeRoundedIcon />} />
          <BottomNavigationAction label="看板" value="dashboard" icon={<InsightsRoundedIcon />} />
          <BottomNavigationAction label="设置" value="settings" icon={<SettingsRoundedIcon />} />
        </BottomNavigation>

        {emergency && (
          <div className="emergency-sheet" role="alertdialog" aria-modal="true" aria-label="紧急风险提醒">
            <div className="emergency-mark"><EmergencyRoundedIcon /></div>
            <small>紧急风险提醒</small>
            <h3>{fallState.status}</h3>
            <p>{fallState.message}</p>
            <div className="emergency-video-note">
              <LockRoundedIcon /> {emergencyNote || "已按预授权临时开放现场画面"}
            </div>
            <Button variant="contained" color="error" startIcon={<CallRoundedIcon />} onClick={onContact}>联系紧急联系人</Button>
            <Button variant="text" startIcon={<CheckCircleRoundedIcon />} onClick={onSafe}>老人已确认安全</Button>
          </div>
        )}
      </div>
      <strong className="column-label">家属端 · 与家中设备同步</strong>
    </section>
  );
}
