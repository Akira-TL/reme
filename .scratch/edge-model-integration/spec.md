# 1 TOPS 端侧感知路线评估

- 状态：方案评估完成，暂不实施模型合包
- 日期：2026-08-06
- 分支：`refactor/structure`

## 1. 实际活动模型

当前正式或候选链路中的模型资产分为三层：

1. **关键点提取前级**
   - MediaPipe Pose Landmarker Lite `.task`：内部实际包含两个 TFLite 子模型：
     - `pose_detector.tflite`：2,959,078 bytes
     - `pose_landmarks_detector.tflite`：2,818,390 bytes
   - MoveNet SinglePose Lightning FP16：4,758,512 bytes
   - MediaPipe 与 MoveNet 是替代方案，不应在正式端侧链路同时运行。
2. **静态姿态头**
   - 68 维输入、4 类 Softmax，276 个线性参数；另有拒判质心。
3. **跌倒时序头**
   - 31 维窗口特征、1 个逻辑回归输出，32 个线性参数。

历史目录中的多组 posture sweep 和 MIL v1/v2 是训练检查点，不是运行时同时加载的模型。

## 2. 远端模型核对

远端仓库：`akira@192.168.100.102:/home/akira/Projects/reme`

远端没有额外隐藏的姿态网络或 INT8 版本。下列资产与本地 SHA-256 完全一致：

- MediaPipe task：`59929e1d...d574a`
- 姿态 Softmax：`83015f9d...a654`
- 跌倒 MIL v3：`bafe306b...96559c`

远端没有 MoveNet TFLite；本地 FP16 MoveNet 是后来恢复的运行时资产。

## 3. 模型图实测

通过 LiteRT 读取 TFLite 图并按卷积输出形状估算 MAC：

| 模型 | 输入 | MAC/次 | 乘加按 2 ops | 本机单线程平均 |
|---|---:|---:|---:|---:|
| MoveNet Lightning FP16 | 192×192 | 270.55 M | 0.541 GOP | 2.969 ms |
| MediaPipe detector | 224×224 | 429.86 M | 0.860 GOP | 4.951 ms |
| MediaPipe landmark | 256×256 | 197.82 M | 0.396 GOP | 6.244 ms |
| MediaPipe 两级合计 | — | 627.68 M | 1.255 GOP | 约 11.2 ms |

在 30 FPS 下：

- MoveNet 理论需求约 `0.0162 TOPS`；
- MediaPipe 两级每帧都运行时约 `0.0377 TOPS`；
- 姿态头与跌倒头的计算量相对可忽略。

因此“层数太多导致无法放进 1 TOPS”不是当前主要风险。

## 4. 真正阻塞项

当前三个视觉 TFLite 图中的卷积和深度卷积实际 operand/result 都是 `float32`。MoveNet 文件虽然使用 FP16 权重压缩，但运行时先反量化到 FP32。

多数标称 1 TOPS 的端侧 NPU以 INT8 峰值作为指标，因此：

- 不能拿当前 FP32 图直接用 `1 TOPS` 数字估算真实 NPU 性能；
- 即使理论运算量足够，也可能因算子、量化方式或 delegate 不支持而全部回落 CPU；
- 在不知道具体芯片、SDK、支持算子和内存带宽前，不能声称已经适配 1 TOPS。

## 5. 推荐新路线

### 路线 A：推荐

```text
摄像头
  → 单阶段全整型 INT8 关键点模型（唯一 NPU 模型）
  → 17 点关键点
  → 固定点几何特征 + 极小姿态线性头（CPU/MCU）
  → 环形缓冲区 + 固定点跌倒线性头（CPU/MCU）
  → 决策层
```

原则：

- 只保留 MoveNet Lightning 类单阶段模型，不运行 MediaPipe detector + landmark 两级网络；
- 获取或重新导出 **全整型 INT8** 模型，输入和中间张量都应可量化；
- 姿态和跌倒不塞入 NPU 图，继续保持可解释、可调阈值和有状态窗口；
- 模型文件可以做成一个部署包，但不伪称为一个端到端神经网络。

### 路线 B：浏览器演示保留

浏览器比赛演示继续使用 MediaPipe GPU，不作为 1 TOPS 端侧证明。它是桌面/浏览器链路，不等价于端侧 NPU。

## 6. 下一阶段验收顺序

1. 明确目标 1 TOPS 芯片、NPU SDK、可用 delegate 和内存限制；
2. 获取或生成 MoveNet Lightning 全整型 INT8；
3. 对同一视频比较 FP16 与 INT8 的关键点误差、覆盖率和连续性；
4. 用模型图计算实际 MAC，并用目标编译器确认 NPU 覆盖率，禁止 CPU fallback；
5. 在没有真实硬件时，用 `计算预算 + 帧率节流 + 单线程 CPU` 做仿真，但明确这不是真实 1 TOPS 硬件测试；
6. 关键点 Gate 通过后，再把姿态与跌倒头改为 int16/int8 固定点实现并做逐值误差测试。

## 7. 数据风险

模型压缩不会解决当前数据问题：

- 姿态模型验证集没有躺姿样本；
- 验证集弯腰/下蹲 F1 约 0.009852；
- 跌倒 MIL 是弱监督模型，训练报告明确禁止报告 fall precision/recall/F1。

因此必须把“端侧可运行”与“分类准确可靠”分开验收。
