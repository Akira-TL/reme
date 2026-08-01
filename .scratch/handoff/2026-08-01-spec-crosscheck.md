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
