# 危险时期链路实测记录（2026-08-01 深夜/08-02，真实 key）

两轮实测：先做 API 能力探针定选型，后做端到端链路冒烟验收。key 走 `~/.config/reme/mimo.env`，不入库。

## 一、能力探针（定选型）

| 探针 | 结果 | 结论 |
|---|---|---|
| chat/completions + `image_url` 单张 JPEG（合成倒地图）+ JSON mode | 200，2.07s，`{"fallen":true,"confidence":0.95}` | **视觉确认路成立**，单帧直判 |
| chat/completions + `input_audio` wav（Tingting 合成"哎哟我摔倒了腿动不了快来帮帮我"） | 200，1.90s，`{"intent":"need_help","transcript":逐字准确}` | **omni 一跳 = ASR+意图**，无需两段 |
| 同上，安全语料"没事没事我就是坐下歇一会儿" | 200，2.08s，`intent=safe` | 意图区分度成立 |
| `input_audio` 格式矩阵 | webm/opus → 400 `only mp3/flac/m4a/wav/ogg are supported`；m4a（格式串 `m4a` 与 `mp4` 均可）→ 200 0.9-2.0s | **webm 不可用**——Chrome MediaRecorder 默认格式必须绕开（C 端 AudioWorklet 录 wav 或 Safari m4a） |
| `/audio/transcriptions`（model=mimo-v2.5-asr，wav 与 webm） | 404（openresty 兜底页） | 独立 ASR 端点与情报文档不符，**不依赖** |
| `/audio/speech`（model=mimo-v2.5-tts） | 404 | 独立 TTS 端点同上；预置语音改 macOS `say` 离线生成（运行时零 TTS、零 key 依赖） |

## 二、端到端冒烟（reme-decision-server live 模式 + 跌倒 bundle 夹具）

流程：`POST /api/decision` 开出跌倒 check-in → 三条确认路各走一遍（每轮 `/api/scene/reset`）。

| 步骤 | 验证点 | 实测 |
|---|---|---|
| S1 check-in | `voice_asset=/voice/fall_check_in.m4a`、`confirm_channels=[frame,voice]`、`response_timeout_ms=8000`；GET 语音资产 | 200，29.9KB `audio/mp4a-latm`（6.4s 台词） |
| S2 语音文本规则路 | "没事没事…" → 关闭 | **0.00s**（零 MiMo，关键词规则直判） |
| S3 语音真音频路 | danger.wav 上传 → 家属告警 | **1.86s**（omni 段 1725ms），`alarm={channels:[vibrate,ring,flash],trigger:voice_intent}` |
| S4 视觉真图路 | fallen.jpg 上传 → 家属告警 | **2.46s**（视觉段 2322ms，conf 0.95），`trigger:visual_confirm`，告警决策自带安抚语音 `/voice/danger_confirmed_alert.m4a` |

审计线（artifacts 同录）：`danger_voice ruled=1 intent=safe`、`danger_voice latency_ms=1725 intent=need_help`、`danger_visual latency_ms=2322 fallen=True confidence=0.95`、`danger_confirmed`。

## 结论

- 双路竞速全链路 ≈ **2-2.5s 出家属告警**，远在 8s 倒计时兜底之内；预置语音零合成延迟。
- 验收面：512 测试全绿（危险链路新增 36），mypy strict 零错误，ruff 清。
- 遗留：C 端渲染（震动/响铃/爆闪、录音上传）未接（api-for-c.md 已写清职责与格式约束）；A 的 evidence 帧通道休眠待 A 侧选用；mock 模式下音频/图片确认不可用（text 规则路可用），演示若走 mock 用按钮兜底。
