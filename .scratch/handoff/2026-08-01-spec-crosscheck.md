# 分工 spec 交叉审阅：冻结会待决清单

- 日期：2026-08-01
- 来源：Codex（gpt-5 系）对 6 份分工文档的异构交叉审阅（team-roles、A/B/C/D spec、motionbert-offline-demo）+ 人工核实，基线参照 `planning/docs/方案-MiMo接入.md`
- 定位：讨论基线（handoff 层）。用途：0-4h 冻结会逐项裁决打勾；已按 team-roles §2 文档优先级校正——planning 层不作为判错依据，冲突默认解优先向 team-roles 候选合同收敛
- 总判断：A 感知 / B 决策 / C 演示 / D 路演的分层可行，但**当前不具备无返工联调条件**；最大风险是共享合同、主演示闭环、高风险旁路三者尚未统一

## 1. P0 裁决项（不决则阻塞联调/主演示）

| # | 待裁决 | 现状矛盾 | 建议默认解 | 决议 |
|---|---|---|---|---|
| 1 | **A→B/C 感知合同冻结** | team-roles §3 定 `posture/motion_level/landmark_quality`+`transition/candidate_event` 两层；A spec 样例实际输出 `motion_state/quality_state`，只有 `fall_like_transition` 无 `candidate_event` 层（A spec §6.4/§7.2 vs team-roles §3） | A 向 team-roles §3 收敛；两份 JSONL 的时间合并规则由 A 补一段说明 | ☐ |
| 2 | **B→C 决策合同冻结** | team-roles §4 `care-decision.v0`（`privacy_mode/need_dialogue/elder_message/demo_mode`）；C spec §8 自有命名 `privacy_state/should_interact/message_to_elder/inference_mode` | C 删自有命名，adapter 只做渲染映射不做语义转换 | ☐ |
| 3 | **高风险旁路语义** | 基线：`possible_fall` 不等 MiMo、规则直接倒计时告警（方案 §3.3/§4.2）；B spec 测试：`fall_like_transition` → `check_in_required`，老人答 safe 即停止升级（B spec §异常测试） | 需明确 `fall_like_transition→possible_fall` 映射条件 + 二选一：确定性告警优先（基线）或 询问先行（B 现行）。**这是安全叙事的根，D 的 PPT 依赖此决议** | ☐ |
| 4 | **主演示闭环范围** | 基线主路径：静坐→牙疼对话→授权→六要素行动卡→家属确认→回执；B/C 均把行动卡/授权/回执放 P1，而 D 仍以其为主故事（B spec §10、C spec P1、D spec §产品定位） | either 行动卡最小版进 B/C 的 P0，or D 改主故事为"询问+家属通知"版——两头必须选一头 | ☐ |
| 5 | **演示隐私口径** | CONTEXT.md 要求评委/家属侧画面不易识别人物；C 与 MotionBERT 双屏均计划展示原始视频，C 仅在"隐私场景"隐藏（C spec §页面、MotionBERT spec） | 明确三场景各自的画面处理（原片/模糊/骨架 only）+ 家属端默认骨架（team-roles §5 已有）在 C 页面落实 | ☐ |
| 6 | **B→C 传输协议** | B 承诺"可调用接口或本地服务"，C 仍在问函数/本地 HTTP/文件回放（B spec P0 vs C spec §19） | 48h 内最稳：本地 HTTP + JSONL 文件回放兜底；当场定 | ☐ |

## 2. 接缝矛盾明细（冻结会对照用）

- **时序关联缺失**：B 输出无 `scene_id/request_id`；C 有 seek/重置/场景切换需求 → 迟到 MiMo 响应可能污染新场景。建议 `care-decision.v0` 增加 `scene_id` + `request_id`，C 丢弃不匹配响应（team-roles §4 需同步改，走 §6 五步变更）。
- **`prolonged_stillness` 生产者未定义**：主演示依赖它，但 A 正式交付只有转变事件；"持续静止观测如何聚合成 CareEvent"无 owner。建议：A 输出 `posture_duration_ms`（已在 team-roles §3.1），由 B 聚合成事件——需 A/B 点头。
- **演示时钟无 owner**：素材仅 79s，主演示需分钟级时长；旧开发计划有 DemoClock 但未进新合同。建议时间加速字段（如 `demo_time_scale`）归 C，A/B 透传。
- **降级标记不一致**（B 内部）：输出字段 `fallback_used` vs 失败处理要求的 `degraded`，后者不在 B→C 合同——B 自查统一。
- **"三个场景"三套定义**：基线三分支（无需求/具体需求/高风险）vs C/D 三展示场景（正常/隐私/异常）vs B smoke test（正常/隐私/疑似异常）。牙疼（具体需求）嵌在哪个展示场景里，冻结会一句话定死。

## 3. 各 owner 自查项（不阻塞冻结会，各自领走）

- **C**：spec §11 仍引用已废止的 ADR-0001（"原始帧不得发送、Visual 需新 ADR"）——ADR-0003 已 Accepted，改引用；Record 模式当验收兜底与基线 P2 定位冲突，与 B 对齐优先级。
- **B**：API 参数不必再"待确认"——直接抄基线 `方案-MiMo接入.md` §5（base URL/模型名/JSON mode/8s 超时/重试 1/OpenRouter 兜底，已实测）；注意情报 §4：**API 仅确认 `image_url` 图片载荷、无文件上传 API**，B 把"短视频上传"列 P0 需先实测视频载荷编码是否可行，不行则 V 路径降为关键帧序列。
- **A**：48h 裁剪——单一 79s 视频撑不起 train/val/test+几何+学习双模型+多窗口评估；补拍视频的数量/人物/负责人/截止无一落纸。建议冻结会直接砍到"几何基线+拒判"最小集。
- **D**：向 C/A/B 索证依赖上游联调，需定"最晚素材快照时间"（建议 T+42h，与开发计划 §第4步一致），过点用 mock 素材成稿。
- **MotionBERT 资产**：无 Owner/冻结路径/重建命令，C 又把"临时 3D 数据丢失"列为风险——指定 owner（建议 C）+ 固化产物路径一次。

