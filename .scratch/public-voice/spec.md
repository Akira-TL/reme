# 公网事件触发式语音唤起 SPEC

- Status: accepted-for-implementation
- Date: 2026-08-02
- Owner: LBX 公网共享 Demo
- Depends on: ADR-0005、ADR-0007、ADR-0008、ADR-0009

## 目标与可测假设

目标是在 `https://monitor.reme.maniforld.com/` 的真实跌倒问询中上线公网语音回应：系统播完预置问询后自动打开一个有界麦克风窗口，将当前事件的一段 WAV 经鉴权 Relay 发送给 Xiaomi MiMo，并用一次 omni 调用完成转写和 `safe | need_help | unclear` 意图判断。

可测假设：在目标浏览器已由“开启后置摄像头”手势授予麦克风权限后，跌倒问询音结束可以自动开始收音；自然短换气不会在首个停顿立即截断；正常、安全与求助短句可在原有确定性告警截止时间内返回可校验结果。任何失败都只失去“更早确认”，不会推迟或取消原有规则告警。

## “语音唤起”的冻结定义

本轮的“语音唤起”是**事件触发式自动收音**：真实姿态跌倒候选进入 `checking`，预置问询播放结束后，页面自动开始监听当前回应。它不是平时常驻的热词唤醒。

明确非目标：

- 不持续占用麦克风，不持续上传环境音；
- 不实现“Reme / 小忆”等固定唤醒词；
- 不使用浏览器 `SpeechRecognition.continuous` 冒充本地热词模型；
- 不把语音或转写放进现有 WebSocket、Durable Object、事件广播、持久存储或日志；
- 不改变未经临床验证的跌倒启发式，也不把 MiMo 结果包装成诊断。

如以后要做常驻热词，必须另开本地 KWS/WASM 可行性实验、模型资产审核、前后台恢复测试和独立隐私 ADR。

## 端到端流程

1. 用户解锁唯一监控端，并在“开启后置摄像头”的明确手势中授予相机和麦克风权限；预授权完成后立即停止麦克风轨道，日常采集期不占麦。
2. 真实姿态流产生跌倒候选，监控端发布 `alarm_state(checking)` 并播放本地预置问询。
3. 只有问询实际结束后才打开新的麦克风轨道；若播放失败，以有界回退时点开始，不录入提示音回声。
4. 录音器输出 16 kHz、单声道、PCM WAV。检测到开口后以尾部静音收尾；无声、事件变化、页面隐藏、停止采集或规则截止均取消并释放轨道。
5. 监控端调用独立鉴权 HTTP 端点；音频不进入 WebRTC 视频 offer，也不进入共享 WebSocket。
6. Relay 验证控制租约、当前活跃 danger event、请求与 WAV，再进行一次 `mimo-v2.5` `input_audio` 调用。
7. `safe` 在事件仍为 `checking` 时关闭事件；`need_help` 立即升级家属告警；`unclear`、空录音、拒权、无网络、MiMo 失败或迟到均保持确定性倒计时兜底。
8. UI 显式显示 `waiting / listening / transcribing / safe / help / unclear / unavailable`，但 transcript 只在当前监控端内存里短暂显示，事件结束即清理。

## HTTP 合同

`POST /api/danger/voice`

请求头：

```http
Authorization: Bearer <ephemeral-control-token>
Content-Type: application/json
```

严格请求体：

```json
{
  "event_id": "fall-opaque-id",
  "audio_b64": "<base64 PCM WAV>",
  "audio_format": "wav"
}
```

严格成功体：

```json
{
  "ok": true,
  "intent": "safe",
  "transcript": "我没事",
  "model": "mimo-v2.5",
  "latency_ms": 1234
}
```

`transcript` 可为 `null`，不得超过 240 字；未知字段、未知 intent、无效 Base64、非 RIFF/WAVE、超出硬上限、非当前 checking event、重复/超预算调用均拒绝。失败返回非 2xx 和闭集错误码，不回显上游正文、音频、token 或供应商密钥。

