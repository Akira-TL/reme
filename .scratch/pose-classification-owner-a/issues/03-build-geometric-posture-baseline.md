# 03 — 建立静态姿态几何基线

**Type:** task

**What to build:** 使用归一化人体关键点建立可解释的静态姿态分类基线，并输出可独立校准、评估和解释的姿态结果。该基线既用于验证标签是否可分，也作为后续学习模型的比较对象和比赛失败时的可解释诊断方案。

**Blocked by:** 02 — 标注姿态与转变并评估样本覆盖。

**Status:** resolved

- [x] 从 17 点骨架提取对平移和尺度稳定的特征，覆盖躯干方向、肩髋方向、关节角度、人体中心高度、包围盒比例、髋膝踝关系和可见关键点比例。
- [x] 几何规则和阈值只使用 train/val 数据确定，测试集不参与调参。
- [x] 关键点质量不足、人体未检出、特征证据不足或规则冲突时输出 `unknown`，不沿用上一帧标签。
- [x] 输出固定姿态枚举、证据分数、置信度、可见比例和明确拒判原因。
- [x] 在固定测试集上报告每类 precision、recall、F1、macro-F1、混淆矩阵和拒判率。
- [x] 记录标签抖动次数、错误发生的场景与时间范围，并保存在 metrics JSON 和结果报告中。
- [x] 为确定性特征计算、阈值判断、冲突拒判、无历史拒判、模型加载和测试集隔离提供自动化测试。
- [x] 提供固定命令生成模型、预测和评估报告，同一输入重复运行不会发生 schema 或标签漂移。

## Answer

实现文件：

```text
backend/reme/pose/geometry.py
tests/test_pose_geometry.py
```

评估报告：

```text
.scratch/pose-classification-owner-a/results/2026-08-01-geometry-baseline.md
```

固定模型与指标产物默认生成到 Git 忽略目录：

```text
artifacts/pose-classification/models/geometry-baseline-v1/model.json
artifacts/pose-classification/models/geometry-baseline-v1/metrics.json
```

最终使用与 Softmax v3 相同的视频级数据索引和每视频最多 400 帧抽样。阈值在 train/val 的 5,366 帧上从 864 组可解释候选中选择，测试集 1,687 帧只在模型冻结后评估。

测试集结果：

```text
accuracy = 0.303497
macro-F1 = 0.230931
rejection_rate = 0.173088
known_rejection_rate = 0.162345
```

Softmax v3 在同一测试划分上的 macro-F1 为 0.712562。几何基线不建议作为比赛主分类器，但建议保留为透明对照、标签诊断和可解释证据来源。

当前任务按用户限定范围保持无状态，没有接入持续时间累计或实时平滑，也未修改 `posture.py`、`runtime_server.py`、`transitions.py` 或 `pyproject.toml`。若后续需要生成完整 `PostureObservation`，应单独建立运行时 Adapter 任务，并继续保证当前帧 `unknown` 不被历史状态覆盖。
