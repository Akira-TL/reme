# B 角色工作说明：MiMo 决策与主动交互

- Status: active planning
- Owner: B
- Date: 2026-08-01
- Related roles: A（姿态分类）、C（软件演示端）、D（产品、PPT 与路演）
- Related documents:
  - `CONTEXT.md`
  - `docs/adr/0003-allow-minimal-visual-context-to-mimo.md`
  - `.scratch/handoff/2026-08-01-product-mimo-handoff.md`
  - `.scratch/abc-interface/spec.md`（A/B/C 共享接口唯一来源）

## 1. 角色定位

B 负责将 A 输出的姿态分类与时序状态，转换为 MiMo 可消费的结构化上下文，并把 MiMo 的判断约束为可校验、可降级、可直接交给 C 展示和执行的主动关怀决策。

B 不负责人体关键点提取、姿态模型训练或最终页面绘制。B 的工作位于感知结果与软件演示之间：

```text
A：视频 → 关键点 → 姿态与动作转变
                 ↓
B：事件整理 → MiMo 推理 → 交互状态机 → 标准输出
                 ↓
C：骨架可视化 → 状态展示 → 交互演示
```

B 的最终责任是：

> 让系统在收到姿态事件后，能够稳定判断是否需要主动关怀、应当如何询问、何时通知家属，并在 MiMo 超时、断网或输出非法时提供清晰的降级结果。

## 2. 当前边界与不可越过的约束

### 2.1 MiMo 视觉输入边界

根据 ADR-0003，B 可以将原图关键帧或短视频片段发送给 MiMo，用于隐私状态和照护状态判断。

支持两条可比较的输入路径：

1. **Structured 路径**：姿态分类、动作转变、持续时间和交互上下文；
2. **Visual 路径**：结构化信息加选定关键帧或短视频片段。

视觉输入要求：

- 不进行持续后台视频上传；
- 只发送当前判断所需的最少帧数或最短片段；
- 每次请求记录是否包含视觉数据、采样时间和片段长度；
- 本地应用在请求完成后不额外持久化临时帧或片段，除非明确开启调试模式；
- C 和 D 的演示及说明必须明确标出视觉内容会发送给 MiMo，不能宣称下游推理完全不接触原图；
- Structured 路径仍需保留，作为隐私更强或网络条件受限时的降级方案。

### 2.2 安全决策边界

- MiMo 不负责提取人体关键点；
- MiMo 不应把单帧躺卧直接解释为跌倒；
- MiMo 不得取消或延迟已被本地确定性规则触发的高风险动作；
- 系统不得宣称医疗诊断、医疗级跌倒检测或自动联系真实急救服务；
- 无法确定时必须输出 `unknown`、`uncertain` 或降级状态，不能伪造确定性。

### 2.3 合同状态

A/B/C 的跨角色字段统一以 `.scratch/abc-interface/spec.md` 为准。该合同当前为 `v0-experiment`，不是永久领域标准；A 的分类实验、MiMo Schema Smoke Test 和 C 的回放验收通过后，再冻结比赛版本。

## 3. B 的输入

B 不再要求 A 生成把姿态、转变和业务候选重复合并在一起的“大 JSON”。B 通过 `scene_id` 和统一视频时间轴组合两条低频输入流：

1. `PostureObservation`：当前姿态、持续时间、运动程度和关键点质量；
2. `TransitionEvent`：动作转变时间窗、置信度和客观证据。

B 还通过 `SceneManifest` 获取受控本地媒体引用。逐帧 `FrameLandmarks` 主要供 C 可视化，B 默认不消费；需要视觉上下文时，B 按 ADR-0003 从本地媒体引用抽取最小关键帧或短片段。

统一字段包括：

- `scene_id`；
- `timestamp_ms` 或 `start_ms / end_ms`；
- `posture / posture_confidence / posture_duration_ms`；
- `motion_level / landmark_quality`；
- `transition / transition_confidence / evidence`。

A 不再向 B 重复输出 `candidate_event = possible_fall`。B 可以在内部将 `fall_like_transition`、后续低运动姿态和老人回应组合成 `possible_fall` 决策上下文，但该内部对象不属于 A/C 外部接口。

### 3.1 可选上下文与视觉输入

B 可以追加以下上下文，但不得伪造：

