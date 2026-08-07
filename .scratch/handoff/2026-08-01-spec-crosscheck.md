# 分工 spec 交叉审阅：冻结会待决清单

- 日期：2026-08-01
- 来源：Codex（gpt-5 系）对 6 份分工文档的异构交叉审阅（team-roles、A/B/C/D spec、motionbert-offline-demo）+ 人工核实，基线参照 `docs/integration/方案-MiMo接入.md`
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

- `docs/integration/方案-MiMo接入.md`：§1 原则 1 已按 ADR-0003 改为 S/V 双路径；流转图出网标注与 Miloco 对照叙事已同步（"按需最少地看"）；头部已声明执行期字段以 team-roles 候选合同为准。

## 7. 对照更新（2026-08-01 傍晚）：develop/akira `56c3604 统一ABC实验接口合同` 解决情况

> 协调基准变更：`.scratch/abc-interface/spec.md`（548 行，七流接口 + SceneBundle + Adapter seam）自此为 A/B/C 接口的**唯一协调来源**，本清单 §1/§2 中与其重叠的裁决项按下表关闭或收窄。ADR 治理规则同步明确：**ADR 由各层 owner 自行创建**（2、3 层任务的两位 owner 自行确立各自 ADR），本清单只列问题、不代立 ADR。**夜间续核**：akira 后续 `74980ff 扩展离线多视频演示合同` 已解决的行在下表直接改判并标注（74980ff）。

| 原清单项 | 状态 | 说明 |
|---|---|---|
| P0-1 A→B/C 感知合同 | ✅ 已解决 | 统一 `posture/posture_duration_ms/landmark_quality`；`candidate_event` 双层取消（B 内部组合）；**`prolonged_stillness` 归属已定**：A 出 `posture_duration_ms`+`motion_level` 事实、B 判是否构成关怀（abc-interface §7/§8） |
| P0-2 B→C 决策合同 | ✅ 已解决 | `reme-care-decision/v0` 统一命名，C 的自有字段已在同提交中清除（software-demo/spec.md 同步改） |
| P0-3 高风险旁路 | ✅ 已解决（74980ff） | 语义澄清保留：**"告警"= 向家属端（子女端）推送告警信息，非呼叫外部报警/急救**。74980ff 落定"询问先行 + 规则确定性升级"：高置信跌倒必带 `response_timeout_ms`（提案绝对口径改相对，判据见 §8.2 ④）、超时 `source=rule` 强制升级、MiMo 后到不可取消（§15.1 已勾）；`urgent_attention` 获触发场景（视频四二次超时）。隐私升档未进合同，归并 P0-5 剩余策略。详见 §8.2 状态更新 |
| P0-4 行动卡/授权/回执 | ✅ 已解决（74980ff） | `text` 主诉通道、`consent_required`、六要素 `action_card`、`consent_granted/card_confirmed/family_input` 枚举全部进合同；牙疼闭环成为 §14 视频三，D 主故事获接口支撑。合同附红线：素材拍完并通过全链路回放前不得宣称端到端完成（§15.2）。详见 §8.1 状态更新 |
| P0-5 隐私口径 | ✅ 机制解决 | `privacy_mode` 四档（visible/blurred/skeleton_only/hidden）由 B 指令、C 渲染；`visual_context.sent_to_mimo` 强制真实。剩余：三场景各用哪档的策略 |
| P0-6 B→C 传输 | ⚠️ 阻塞解除 | Adapter seam 冻结（§13），HTTP/框架明确列入 §16 暂不冻结——降为实现细节 |
| 接缝-时序关联 | ✅ 已解决 | 全记录强制 `scene_id`；`decision_id` 贯穿 CareDecision↔InteractionResponse |
| 接缝-degraded | ✅ 已解决 | `state=degraded`/`fallback_used`/`source=degraded` 三者语义分清（§10、场景四） |
| 接缝-演示时钟 | ✅ 已解决（74980ff） | `media.demo_time_scale` 进 manifest（可选正数默认 1.0），仅供 C 叙事换算、不改真实 `*_ms`、B 阈值不得据此伪造感知数据；A 落字段，owner 分工同提案。详见 §8.3 状态更新 |
| C 自查-废止 ADR-0001 引用 | ❌ 仍在 | software-demo/spec.md 改了 105 行但 line 418 仍引用 ADR-0001 边界 |
| §4 ADR 撞号 | 不涉及 | akira 未动 docs/adr/；本仓库侧改号 ADR-0004 的义务不变 |
| pytest 破坏（e35b5bd） | ❌ akira 未修 | develop/akira 不含 pyproject.toml 修复，该分支上测试仍全挂；e35b5bd 仍需尽快进 upstream |

