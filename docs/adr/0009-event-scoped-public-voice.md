# ADR-0009: 公网事件范围语音确认通道

- Status: Accepted for LBX demo feasibility
- Date: 2026-08-02
- Owner: LBX 公网共享 Demo
- Depends on: ADR-0005、ADR-0007、ADR-0008

## 背景

ADR-0007 已接受跌倒问询中的一次性语音意图路径，但当前公网共享 Demo 只请求摄像头，Vercel 响应头明确禁止麦克风；Relay 只有视觉 MiMo 端点，现有 WebSocket/DO 媒体拒绝规则也不允许音频。因而本地语音证据不能外推为公网能力。

“语音唤起”还可能指两种完全不同的产品：事件发生后系统主动问询并自动短时收音，或平时持续监听固定热词。后者需要常驻本地关键词模型、前后台恢复和独立隐私验证，当前没有模型或实测依据。

## 决议

LBX 公网 Demo 接受**事件触发式语音唤起**：真实跌倒候选进入 check-in，预置问询播放结束后自动打开一个有界麦克风窗口；当前事件的一段 PCM WAV 经独立鉴权 HTTP 端点送到 Relay，由 `mimo-v2.5` 一次 omni `input_audio` 调用同时完成转写与 `safe | need_help | unclear` 意图判断。

实现必须遵守：

- 麦克风首次授权并入用户主动“开启采集”手势；预授权后立即停止音轨，非事件期不占麦。
- 音频只进入 `POST /api/danger/voice`。现有姿态/事件 WebSocket 继续拒绝音频、Base64 和媒体字段；WebRTC 仍只发送视频轨道。
- Relay 先验证短期控制令牌、活跃租约、当前 `alarm_state(checking)` 的 `event_id` 和单事件预算，再读取有硬上限的请求并调用 MiMo。
- Durable Object 只原子判断结构状态与预算，不接触或保存音频、Base64、transcript。
- 音频与 transcript 不持久化、不广播、不写日志。Worker 仅写脱敏结构日志：请求/事件标识、provider/model、状态、上游 HTTP 状态、延迟、字节数与最终 intent。
- `safe` 仅可关闭仍处于 checking 的同一事件；`need_help` 可提前升级；`unclear`、空音频、拒权、网络/MiMo 失败或迟到均不得延长、取消或降低 ADR-0005 的确定性倒计时告警。
- 每事件只有一次公网 MiMo 语音预算；本轮不以第二次云端调用做澄清。
- UI 必须显示监听、转写、结果与降级状态；事件结束、切场景、停止采集、释放控制或页面隐藏时立即取消并释放麦克风。

## 不接受的替代

- **浏览器直连 MiMo**：拒绝。会暴露 API key，并绕过 Relay 的鉴权、限额与日志边界。
- **把音频塞进 WebSocket/DO**：拒绝。扩大结构状态存储的隐私和攻击面，破坏 ADR-0008 的平面隔离。
- **常驻云端监听或 Web Speech 热词**：拒绝。持续上传与当前“按需最少地看/听”边界冲突，浏览器能力也不足以证明跨端热词可靠性。
- **录音/模型调用暂停确定性 timer**：拒绝。MiMo 不是安全承重墙。

## 后果

- 公网 monitor 可以在跌倒问询后无需再点按钮地接收语音回应，并留下真实 MiMo 请求的脱敏供应商级证据。
- Vercel `Permissions-Policy` 需要允许同源麦克风；这只开放浏览器询问权限，viewer 仍没有调用麦克风的代码。
- 本地“语音无固定时长上限”的定调不适用于公网付费端点；公网按当前事件窗设置严格字节/时长上限，避免内存与付费放大。
- `ScriptProcessorNode` 若作为首版兼容实现继续使用，必须记录为待迁移技术债，不能把简单 RMS + 尾静音称为语义 VAD。
- 目标 iPhone Safari / Android Chrome 的权限、自然换气与前后台恢复仍是人工 Gate；自动化与桌面 smoke 通过不等于该 Gate 已通过。
