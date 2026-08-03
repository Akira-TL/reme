import CampaignRoundedIcon from "@mui/icons-material/CampaignRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import RestaurantRoundedIcon from "@mui/icons-material/RestaurantRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import VolumeUpRoundedIcon from "@mui/icons-material/VolumeUpRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import { Button } from "@mui/material";

const VOICE_STAGE_LABELS = {
  idle: "等待下一次对话",
  fall_inquiry_wait: "检测到跌倒，1 秒后开始询问…",
  tts_request: "正在准备语音询问…",
  playing: "正在播放关怀语音…",
  playing_fallback: "正在使用备用语音播放…",
  waiting_reply: "播放结束后会自动聆听…",
  recording: "正在播报并聆听外婆的回复…",
  asr_request: "正在理解语音回复…",
  complete: "这一轮对话已完成",
  failed: "语音对话暂时没有完成",
};

export function AcceptanceControls({ scene, live, onTriggerFall, onReset }) {
  const decision = live.decision?.decision;
  const mimoRequest = live.decision?.mimoRequest || {};
  const voice = live.voice || {};
  const waitingResponse = ["check_in_required", "consent_required"].includes(decision?.state);
  const waitingConsent = Boolean(decision?.consent_required);
  const kitchen = scene.id === "kitchen";
  const fall = scene.id === "fall";
  const conversationScenario = scene.conversationScenario;
  const conversationBusy = ["waiting_scene", "requesting"].includes(mimoRequest.status);

  return (
    <section className="acceptance-controls" aria-label="手动演示控制">
      <div className="acceptance-control-title">
        <span><CampaignRoundedIcon /></span>
        <div>
          <small>演示控制</small>
          <strong>手动演练关怀流程</strong>
          <p>这里用于路演时补触发场景；后续询问、回复和提醒仍按真实链路执行。</p>
        </div>
      </div>

      <div className="acceptance-control-groups">
        <div className="acceptance-control-group">
          <small>场景演练</small>
          <div>
            {conversationScenario && (
              <Button
                color={kitchen ? "warning" : "primary"}
                variant="contained"
                startIcon={kitchen ? <RestaurantRoundedIcon /> : <CampaignRoundedIcon />}
                disabled={!live.active || waitingResponse || conversationBusy}
                onClick={() => live.startDemoConversation(conversationScenario)}
              >
                {kitchen ? "发起分享询问" : "发起主动关怀"}
              </Button>
            )}
            {fall && (
              <Button
                color="error"
                variant="contained"
                startIcon={<WarningAmberRoundedIcon />}
                disabled={!live.active}
                onClick={onTriggerFall}
              >
                模拟一次跌倒异常
              </Button>
            )}
            <Button
              variant="outlined"
              startIcon={<RestartAltRoundedIcon />}
              disabled={!live.active}
              onClick={onReset}
            >
              重新开始当前场景
            </Button>
          </div>
        </div>

        <div className="acceptance-control-group">
          <small>语音对话备用操作</small>
          <div>
            <Button
              variant="outlined"
              startIcon={<VolumeUpRoundedIcon />}
              disabled={!decision?.elder_message}
              onClick={live.replayVoice}
            >
              再听一遍询问
            </Button>
            {waitingConsent ? (
              <>
                <Button
                  color="success"
                  variant="outlined"
                  startIcon={<CheckCircleRoundedIcon />}
                  onClick={live.respondConsentGranted}
                >
                  分享给孩子
                </Button>
                <Button
                  variant="outlined"
                  startIcon={<CloseRoundedIcon />}
                  onClick={live.respondConsentDenied}
                >
                  这次不分享
                </Button>
              </>
            ) : (
              <>
                <Button
                  color="success"
                  variant="outlined"
                  startIcon={<CheckCircleRoundedIcon />}
                  disabled={!waitingResponse}
                  onClick={live.respondSafe}
                >
                  我没事
                </Button>
                <Button
                  color="error"
                  variant="outlined"
                  startIcon={<MedicalServicesRoundedIcon />}
                  disabled={!waitingResponse}
                  onClick={live.respondNeedHelp}
                >
                  我需要帮助
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="acceptance-control-status">
        <span className={live.active ? "is-online" : ""} />
        <b>{live.active ? `正在演示：${scene.title}` : "关怀链路尚未连接"}</b>
        <p>
          {voice.error
            || (voice.stage && voice.stage !== "idle" ? VOICE_STAGE_LABELS[voice.stage] : "")
            || mimoRequest.error
            || (mimoRequest.status === "waiting_scene" ? "正在切换场景，稍后会发起询问…" : "")
            || (mimoRequest.status === "requesting" ? "关怀询问已经发出，正在等待回复…" : "")
            || (mimoRequest.status === "succeeded" ? `本轮决策已生成：${mimoRequest.source === "mimo" ? "MiMo" : "本地规则"}` : "")
            || (voice.transcript ? `听到的回复：${voice.transcript}` : "对话进度和语音结果会显示在这里")}
        </p>
        {decision && (
          <em>
            B：{decision.state} · {decision.source === "mimo" ? "MiMo" : "规则"}
          </em>
        )}
      </div>
    </section>
  );
}
