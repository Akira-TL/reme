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
- Relay 只有在把 `checking` 的绝对 deadline 写入 Durable Object 并成功设置单次 alarm 后才确认事件；同一事件允许缩短 deadline，禁止延长。
- Relay 将 watchdog 的最新结构化 alarm checkpoint 与状态转换放在同一事务中；冷启动必须幂等迁移升级前已有的 `alarm_state`，并单调合并旧 Worker 回滚窗口中的写入，已经权威升级的事件不得被更高客户端 sequence 重开或改写 trigger。
- deadline 到达、仍在 `checking` 时释放控制权或控制租约到期，Durable Object 必须原子生成、持久化并广播 `check_in_timeout` 升级，不依赖浏览器计时器、标签页存活或新的入站请求。服务端升级不自动签发视频；没有控制端时明确保持“已告警、视频不可用”。
- `controller_ready` 必须携带当前权威 alarm。未结案的服务端 `escalated` 不随旧租约清空，而是以同一事件/trigger、全新的 session_id 和事件序列滚入下一次合法解锁；监控端先采用该权威状态并强制 fall 场景，再补发本地状态。只有 trigger 与权威升级一致的显式关闭可完成 `escalated -> resolved`，离线形成的旧 safe 不得自动撤销服务端 timeout 告警。
- Durable Object 只原子判断结构状态与预算，不接触或保存音频、Base64、transcript。
- 音频与 transcript 不持久化、不广播、不写日志。Worker 仅写脱敏结构日志：请求/事件标识、provider/model、状态、上游 HTTP 状态、延迟、字节数与最终 intent。
- Cloudflare 自动 invocation logs 必须关闭，避免把浏览器 WebSocket 子协议里的短期控制凭证持久化为请求元数据；实时 tail 仅可作为受信任发布者的短时调试通道，完成验证后必须关闭。
- `safe` 仅可关闭仍处于 checking 的同一事件；`need_help` 可提前升级；`unclear`、空音频、拒权、网络/MiMo 失败或迟到均不得延长、取消或降低 ADR-0005 的确定性倒计时告警。
- deadline 后从 `checking` 直接提交 `resolved` 必须先由 Relay 升级并拒绝该迟到关闭；已经持久化的 `escalated` 可在 Relay 确认送达后由本人显式转为 `resolved`。
- 每事件只有一次公网 MiMo 语音预算；本轮不以第二次云端调用做澄清。
- UI 必须显示监听、转写、结果与降级状态；事件结束、切场景、停止采集、释放控制或页面隐藏时立即取消并释放麦克风。
- 上述中断不得静默清除仍在 `checking` 的规则告警：停止、释放、切场景与 `pagehide` 先 fail-closed 升级；普通后台隐藏仅停止麦克风并保留绝对 deadline。控制链路恢复后按该 deadline 重发 checking、升级过期事件，或重发本地 terminal alarm 状态。
- 监控端只在 `sessionStorage` 镜像一个严格版本化的未结案 fall 恢复记录，最多保留 24 小时，且不含控制令牌、音频或 transcript。旧租约失效后不得清除此记录；重新解锁必须强制回到 fall 场景、把 delivery 重置为 pending，并在新 session 重放或按原 deadline 升级。`resolved + accepted` 或确认无事件的正常退出才可清理。

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
- 浏览器在 Relay 尚未确认事件且网络不可用时无法凭空送达告警；UI 必须阻断场景切换和控制权释放，并要求页面保持开启。已被 Relay 确认的 `checking` 不再依赖页面存活，由 Durable Object alarm 承担最终升级。
- 目标 iPhone Safari / Android Chrome 的权限、自然换气与前后台恢复仍是人工 Gate；自动化与桌面 smoke 通过不等于该 Gate 已通过。
