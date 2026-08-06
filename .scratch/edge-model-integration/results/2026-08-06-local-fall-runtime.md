# 本机完整跌倒链路回放结果（2026-08-06）

## 结论

当前端侧 bundle **不能稳定检测跌倒**。该结论来自本机完整链路回放，不只是 MIL 训练报告：

```text
INT8 MoveNet
→ nose_body_geometry INT16 姿态头
→ RealtimePostureTracker
→ TransitionDetector
→ INT16 MIL enhancer
→ fall_like_transition
```

验证对象为归档数据中的留出 split：

- 15 个跌倒片段：7 个 validation、8 个 test；
- 10 个正常动作视频：4 个 validation、6 个 test；
- 不使用 train split 作为稳定性结论。

## 12 FPS 完整回放

报告：

```text
artifacts/training/edge-int8/local-fall-eval-heldout-12fps-20260806-1430/report.json
```

结果：

| 项目 | 结果 |
|---|---:|
| 留出跌倒片段 | 15 |
| 实际发出 `fall_like_transition` | 2 |
| 触发率 | 13.33% |
| 留出正常视频 | 10 |
| 误报视频 | 1 |
| 正常视频误报率 | 10% |
| 重复跌倒事件 | 0 |

触发片段：

```text
fall-009
fall-028
```

误报场景：

```text
d6-lying-down-25
```

普通躺下视频在 12 FPS 回放时发出了一个 `fall_like_transition`。

## 24 FPS 复测

对全部 15 个留出跌倒片段重新逐帧回放，仍只有 2 个触发：

```text
fall-004
fall-021
```

12 FPS 和 24 FPS 的触发集合没有交集，说明当前事件输出对采样节奏敏感。

普通躺下视频在 24 FPS 复测时未触发跌倒，但这并不能抵消 12 FPS 的误报；相同动作在不同采样频率下产生不同结论，本身就是稳定性失败。

## 与离线 MIL bag 结果的差异

候选模型训练报告中，validation + test 的离线 bag 阈值结果为：

- 跌倒：8/15 越过阈值；
- 正常：1/10 越过阈值。

完整运行时只有 2/15 跌倒触发。主要原因是当前 enhancer 只在确定性 detector 已经发出 transition event 时计算增强，并且只允许把 `uncertain_transition` 升级为跌倒：

```text
if deterministic transition == uncertain
and MIL score confirmed
then upgrade to fall_like
```

如果确定性 detector 先发出 `normal_transition`，或者 MIL 分数在该事件时刻尚未达到阈值，后续即使窗口变得可确认，也不会独立产生跌倒事件。确定性 detector 的 cooldown 和窗口清空会进一步缩小升级时机。

## 工程门槛

本次本地演示稳定性门槛定义为：

- 留出跌倒触发率 >= 80%；
- 留出正常视频误报率 <= 5%；
- 重复跌倒事件率 <= 5%。

当前结果：

```text
13.33% fall trigger rate
10% normal alert rate
0% duplicate rate
```

因此 Gate 失败。

这些数字只描述当前归档弱标签视频上的本机工程回放，不是医学、临床或真人场景准确率。

## 下一步应修复的运行时结构

1. MIL 必须按 stride 连续评分，不能只依附于确定性 transition event。
2. 新增独立的跌倒状态机：稳定高位 → 快速下降 → 低位稳定。
3. 普通躺下必须作为强 hard negative，使用下降速度、持续时间和落地后稳定性区分。
4. 同一组片段必须同时通过 12、24、30 FPS 回放，触发集合不能随采样频率大幅变化。
5. 修复后仍需保留一次事件去重和 cooldown，但不能在确认窗口形成前清空关键证据。
