# MoveNet INT8 与端侧分类头训练结果

- 日期：2026-08-06
- 分支：`feature/edge-int8`
- 第一轮归档：`artifacts/training/edge-int8/day1-20260806-1233`
- 留一验证归档：`artifacts/training/edge-int8/refine-loso-20260806-1250`
- 状态：训练与评估完成，暂不提升为默认运行时模型

## 1. 保留与隔离

本轮没有修改或删除：

- `frontend/` 中的任何文件；
- `models/runtime/movenet/movenet_lightning_f16_v4.tflite`；
- `models/trained/posture/` 中的历史姿态模型；
- `models/trained/fall/` 中的 MIL v1、v2、v3；
- `data/training/` 中的原始视频、旧关键点和标注。

全部新模型、关键点、报告和中间数据均写入 Git 忽略的独立 `artifacts/training/edge-int8/` 目录。

## 2. INT8 关键点模型 Gate

使用 TensorFlow Hub 的 MoveNet SinglePose Lightning INT8 v4：

- 文件：`movenet_lightning_int8_v4.tflite`
- SHA-256：`cd7cc22fa946e5d146a7b98d496853e1923e22828d3972d579973f27f91bb105`
- 大小：2,894,840 bytes
- 输入：`uint8 [1, 192, 192, 3]`
- 输出：`float32 [1, 1, 17, 3]`
- 50 个普通卷积和 24 个深度卷积均为整数卷积：int8 输入/权重、int32 bias、int8 输出；
- 图内仍有少量 `QUANTIZE`/`DEQUANTIZE` 和 float32 后处理输出，因此目标 NPU 仍需检查完整算子覆盖率；
- 估算 270,549,504 MAC，约 0.541 GOP/帧；
- 本机单线程 LiteRT：平均 2.078 ms，P95 2.178 ms；
- 按 1 TOPS 的 10% 有效利用率估算，卷积预算约 5.411 ms/帧。

结论：INT8 卷积 Gate 通过；真实 1 TOPS 芯片的 delegate 覆盖率 Gate 尚未执行。

## 3. FP16 与 INT8 回归

在 23 个姿态视频、22,255 个对齐帧上比较归档 FP16 输出与新 INT8 输出：

- 坐标欧氏误差均值：0.010701；
- 坐标误差 P50：0.005309；
- 坐标误差 P95：0.039698；
- 人体检测分歧：316 帧，1.4199%；
- FP16 平均场景人体覆盖率：0.991353；
- INT8 平均场景人体覆盖率：0.988529；
- 归档 FP16 平均推理：4.054 ms；
- 新 INT8 平均推理：1.669 ms。

躺姿视频的检测分歧最多：

- `d6-lying-down-25`：93 帧；
- `d6-lying-goodnight-07`：98 帧。

这些数字是相对于旧 FP16 教师输出的回归差异，不是相对于人工关键点真值的准确率。

## 4. 第一轮姿态训练

基于 INT8 重新提取数据执行 12 组 Softmax 参数扫描，选中：

- seed 42；
- learning rate 0.04；
- 固定验证集 macro-F1 0.577967；
- 固定测试集 macro-F1 0.682612。

固定验证集仍没有躺姿视频，弯腰/下蹲 F1 仍为 0，因此不能据此可靠选模。新模型没有超过历史默认模型，未提升到 `models/trained/`。

## 5. 几何基线

在 INT8 数据上重新校准几何模型：

- 验证 macro-F1：0.348053；
- 测试 macro-F1：0.275529；
- 测试躺姿 F1：0.039409；
- 测试弯腰/下蹲 F1：0.144681。

结论：几何规则可以作为可解释回退，但不能独立替代学习分类头。

## 6. 逐视频留一验证

由于躺姿只有两个视频，固定 train/val/test 不可能在每个 split 都覆盖躺姿。本轮对全部 23 个场景执行 leave-one-video-out：

- 每个 fold 整段视频留出，禁止帧泄漏；
- 比较 68 维全特征、去掉面部的身体+几何特征、仅 17 维几何特征；
- 用全部 out-of-fold 预测选择置信度和距离拒判阈值；
- 选择目标为 `macro-F1 + 0.2 × 最弱已知类别 F1`。

选中 `body_geometry`：

- seed 42；
- learning rate 0.01；
- OOF accuracy：0.593081；
- OOF macro-F1：0.531654；
- 最弱已知类别 F1：0.358919。

OOF 各类：

| 类别 | F1 | Recall | Support |
|---|---:|---:|---:|
| standing | 0.645851 | 0.750672 | 1488 |
| sitting | 0.724230 | 0.762330 | 2129 |
| lying | 0.358919 | 0.458564 | 362 |
| bending_or_crouching | 0.362832 | 0.339779 | 1086 |
| unknown | 0.566438 | 0.456740 | 1988 |

最弱场景包括：

- `d6-unknown-jump-14`：accuracy 0.054；
- `d6-crouching-squats-28`：0.070；
- `d6-bending-bow-04`：0.080；
- `d6-sitting-floor-31`：0.178。

结论：去掉面部特征比全 68 维和纯几何更稳定，但现有动画视频域与标签仍不足以支持稳定姿态分类。该模型只保留为端侧候选，不替换演示默认模型。

## 7. 跌倒 MIL 重训

第一轮和留一验证后的 3 个随机种子均得到相同弱验证结果：

- 弱正 bag 候选率：4/7，0.571429；
- 弱负 bag 告警率：0/4，0；
- 选择分数：0.571429。

训练报告仍保留：

- `event_accuracy_report_allowed=false`；
- 禁止报告跌倒 precision、recall、F1；
- 禁止医疗或保证性跌倒检测表述。

结论：MIL 重训链路跑通，但没有证据表明新模型超过历史 MIL v3，暂不提升为默认模型。

## 8. 决策

当前可确认：

1. 官方 MoveNet Lightning INT8 的主要卷积已全整型化；
2. 本机单线程延迟和理论 1 TOPS 预算有充足余量；
3. 量化引入的关键点差异总体可控，但躺姿覆盖下降需要单独处理；
4. 当前主要瓶颈是数据域、标签质量和场景覆盖，不是模型参数量或 TOPS；
5. 下一 Gate 应是目标 NPU 编译覆盖率与真人场景人工复核，而不是继续盲目增加参数扫描。
