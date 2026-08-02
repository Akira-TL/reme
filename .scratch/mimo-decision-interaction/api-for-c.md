# B 决策服务 · 给 C 的接入文档

- 服务：`reme-decision-server`（stdlib，零依赖），默认 `127.0.0.1:8100`
- 合同：`reme-care-decision/v0-experiment` / `reme-interaction-response/v0-experiment`（唯一出处 `.scratch/abc-interface/spec.md` §10/§11；本文只讲怎么调）
- 启动（live 模式，key 在服务端环境变量，不进浏览器）：

```bash
source ~/.config/reme/mimo.env
uv run reme-decision-server --static <C构建产物目录> \
  --cert certs/lan.pem --key certs/lan-key.pem
```

**纯 live_camera 不需要任何预录素材**——感知来自会话事件流而非磁盘，`scenes目录` 可整个省略。要跑预录场景时再把它作为第一个位置参数传入，下面每个子目录是一个 SceneBundle（含 manifest.json）：

```bash
uv run reme-decision-server <scenes目录> --mode record --static <C构建产物目录>
```

`--mode mock|record` 切模式（**record 模式必须给 scenes目录**，否则启动即报错）；`--record-output` 在 live 上捕获 `recorded_decisions.jsonl`；`--visual` 启用 ADR-0003 V 路径（bundle 需有 `derived/visual_context.mp4`，用 `uv run reme-visual-precut <manifest> --start-ms … --end-ms …` 预剪）；`--home-script`／`--home-room`＋`--local-hour`／`--memory-file` 开认知三层，`--no-cognition` 一键回退。

## 端点

### `POST /api/decision` — 拉取当前决策（C 的 getCareDecision）

```bash
curl -s localhost:8100/api/decision -H 'Content-Type: application/json' \
  -d '{"scene_id":"fall_demo_01","timestamp_ms":13000}'
```

返回完整 CareDecision JSON（合同 §10 全字段）。**幂等语义**：同一会话阶段内重复调用返回**同一 `decision_id`**（C 按 id 去重渲染即可、可随播放进度轮询）；只有状态变迁才产生新 id。`timestamp_ms` 是视频毫秒偏移；大幅回退（>3s）而未 reset 会得到 409 `timeline_rewind`——seek 前先调 reset。

### `POST /api/response` — 提交回应，返回下一条决策（submitInteractionResponse）

```bash
curl -s localhost:8100/api/response -H 'Content-Type: application/json' \
  -d '{"schema_version":"reme-interaction-response/v0-experiment","scene_id":"fall_demo_01",
       "decision_id":"decision-0001","timestamp_ms":21000,"response":"none",
       "source":"timeout","demo_mode":"live","text":null}'
```

要点：`decision_id` 必须是触发本次询问的那条决策；倒计时由 C 按 `response_timeout_ms`（相对毫秒）渲染，超时提交 `response=none, source=timeout`；老人原话放 `text`（仅 `user_input|script` 可非空）；家属确认行动卡用 `response=card_confirmed, source=family_input`。

### `POST /api/scene/reset` — 重置场景会话

`{"scene_id":"fall_demo_01"}`。切场景、seek、重跑演示前调用。

### `GET /api/health` — 模式与各场景流完备性

### `GET /scenes/<scene_id>/<相对路径>` — bundle 静态资产

mp4 支持 Range（手机浏览器可拖进度条）。C 用它取 manifest/media/各 jsonl，同源无 CORS。`GET /` 伺服 `--static` 目录（C 的构建产物）。

## 错误约定

统一 `{"error":{"code":…,"message":…}}`：

| HTTP | code | C 的处理 |
|---|---|---|
| 400 | bad_json / bad_request | 修请求 |
| 404 | unknown_scene / not_found | 检查 scene_id |
| 409 | stale_decision | 丢弃本地旧决策，重新 `POST /api/decision` |
| 409 | timeline_rewind | 先 reset 再继续 |
| 409 | episode_resolved | 本场景剧终，reset 或换场景 |
| 422 | invalid_response | 当前阶段不接受该回应枚举（如无 consent 挂起时发 consent_granted） |
| 422 | no_pending_decision | 先 `POST /api/decision` |
| 422 | contract_violation | 回应载荷不合合同（message 里有具体字段） |

