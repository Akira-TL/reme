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
  idle: "等待对话",
  tts_request: "MiMo TTS 合成询问中…",
  playing: "正在播放 MiMo 语音…",
  playing_fallback: "正在播放降级语音…",
  waiting_reply: "即将自动聆听…",
  recording: "正在自动聆听老人回复…",
  asr_request: "MiMo ASR 识别中…",
  complete: "本轮语音对话完成",
  failed: "语音链路失败",
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
    <section className="acceptance-controls" aria-label="ABC 手动验收控制">
      <div className="acceptance-control-title">
        <span><CampaignRoundedIcon /></span>
        <div>
          <small>MANUAL ACCEPTANCE</small>
          <strong>对话、沟通与提醒验收</strong>
          <p>手动触发只代替现场事件，后续仍由 B 调用 MiMo、等待回复并发布真实决策。</p>
        </div>
      </div>

      <div className="acceptance-control-groups">
        <div className="acceptance-control-group">
          <small>当前场景触发</small>
          <div>
            {conversationScenario && (
              <Button
                color={kitchen ? "warning" : "primary"}
                variant="contained"
                startIcon={kitchen ? <RestaurantRoundedIcon /> : <CampaignRoundedIcon />}
                disabled={!live.active || waitingResponse || conversationBusy}
                onClick={() => live.startDemoConversation(conversationScenario)}
              >
                {kitchen ? "触发包包子分享对话" : "手动触发 MiMo 主动询问"}
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
                手动触发跌倒报警
              </Button>
            )}
            <Button
              variant="outlined"
              startIcon={<RestartAltRoundedIcon />}
              disabled={!live.active}
              onClick={onReset}
            >
              重置当前对话
            </Button>
          </div>
        </div>

        <div className="acceptance-control-group">
          <small>免按钮语音 / 手动回退</small>
          <div>
            <Button
              variant="outlined"
              startIcon={<VolumeUpRoundedIcon />}
              disabled={!decision?.elder_message}
              onClick={live.replayVoice}
            >
              重播 MiMo 询问
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
        <b>{live.active ? `当前场景：${scene.title}` : "ABC 链路未连接"}</b>
        <p>
          {voice.error
            || (voice.stage && voice.stage !== "idle" ? VOICE_STAGE_LABELS[voice.stage] : "")
            || mimoRequest.error
            || (mimoRequest.status === "waiting_scene" ? "正在同步 B 场景，随后发起 MiMo 请求…" : "")
            || (mimoRequest.status === "requesting" ? "MiMo 请求已发出，等待响应…" : "")
            || (mimoRequest.status === "succeeded" ? `MiMo 已响应：${mimoRequest.source || "unknown"}` : "")
            || (voice.transcript ? `识别文本：${voice.transcript}` : "MiMo 对话与语音识别结果会显示在这里")}
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
