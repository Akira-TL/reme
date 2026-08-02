# 跌倒弱监督 Round 0 数据准备结果

- Date: 2026-08-02
- Evidence level: weak-supervision-bootstrap
- Source: `50种摔倒.mp4`
- Audit reference: `50种摔倒方式 -摔倒检测.mp4`
- Result: 数据准备链路可用；不得据此报告跌倒准确率；进入多实例学习与人工复核阶段

## 输入与切片

- 原视频：232.958秒，960×544，24 FPS；
- 标记版：232.982秒，1280×720，23.976 FPS；
- 时长差约23.7毫秒，只按时间戳对齐；
- 自动选择49个候选场景边界，形成50个positive bags；
- 固定片段级划分：35 train / 7 val / 8 test；
- 片段中位时长约4.604秒；
- 最短片段1.875秒，最长片段9.958秒；
- 标记版只作为审核引用，不进入模型像素输入。

机器清单：

```text
artifacts/pose-classification/fall-50/bootstrap/clip-manifest.json
```

## MoveNet提取

- 采样频率：12 Hz；
- 抽样帧：2,796；
- 人体检测覆盖率：0.972103；
- MoveNet平均推理：3.100 ms；
- 总运行时间：14.322秒；
- 原始帧落盘：否；
- 标记版用于训练：否。

产物：

```text
artifacts/pose-classification/fall-50/bootstrap/pose-samples.jsonl
artifacts/pose-classification/fall-50/bootstrap/weak-candidates.json
```

## 旧静态姿态模型迁移表现

帧级输出分布：

| 姿态 | 帧数 |
|---|---:|
| unknown | 2,020 |
| sitting | 377 |
| standing | 199 |
| bending_or_crouching | 126 |
| lying | 74 |

旧模型在动画弱标签域训练，迁移到真人跌倒合集后72.2%的帧拒判为unknown。人体检测覆盖率仍为97.2%，因此主要瓶颈是静态姿态模型域差异，不是MoveNet无法识别人。

## 相对几何证据

所有片段前25%与后25%的总体分布：

| 特征 | 前段中位数 | 后段中位数 |
|---|---:|---:|
| 躯干偏离竖直角 | 5.612° | 69.438° |
| 包围盒宽高比 | 0.292 | 1.282 |
| 人体中心Y | 0.512 | 0.715 |
| 运动速度 | 0.072 | 0.089 |

大多数片段符合“前段竖直窄体态、后段水平宽体态且中心下移”。因此standing锚点不能只依赖旧静态模型标签，应允许低运动、竖直躯干和窄包围盒构成几何standing证据。

## Round 0候选

第一版仅依赖静态模型standing锚点：

```text
accepted: 4
uncertain: 4
rejected: 42
```

增加保守几何standing锚点后：

```text
accepted: 12
uncertain: 9
rejected: 29
```

拒判原因：

```text
no_stable_standing_anchor: 15
no_stable_fallen_anchor_after_standing: 14
transition_too_slow: 9
```

accepted候选的站立消失到倒地稳定时间约0.50–1.58秒。9个uncertain候选均因转变时间超过当前1.6秒阈值；这些不能直接判为正常躺下，也不能直接当跌倒正样本，必须审核或交给后续MIL。

## 结论

### 已证明

- 50段候选切片可确定性重建；
- 原视频可在约14秒内完成12Hz MoveNet提取；
- 标记版无需进入训练像素；
- 相对几何可以恢复部分standing→fallen候选；
- 证据不足时系统会拒判而非强贴正标签。

### 尚未证明

- 50段切片边界全部正确；
- 12个accepted候选的事件边界是真值；
- rejected片段没有跌倒；
- 1.6秒是最终跌倒时间阈值；
- 当前规则或未来模型能够区分真人正常躺下与跌倒；
- 任何precision、recall、F1或误报率。

## 下一阶段训练方法

采用三部分数据：

1. **Seed positives**：12个高置信accepted候选窗口；
2. **Positive bags**：全部50个跌倒主题片段，每段已知包含一个主要跌倒但时间未知；
3. **Hard negatives**：已有正常躺下、坐下、起身、弯腰/下蹲、稳定站立和稳定躺卧窗口。

训练采用轻量多实例学习：

```text
片段 → 多个1.5–3.2秒窗口 → 窗口跌倒分数
positive bag loss: 至少一个窗口为正
negative bag loss: 所有窗口应为负
```

12个seed positives用于初始化；每轮在每个positive bag中选择满足时间顺序与质量约束的最高分窗口，低置信片段保持uncertain。测试集8段必须人工复核事件边界后，才允许报告真实事件指标。
