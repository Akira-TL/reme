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
2. 真实姿态流产生跌倒候选，监控端先写入不含令牌/音频/转写的会话级恢复记录，再发布 `alarm_state(checking)`；Relay 持久化绝对 deadline、成功设置 Durable Object alarm 后才返回事件确认，然后页面播放本地预置问询。
3. 只有问询实际结束后才打开新的麦克风轨道；若播放失败，以有界回退时点开始，不录入提示音回声。
4. 录音器输出 16 kHz、单声道、PCM WAV。检测到开口后以尾部静音收尾；无声、事件变化、页面隐藏、停止采集或规则截止均取消并释放轨道。
5. 监控端调用独立鉴权 HTTP 端点；音频不进入 WebRTC 视频 offer，也不进入共享 WebSocket。
6. Relay 验证控制租约、当前活跃 danger event、请求与 WAV，再进行一次 `mimo-v2.5` `input_audio` 调用。
7. `safe` 在事件仍为 `checking` 时关闭事件；`need_help` 立即升级家属告警；`unclear`、空录音、拒权、无网络、MiMo 失败或迟到均保持确定性倒计时兜底。
8. `checking` 期间停止采集、释放控制、切场景或 `pagehide` 必须先按超时 fail-closed 升级；若页面已经隐藏后才完成一次在途姿态推理，新事件直接升级，不进入可能被节流的问询计时。控制 WebSocket 重连后必须按绝对 deadline 对账并重发当前 alarm 状态。
9. Relay 在 deadline、仍 checking 的主动释放或租约到期时独立合成并广播 `check_in_timeout` 升级。服务端升级不凭空签发视频；控制端缺席时 viewer 显示告警但视频不可用。该未结案升级会滚入下一次合法 session，`controller_ready.current_alarm` 使监控端在补发前先收敛到权威状态并强制回到 fall 场景。
10. UI 显式显示 `waiting / listening / transcribing / safe / help / unclear / unavailable` 以及 Relay delivery 状态；未确认的升级不能被本地“关闭事件”覆盖，未确认结案或存储故障时不能切场景或释放控制权。transcript 只在当前监控端内存里短暂显示，事件结束即清理。

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
- DO 只维护一个活跃 checking watchdog：绝对 deadline 可单调缩短、不可延长；alarm 到期时以事务原子推进事件序列、watchdog 状态和最新 `alarm_state`，再广播给 viewer。
- watchdog 与结构化 alarm checkpoint 同事务更新；冷启动会幂等接管升级前已有的 `alarm_state`，并按单调状态机合并旧 Worker 回滚窗口内的写入，已落盘 escalation 不得被更高客户端 sequence 重开或改写 trigger。
- 未结案 fall 另存为 24 小时上限的严格 `sessionStorage` 恢复记录；它不含 token、audio、Base64 或 transcript。新租约必须把恢复记录的 delivery 重置为 pending 后重放；只有 Relay 已确认的 resolved 或确认无事件的正常退出才清理。
- 结构日志只含 request/event 标识、provider/model、状态、上游 HTTP 状态、耗时、字节数与 intent；严禁 transcript、音频、Base64、Bearer token、API key。
- Cloudflare 持久化 invocation logs 必须关闭，仅保留上述自定义结构日志；显式实时 tail 会看到瞬时请求元数据，只能由受信任发布者短时开启并在 smoke 后关闭。
- WebRTC bridge 继续只取 `getVideoTracks()`；麦克风权限不能扩大 viewer 的能力。
- `Permissions-Policy` 可允许同源麦克风，但 viewer 代码不得请求麦克风；生产响应头与浏览器权限面板必须实测。

## 决策竞态不变量

- 本地规则截止时间从问询窗口建立时冻结，录音与上传不延长它。
- `safe` 只在相同 `event_id` 仍为 `checking` 时生效；超时已经升级后，迟到 `safe` 不自动撤销已发送的家属告警。
- 按钮“我没事”与 MiMo `safe` 使用同一绝对 deadline 边界；deadline 相等也视为迟到并先升级。
- `escalated/pending` 不允许转为 `resolved`；只有当前升级获得匹配的 Relay `event_accepted` 后，才开放本人显式关闭。
- 服务端 timeout escalation 优先于离线形成的 stale safe；跨重连或新租约只有与权威 escalation trigger 相同的显式 resolved 才可结案。
- `need_help` 可以更早升级，但不得产生第二次告警或第二个媒体授权。
- `unclear` 不清除倒计时；本轮不增加第二次云端语音调用。
- stop、scene change、pagehide、release 会同时取消录音与在途 fetch；迟到 Promise 不得覆盖新事件状态。
- release HTTP 网络错误或非终态响应不得清本地凭证；仅 Relay 2xx 或代表旧令牌已无控制权的 401 可完成本地释放。

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
- Durable Object alarm 的 early-fire 重排、到期升级、重复执行幂等、deadline 只缩不延、late resolved 拒绝、checking release/lease expiry 升级与新 session 清理；
- 旧 `alarm_state` 冷启动迁移、旧 Worker 回滚写入的单调合并，以及服务端 timeout 与客户端 help 同时升级时的权威 trigger 收敛；
- 日志不含 transcript/audio/token；
- `wrangler types --check`、测试、staging/production dry-run。

## 发布 Gate 与回滚

1. 本地全绿并确认 `frontend/`、`demo-relay/`、本 SPEC/ADR 之外无意外改动。
2. 先部署 Worker staging；用本地受允 Origin 验证 CORS、401/4xx 不触发 MiMo，再用合成“我没事/需要帮助”WAV 做一次真实授权调用。
3. Vercel Preview 验证构建、`Permissions-Policy`、viewer 不请求麦克风和 monitor 状态机；随机 Preview Origin 未加入 staging allowlist 时不得伪称跨域 Gate 已过。
4. `controller_ready` 新前端在发布窗口内同时严格接受旧五字段合同与带 `current_alarm` 的新合同；因此先发布 Vercel production（旧 Worker 下语音端点只会显式降级），确认控制链路正常后再发布 Worker production。上线后做安全 smoke、权威 alarm 收敛、真实 MiMo synthetic WAV 和脱敏日志核对。
5. 目标 iPhone Safari 与 Android Chrome 人工 Gate：HTTPS 权限、提示音回声、自然换气、噪声、safe/help、拒权、后台/前台恢复、停止后麦克风指示器熄灭。
6. 回滚先恢复上一 Worker production，再恢复上一 Vercel production，避免旧前端遇到新增 `current_alarm` 字段；独立新增端点若保持安全且 controller 合同不变，才可只回滚前端。

## Go / No-Go

- 自动化、本机公网 smoke 与生产响应头通过：允许作为“公网事件触发式语音已上线”发布。
- 未完成目标手机人工 Gate：能力必须标记“目标手机待验收”，不得宣称跨设备自然换气或浏览器兼容性已经证明。
- 任一情况下都不得宣称已实现常驻唤醒词。