```json
{
  "privacy_state": "unknown",
  "time_context": "afternoon",
  "recent_events": [],
  "dialogue_history": [],
  "elder_response": "none",
  "visual_context": {
    "enabled": true,
    "type": "keyframes",
    "sample_count": 3,
    "window_start_ms": 10000,
    "window_end_ms": 12500
  },
  "demo_mode": "live"
}
```

其中：

- `privacy_state` 可以由 MiMo 根据视觉上下文推断，也可以来自本地模块或脚本状态；
- `visual_context` 记录本次是否上传关键帧或短视频及其采样范围；
- 实际图片或视频通过 MiMo API 的多模态字段传递，不直接嵌入业务 JSON；
- `recent_events` 只保留当前演示需要的短窗口；
- `dialogue_history` 不保存无关私人对话；
- `demo_mode` 必须明确标记 `live`、`mock` 或 `record`。

## 4. B 的输出

B 必须向 C 返回稳定、结构化、已校验的结果，而不是只返回一段自然语言。

候选输出合同：

```json
{
  "schema_version": "reme-care-decision/v0-experiment",
  "scene_id": "fall_demo_01",
  "decision_id": "decision-0007",
  "timestamp_ms": 12500,
  "state": "check_in_required",
  "risk_level": 2,
  "privacy_mode": "skeleton_only",
  "need_dialogue": true,
  "dialogue_goal": "confirm_safety",
  "elder_message": "您还好吗？需要我帮您联系家人吗？",
  "family_notification": null,
  "action": "ask_elder",
  "reason_summary": "检测到疑似跌倒式转变，随后处于低运动状态。",
  "uncertainty": "medium",
  "fallback_used": false,
  "source": "mimo",
  "demo_mode": "live"
}
```

### 4.1 C 必须可直接使用的字段

- `state`：当前业务状态；
- `risk_level`：风险等级；
- `privacy_mode`：页面应采用的隐私展示模式；
- `need_dialogue`：是否主动询问；
- `dialogue_goal`：询问目的；
- `elder_message`：老人端提示；
- `family_notification`：家属端通知内容；
- `action`：当前动作；
- `reason_summary`：页面可展示的简短原因；
- `uncertainty`：不确定性；
- `fallback_used`：是否使用降级路径；
- `source`：结果来自 MiMo、规则或脚本；
- `demo_mode`：当前演示模式。

## 5. 风险等级与业务状态

比赛演示建议使用五级风险，但名称必须与 C 和 D 统一：

| 风险等级 | 状态 | 行为 |
|---|---|---|
| 0 | `normal` | 不主动打扰 |
| 1 | `observe` | 继续观察，显示轻度异常 |
| 2 | `check_in_required` | 主动询问老人 |
| 3 | `family_notification_required` | 生成家属通知 |
| 4 | `urgent_attention` | 展示紧急关注状态，不接入真实急救服务 |

MiMo 可以参与风险解释和沟通措辞，但高风险确定性规则必须优先执行。

## 6. 主动交互状态机

B 负责维护业务状态，而不是让 C 根据文本自行猜测下一步。

```text
normal
  ├─ 无异常 → normal
  └─ 轻度异常 → observe

observe
  ├─ 状态恢复 → normal
  ├─ 证据不足 → uncertain
  └─ 异常持续或升级 → check_in_required

check_in_required
  ├─ 老人回应 safe → resolved
  ├─ 老人回应 need_help → family_notification_required
  ├─ 超时无回应 → family_notification_required
  └─ 输入不可用 → degraded

family_notification_required
  ├─ 家属已确认 → resolved
  └─ 风险继续上升 → urgent_attention
```

### 6.1 老人回应枚举

C 向 B 回传的模拟或真实回应应使用固定枚举：

- `safe`：老人明确表示无事；
- `need_help`：老人请求帮助；
- `unclear`：回应无法理解；
- `none`：超时无回应。

### 6.2 响应原则

- `safe`：停止升级，记录已确认安全；
- `need_help`：生成家属通知；
- `unclear`：最多进行一次澄清询问，随后进入人工确认；
- `none`：按演示规则升级家属通知；
- 不允许无限多轮追问。

## 7. MiMo 接入模块

B 应将 MiMo 封装为独立适配器，避免业务代码直接依赖具体 API 请求格式。

建议模块边界：