## 4. 新发现：ADR 编号冲突（本仓库侧，立即处理）

本地分支 `adr-0003-keypoint-frame-record`（90057c6，未 push）新增 `docs/adr/0003-keypoint-frame-record.md`，与 upstream 已合入且 **Accepted** 的 `docs/adr/0003-allow-minimal-visual-context-to-mimo.md` **同号不同主题**。PR 前必须把关键点帧记录 ADR 改号为 **ADR-0004**（文件名+标题+正文自引用），避免撞号合并事故。

## 5. P1/P2 摘要（冻结会不展开，进各自 backlog）

- P1：B 单点故障（任务分解已量化 ~57h 集中一人）——冻结会明确 B 的 P0 砍单；A 实验范围裁剪（见 §3）；D 素材快照时间（见 §3）。
- P2：审计日志合同弱化（基线 `AuditEntry` append-only+导出未进 B spec）；最终报名/提交/版本锁定无 owner——建议 D 领走并写截止清单。

## 6. 基线侧已完成的对齐（本次已改，无需裁决）

- `planning/docs/方案-MiMo接入.md`：§1 原则 1 已按 ADR-0003 改为 S/V 双路径；流转图出网标注与 Miloco 对照叙事已同步（"按需最少地看"）；头部已声明执行期字段以 team-roles 候选合同为准。

## 7. 对照更新（2026-08-01 傍晚）：develop/akira `56c3604 统一ABC实验接口合同` 解决情况

> 协调基准变更：`.scratch/abc-interface/spec.md`（548 行，七流接口 + SceneBundle + Adapter seam）自此为 A/B/C 接口的**唯一协调来源**，本清单 §1/§2 中与其重叠的裁决项按下表关闭或收窄。ADR 治理规则同步明确：**ADR 由各层 owner 自行创建**（2、3 层任务的两位 owner 自行确立各自 ADR），本清单只列问题、不代立 ADR。

| 原清单项 | 状态 | 说明 |
|---|---|---|
| P0-1 A→B/C 感知合同 | ✅ 已解决 | 统一 `posture/posture_duration_ms/landmark_quality`；`candidate_event` 双层取消（B 内部组合）；**`prolonged_stillness` 归属已定**：A 出 `posture_duration_ms`+`motion_level` 事实、B 判是否构成关怀（abc-interface §7/§8） |
| P0-2 B→C 决策合同 | ✅ 已解决 | `reme-care-decision/v0` 统一命名，C 的自有字段已在同提交中清除（software-demo/spec.md 同步改） |
| P0-3 高风险旁路 | ⚠️ 收窄未闭 | 合同场景三事实上选了**询问先行**（fall_like→check_in_required→无回应→family_notification_required）；但"确定性告警不等 MiMo"未显式落地，`urgent_attention` 状态存在却无触发场景。**若坚持基线"规则直接告警"须立刻提出，否则默认被合同锁定**——按治理规则由决策层 owner 立 ADR 裁决 |
| P0-4 行动卡/授权/回执 | ❌ 仍开放 | `action` 枚举无 action_card，无 consent 字段，InteractionResponse 无授权类响应；§14 四个验收场景不含"牙疼具体需求"分支。D 主故事仍无接口支撑——**当前最大开放项** |
| P0-5 隐私口径 | ✅ 机制解决 | `privacy_mode` 四档（visible/blurred/skeleton_only/hidden）由 B 指令、C 渲染；`visual_context.sent_to_mimo` 强制真实。剩余：三场景各用哪档的策略 |
| P0-6 B→C 传输 | ⚠️ 阻塞解除 | Adapter seam 冻结（§13），HTTP/框架明确列入 §16 暂不冻结——降为实现细节 |
| 接缝-时序关联 | ✅ 已解决 | 全记录强制 `scene_id`；`decision_id` 贯穿 CareDecision↔InteractionResponse |
| 接缝-degraded | ✅ 已解决 | `state=degraded`/`fallback_used`/`source=degraded` 三者语义分清（§10、场景四） |
| 接缝-演示时钟 | ❌ 仍开放 | 合同只统一了视频毫秒偏移；分钟级静止在 79s 素材中如何加速演示仍无机制、无 owner |
| C 自查-废止 ADR-0001 引用 | ❌ 仍在 | software-demo/spec.md 改了 105 行但 line 418 仍引用 ADR-0001 边界 |
| §4 ADR 撞号 | 不涉及 | akira 未动 docs/adr/；本仓库侧改号 ADR-0004 的义务不变 |
| pytest 破坏（e35b5bd） | ❌ akira 未修 | develop/akira 不含 pyproject.toml 修复，该分支上测试仍全挂；e35b5bd 仍需尽快进 upstream |

另两处观察：① 合同头部 Status 已标 `accepted-for-demo`，但 §15 冻结条件 checkbox 全部未勾——**Status 与自身流程矛盾**，三方（尤其 A/C）是否真已确认需当面核实；② 935effd 把 A 的工作拆为 7 张顺序票（冻结输入→标注→几何基线→轻量模型→静止/转变基线→评审冻结→ABC 验收），范围仍是全集但有了 06 票的裁剪点，与本清单 §3 对 A 的裁剪建议兼容；③ CONTEXT.md 新增 Canonical runtime terms 七术语，术语层级问题就此关闭。
