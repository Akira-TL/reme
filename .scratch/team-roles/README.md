# Reme 四人分工与接口索引

- Status: active coordination baseline
- Date: 2026-08-01
- Scope: A / B / C / D 的职责、交付关系与共享接口入口

## 1. 当前分工

| 成员 | 角色 | 最终负责结果 | 详细文档 |
|---|---|---|---|
| A | 姿态算法与数据 | 视频能够稳定输出关键点、姿态观察和时序转变事件 | [`../pose-classification-owner-a/spec.md`](../pose-classification-owner-a/spec.md) |
| B | MiMo 决策与主动交互 | 感知结果能够形成可校验、可降级的关怀决策 | [`../mimo-decision-interaction/spec.md`](../mimo-decision-interaction/spec.md) |
| C | 软件演示端 | A 与 B 的输出能够在同一软件中同步、稳定地展示 | [`../software-demo/spec.md`](../software-demo/spec.md) |
| D | 产品、PPT 与路演 | 作品价值、完成度和边界能够被评委准确理解 | [`../product-roadshow-owner-d/spec.md`](../product-roadshow-owner-d/spec.md) |

整体协作链路：

```text
原始视频
  ↓
A：关键点 → 静态姿态 → 时序转变
  ↓
B：结构化上下文 / 最小视觉上下文 → MiMo → 决策状态机
  ↓
C：视频 + 骨架 + 姿态 + 决策 + 主动交互的软件演示
  ↓
D：产品叙事 + PPT + 路演 + 申报与答辩材料
```

## 2. 共享接口唯一来源

A、B、C 的跨角色字段、时间语义、失败状态、SceneBundle 和 Adapter 约定统一维护在：

> [`../abc-interface/spec.md`](../abc-interface/spec.md)

该合同当前状态为 `proposed`，版本为 `v0-experiment`。在 A、B、C 联合确认前：

- 不拆分依赖最终字段的实现 Ticket；
- 不把候选字段写入永久产品合同；
- 不让各角色规格自行新增同义字段；
- 不让 C 根据自然语言复制 B 的业务规则；
- 不让 B 要求 A 生成语义重复的大型合并 JSON。

共享接口当前统一的关键命名：

```text
posture
posture_confidence
posture_duration_ms
motion_level
landmark_quality
transition
transition_confidence
privacy_mode
need_dialogue
elder_message
family_notification
```

统一关系：

```text
A → C：FrameLandmarks
A → B/C：PostureObservation + TransitionEvent + SceneManifest
B → C：CareDecision
C → B：InteractionResponse
```

## 3. 文档优先级

发生冲突时按以下顺序处理：

1. 已接受的 `docs/adr/`：不可逆或高影响技术与隐私决策；
2. 根目录 `CONTEXT.md`：当前领域边界和统一术语；
3. `.scratch/abc-interface/spec.md`：A/B/C 当前共享实验接口；
4. 本目录链接的 A / B / C / D 工作规格：各角色内部执行范围；
5. `.scratch/handoff/`：讨论基线和移交背景；
6. `docs/product/`：产品、比赛材料和历史规划基线。

`docs/product/` 中的“冻结版”不覆盖后续实验结果或 ADR。产品叙事由 D 根据当前实测结果和已接受 ADR 持续校正。

## 4. 职责接口摘要

### A → B / C

A 提供：

- SceneManifest 与受控本地媒体引用；
- 逐帧 2D 关键点；
- 可选 3D 关键点；
- 低频姿态观察；
- 时间窗口转变事件；
- 置信度、拒判和数据质量。

A 不提供：

- 风险等级；
- 是否主动询问；
- 家属通知；
- MiMo 网络发送结果；
- 医疗或报警结论。

### B → C

B 提供：

- 风险状态与等级；
- 隐私展示模式；
- 是否需要主动询问；
- 老人端与家属端文本；
- 当前动作；
- 不确定性、降级状态和结果来源；
- 实际视觉上下文发送记录。

B 不要求 C 理解 MiMo 请求格式，也不让 C 从自然语言推断下一步。

### C → B

C 只提交标准化老人回应：

```text
safe
need_help
unclear
none
```

C 不直接把回应转换为家属通知或风险升级，而是等待 B 返回下一条 CareDecision。

## 5. 媒体与隐私边界

依据 ADR-0003，团队允许经过明确触发的原图关键帧或短视频进入 MiMo：

- A 本地解码视频并提供关键点、时间戳和受控媒体引用；
- B 可以比较结构化路径和结构化信息加最小视觉上下文路径；
- 关键帧或短视频发送必须显式、最小、可观察，并记录采样范围；
- 不允许持续后台上传；
- 请求完成后不额外留存临时视觉文件，除非明确开启调试模式；
- C 的演示必须显示当前是否发送了视觉上下文；
- D 的路演不得声称所有 MiMo 推理完全不接触像素；
- 家属端默认仍只展示骨架、事件、对话摘要和行动结果。

## 6. 变更规则

任何跨角色字段调整必须同时完成：

1. 修改共享接口合同；
2. 修改受影响的角色规格；
3. 更新样例或适配器；
4. 运行 A→B→C 最小回放验收；
5. 在提交信息中明确接口变化。

比赛接口冻结后：

- 不随意增加姿态标签；
- 不随意更换风险状态名称；
- 不让 C 复制 B 的决策逻辑；
- 不让 D 把候选功能描述成已完成功能；
- P0 以外功能必须在不影响主演示路径时再加入。

## 7. 接口评审完成条件

- [ ] A 确认能够生成 SceneManifest、FrameLandmarks、PostureObservation 和 TransitionEvent；
- [ ] B 确认能够通过 `scene_id` 和时间轴组合 A 的结果；
- [ ] C 确认能够通过 manifest 同步读取视频、骨架、姿态和事件；
- [ ] B/C 确认 CareDecision 与 InteractionResponse 往返字段；
- [ ] `unknown`、`uncertain_transition`、MiMo 超时和离线降级均可表达；
- [ ] Structured 与 Visual 路径均能记录实际发送内容；
- [ ] 至少一组完整样例完成人工 A→B→C 回放；
- [ ] 共享合同状态改为 `accepted-for-demo`。

满足以上条件后，再分别对 A、B、C 执行 `/to-tickets`。