**degraded 约定**：收到 `state=degraded, fallback_used=true` 表示 MiMo 暂不可用——会话停在原地、原 pending 决策仍有效；C 明确展示降级状态（不伪装在线），可切 `--mode mock` 重启服务或稍后**用同一 decision_id 重发同一回应**继续。

## 实时运行时（合同 §3/§4/§14，B 侧已实现）

### `POST /api/session` — 启动会话（C→B 控制面）

请求体 = 合同 §3.2 RuntimeSessionRequest 原样（`live_camera` 必带 `camera_id`、`recorded_video` 必带 `manifest_path`）；返回 §3.3 的 DECISION 组件 status（`running`）。规则：单活跃会话；重启/换 profile 必须换新 `session_id`（否则 409 `session_conflict`）；`POST /api/session/stop` `{"session_id":…}` 停止（幂等）；`GET /api/session/status` 查询（无会话 404 `no_session`）。session 变更会顺带清空实时缓冲并向 WS 广播新 status。

### `POST /api/events` — A 的感知事件入口

请求体 = 合同 §4 RuntimeEvent 信封（`posture_observation`/`transition_event` 会被缓冲并**触发一次后台决策评估**；其他合法类型接受但忽略）。错误：无活跃会话/信封 session 不符 → 409（`no_active_session`/`stale_session`）；坏信封/坏载荷/时间戳回退 → 422 `bad_event`。B 的决策结果不在本响应里——走 WS 流。

### `GET /ws` — B→C 决策事件流（WebSocket）

标准 RFC6455 升级（浏览器 `new WebSocket("wss://…/ws")` 即可）。**线格式**：每帧一个 JSON 对象，按 `schema_version` 区分两种：
- `reme-runtime-event/v0-experiment`：RuntimeEvent 信封，`event_type=care_decision`，`payload` 为完整 CareDecision，`sequence` 为 B 侧单调序列——**C 按 `payload.decision_id` 去重**（罕见竞态可能重复推送同一决策）；
- `reme-runtime-session-status/v0-experiment`：会话状态变更。

C→B 的用户回应仍走 `POST /api/response`（HTTP，有明确成败）；`POST /api/decision` 轮询在实时模式下依然可用且与推流同 id 幂等（可作 WS 断线兜底）。live 场景的 `scene_id` 不需要 bundle——会话激活期间任何 scene_id 都按实时缓冲解析。

## 危险时期链路（跌倒快速确认，2026-08-02 新增）

跌倒 check-in 之后 B 开一个"确认窗口"：C 上传一帧原图和/或老人的语音回应，B 并行跑视觉判摔与语音意图，**任一路判定危险立即升级家属告警**；两路都失败也无妨——倒计时超时的规则升级（ADR-0005）始终垫底。全链路实测（2026-08-02，真实 key）：语音路 1.9s、视觉路 2.5s 出告警，均远在 8s 倒计时之内。

### CareDecision 新增可空字段（不识别可忽略，零破坏）

- `voice_asset: string|null` — 预生成语音的相对 URL（如 `/voice/fall_check_in.m4a`）。**老人端拿到带此字段的决策应立即播放**（`new Audio(base + voice_asset).play()`），文字仍在 `elder_message`（audio 失败或字段为 null 时用 Web Speech `speechSynthesis` 读 `elder_message` 兜底）。只在语音与文字逐字一致时才下发，不会读错词。
- `confirm_channels: ["frame","voice"]|null` — 非空表示 B 正接受对本决策的确认上传。老人端见到含 `"frame"` 时**立即抓一帧当前画面上传**（canvas→JPEG→base64）；含 `"voice"` 时开麦录老人回应（3-5 秒）上传。跌倒 check-in 与跌倒澄清都会带；关怀问候不带。
- `alarm: {"channels": ["vibrate","ring","flash"], "trigger": "..."}|null` — **家属端告警指令**，只出现在 `family_notification_required` / `urgent_attention` 且事件源于跌倒时。家属端按能力渲染：`navigator.vibrate([500,200,500…])` 循环、`<audio loop>` 响铃、屏幕全屏爆闪（背景色 200ms 交替；有 torch 权限可用 ImageCapture torch）。`trigger` 说明由哪条路触发：`elder_report`（按钮求助）/`voice_intent`（语音判定）/`visual_confirm`（画面确认）/`check_in_timeout`（询问超时）/`unclear_response`（澄清失败）/`family_unresponsive`（家属未确认，urgent 级）。