```text
PoseEventInput + OptionalVisualContext
      ↓
ContextBuilder
      ↓
CareDecisionPolicy
      ├─ DeterministicGuardrails
      └─ MiMoDecisionAdapter
              ↓
SchemaValidator
      ↓
CareDecisionOutput
```

### 7.1 ContextBuilder

负责：

- 过滤无关字段；
- 合并最近姿态、交互上下文与可选视觉上下文；
- 标记输入质量和不确定性；
- 控制发送给 MiMo 的最小必要结构化信息和视觉片段；
- 记录发送的视觉类型、采样范围和数量；
- 避免发送与当前判断无关的身份或家庭环境信息。

### 7.2 MiMoDecisionAdapter

负责：

- 调用 MiMo API；
- 支持纯结构化请求和多模态视觉请求；
- 上传选定关键帧或短视频片段；
- 设置超时；
- 限制重试次数；
- 记录响应延迟和视觉传输信息；
- 返回原始响应供校验；
- 不包含业务状态机逻辑。

### 7.3 SchemaValidator

负责：

- 验证 JSON 是否可解析；
- 验证字段是否完整；
- 验证枚举是否合法；
- 验证风险等级范围；
- 拒绝模型自行增加危险动作；
- 将非法输出交给降级逻辑。

### 7.4 DeterministicGuardrails

负责：

- 处理明确的本地安全规则；
- 防止 MiMo 降低确定性高风险状态；
- 防止 MiMo 输出医疗诊断；
- 防止 MiMo声称已经联系真实家属或急救机构；
- 将低质量输入转换为 `uncertain` 或 `degraded`。

## 8. 降级方案

比赛 Demo 不得依赖 MiMo 每次在线成功。

B 必须支持三种模式：

### 8.1 Live

真实调用 MiMo，展示实际延迟和结构化输出。

### 8.2 Mock

使用固定场景和预生成结构化结果，用于现场断网或 API 异常。

### 8.3 Record

回放提前完成的一次真实运行结果，并明确标记为录制结果。

### 8.4 失败处理

| 失败类型 | B 的处理 |
|---|---|
| 请求超时 | 返回本地降级决策，`fallback_used=true` |
| 网络断开 | 自动切换 Mock 或 Record |
| 非法 JSON | 尝试一次修复或重试，仍失败则降级 |
| 字段缺失 | 使用安全默认值并标记 `degraded` |
| A 输入低质量 | 返回 `uncertain`，不得强行报警 |
| MiMo 输出越权动作 | 丢弃越权字段，使用本地策略 |

## 9. B 与其他成员的接口

### 9.1 A → B

A 应交付：

- 姿态分类结果；
- 动作转变结果；
- 置信度；
- 持续时间；
- 运动强度；
- 关键点质量；
- 事件候选；
- 测试场景时间轴。

B 不应直接依赖 A 的模型内部变量，而应只依赖版本化数据合同。

### 9.2 B → C

B 应交付：

- 可调用的决策接口；
- 示例输入和输出；
- 风险等级；
- 隐私展示模式；
- 主动询问内容；
- 家属通知内容；
- 时间轴事件；
- Live、Mock、Record 三种模式；
- 错误状态和降级标识。

C 不应复制一套独立业务判断逻辑。C 只负责触发交互并渲染 B 的状态。

### 9.3 B → D

B 应提供：

- MiMo 在项目中的准确角色说明；
- 一组真实输入输出示例；
- 在线响应时间和失败情况；
- 当前已实现能力；
- 降级策略；
- 不能宣称的能力；
- Demo 中各风险状态的解释。

D 据此制作技术架构、PPT 和答辩口径。

## 10. 任务拆分

### P0：必须完成

1. 与 A、C 联合确认共享接口中的 `PostureObservation`、`TransitionEvent`、`CareDecision` 和 `InteractionResponse`；
2. 完成 Structured 路径的 MiMo API Smoke Test；
3. 完成关键帧或短视频 Visual 路径的 MiMo API Smoke Test；
4. 比较两条路径的输出稳定性、延迟和隐私状态判断效果；
5. 约束 MiMo 返回结构化 JSON；
6. 完成 Schema 校验；
7. 完成超时、非法输出和断网降级；
8. 完成主动交互状态机；
9. 向 C 提供可调用接口或本地服务；
10. 提供三个演示场景的 Mock 数据；
11. 记录实际发送给 MiMo 的字段、关键帧数量或视频时长；
12. 记录至少一次端到端运行结果。

