# 情报：Xiaomi MiMo API 官方文档（接入要点）

> 抓取/实测时间：2026-08-01。一手来源：mimo.mi.com 官方文档（[llms.txt 全量索引](https://mimo.mi.com/llms.txt)）、XiaomiMiMo GitHub org、HuggingFace/OpenRouter API 实测、CORS curl 实测。18 篇关键文档 md 已缓存于会话 scratchpad（`mimodocs/`）。
> 结论先行：**MiMo API 个人自助、即时开通、OpenAI 协议兼容、CORS 实测放行**——v3.0 里"MiMo API 现场提供方式未确认，live 视为加分"的前提可以升级：live 模式可行性高，剩余风险只在账号额度与现场网络。

## 1. 结论速览

1. 官方开放平台：控制台 [platform.xiaomimimo.com](https://platform.xiaomimimo.com)，文档站 [mimo.mi.com/docs](https://mimo.mi.com/docs)。
2. 双协议：OpenAI 兼容 `https://api.xiaomimimo.com/v1`（chat/completions、models、Responses API）；Anthropic 兼容 `https://api.xiaomimimo.com/anthropic`。现有 OpenAI/Anthropic SDK 换 base URL 即用。
3. 主力模型只有两个字符串：**`mimo-v2.5-pro`**（文本旗舰，1T MoE/42B 激活）与 **`mimo-v2.5`**（全模态：图/音/视频理解，310B/15B 激活）；均 1M 上下文 / 128K 输出。mimo-v2 旧系列 2026-06-30 已下线。
4. 认证 header 两种任选：`api-key: $KEY` 或 `Authorization: Bearer $KEY`；key 格式 `sk-...`。
5. **CORS 实测放行**（2026-08-01 curl preflight：`access-control-allow-origin: *`，三端点全过）→ 纯浏览器直连技术可行；但用户协议禁止把 key 硬编码进浏览器代码 → Demo 采用**运行时粘贴 key**（localStorage）方案。
6. 结构化输出：JSON mode `response_format: {"type":"json_object"}`（无严格 json_schema，需在 prompt 里定义结构）——与 v3.0"schema 校验+重试+降级"设计正好互补。
7. Function calling 支持但 `tool_choice` 仅 `auto`（不能强制指定工具）；官方建议工具调用时关闭 thinking。
8. 限流每账号每模型 **RPM 100 / TPM 10M**；国内价 `mimo-v2.5` 输入 ¥1/输出 ¥2 每 M tokens（缓存命中 ¥0.02），`-pro` ¥3/¥6。48h 演示成本可忽略。
9. 语音全家桶在同一平台：`mimo-v2.5-asr`（¥0.5/小时）、`mimo-v2.5-tts`（**限免**）——MIMO-14 ASR / MIMO-15 TTS 可直接走同一个 key，不必另找供应商。
10. 模型权重 MIT 开源可商用；**Miloco 项目代码为小米专有非商用许可（明文禁止用于开发 Web 服务）**——架构可参考，代码零复用（详见 [情报-Miloco.md](情报-Miloco.md)）。

## 2. 接入形态

| 项 | 值 | 来源 |
|---|---|---|
| OpenAI 兼容 Base URL | `https://api.xiaomimimo.com/v1` | [first-api-call](https://mimo.mi.com/static/docs/quick-start/summary/first-api-call.md) |
| Anthropic 兼容 Base URL | `https://api.xiaomimimo.com/anthropic`（`/v1/messages`） | 同上 |
| 认证 | `api-key: $KEY` 或 `Authorization: Bearer $KEY` | [list-models](https://mimo.mi.com/static/docs/api/model/list-models.md) |
| Key 申请 | 小米账号（手机号即可）登录控制台 → [API Keys 页](https://platform.xiaomimimo.com/#/console/api-keys) 自助创建，**即时生效无审批**；key 仅创建时可见 | [account FAQ](https://mimo.mi.com/static/docs/quick-start/faq/account.md) |
| 实名 | 国内账号**充值前**需实名认证（调用本身不需要，待实测确认） | 同上 |
| 内容审核 | 平台对输入输出双向审核，违规自动拦截 | [api-integration FAQ](https://mimo.mi.com/static/docs/quick-start/faq/api-integration.md) |

最小调用（MIMO-01 直接可用）：

```bash
curl https://api.xiaomimimo.com/v1/chat/completions \
  -H "Authorization: Bearer $MIMO_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5","messages":[{"role":"user","content":"ping"}]}'
```

## 3. 模型清单与 Reme 选型建议

| 模型 ID | 能力 | 上下文/输出 | Reme 用途建议 |
|---|---|---|---|
| `mimo-v2.5` | 文本 + 全模态理解、思考、流式、FC、JSON mode | 1M / 128K | **主力**：介入判断/对话/分流（纯文本事件输入，成本 1/3，延迟预期更低） |
| `mimo-v2.5-pro` | 文本旗舰、深度思考、联网搜索 | 1M / 128K | A/B 备选：若 v2.5 的决策质量不够再升级 |
| `mimo-v2.5-asr` | 语音识别 | 8K / 2K | MIMO-14 老人语音输入（P1） |
| `mimo-v2.5-tts` | 语音合成（**限免**） | 8K / 8K | MIMO-15 老人端播报 |

- Reme 的 MiMo 输入是**去身份化结构化事件（纯文本 JSON）**，不需要 VL 能力——这本身就是与 Miloco（把摄像头帧喂给 `mimo-v2.5` 做视觉感知）的架构分界线。
- 官方 Miloco 默认配置即 `api.xiaomimimo.com/v1` + `mimo-v2.5`（感知）+ `mimo-v2.5-pro`（Agent），可作为"官方也这么接"的背书范式。
- Anthropic 协议下 1M 上下文需模型名加 `[1m]` 后缀；OpenAI 协议无需。Reme 用量远低于此，无关紧要。

## 4. 请求/响应关键能力（MIMO-02/04 实现参数）

- 请求字段：`model / messages / max_completion_tokens / temperature(默认1.0, [0,1.5]) / top_p(默认0.95) / stream / stop / response_format / thinking / tools / tool_choice` 等（[openai-api](https://mimo.mi.com/static/docs/api/chat/openai-api.md)）。
- **思考开关**：`thinking: {"type":"enabled"|"disabled"}`（OpenAI SDK 走 `extra_body`），响应带 `reasoning_content`。**决策调用建议 disabled**（降延迟、定温度；思考模式下 temperature/top_p 被强制 1.0/0.95，不利于稳定 JSON）。
- **结构化输出（MIMO-04 核心）**：`response_format: {"type":"json_object"}` + prompt 内完整定义字段（[structured-output](https://mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/structured-output.md)）。无 strict schema ⇒ 本地 schema 校验 + 重试 1 次 + 规则模板降级的 v3.0 设计**必须保留**，不是可选项。
- **Function calling**：`tool_choice` 只认 `auto`（传其他值后端直接删字段）⇒ **不用 FC 承载决策合同**，统一走 JSON mode + 校验，分支逻辑留在我们代码里（也符合"高风险状态机 > MiMo"的安全序）。
- **流式**：SSE 标准；老人端开场白可流式渲染降低体感延迟；决策 JSON 调用不建议流式（要整体校验）。
- **多模态**（仅 `mimo-v2.5`，Reme 不用但备查）：图像走 content part `image_url`，支持公网 URL 或 base64 data URI（各 ≤50MB，JPEG/PNG/GIF/WebP/BMP）。
- 官方错误结构：`{"error":{"message":"...","code":"401","type":"invalid_key"}}`；[错误码表](https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes)。
- 无文件上传 API（FAQ 明文）。

## 5. 限流与成本

| 项 | 值 |
|---|---|
| 限流 | 每账号每模型 RPM 100 / TPM 10M（账号下所有 key 合并计），超限 429 |
| `mimo-v2.5` 国内价 | 输入 ¥1.00 / 输出 ¥2.00 每 M tokens（缓存命中 ¥0.02） |
| `mimo-v2.5-pro` 国内价 | 输入 ¥3.00 / 输出 ¥6.00（缓存命中 ¥0.025） |
| ASR / TTS | ¥0.5/小时 / **限免** |
| 免费额度 | **未查到**新用户 API 赠额明文；零充值能否调用待实测（G-01 首项） |

RPM 100 对演示（分钟级事件+3 轮对话）绰绰有余；对话轮间自然间隔即可，无需专门限流器。整场 48h 开发+彩排+决赛的 token 成本按 v2.5 估算在个位数人民币。

## 6. CORS 与浏览器 Demo 合规

- 实测（2026-08-01，OPTIONS preflight，Origin localhost:5173）：`/v1/chat/completions`、`/anthropic/v1/messages`、`/v1/models` 均返回 `access-control-allow-origin: *`、`allow-headers` 按请求回显（authorization/api-key 均放行）。
- ⇒ **浏览器纯前端直连可行**（OpenAI JS SDK 需 `dangerouslyAllowBrowser: true`）。
- 合规约束：用户协议 2.3 明文"不要将其（API key）暴露在浏览器或其他客户端代码中" ⇒ **key 不进源码不进构建产物**，页面运行时粘贴、存 localStorage，仓库与录屏中不出现真实 key。
- 风险备注：CORS 放行无文档承诺（可能是网关默认行为），存在收紧可能 ⇒ MiMoClient 的 base URL 做成可配置，留 OpenRouter 一键切换（见 §7）。

## 7. 备选接入路径（live 降级链）

1. **OpenRouter**（实测在线）：`xiaomi/mimo-v2.5-pro`、`xiaomi/mimo-v2.5`（ctx 1.05M；$0.14/$0.28）。同为 OpenAI 协议，换 base URL 与模型名即切换；OpenRouter 本身支持浏览器直连。
2. **mock / record 模式**（MIMO-10/11）：产品闭环保底，与 live 同构响应。
3. **本地 GGUF**（仅调研备注，不进排期）：[Xiaomi-MiMo-VL-Miloco-7B-GGUF](https://huggingface.co/xiaomi-open-source/Xiaomi-MiMo-VL-Miloco-7B-GGUF)（家庭场景特调 8.3B，llama.cpp 可跑）；通用 MiMo-VL-7B-SFT/RL GGUF（MIT）。
4. ModelScope 有全套权重镜像（国内下载快）。

## 8. 许可与风险红线

- 模型权重：MiMo-V2.5 全系 MIT，可商用、可微调（[开源公告](https://mimo.mi.com/static/docs/news/latest/v2.5-open-sourced.md)）。
- API 用户协议：18+；key 不得共享/公开/暴露在客户端代码；禁止逆向；生成内容标识等合规义务在开发者；国内数据存于中国大陆服务器。
- **Miloco 代码**：小米专有许可，"仅限非商业性目的"，明文不得用于"开发应用程序（APP）、Web 服务"等 ⇒ Reme 零复用其代码、不宣称基于 Miloco 二次开发、宣传不蹭"小米/米家"字样（与 [情报-Miloco.md](情报-Miloco.md) §2.5 一致）。
- 平台双向内容审核：老人健康/跌倒场景措辞一般安全，Demo 前用真实 prompt 实测一遍防误拦。

## 9. 未确认事项（转入 G-01 现场实测）

1. 零充值/未实名状态下 key 能否实际调用（最优先：注册即测）。
2. 新用户是否有隐性免费额度（"免费体验 4h/天"疑指 aistudio 网页版而非 API）。
3. 流式下 usage 统计返回方式（做日志耗时统计时注意）。
4. 决策 prompt 连续 5 次 JSON 解析成功率（MIMO-04 验收前置）。
5. 现场网络对 `api.xiaomimimo.com` 的连通性与延迟（P95 记录进 AuditEntry 口径）。