### `POST /api/danger/frame` — 原图确认上传（老人端→B）

```json
{"scene_id": "…", "decision_id": "…", "timestamp_ms": 14000,
 "image_b64": "<JPEG base64，≤2MB>", "mime_type": "image/jpeg"}
```

200 `{"accepted":"visual_confirm"}` 表示确认已在后台运行——**结果不在响应里**，若判定摔倒，新决策（带 `alarm`）从 `/ws` 推下来。`mime_type` 支持 `image/jpeg`/`image/png`。每个待确认决策最多接受 2 帧。

### `POST /api/danger/voice` — 语音回应上传（老人端→B）

```json
{"scene_id": "…", "decision_id": "…", "timestamp_ms": 14000,
 "audio_b64": "<base64，≤2MB>", "audio_format": "wav"}
```

或浏览器自转文字后 `{"text": "老人说的话"}`（`text` 与 `audio_b64` 二选一）。**`audio_format` 只支持 `wav/mp3/m4a/ogg/flac`——MiMo 不收 webm**，Chrome/Android 的 MediaRecorder 默认 webm 不能直传：用 AudioWorklet/ScriptProcessor 采 PCM 拼 WAV（16kHz 单声道即可，3 秒 ≈ 96KB）；Safari 的 `audio/mp4` (m4a) 可直传。B 一次 omni 调用同时完成转写+意图（实测 ~2s），判定后走正常回应机器：求助→立即家属告警、安全→关闭、听不清→触发一次澄清（澄清决策同样带 `confirm_channels`，重录再传即可）。

### `GET /voice/<file>` — 预置语音静态文件

`voice_asset` 字段指到这里；`audio/mp4a-latm` (AAC/m4a)，`<audio>` 直接可播。

### 错误码增补

| HTTP | code | 含义 |
|---|---|---|
| 409 | `no_confirm_pending` | 当前没有接受上传的待确认决策（事件已关闭/已升级）——静默放弃即可 |
| 422 | `channel_not_offered` | 该决策未开放此通道 |
| 422 | `bad_media` | base64/格式/魔数/大小不合法，或 text 与 audio 同给 |
| 429 | `confirm_budget_exhausted` | 本决策的确认次数用尽 |
| 503 | `confirm_unavailable` | B 无认知后端（mock 模式的音频/图片路；text 规则路仍可用） |
| 503 | `danger_disabled` | 服务端以 `--no-danger` 启动 |

上传被拒不影响主链路：按钮回应、倒计时超时照常工作。

## 附录：mkcert HTTPS（手机摄像头硬前提）

手机浏览器只在安全上下文开放 `getUserMedia`；`http://内网IP` 不算。一次性配置：

```bash
brew install mkcert && mkcert -install
mkdir -p certs && cd certs
mkcert -cert-file lan.pem -key-file lan-key.pem localhost 127.0.0.1 $(ipconfig getifaddr en0)
```

- 证书 SAN 里必须含笔记本的热点/局域网 IP（上面命令已带）；换网络后 IP 变了要重签。
- 演示手机装 CA：`mkcert -CAROOT` 找到 `rootCA.pem` 传到手机——Android：设置→安全→安装证书（CA）；iOS：AirDrop 后 设置→已下载描述文件→安装，再到 通用→关于本机→证书信任设置 打开开关。**优先用 Android 演示机**。
- 兜底：评委机/电脑直接开 `https://localhost:8100`（或明文 `http://127.0.0.1:8100`，localhost 天然是安全上下文）。
- 评委扫码看页面可以承诺；评委自有手机调摄像头不承诺（他们没装我们的 CA）。