### P1：重要加分项

1. 比较不同提示词的结构化输出稳定性；
2. 增加对话澄清流程；
3. 自动生成家属行动卡；
4. 对决策时间轴增加可解释字段；
5. 完成 Live、Mock、Record 无缝切换；
6. 收集平均和 P95 响应时间。

### P2：时间充足再做

1. 多轮长期上下文；
2. 个性化老人档案；
3. 多房间或多用户状态；
4. 真实家属消息通道；
5. 真实急救或报警接口；
6. 连续视频流上传或长期视觉上下文。

## 11. 测试清单

### 正常场景

- 正常站立或坐姿不触发主动询问；
- MiMo 输出 `risk_level=0`；
- C 收到 `action=no_action` 或等价状态。

### 模糊场景

- A 输出低置信度或关键点不可用；
- B 返回 `uncertain`；
- 不生成确定性跌倒结论；
- C 显示“当前无法可靠判断”。

### 疑似异常场景

- A 输出 `fall_like_transition` 或异常持续；
- B 进入 `check_in_required`；
- C 显示主动询问；
- 老人回应 `safe` 后停止升级。

### 无回应场景

- 主动询问后返回 `none`；
- B 进入 `family_notification_required`；
- C 展示家属通知；
- 不声称已经真实发送通知。

### MiMo 故障场景

- 模拟超时；
- 模拟非法 JSON；
- 模拟字段越权；
- 模拟断网；
- 每种情况均返回合法降级输出。

## 12. 验收标准

B 的工作完成需要同时满足：

1. A 的样例姿态结果可以被正常解析；
2. MiMo 至少完成一次真实 Structured 调用；
3. MiMo 至少完成一次真实关键帧或短视频 Visual 调用；
4. 输出首次校验失败时有明确处理；
5. 所有返回给 C 的结果都符合统一 JSON 合同；
6. 正常、模糊、疑似异常、无回应四类场景均有可复现结果；
7. MiMo 超时、断网和非法输出不会导致 Demo 中断；
8. 日志能够说明是否发送视觉内容、采样范围，以及本次使用 Live、Mock 还是 Record；
9. C 能够只依赖 B 的公开接口完成演示接入；
10. D 能够基于真实结果说明 MiMo 的价值、视觉输入方式和限制。

## 13. 48 小时内的建议执行顺序

### 第一阶段：接口与双路径 Smoke Test

- 与 A 对齐首个输入样例和原始视频时间点；
- 用手工构造事件测试 Structured 路径；
- 抽取最少关键帧或短视频测试 Visual 路径；
- 确认 API、模型、多模态参数和响应格式；
- 记录两条路径的延迟、输出差异和首轮失败原因。

### 第二阶段：结构化输出与降级

- 固定候选输出 Schema；
- 添加校验器；
- 添加一次有限重试；
- 添加 Mock 和 Record 结果；
- 测试断网和非法输出。

### 第三阶段：主动交互状态机

- 实现 `normal → observe → check_in → notify_family`；
- 接收 C 返回的老人回应；
- 完成 `safe`、`need_help`、`none` 三条分支；
- 输出统一时间轴事件。

### 第四阶段：与 C 联调

- 提供接口文档和样例；
- 完成视频时间点与决策事件同步；
- 验证隐私模式、询问和家属通知；
- 连续跑通三个场景。

### 第五阶段：向 D 提供真实材料

- 整理 MiMo 输入输出截图；
- 给出实际延迟与失败情况；
- 标记已完成、Mock 和规划能力；
- 提供技术架构说明和答辩边界。

## 14. 当前第一步

B 当前最先要完成的不是完整业务系统，而是一个可测量的 MiMo 双路径 Smoke Test：

1. 使用正常、隐私、疑似异常三个场景准备结构化事件；
2. 对同一场景分别调用 Structured 路径和 Visual 路径；
3. Visual 路径使用最少关键帧或最短可用视频片段；
4. 验证两条路径都返回统一 JSON；
5. 记录延迟、字段漂移、隐私判断差异和失败情况；
6. 根据证据确定比赛主路径、增强路径和降级路径，再交给 C 联调。

只有双路径 Smoke Test 完成后，才进入完整主动交互和页面接入。
