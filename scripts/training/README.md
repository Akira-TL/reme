# 训练脚本

该目录保存可重复执行的训练与参数扫描入口。恢复的历史模型位于 `models/trained/`，脚本默认不会覆盖这些模型；新训练结果写入 Git 忽略的 `artifacts/training/`，经过人工验收后再决定是否提升到稳定模型目录。

当前脚本：

- `run-posture-sweep.sh`：对姿态 Softmax 基线执行固定 seed 与学习率扫描。

默认输入：

```text
data/training/pose/processed/downloads6/dataset-index.json
```

默认输出为带时间戳的目录：

```text
artifacts/training/posture/posture-sweep-YYYYMMDD-HHMMSS/
```

运行：

```bash
scripts/training/run-posture-sweep.sh
```

也可以显式传入数据索引和输出目录：

```bash
scripts/training/run-posture-sweep.sh \
  data/training/pose/processed/downloads6/dataset-index.json \
  artifacts/training/posture/my-sweep
```

脚本使用 `uv run --extra pose python -m reme.runtime.perception.posture`，不会下载或生成缺失的数据集。训练前应确认数据来源和标签适合当前实验，训练指标不得直接表述为真人场景准确率。
