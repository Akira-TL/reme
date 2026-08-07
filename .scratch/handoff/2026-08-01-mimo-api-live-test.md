# G-01 · MiMo API live 实测记录（真实 key）

- 时间：2026-08-01 下午 ｜ 执行：owen 侧（Claude 会话）｜ 端点：`https://api.xiaomimimo.com/v1/chat/completions`
- key 寄存：`~/.config/reme/mimo.env`（`export MIMO_API_KEY=…`，chmod 600，仓库外不进 git）；使用方式 `source ~/.config/reme/mimo.env`。浏览器 Demo 仍按方案走运行时粘贴，不复用此文件。
- 结论先行：**G-01 的 API 项全绿；crosscheck L30 的视频载荷问号消除（video_url 可行，V 路径不必降级关键帧）。**

## 实测项与结果

| # | 项 | 结果 |
|---|---|---|
| 1 | 最小调用 | HTTP 200，`mimo-v2.5` **官方模型名直接可用，无需 `xiaomi/` 前缀**；经系统代理 0.75s |
| 2 | key 状态 | 新建 key 即可调用（是否属"零充值可调用"请开 key 者按账户充值状态认定） |
| 3 | 直连延迟 ×5（--noproxy，每次冷连接含 TLS） | 0.51 / 0.57 / 1.12 / 1.65 / 2.03 s，全 200；keep-alive 后可预期 ≈0.5s；代理与直连均可用 |
| 4 | 决策 prompt JSON mode ×5 | **5/5 解析成功，九字段全齐、零多余字段**（`response_format: json_object` + `thinking: disabled` + system 内定义合同字段）；3.4–5.9s（max_completion_tokens=400） |
| 5 | CORS 复核 | 真实 POST（带 `Origin: http://localhost:5173`）响应含 `access-control-allow-origin: *`，浏览器直连无阻碍 |
| 6 | 多模态载荷探测（V 路径前提，crosscheck B-P0） | `image_url` base64 PNG → 200，正确识色；**`video_url` base64 mp4（Miloco 同款块，`{"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"},"fps":1}`）→ 200 且回答有内容依据**（64×64 合成红→蓝测试片答"红色、黑色"，蓝误判黑属小图压缩语义误差；通道成立，真实画面质量归 B 实测） |

## 对 MIMO-03/05 的两条观察（写 prompt 时用）

1. 五次决策中出现一次 `need_dialogue=false` 空开场（模型自发走"夜间静默不打扰"路径）——介入判断语义可用，但分支波动明显，**决策调用建议显式设 `temperature≈0.2`**（thinking disabled 时温度可自由设）。
2. 称呼漂移（老先生/奶奶/爷爷混用）——人设 prompt 必须钉死称呼来源（从配置注入，不让模型猜性别）。

## 遗留（不阻塞）

- 真实居家画面上的 V 路径识别质量与 video_tokens 成本（B 的 P0 实测素材）。
- 流式响应的 usage 返回方式（做 AuditEntry 耗时统计时再验）。

复现资产：会话 scratchpad `g01/`（请求体 req_decision.json / req_img.json / req_vid.json 与全部响应），会话结束即失效；请求体模板已内联于 [方案-MiMo接入.md](../../docs/integration/方案-MiMo接入.md) §3/§5。
