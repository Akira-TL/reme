# B 执行计划：MiMo 决策模块（方案 A · 本地 Python 服务）

- Status: agreed（2026-08-01 晚，与 owner 对齐）
- 上位文档：[spec.md](spec.md)（角色说明）、`.scratch/abc-interface/spec.md`（接口合同，develop/akira）、[方案-MiMo接入](../../planning/docs/方案-MiMo接入.md) §5（live 实测参数）、[G-01 live 实测](../handoff/2026-08-01-mimo-api-live-test.md)
- 演示优先级（owner 定调，2026-08-01）：**载体首选摄像头实时输入；演示设备首选手机，其次电脑。**

## 1. 运行时形态（已拍板）

**本地 Python 服务（FastAPI）**，理由按分量：①V 路径须从 `SceneManifest.media.local_path` 抽帧（合同 §5），浏览器读不了本地路径，Python+ffmpeg 十分钟能做；②key 只活在 `~/.config/reme/mimo.env`，不进浏览器（用户协议红线），"每次请求实际发送内容可观察"在服务端日志天然成立；③验收全是 pytest 生态（JSON 100%/故障注入/不可取消）；④服务端调用免疫 CORS 收紧风险；⑤与 Miloco 同形态可对比，差异聚焦"发什么数据"。

代价与对冲：多跑一个进程（一行 `uv run` 进启动脚本）；进程挂掉时 C 的 Record Adapter 直读 `recorded_decisions.jsonl` 保底（合同 §13.2 本有要求）。

## 2. 逻辑架构

```
输入 adapters                     核心（纯函数，pytest 可测）                输出
A 的 JSONL/流 ──┐
C 的回应 ────────┤→ ContextBuilder → CareDecisionPolicy → CareDecision(+审计日志)
SceneManifest ──┘                     ├─ DeterministicGuardrails   ← MiMo 前卡（高风险不等模型）
                                      │                            ← MiMo 后卡（越权丢弃、不可取消）
                                      └─ MiMoDecisionAdapter(live/mock/record)
                                             └─ SchemaValidator → 重试1 → 降级模板(degraded)
```

原则：核心零 IO（A 未交付时用自造 fixture，"假上游"）；规则先行两道卡；三模式同构（live/mock/record 同 shape，`source` 如实标注）；状态转移只发生在一处。

live 参数（已实测定型）：`api.xiaomimimo.com/v1` + `mimo-v2.5` + JSON mode + `thinking: disabled` + `temperature≈0.2` + 超时 8s + 重试 1 + 规则模板降级；OpenRouter 兜底开关。

## 3. 部署拓扑（手机优先）

```
手机（老人端，摄像头 getUserMedia + A 姿态提取 WASM/WebGL，原始帧不出手机）
  │ Wi-Fi / 笔记本热点，仅去身份化事件与回应
  ▼
笔记本：FastAPI :8443（HTTPS/mkcert）
  ├─ 同源伺服 C 静态页（无 CORS、无混合内容）
  ├─ POST /decision、POST /response、GET /health
  ├─ MiMoClient → MiMo 云 API（key 仅在笔记本）
  └─ 家属端页面（另一部手机/本机）
```

- **HTTPS 是手机摄像头的硬前提**（getUserMedia 仅安全上下文；`http://内网IP` 不算）。主路径 mkcert 自签 + 演示手机预装 CA（优先 Android，iOS 描述文件步骤多）；备选内网穿透真域名（依赖场馆网络，不作前提）；电脑 localhost 天然安全上下文，为第二顺位兜底。
- 评委扫码看页面可承诺；评委自有手机调摄像头不承诺（无 CA）。

## 4. 阶段计划（每步可运行验证）

| 步 | 内容 | 验证 | 依赖 | 估时 |
|---|---|---|---|---|
| S1 | 契约层：PostureObservation/TransitionEvent/CareDecision/InteractionResponse pydantic 化（含 §8 可空增量：text/consent_*/card_confirmed/family_input/consent_required/action_card/respond_by_ms）+ 三场景自造 fixture（正常/跌倒无回应/牙疼） | pytest 契约测试 | 无 | ~2h |
| S2 | MiMoClient 三模式 + SchemaValidator + 降级模板 + 审计日志（visual_context 如实记录） | 故障注入全绿（超时/非法 JSON/断网/越权）+ live smoke 5/5 | S1 | ~3h |
| S3 | 状态机 + Guardrails：合同 §6 转移图、8.2 respond_by_ms 三约束（超时→rule 升级不等 MiMo、后到结果不可取消）、8.1 授权前置（consent_granted 前不得 notify_family）；收尾由 B owner 立"检查-升级-不可取消"ADR | 合同 §14 场景一~四 + 场景五牙疼单测全过 | S1 | ~3h |
| S4 | 对 C 接口层：FastAPI 双端点 + 同源静态托管 + mkcert HTTPS + 启动脚本；接口文档与样例 | 手机连热点走通场景三升级链（curl + 真机各一遍） | S2,S3 | ~2h |
| S5 | 真实素材双路径对比（Structured vs Visual：延迟/字段漂移/隐私判断）→ 定主路径 | 对比记录落 `.scratch/handoff/` | A 场景视频 | ~1.5h |
| S6 | 与 C 联调三场景 + 给 D 材料包（真实 IO 示例/延迟/失败/能力边界） | 连续跑通 ×3 | C 排期 | — |

S1–S4 不等 A；S5 是唯一卡 A 的点。

## 5. 交接票（非 B 职责，冻结会/群里同步）

1. **→A：目标演示手机上的姿态帧率 spike**（G-01"帧率"项扩展为手机真机口径；MoveNet Lightning 中端机预期 20-30fps 量级，需实测定档）。
2. **→C：手机优先口径**——竖屏布局、`facingMode` 前后摄选择、`playsinline`、摄像头须用户手势触发；感知 Adapter 按合同 §13.1。
3. **→D：叙事升级**——"原始画面连手机都不出"（对比 Miloco 的 Mac mini 7×24 + 画面上云）；扫码即用。

## 6. 未决项（不阻塞 S1–S4）

- B→C 是否加 SSE 推送（现按 C 轮询/请求-响应起步，联调期按需加）。
- `respond_by_ms` 倒计时秒数初值与演示时钟换算（冻结会/统一调优）。
- 8.2 ADR 文本（S3 收尾时由 owner 落 `docs/adr/`）。