另两处观察：① 合同头部 Status 已标 `accepted-for-demo`，但 §15 冻结条件 checkbox 全部未勾——**Status 与自身流程矛盾**，三方（尤其 A/C）是否真已确认需当面核实；② 935effd 把 A 的工作拆为 7 张顺序票（冻结输入→标注→几何基线→轻量模型→静止/转变基线→评审冻结→ABC 验收），范围仍是全集但有了 06 票的裁剪点，与本清单 §3 对 A 的裁剪建议兼容；③ CONTEXT.md 新增 Canonical runtime terms 七术语，术语层级问题就此关闭。

## 8. 合同增补提案（2026-08-01 晚，供 abc-interface 采纳）

> 语义前提（适用全节）：本项目**"告警"指向家属端（子女端）推送告警信息**，不是呼叫外部报警/急救服务。
> 治理：以下为字段级提案；本文件不直接修改 abc-interface 合同，也不代立 ADR——涉及不可逆决策的项由对应层 owner（2/3 层为梁博星、江婷芳）自行确立 ADR。所有增量均为**可空字段/新枚举值**，对已实现代码零破坏。
>
> **与 B/C 的耦合评估（2026-08-01 结论：无需事前交流，代码先行）**：三项均满足"B/C 可方便兼容"——8.1 全部为可空字段+新枚举，C 不产/不读时现有行为不变，等实现对话与行动卡 UI 时照枚举渲染即可（合同 §13 本就规定 C 照 action 渲染不自行推断）；8.2 三条升级约束是**决策层内部逻辑**，C 只多一个可选倒计时组件（`respond_by_ms=null` 时不渲染）；8.3 的 `demo_time_scale` 为可空字段，A 不落 manifest 时 C 可在自身场景配置兜底。因此不设事前评审前置，接口增量在联调/统一调优时自然呈现。
>
> **文件定位（用户定调）**：本计划文件是相对参考，**具体以实际开发代码为主**，后续做一次统一调优时校正合同与本清单的偏差。

### 8.1 行动卡与授权闭环（闭 P0-4）

> **状态更新（2026-08-01 夜，核对 akira `74980ff`）**：本节五项已全部进合同——① `text` 字段及"仅 `user_input | script` 可非空、`timeout` 必为 `null`"约束原样落地（合同 §11，样例即"牙疼，饭咬不动。"）；② `consent_required`/六要素 `action_card`（含 `status` 三值枚举）与授权前置约束逐条进 §10，合同并增设 `state = consent_required` 档（明确 risk_level 仍为 2，等待授权≠风险升级）；③ 三个 `response` 新枚举与 `source = family_input`（含"`card_confirmed` 仅家属视图提交"）进 §11；④ 回执按 `mark_resolved` + 回执文案 + 行动卡状态 `confirmed|done` 落入场景步骤；⑤ 即合同 §14"视频三：具体需求与行动卡闭环"，并附诚实红线：素材拍摄完成前不得宣称闭环端到端完成（§15.2 留待验收）。**P0-4 就此关闭**，剩余为素材拍摄与契约测试等实现项。

**① `InteractionResponse` 增加可空 `text` 字段**——这是隐藏的先决缺口：老人主诉（"牙疼，饭咬不动"）必须能从 C 传到 B 再进 MiMo 做需求理解，否则"具体需求"分支整体不可运行。

