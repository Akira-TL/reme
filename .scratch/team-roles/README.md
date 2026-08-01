# Reme 四人分工与接口索引

- Status: active coordination baseline
- Date: 2026-08-01
- Scope: A / B / C / D 的职责、交付关系与候选接口命名

## 1. 当前分工

| 成员 | 角色 | 最终负责结果 | 详细文档 |
|---|---|---|---|
| A | 姿态算法与数据 | 视频能够稳定输出关键点、姿态分类和时序事件候选 | [`../pose-classification-owner-a/spec.md`](../pose-classification-owner-a/spec.md) |
| B | MiMo 决策与主动交互 | 感知结果能够形成可校验、可降级的关怀决策 | [`../mimo-decision-interaction/spec.md`](../mimo-decision-interaction/spec.md) |
| C | 软件演示端 | A 与 B 的输出能够在同一软件中同步、稳定地展示 | [`../software-demo/spec.md`](../software-demo/spec.md) |
| D | 产品、PPT 与路演 | 作品价值、完成度和边界能够被评委准确理解 | [`../product-roadshow-owner-d/spec.md`](../product-roadshow-owner-d/spec.md) |

整体协作链路：

```text
原始视频
  ↓
A：关键点 → 静态姿态 → 时序转变 → 事件候选
  ↓
B：结构化上下文 / 最小视觉上下文 → MiMo → 决策状态机
  ↓
C：视频 + 骨架 + 姿态 + 决策 + 主动交互的软件演示
  ↓
D：产品叙事 + PPT + 路演 + 申报与答辩材料
```

## 2. 文档优先级

发生冲突时按以下顺序处理：

1. 已接受的 `docs/adr/`：不可逆或高影响技术与隐私决策；
2. 根目录 `CONTEXT.md`：当前领域边界和已知事实；
3. 本目录链接的 A / B / C / D 工作规格：当前执行分工和候选接口；
4. `.scratch/handoff/`：讨论基线和移交背景；
5. `planning/`：产品、比赛材料和历史规划基线。

`planning/` 中的“冻结版”不覆盖后续实验结果或 ADR。产品叙事由 D 根据当前实测结果和已接受 ADR 持续校正。

## 3. A → B / C 候选感知合同

当前统一使用以下命名。该合同仍为 `v0-experiment`，只有在 A、B、C 联合验收后才能冻结。

### 3.1 姿态观测

```json
{
  "schema_version": "reme-posture/v0-experiment",
  "scene_id": "fall_demo_01",
  "timestamp_ms": 12500,
  "frame_index": 375,
  "person_detected": true,
  "posture": "lying",
  "posture_confidence": 0.88,
  "posture_duration_ms": 4200,
  "motion_level": "low",
  "visible_keypoint_ratio": 0.94,
  "landmark_quality": "usable"
}
```

统一规则：

- 使用 `posture`，不再混用 `pose`、`pose_state`；
- 使用 `posture_confidence` 和 `posture_duration_ms`；
- 使用 `motion_level`，候选值为 `still / low / medium / high / unknown`；
- 使用 `landmark_quality`，候选值为 `usable / degraded / unavailable`；
- 时间统一为毫秒；
- `unknown` 和不可用状态必须显式输出。

### 3.2 时序事件

```json
{
  "schema_version": "reme-transition/v0-experiment",
  "scene_id": "fall_demo_01",
  "start_ms": 11100,
  "end_ms": 12700,
  "transition": "fall_like_transition",
  "transition_confidence": 0.76,
  "candidate_event": "possible_fall",
  "candidate_event_confidence": 0.72,
  "evidence": {
    "center_height_change": 0.41,
    "peak_keypoint_speed": 0.18,
    "posture_before": "standing",
    "posture_after": "lying"
  },
  "landmark_quality": "usable"
}
```

静态 `lying` 不等于跌倒。跌倒候选必须来自时间窗口，并允许输出 `uncertain_transition`。

## 4. B → C 候选决策合同

```json
{
  "schema_version": "care-decision.v0",
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

统一规则：

- 页面隐私状态使用 `privacy_mode`；
- 主动询问开关使用 `need_dialogue`；
- 老人端文本使用 `elder_message`；
- 家属端文本使用 `family_notification`；
- 结果来源使用 `source`；
- 演示路径使用 `demo_mode`，候选值为 `live / mock / record`；
- C 不根据自然语言自行推断风险状态或下一步动作。

## 5. 媒体与隐私边界

依据 ADR-0003，团队统一允许经过明确触发的原图关键帧或短视频进入 MiMo：

- A 本地解码视频并提供关键点、时间戳和受控媒体引用；
- B 可以使用结构化路径，也可以使用结构化信息加视觉上下文的路径；
- 关键帧或短视频发送必须显式、最小、可观察，并记录采样范围；
- 不允许持续后台上传；
- 请求完成后，本地应用不额外留存临时视觉文件，除非明确开启调试模式；
- C 的演示必须显示当前是否发送了视觉上下文；
- D 的路演不得声称所有 MiMo 推理都完全不接触像素；
- 家属端默认仍只展示骨架、事件、对话摘要和行动结果。

## 6. 变更规则

任何跨角色字段调整必须同时完成：

1. 修改本索引中的候选合同；
2. 修改受影响的角色规格；
3. 更新模拟数据或适配器；
4. 运行 A→B→C 的最小回放验收；
5. 在提交信息中明确接口变化。

比赛版本冻结后：

- 不随意增加姿态标签；
- 不随意更换风险等级名称；
- 不让 C 复制 B 的决策逻辑；
- 不让 D 把候选功能描述成已完成功能；
- P0 以外的功能必须在不影响主演示路径时再加入。

## 7. 联合验收

- [ ] A 的姿态观测能被 B 和 C 读取；
- [ ] B 能把 A 的姿态和时序事件合并成同一决策上下文；
- [ ] C 能同步展示视频、骨架、姿态、事件和决策；
- [ ] `unknown`、`uncertain_transition`、MiMo 超时和离线降级可见；
- [ ] Structured 与 Visual 路径都明确记录实际发送内容；
- [ ] D 的 PPT、演讲和申报口径与当前 ADR、实测结果一致；
- [ ] 三条主演示路径可连续回放，失败时能切换 `mock` 或 `record`。
