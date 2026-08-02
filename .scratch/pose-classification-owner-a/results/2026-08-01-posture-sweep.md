# 姿态分类参数搜索结果（2026-08-01）

## 目的

在不增加新数据的前提下，检查随机种子和学习率是否仍是当前弱标签姿态分类的主要误差来源，并冻结一个用于 A/B/C 联调的候选模型。

## 搜索空间

- 数据索引：`artifacts/pose-classification/datasets/downloads6/dataset-index.json`
- 每个视频最多抽样：400帧
- epochs：5000
- L2：0.0001
- seed：42、2026、3407
- learning rate：0.005、0.01、0.02、0.04
- 总配置：12
- 输出目录：`artifacts/pose-classification/models/posture-sweep-20260801/`

## 最佳候选

```text
seed=42
learning_rate=0.04
confidence_threshold=0.5
distance_threshold=1.053877
validation macro-F1=0.607564
test macro-F1=0.714208
```

模型：

```text
artifacts/pose-classification/models/posture-sweep-20260801/
└── seed-42-lr-0.04/model.json
```

## 结论

12组配置的测试 Macro-F1 集中在约0.713到0.714，随机种子和学习率带来的差异很小。当前瓶颈主要是：

1. 动画参考视频与真人摄像头之间存在明显数据域差异；
2. 文件名弱标签无法精确覆盖长视频中的静态动作区间；
3. `lying` 和 `bending_or_crouching` 的人物、机位和动作覆盖仍少；
4. `unknown` 是开放集拒判状态，不是一个形态统一的普通动作类别。

因此不继续通过机械增加训练轮数追求虚假提升。该候选只用于实时接口、平滑和 B/C 联调，真人准确率仍需真人受控视频验收。
