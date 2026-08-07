# 训练脚本

该目录保存可重复执行的训练与参数扫描入口。恢复的历史模型位于 `models/trained/`，脚本默认不会覆盖这些模型；新训练结果写入 Git 忽略的 `artifacts/training/`，经过人工验收后再决定是否提升到稳定模型目录。

当前脚本：

- `run-posture-sweep.sh`：对姿态 Softmax 基线执行固定 seed 与学习率扫描。
- `run-edge-int8-day1.sh`：下载并审计官方 MoveNet Lightning INT8 v4，使用本地原始视频重新提取关键点，执行 12 组姿态扫描和 3 组跌倒 MIL 训练。所有结果写入新的 `artifacts/training/edge-int8/` 时间戳目录，不覆盖 `models/trained/` 中的历史模型。
- `edge_int8_refine.py`：在第一轮 INT8 数据集上执行逐视频留一验证，比较全特征、无头部身体特征、保留鼻子的身体/核心特征和纯几何特征；最终选模只允许使用保留鼻子的方案，再使用选中的姿态头重提跌倒样本并训练 3 个 MIL 随机种子。
- `export_edge_bundle.py`：把 INT8 MoveNet、保留鼻子的 INT16 姿态头和 INT16 跌倒头导出为可校验 bundle，并在现有姿态样本和全部可用跌倒窗口上执行量化回归与 1 TOPS 运算预算计算。
- `benchmark_edge_bundle.py`：对真实视频运行完整 bundle，并以指定 TOPS 与有效利用率模拟固定计算吞吐，记录实际推理、预算等待、P50/P95 和目标帧率是否通过。该结果不是目标 NPU 的芯片、功耗或编译器实测。
- `evaluate_local_fall_runtime.py`：把留出跌倒片段和正常动作视频逐帧回放到完整关键点、姿态、确定性转变和连续跌倒状态机，统计实际 `fall_like_transition` 触发、误报与重复事件；支持 `--case-id` 定向复测。工程门槛仅用于本地演示稳定性，不是医学或真人准确率标准。

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

第一轮完成后可执行逐视频留一验证。最终候选保留 `nose` 作为头部代理点，排除双眼和双耳：

```bash
uv run --extra pose python scripts/training/edge_int8_refine.py \
  --source-run artifacts/training/edge-int8/day1-manual-run \
  --output-dir artifacts/training/edge-int8/refine-loso-manual-run
```

导出紧凑端侧包：

```bash
uv run --extra pose python scripts/training/export_edge_bundle.py \
  --source-run artifacts/training/edge-int8/refine-loso-manual-run \
  --output-dir artifacts/training/edge-int8/bundle-manual-run
```

导出器会保留失败结果并拒绝覆盖非空目录。姿态或跌倒量化出现任何最终决策分歧时，bundle 的 `deployment_status` 会标记为失败；当前推荐结构是 INT8 关键点网络加 INT16 下游线性头。

以 1 TOPS、10% 有效利用率运行 30 FPS 仿真：

```bash
uv run --extra pose python scripts/training/benchmark_edge_bundle.py \
  --bundle artifacts/training/edge-int8/bundle-manual-run \
  --video 'data/training/pose/raw/downloads6/01 - 【日常动作】[伸懒腰][伸展运动].mp4' \
  --target-fps 30 \
  --max-frames 300 \
  --threads 1 \
  --tops 1 \
  --effective-utilization 0.1 \
  --output artifacts/training/edge-int8/bundle-manual-run/benchmark.json
```

本机完整跌倒链路回放。运行时每 250 ms 连续评估最近窗口；MIL 只提供模型证据，缺少中心下降、冲击和低位结构确认时不会单独升级事件：

```bash
uv run --extra pose python scripts/training/evaluate_local_fall_runtime.py \
  --bundle artifacts/training/edge-int8/bundle-manual-run \
  --fall-manifest artifacts/training/edge-int8/refine-loso-manual-run/inputs/fall-clip-manifest.local.json \
  --normal-index artifacts/training/edge-int8/day1-manual-run/pose-int8-dataset/dataset-index.json \
  --sample-fps 12 \
  --threads 1 \
  --splits val test \
  --output artifacts/training/edge-int8/local-fall-eval/report.json
```

针对单个误报或漏检 case 复测：

```bash
uv run --extra pose python scripts/training/evaluate_local_fall_runtime.py \
  --bundle artifacts/training/edge-int8/bundle-manual-run \
  --fall-manifest artifacts/training/edge-int8/refine-loso-manual-run/inputs/fall-clip-manifest.local.json \
  --normal-index artifacts/training/edge-int8/day1-manual-run/pose-int8-dataset/dataset-index.json \
  --sample-fps 24 \
  --splits val test \
  --case-id fall-004 \
  --case-id d6-lying-down-25 \
  --output artifacts/training/edge-int8/local-fall-debug/report.json
```


该流程会读取 `data/training/` 下已经归档的原始视频和标注，旧 FP16 MoveNet、历史姿态模型、MIL v1–v3 均保持不变。输出中的姿态指标仍是弱标签验证结果；跌倒模型只允许用于弱监督候选选择，在人工事件复核完成前不得报告跌倒 precision、recall、F1 或医学级结论。
