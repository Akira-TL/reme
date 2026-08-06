# 训练脚本

该目录保存可重复执行的训练与参数扫描入口。恢复的历史模型位于 `models/trained/`，脚本默认不会覆盖这些模型；新训练结果写入 Git 忽略的 `artifacts/training/`，经过人工验收后再决定是否提升到稳定模型目录。

当前脚本：

- `run-posture-sweep.sh`：对姿态 Softmax 基线执行固定 seed 与学习率扫描。
- `run-edge-int8-day1.sh`：下载并审计官方 MoveNet Lightning INT8 v4，使用本地原始视频重新提取关键点，执行 12 组姿态扫描和 3 组跌倒 MIL 训练。所有结果写入新的 `artifacts/training/edge-int8/` 时间戳目录，不覆盖 `models/trained/` 中的历史模型。
- `edge_int8_refine.py`：在第一轮 INT8 数据集上执行逐视频留一验证，比较全特征、去面部身体特征和纯几何特征，再使用选中的姿态头重提跌倒样本并训练 3 个 MIL 随机种子。

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

姿态扫描脚本使用 `uv run --extra pose python -m reme.runtime.perception.posture`，不会下载或生成缺失的数据集。训练前应确认数据来源和标签适合当前实验，训练指标不得直接表述为真人场景准确率。

INT8 一日训练入口：

```bash
bash scripts/training/run-edge-int8-day1.sh
```

也可以指定新的归档目录：

```bash
bash scripts/training/run-edge-int8-day1.sh \
  artifacts/training/edge-int8/day1-manual-run
```

第一轮完成后可执行逐视频留一验证：

```bash
uv run --extra pose python scripts/training/edge_int8_refine.py \
  --source-run artifacts/training/edge-int8/day1-manual-run \
  --output-dir artifacts/training/edge-int8/refine-loso-manual-run
```

该流程会读取 `data/training/` 下已经归档的原始视频和标注，旧 FP16 MoveNet、历史姿态模型、MIL v1–v3 均保持不变。输出中的姿态指标仍是弱标签验证结果；跌倒模型只允许用于弱监督候选选择，在人工事件复核完成前不得报告跌倒 precision、recall、F1 或医学级结论。
