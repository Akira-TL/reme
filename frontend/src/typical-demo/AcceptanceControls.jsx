import CampaignRoundedIcon from "@mui/icons-material/CampaignRounded";
import ChairRoundedIcon from "@mui/icons-material/ChairRounded";
import CheckCircleRoundedIcon from "@mui/icons-material/CheckCircleRounded";
import MedicalServicesRoundedIcon from "@mui/icons-material/MedicalServicesRounded";
import MicRoundedIcon from "@mui/icons-material/MicRounded";
import RestartAltRoundedIcon from "@mui/icons-material/RestartAltRounded";
import VolumeUpRoundedIcon from "@mui/icons-material/VolumeUpRounded";
import WarningAmberRoundedIcon from "@mui/icons-material/WarningAmberRounded";
import { Button } from "@mui/material";

export function AcceptanceControls({ scene, live, onTrigger, onReset }) {
  const decision = live.decision?.decision;
  const voice = live.voice || {};
  const waitingResponse = Boolean(decision?.need_dialogue);

  return (
    <section className="acceptance-controls" aria-label="ABC 手动验收控制">
      <div className="acceptance-control-title">
        <span><CampaignRoundedIcon /></span>
        <div>
          <small>MANUAL ACCEPTANCE</small>
          <strong>场景状态与语音验收</strong>
          <p>按钮通过 C→A WebSocket 进入真实 B 状态机，不是前端假动画。</p>
        </div>
      </div>

      <div className="acceptance-control-groups">
        <div className="acceptance-control-group">
          <small>异常场景</small>
          <div>
            <Button
              color="error"
              variant="contained"
              startIcon={<WarningAmberRoundedIcon />}
              disabled={!live.active}
              onClick={() => onTrigger("fall", "fall")}
            >
              手动触发跌倒报警
            </Button>
            <Button
              color="warning"
              variant="outlined"
              startIcon={<ChairRoundedIcon />}
              disabled={!live.active}
              onClick={() => onTrigger("long_sit", "living")}
            >
              手动触发久坐关怀
            </Button>
            <Button
              variant="outlined"
              startIcon={<RestartAltRoundedIcon />}
              disabled={!live.active}
              onClick={onReset}
            >
              恢复正常
            </Button>
          </div>
        </div>

        <div className="acceptance-control-group">
          <small>老人语音对话</small>
          <div>
            <Button
              variant="outlined"
              startIcon={<VolumeUpRoundedIcon />}
              disabled={!decision?.elder_message}
              onClick={live.replayVoice}
            >
              重播询问
            </Button>
            <Button
              variant="contained"
              startIcon={<MicRoundedIcon />}
              disabled={!waitingResponse || !voice.supported || voice.listening}
              onClick={live.startVoiceReply}
            >
              {voice.listening ? "正在聆听…" : "开始说话"}
            </Button>
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
          </div>
        </div>
      </div>

      <div className="acceptance-control-status">
        <span className={live.active ? "is-online" : ""} />
        <b>{live.active ? `当前场景：${scene.title}` : "ABC 链路未连接"}</b>
        <p>
          {voice.error
            || (voice.transcript ? `识别文本：${voice.transcript}` : "语音识别结果会显示在这里")}
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
