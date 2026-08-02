import { Alert, Snackbar } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { CallDialog } from "./components/CallDialog";
import { ContactDrawer } from "./components/ContactDrawer";
import { DashboardScreen } from "./components/DashboardScreen";
import { DetailDialog } from "./components/DetailDialog";
import { EmergencyOverlay } from "./components/EmergencyOverlay";
import { HomeScreen } from "./components/HomeScreen";
import { Navigation } from "./components/Navigation";
import { SceneDrawer } from "./components/SceneDrawer";
import { SettingsScreen } from "./components/SettingsScreen";
import { DASHBOARD_DETAILS, SCENES, SETTINGS_DETAILS } from "./data/content";

export function App() {
  const [tab, setTab] = useState("home");
  const [sceneKey, setSceneKey] = useState("normal");
  const [cameraVisible, setCameraVisible] = useState(true);
  const [sceneDrawerOpen, setSceneDrawerOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [callOpen, setCallOpen] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const [privacyOn, setPrivacyOn] = useState(true);
  const [mimoOn, setMimoOn] = useState(true);
  const [toast, setToast] = useState("");

  const scene = SCENES[sceneKey];

  useEffect(() => {
    if (sceneKey !== "risk") return undefined;
    const timer = window.setTimeout(() => {
      setEmergencyOpen(true);
      navigator.vibrate?.([120, 80, 120]);
    }, 900);
    return () => window.clearTimeout(timer);
  }, [sceneKey]);

  const activeDetail = useMemo(() => {
    if (!detail) return null;
    if (detail.kind === "dashboard") return DASHBOARD_DETAILS[detail.key];
    if (detail.kind === "settings") {
      const [title, body] = SETTINGS_DETAILS[detail.key];
      return { title, body, eyebrow: "PRIVACY BY DESIGN", action: "保存设置" };
    }
    if (detail.kind === "status") {
      return {
        title: scene.name,
        body: `${scene.detail}。当前原始视频不上传，仅同步状态和授权后的摘要。`,
        eyebrow: "CURRENT STATUS",
        action: "知道了",
      };
    }
    return null;
  }, [detail, scene]);

  function showToast(message) {
    setToast(message);
  }

  function selectScene(nextScene) {
    setSceneKey(nextScene);
    setCameraVisible(SCENES[nextScene].camera);
    setSceneDrawerOpen(false);
    showToast(`已切换：${SCENES[nextScene].name}`);
  }

  function toggleCamera() {
    if (sceneKey !== "normal") {
      setSceneKey("normal");
      setCameraVisible(true);
      showToast("已进入实时本地处理");
      return;
    }
    setCameraVisible((current) => !current);
    showToast(cameraVisible ? "已切换到产品视觉稿" : "实时本地处理已显示");
  }

  return (
    <main className="prototype relative isolate overflow-hidden bg-white" aria-label="Reme 手机端原型">
      <HomeScreen
        active={tab === "home"}
        scene={scene}
        cameraVisible={cameraVisible}
        onOpenScenes={() => setSceneDrawerOpen(true)}
        onToggleCamera={toggleCamera}
        onHideCamera={() => { setCameraVisible(false); showToast("实时画面已隐藏，摄像头继续在本地运行"); }}
        onOpenStatus={() => setDetail({ kind: "status" })}
      />
      <DashboardScreen active={tab === "dashboard"} onOpenDetail={(key) => setDetail({ kind: "dashboard", key })} />
      <SettingsScreen
        active={tab === "settings"}
        privacyOn={privacyOn}
        mimoOn={mimoOn}
        onTogglePrivacy={() => { setPrivacyOn((value) => !value); showToast(privacyOn ? "自动隐私保护已暂停（仅演示）" : "自动隐私保护已开启"); }}
        onToggleMimo={() => { setMimoOn((value) => !value); showToast(mimoOn ? "MiMo 主动关怀已关闭" : "MiMo 主动关怀已开启"); }}
        onOpenDetail={(key) => setDetail({ kind: "settings", key })}
      />

      <Navigation value={tab} onChange={setTab} />
      <EmergencyOverlay
        open={emergencyOpen}
        onClose={() => setEmergencyOpen(false)}
        onCall={() => { setEmergencyOpen(false); setCallOpen(true); }}
        onLive={() => { setEmergencyOpen(false); showToast("正在查看风险事件的实时骨骼状态"); }}
        onContact={() => { setEmergencyOpen(false); setContactsOpen(true); }}
      />

      <SceneDrawer open={sceneDrawerOpen} currentScene={sceneKey} onClose={() => setSceneDrawerOpen(false)} onSelect={selectScene} />
      <DetailDialog
        open={Boolean(detail)}
        content={activeDetail}
        onClose={() => setDetail(null)}
        onPrimary={() => { setDetail(null); showToast(detail?.kind === "settings" ? "设置已保存在本机" : "已准备关怀消息，等待你确认发送"); }}
      />
      <CallDialog open={callOpen} onClose={() => { setCallOpen(false); showToast("通话已结束"); }} />
      <ContactDrawer
        open={contactsOpen}
        onClose={() => setContactsOpen(false)}
        onSelect={(name) => { setContactsOpen(false); showToast(`正在联系${name}`); }}
      />
      <Snackbar open={Boolean(toast)} autoHideDuration={1900} onClose={() => setToast("")} anchorOrigin={{ vertical: "bottom", horizontal: "center" }}>
        <Alert severity="info" variant="filled" onClose={() => setToast("")} sx={{ borderRadius: 999, bgcolor: "rgba(23,23,24,.9)" }}>{toast}</Alert>
      </Snackbar>
    </main>
  );
}