```json
{ "response": "need_help", "text": "牙疼，饭咬不动。", "…": "其余字段不变" }
```

- `text` 仅在 `source = user_input | script` 时可非空；`timeout` 时必为 `null`。

**② `CareDecision` 增加两个可空字段**：

```json
"consent_required": true,
"action_card": {
  "event": "长时间静坐 + 主诉牙疼",
  "elder_quote": "牙疼，饭咬不动。",
  "system_judgment": "疑似口腔问题影响进食，非紧急",
  "suggested_action": "本周内预约口腔科检查",
  "time_window": "3 天内",
  "status": "pending"
}
```

- 六要素全必填，缺任一即 schema 校验失败（v3.0 红线保留）；`status ∈ {pending, confirmed, done}`。
- **授权前置约束**：`consent_required = true` 时，在收到 `consent_granted` 前 `action` 不得为 `notify_family`。
- 授权征求不加新 action 枚举：用 `action = ask_elder` + `consent_required = true` 组合表达，C 见此组合渲染"同意/不同意"选项。

**③ `InteractionResponse` 枚举扩展**：`response` 增加 `consent_granted / consent_denied / card_confirmed`；`source` 增加 `family_input`（`card_confirmed` 只能由家属视图以 `family_input` 提交）。

**④ 回执不加新枚举**：B 收到 `card_confirmed` 后输出下一条 CareDecision（`action = mark_resolved` + `elder_message` 承载回执文案，`action_card.status = confirmed/done`）。

**⑤ 验收场景五（牙疼行动闭环，补进合同 §14）**：

```text
A: 长时间静坐（posture_duration_ms 高 + motion_level=still/low）
B: check_in_required + ask_elder（开场询问）
C: response=need_help, text="牙疼，饭咬不动。"
B: (MiMo 需求理解) ask_elder + consent_required=true（征求告知家属授权）
C: response=consent_granted
B: notify_family + family_notification 非空 + action_card 六要素（status=pending）
C(家属视图): response=card_confirmed, source=family_input
B: mark_resolved + elder_message 回执（status=confirmed）
```

### 8.2 高风险确定性升级（闭 P0-3）

与合同现行"询问先行"调和为：**询问可以先行，升级必须确定性**。

> **状态更新（2026-08-01 夜，核对 akira `74980ff`）**：本节语义已进合同——② 三条约束逐条落入合同 §10 约束区（高置信必带时限、超时后 `source=rule` 强制升级、MiMo 后到不得取消），③ 的二次超时→`urgent_attention` 已进合同 §14 视频四（隐私升档未进合同，归并 P0-5 隐私策略残项）；唯 ① 的字段未采用绝对口径，改为**相对倒计时 `response_timeout_ms`**（从 C 收到本条 CareDecision 起算），合同注明理由：预录视频输入下交互可能发生在视频暂停或结束后，锚定视频钟的绝对截止会失效。实现以合同字段为准，① 原文留作提案存档；两种口径的判据与生产形态的双字段演进见新增 ④。

**① `CareDecision` 增加可空 `respond_by_ms`**（要求回应的截止视频时刻）：C 据此渲染倒计时；`null` 表示本决策无时限。〔已被合同以 `response_timeout_ms` 相对口径替代，见上方状态更新〕

**② 确定性升级约束（写入合同 §10 约束区）**：

1. 高置信 `fall_like_transition` 后 → `check_in_required` 必须携带 `respond_by_ms`；
2. 截止无回应（`response=none, source=timeout`）→ **规则路径**（`source=rule`）直接输出 `family_notification_required` 或 `urgent_attention`（按严重度），`family_notification` 非空（家属端告警推送）——此升级**不等待、不依赖 MiMo 返回**；
3. **MiMo 后到的结果不得取消、降级或推迟已发出的规则告警**，只能补充 `reason_summary` 解释文案（v3.0 原则 2 落地为合同约束）。

