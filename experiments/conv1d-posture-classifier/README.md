# MoveNet17 + Conv1D 姿态分类复现原型

> **边界：**这是依据论文公开描述编写的独立复现原型，不是作者官方代码，也不是对论文网络层数和超参数的逐项精确复刻。

## 论文与代码状态

论文：*From Keypoints to Actions: Real-Time Motion Analysis Using MoveNet and Lightweight Conv1D Networks*

- DOI：<https://doi.org/10.1142/S0219519426500272>
- 成大成果页：<https://researchoutput.ncku.edu.tw/en/publications/from-keypoints-to-actions-real-time-motion-analysis-using-movenet/>
- 截至 2026-08-01，使用完整标题、DOI、作者姓名和 `MoveNet Conv1D Triplet-Center Loss` 检索 GitHub/GitLab，未发现作者公开仓库。
- 成大成果页的 `Other files and links` 仅包含 DOI 与 Scopus，没有 GitHub、数据或补充材料链接。

论文公开方法可以确定的部分是：

1. MoveNet 提取 17 个关节坐标；
2. 将关键点序列输入轻量 Conv1D 网络；
3. 使用分类损失和 Triplet-Center Loss 增强类别分离；
4. 论文数据包含 23 个分解动作，但与 Reme 的姿态标签不相同。

作者未公开的层数、通道数、窗口长度、采样率、归一化方式、Triplet-Center Loss 权重等，必须在 Reme 数据上重新标定。

## 本原型做了什么

- 直接读取当前 MoveNet runner 生成的 `movenet-17/v0-experiment` JSONL；
- 以髋中点为根节点，髋不可用时回退到肩中点或可见点均值；
- 使用肩髋距离或可见骨架范围做尺度归一化；
- 保留 17 个关键点的 `x / y / confidence`，输入形状为 `[batch, time, 17, 3]`；
- Conv1D 编码后输出 L2 归一化 embedding 和分类 logits；
- 总损失为 `CrossEntropy + center_weight × TripletCenterLoss`；
- CSV 按连续时间段指定 `train / val / test`，避免随机打散相邻帧造成数据泄漏。

## 文件

```text
model.py                 Conv1D 分类器、Triplet-Center Loss、联合目标函数
dataset.py               JSONL 读取、归一化、时间窗与分段数据集
train.py                 训练、验证、混淆矩阵、macro-F1、checkpoint
infer.py                 对完整关键点序列滑窗分类并输出 JSONL
annotations.example.csv  标注格式示例
requirements.txt         独立依赖
```

## 环境

当前项目 `.venv` 尚未安装 PyTorch。机器已有 `DL` Conda 环境，实测为 PyTorch 2.10.0 + CUDA 13.0，可直接运行：

```bash
conda run -n DL python \
  experiments/conv1d-posture-classifier/train.py \
  --dry-run --device cuda
```

需要隔离环境时再新建虚拟环境：

```bash
python3 -m venv experiments/conv1d-posture-classifier/.venv
experiments/conv1d-posture-classifier/.venv/bin/pip install \
  -r experiments/conv1d-posture-classifier/requirements.txt
```

CUDA 版本的 PyTorch 应按机器 CUDA 驱动选择官方安装命令，不要盲目使用 CPU wheel 或固定 CUDA wheel。

## 模型烟雾测试

安装依赖后运行一次合成数据前向和反向传播：

```bash
experiments/conv1d-posture-classifier/.venv/bin/python \
  experiments/conv1d-posture-classifier/train.py \
  --dry-run \
  --device cuda
```

没有 CUDA 时改成 `--device cpu`。

## 标注

复制示例文件后，按视频连续片段填写：

```bash
cp experiments/conv1d-posture-classifier/annotations.example.csv \
  experiments/conv1d-posture-classifier/annotations.csv
```

CSV 格式：

```csv
start_ms,end_ms,label,split
0,10000,standing,train
10000,20000,sitting,val
```

推荐标签仍采用项目 feasibility Gate：

- `standing`
- `sitting`
- `lying`
- `bending_or_crouching`
- `unknown`

正常动作转变和跌倒式转变应另外建立时序事件标注，不要把单帧 `lying` 当作跌倒。

## 训练

使用当前最佳 MoveNet 跟踪裁剪输出：

```bash
experiments/conv1d-posture-classifier/.venv/bin/python \
  experiments/conv1d-posture-classifier/train.py \
  --keypoints /tmp/reme-litert-lightning-f16-tracking-full/keypoints.jsonl \
  --annotations experiments/conv1d-posture-classifier/annotations.csv \
  --output-dir artifacts/conv1d-posture \
  --window-frames 60 \
  --stride-frames 15 \
  --device cuda
```

默认窗口为 60 帧，即当前 30 FPS 视频约 2 秒。这个值不是论文已核实参数，应比较 30、45、60、90 帧窗口。

## 推理

```bash
experiments/conv1d-posture-classifier/.venv/bin/python \
  experiments/conv1d-posture-classifier/infer.py \
  --keypoints /tmp/reme-litert-lightning-f16-tracking-full/keypoints.jsonl \
  --checkpoint artifacts/conv1d-posture/best.pt \
  --output artifacts/conv1d-posture/predictions.jsonl \
  --min-confidence 0.6 \
  --device cuda
```

`--min-confidence` 以下的窗口会拒判为 `unknown`，但阈值必须在验证集上校准。

## 验收要求

该模型只有在以下条件满足后才可称为 Reme 姿态分类基线：

1. 标注覆盖视频中实际发生的站、坐、躺、弯腰/下蹲与未知片段；
2. 训练、验证、测试按连续片段或不同人物划分，而不是随机帧划分；
3. 报告每类 precision、recall、F1、混淆矩阵和拒判率；
4. 与几何规则、XGBoost/小型 MLP 基线使用同一划分比较；
5. 不引用论文的 92% 测试准确率作为本项目指标。