## 安全、隐私与资源约束

- `Content-Length` 先验限长，并对流式读取再次限长；16 kHz mono 16-bit WAV 录音硬上限按前端事件窗配置，服务端不得沿用本地“无限语音”策略。
- Relay 仅在控制令牌仍属于当前租约、`event_id` 对应最新 `alarm_state(checking)` 时允许调用；每事件只消费一次语音预算，防止重复计费和迟到结果。
- MiMo API key 只来自 Worker secret；浏览器不得直连 MiMo。
- DO 只可原子校验租约、当前结构事件和预算；不得接收、保存或返回音频、Base64、transcript。
- 结构日志只含 request/event 标识、provider/model、状态、上游 HTTP 状态、耗时、字节数与 intent；严禁 transcript、音频、Base64、Bearer token、API key。
- WebRTC bridge 继续只取 `getVideoTracks()`；麦克风权限不能扩大 viewer 的能力。
- `Permissions-Policy` 可允许同源麦克风，但 viewer 代码不得请求麦克风；生产响应头与浏览器权限面板必须实测。

## 决策竞态不变量

- 本地规则截止时间从问询窗口建立时冻结，录音与上传不延长它。
- `safe` 只在相同 `event_id` 仍为 `checking` 时生效；超时已经升级后，迟到 `safe` 不自动撤销已发送的家属告警。
- `need_help` 可以更早升级，但不得产生第二次告警或第二个媒体授权。
- `unclear` 不清除倒计时；本轮不增加第二次云端语音调用。
- stop、scene change、pagehide、release 会同时取消录音与在途 fetch；迟到 Promise 不得覆盖新事件状态。

## 自动化验收

前端：

- WAV 编码、最大录音窗口、尾静音、取消与所有音轨释放；
- voice client 的请求/成功/错误严格合同；
- prompt 结束后才录音；权限拒绝、无声和上传失败显式降级；
- `safe / need_help / unclear` 与超时、切场景、停止、pagehide、迟到结果竞态；
- WebRTC offer 仍为 video-only；
- lint、全部测试、production build。

Relay：

- CORS、method、content type、缺失/非法 token；
- 非当前事件、重复预算、未知字段、畸形/超大 Base64、WAV magic；
- MiMo payload 精确使用 `input_audio` WAV、JSON mode、thinking disabled；
- 上游超时、网络错误、非 2xx、超大/非法 JSON、未知 intent；
- 升级式危险词 guardrail；
- 日志不含 transcript/audio/token；
- `wrangler types --check`、测试、staging/production dry-run。

## 发布 Gate 与回滚

1. 本地全绿并确认 `frontend/`、`demo-relay/`、本 SPEC/ADR 之外无意外改动。
2. 先部署 Worker staging；用本地受允 Origin 验证 CORS、401/4xx 不触发 MiMo，再用合成“我没事/需要帮助”WAV 做一次真实授权调用。
3. Vercel Preview 验证构建、`Permissions-Policy`、viewer 不请求麦克风和 monitor 状态机；随机 Preview Origin 未加入 staging allowlist 时不得伪称跨域 Gate 已过。
4. 先 Worker production、后 Vercel production；上线后做安全 smoke、真实 MiMo synthetic WAV 和脱敏日志核对。
5. 目标 iPhone Safari 与 Android Chrome 人工 Gate：HTTPS 权限、提示音回声、自然换气、噪声、safe/help、拒权、后台/前台恢复、停止后麦克风指示器熄灭。
6. 回滚先恢复上一 Vercel production，使前端回到按钮回应；必要时再回滚 Worker。独立新增端点若保持安全，可只回滚前端。

## Go / No-Go

- 自动化、本机公网 smoke 与生产响应头通过：允许作为“公网事件触发式语音已上线”发布。
- 未完成目标手机人工 Gate：能力必须标记“目标手机待验收”，不得宣称跨设备自然换气或浏览器兼容性已经证明。
- 任一情况下都不得宣称已实现常驻唤醒词。
