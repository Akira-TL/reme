# 静态姿态几何基线评估报告

- Date: 2026-08-01
- Owner: A
- Branch: `feature/a-geometry-baseline`
- Evidence level: `weak_label_bootstrap`
- Dataset: `downloads6-animation-bootstrap-v2`
- Model schema: `reme-posture-geometry/v1-experiment`
- Result: **不建议作为当前比赛主分类器；建议保留为可解释对照、诊断工具和后续规则证据来源**

## 1. 目标与边界

本次实现建立了独立于当前 Softmax 分类器的静态姿态几何规则基线。该基线没有读取 Softmax 权重、类别中心或预测结果，也没有把 Softmax 包装成规则模型。

输入继续使用 MoveNet 17 点 `FrameLandmarks`。规则只使用可直接解释的几何量：

- 肩部中点到髋部中点的躯干方向；
- 人体可见关键点包围盒宽、高和宽高比；
- 双肩连线与双髋连线方向；
- 髋、膝、踝的垂直相对位置；
- 左右膝关节角度及均值；
- 人体包围盒中心在画面中的高度；
- 全部关键点和核心下肢关键点的可见比例。

输出支持：

```text
standing
sitting
lying
bending_or_crouching
unknown
```

模型是无状态的。人体未检出、核心关键点不足、规则证据不足或两个最高规则分数冲突时，当前帧直接返回 `unknown`，不会沿用上一帧标签。

## 2. 数据与划分

复用当前 Softmax 模型使用的同一个数据索引：

```text
/home/akira/Projects/reme/artifacts/pose-classification/datasets/downloads6/dataset-index.json
```

保持完全相同的视频级 train / val / test 划分，并保持每个视频最多均匀抽样 400 帧：

| Split | 抽样帧数 |
|---|---:|
| train | 4,231 |
| val | 1,135 |
| test | 1,687 |
| total | 7,053 |

阈值候选只使用 train / val 选择。测试集不参与阈值生成、候选排序或规则权重调整。最终模型记录：

```json
{
  "calibration_splits": ["train", "val"],
  "test_used_for_calibration": false
}
```

本数据来自 3D 动画动作参考视频，标签主要由文件名和相对时间段推断，未逐帧人工复核。本报告不得解释为真人摄像头准确率、跌倒检测准确率或医疗级指标。

## 3. 规则结构

### 3.1 质量拒判

满足任一条件时直接返回 `unknown`：

- `person_detected = false`；
- 可见关键点比例低于阈值；
- 肩、髋、膝、踝核心点可见比例低于阈值；
- 无法计算躯干方向、膝角或髋膝踝关系。

### 3.2 类别证据

- `standing`：躯干接近直立作为前置条件，再结合膝关节接近伸直、髋膝踝垂直有序、腿部垂直跨度和窄包围盒。
- `sitting`：躯干接近直立作为前置条件，再结合膝关节屈曲、腿部垂直跨度缩短、髋膝高度接近和人体中心高度。
- `lying`：结合躯干接近水平、包围盒变宽、肩线或髋线相对画面水平轴明显旋转。
- `bending_or_crouching`：结合躯干斜向、膝关节屈曲、人体中心降低、腿部垂直跨度和非躺卧包围盒。

各类别输出 `0.0..1.0` 的规则证据分数。最高分低于最小证据阈值时为 `insufficient_evidence`；最高分与次高分间隔不足时为 `conflicting_rules`。

## 4. 校准结果

共比较 864 组候选阈值。候选值来自预定义的可解释范围和 train / val 几何分布分位数；排序目标为 70% validation macro-F1 + 30% train macro-F1，并在同分时优先降低已知类拒判。

最终主要阈值：