**③ `urgent_attention` 触发场景补进 §14**：场景三扩展一步——family_notification_required 后仍无任何回应（二次超时）→ `urgent_attention` + `privacy_mode` 可升档（如 `blurred→visible`，须 owner 确认隐私口径）。

**④ 双字段演进模式（实况摄像头形态预案，本届演示不实施）**：口径选择的真判据不是"预录 vs 实时"，而是**截止所锚定的钟对回应者是否一直在走**。预录视频钟会暂停/跳转/放完，绝对截止一锚即死——故演示用相对 `response_timeout_ms` 正确；切到实况摄像头后感知钟≈现实钟，绝对截止的幂等与可审计优势才重新值钱（重复投递不重启窗口、老人端/家属端/审计端算得同一截止、离线可验升级时点）。届时不做二选一，锚点+时长双发（实况形态下三值均为现实钟 epoch 毫秒，不再是视频偏移）：

```json
"response_deadline": {
  "issued_at_ms": 1780000000000,
  "timeout_ms": 8000,
  "respond_by_ms": 1780000008000
}
```

- 端间钟同步可信（NTP 级）→ 按 `respond_by_ms` 渲染与校验；钟不可信 → 退化为收到起算的 `timeout_ms`，行为等价演示现状。绝对口径依赖对钟是老教训（HTTP `Expires` 因客户端钟不可信败给 `max-age`）；
- **权威计时者上移到 B**：升级截止由 B 在自己的钟上强制执行，C 断线/卡死不阻断升级，C 的倒计时降级为纯展示；`source=timeout` 的超时判定随之从 C 移回 B（演示现状由 C 报超时，生产不可依赖展示端的钟与在线状态）。

此节涉及安全叙事根基，**建议由决策层 owner 立 ADR 固化**（"检查-升级-不可取消"三段式），D 的路演话术依赖此 ADR；④ 的双字段演进可作为该 ADR 的"后续工作"附注一并记录。

### 8.3 演示时钟（闭演示时钟缺口）

> **状态更新（2026-08-01 夜，核对 akira `74980ff`）**：已进合同——`media.demo_time_scale` 为可选正数、默认 `1.0`（合同样例即 `30.0`），且"只用于 C 的叙事时长换算、不改变任何真实 `*_ms`"与"B 规则阈值不得用它伪造感知数据"两条红线原文落地，与本节"数据层不变"原则完全一致；manifest 由 A 侧（SceneBundle 生成方）落字段，owner 分工与提案相同。**演示时钟缺口就此关闭**。

**`SceneManifest` 增加可空 `demo_time_scale`**（数值；如 `30.0` = 1 视频秒代表 30 叙事秒）：

```json
"media": { "…": "现有字段不变", "demo_time_scale": 30.0 }
```

- **数据层不变**：所有 `*_ms` 仍是真实视频毫秒，A 的产出零改动（仅 manifest 多一个可空字段）；
- C 仅在**叙事展示**处换算（"已静坐 32 分钟"），技术面板仍显示真实值——避免 D 的"不夸大"红线被误触；
- B 的静止判定阈值按场景配置（视频毫秒口径），不在感知数据里造假时长；
- owner 分工：C 提出（渲染需求方）、A 落 manifest 字段、B 落场景阈值配置——三方各约一行改动。

### 8.4 采纳路径（按"代码先行"定调修订）

1. **不设事前评审**：我方按本提案直接实现（decision 侧字段、状态机、倒计时逻辑）；接口增量以可空字段呈现，B/C 未实现侧零感知；
2. 8.2 的"检查-升级-不可取消"三段式仍建议由决策层 owner 立 ADR 固化（D 路演话术依赖），时点不阻塞开发；
3. **统一调优时**（后续一次性）：将实际代码中生效的字段回写 abc-interface/spec.md（遵循其 §15 流程），校正本清单与合同的偏差，关闭 P0-3/P0-4/演示时钟三行，验收场景以五场景为准。