| 阈值 | 值 |
|---|---:|
| MoveNet 可见分数 | 0.20 |
| 最低可见关键点比例 | 0.60 |
| 最低核心关键点比例 | 0.75 |
| 直立躯干最大偏角 | 20.0° |
| 躺卧躯干最小偏角 | 55.0° |
| 躺卧包围盒最小宽高比 | 0.434 |
| 躺卧肩/髋线最小旋转角 | 30.0° |
| 站立膝角最小值 | 171.852° |
| 坐姿膝角最大值 | 147.853° |
| 最低规则证据分数 | 0.60 |
| 最低类别分数间隔 | 0.10 |

完整阈值保存在：

```text
artifacts/pose-classification/models/geometry-baseline-v1/model.json
```

## 5. 测试集指标

### 5.1 汇总

| 指标 | 几何基线 |
|---|---:|
| Accuracy | 0.303 |
| Macro-F1 | 0.231 |
| 输出 `unknown` 比例 | 0.173 |
| 已知姿态被拒判比例 | 0.162 |
| 标签抖动次数 | 249 |

测试集 292 次拒判原因：

| 原因 | 帧数 |
|---|---:|
| `insufficient_landmarks` | 198 |
| `conflicting_rules` | 60 |
| `insufficient_evidence` | 34 |

### 5.2 每类指标

| 标签 | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| `standing` | 0.349 | 0.997 | 0.516 | 292 |
| `sitting` | 0.167 | 0.126 | 0.143 | 262 |
| `lying` | 0.101 | 0.155 | 0.122 | 181 |
| `bending_or_crouching` | 0.143 | 0.079 | 0.102 | 152 |
| `unknown` | 0.507 | 0.185 | 0.271 | 800 |

### 5.3 混淆矩阵

行是真值，列是预测，顺序均为：

```text
standing, sitting, lying, bending_or_crouching, unknown
```

```text
[[291,   0,   0,  0,   1],
 [174,  33,   0,  2,  53],
 [ 48,  20,  28, 16,  69],
 [119,   0,   0, 12,  21],
 [203, 145, 250, 54, 148]]
```

## 6. 典型错误视频与时间范围

| 视频 | 时间范围 | 真值 | 预测 | 连续抽样帧 |
|---|---:|---|---|---:|
| `d6-bending-curtsy-15` | 24.224–31.031 s | `bending_or_crouching` | `standing` | 69 |
| `d6-unknown-pushup-34` | 29.700–36.800 s | `unknown` | `lying` | 51 |
| `d6-unknown-pushup-34` | 67.700–74.800 s | `unknown` | `lying` | 51 |
| `d6-unknown-pushup-34` | 48.100–55.000 s | `unknown` | `lying` | 49 |
| `d6-bending-kneel-49` | 85.900–92.300 s | `unknown` | `lying` | 47 |
| `d6-bending-kneel-49` | 63.800–69.900 s | `unknown` | `lying` | 45 |
| `d6-sitting-smile-23` | 77.800–82.000 s | `sitting` | `standing` | 43 |
| `d6-bending-curtsy-15` | 19.520–22.623 s | `bending_or_crouching` | `standing` | 32 |

主要失效模式：

1. 当前弱标签把整段“屈膝礼、躺下、弯腰”等动作视频标成单一静态姿态，实际帧中包含站立起始、动作转变和恢复阶段；几何规则会把这些帧判断为其当下几何状态，而不是文件名动作标签。
2. 俯卧撑与侧躺在单帧 2D 骨架中都可能呈现水平躯干和宽包围盒。没有地面接触、支撑关系或时间信息时，纯静态规则难以稳定区分。
3. 坐姿动画中存在伸腿、盘腿和接近直腿的形态，单一膝角阈值无法覆盖；Softmax 可利用更多相对坐标细节，几何规则不能。
4. 躺卧视频的 MoveNet 核心关键点可见性低于其他类别，质量拒判集中在该类。

完整错误区间保存在 metrics JSON 的 `metrics.test.error_ranges`。

## 7. 与 Softmax v3 的比较

两者使用同一数据索引、同一视频级划分和同一每视频 400 帧上限。

| 指标 | 几何规则 | Softmax v3 |
|---|---:|---:|
| Test Accuracy | 0.303 | 0.745 |
| Test Macro-F1 | 0.231 | 0.713 |
| `standing` F1 | 0.516 | 0.910 |
| `sitting` F1 | 0.143 | 0.720 |
| `lying` F1 | 0.122 | 0.600 |
| `bending_or_crouching` F1 | 0.102 | 0.581 |
| `unknown` F1 | 0.271 | 0.752 |

主要差异：

- 几何基线只有少量人工可读特征和阈值，任何预测都能解释为具体几何证据。
- Softmax 使用 68 维根节点归一化坐标、关键点分数和几何特征，并通过监督训练学习组合边界；其动画域区分能力显著更强。
- 几何基线不保存历史状态，当前帧证据不足立即拒判；Softmax 实时链路可由独立 tracker 做短窗口平滑，但当前帧 `unknown` 同样不会沿用旧标签。
- 几何基线暴露了当前标签与“真实单帧姿态”不一致的问题；Softmax 的较高指标部分可能来自学习动画角色、动作轨迹阶段或高维坐标模式，不能直接外推到真人。

## 8. 固定命令

### 8.1 校准并评估

```bash
uv run python -m reme.pose.geometry calibrate \
  /home/akira/Projects/reme/artifacts/pose-classification/datasets/downloads6/dataset-index.json \
  --model-output artifacts/pose-classification/models/geometry-baseline-v1/model.json \
  --metrics-output artifacts/pose-classification/models/geometry-baseline-v1/metrics.json \
  --max-samples-per-scene 400
```

### 8.2 冻结模型后重新评估

```bash
uv run python -m reme.pose.geometry evaluate \
  artifacts/pose-classification/models/geometry-baseline-v1/model.json \
  /home/akira/Projects/reme/artifacts/pose-classification/datasets/downloads6/dataset-index.json \
  --metrics-output artifacts/pose-classification/models/geometry-baseline-v1/metrics-eval.json \
  --max-samples-per-scene 400
```

### 8.3 单帧解释

```bash
uv run python -m reme.pose.geometry predict \
  artifacts/pose-classification/models/geometry-baseline-v1/model.json \
  path/to/frame-landmarks.json
```

单帧输出包含：

```text
posture
confidence
reason
evidence
features
```

## 9. 自动化测试

`tests/test_pose_geometry.py` 覆盖：

- 几何特征的数值与语义；
- 四类标准姿态规则；
- 关键点不足立即返回 `unknown`，不沿用上一帧；
- 规则冲突拒判；
- 模型保存、加载和 schema 校验；
- 修改测试集不会改变校准后的模型阈值；
- 指标包含拒判率和错误时间范围。

## 10. 比赛路径建议

### 主分类器：不建议

当前几何基线的测试 macro-F1 为 0.231，坐姿、躺卧、弯腰/下蹲和未知动作区分能力不足，不应替换当前 Softmax，也不应作为比赛页面的主要自动姿态标签来源。

### 解释与诊断：建议保留

建议保留以下用途：

- 作为 Softmax 的透明对照基线；
- 在调试页面展示躯干角、膝角、包围盒比例和拒判原因；
- 发现标签与真实单帧姿态不一致的区间；
- 为后续 MiMo 或规则层提供“可解释证据”，但不直接产生关怀决策；
- 真人受控数据完成后，重新校准并判断是否能作为有限类别的降级规则。

进入比赛前仍需使用真人摄像头、逐段人工标注的独立验证集重新比较。动画参考数据不能代表真人准确率。

## 11. 改动边界

本次未修改：

```text
backend/reme/pose/posture.py
backend/reme/pose/runtime_server.py
backend/reme/pose/transitions.py
pyproject.toml
```

静态几何模型没有接入持续时间累计或实时平滑，以保持本票的无状态拒判要求，并避免扩大到被禁止修改的运行时文件。后续若需要把几何模型接入 `PostureObservation`，应另开接口接入任务并继续保证当前帧 `unknown` 不被历史标签覆盖。
