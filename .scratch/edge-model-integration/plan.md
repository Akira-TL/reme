# Reme 1 TOPS 端侧感知快速实施计划

- 日期：2026-08-06
- 目标分支：`feature/edge-int8`
- 基线：`refactor/structure@dcfc922`
- 优先级：比赛可运行 > 端侧可解释 > 重新训练完整大模型

## 1. 目标架构

```text
摄像头帧
  -> 单阶段全整型 INT8 关键点模型（唯一 NPU 模型）
  -> MoveNet-17 关键点
  -> 姿态线性头 + 几何拒判回退（CPU/MCU）
  -> 跌倒窗口特征 + MIL/线性头（CPU/MCU）
  -> 现有 RuntimeEvent / 决策链路
```

浏览器比赛演示继续保留 MediaPipe GPU；端侧实验使用 INT8 单阶段模型。两条路径输出同一关键点和事件合同，但不互相冒充硬件证明。

## 2. 可使用的数据

### 原始视频

- `data/training/fall/raw/50种摔倒.mp4`
- `data/training/fall/raw/50种摔倒方式 -摔倒检测.mp4`
- `data/training/pose/raw/downloads6/`：57 个日常动作视频
- `data/reference/pose/video_148703662/media/source.mp4`

### 已处理训练资产

- `data/training/pose/processed/downloads6/dataset-index.json`
- 23 个姿态场景的 `keypoints.jsonl + annotations.json`
- `data/training/fall/bootstrap/pose-samples.jsonl`
- `data/training/fall/bootstrap/clip-manifest.json`

## 3. 训练与量化策略

### 3.1 关键点网络

最快方案按优先顺序执行：

1. 获取官方或可信来源的 MoveNet Lightning 全整型 INT8 TFLite；
2. 若没有可用成品，从原始 MoveNet checkpoint 重新导出全整型 INT8；
3. 若直接量化精度损失明显，再做量化感知训练或教师蒸馏。

现有视频可用于：

- representative dataset 校准；
- FP16 教师模型生成伪关键点；
- 暗光、遮挡、跌倒、弯腰、坐姿和躺姿的蒸馏样本；
- 量化前后逐帧一致性评估。

限制：这些视频没有完整人工关键点真值，因此不能仅凭教师一致性宣称真实姿态准确率。需要抽取一个小型人工复核集，至少覆盖站、坐、躺、弯腰、快速下落、遮挡和无人帧。

### 3.2 姿态头

基于现有 23 个场景重新训练，而不是沿用当前弱验证结果：

- 按视频分组切分，禁止同一视频帧进入不同 split；
- 增加关键点抖动、坐标量化、随机缺点和置信度退化；
- 补强躺姿与弯腰验证集；
- 保留 `unknown` 和几何回退；
- 训练后导出 float 基线与 int16/int8 固定点参数；
- 逐样本比较量化前后类别、置信度和拒判结果。

### 3.3 跌倒头

继续使用时序窗口，不把跌倒改成单帧分类：

- 重新处理两段跌倒视频；
- 将普通坐下、躺下、跪下、俯卧撑、弯腰和快速运动作为 hard negatives；
- 保持按原视频/事件分组切分；
- MIL 只作为候选增强，确定性安全规则继续保留；
- 在人工复核测试集完成前，不报告 fall precision/recall/F1。

## 4. 快速实施阶段

### Gate A：INT8 模型合法性

交付：

- `models/runtime/edge/pose_int8.tflite`
- 模型来源、SHA-256、输入输出 dtype；
- TFLite 算子清单；
- 所有卷积/深度卷积的输入、权重和输出 dtype；
- 禁止“只有权重量化、运行仍是 FP32”的伪 INT8。

通过条件：模型能被 LiteRT 加载，输入/核心卷积满足全整型部署要求，输出可以稳定映射到 MoveNet-17。

### Gate B：关键点等价性

在同一批视频帧上同时运行 FP16 与 INT8：

- 人体检测覆盖一致性；
- 关键点坐标差异；
- 关键点置信度差异；
- 躯干覆盖率；
- 帧间抖动和缺点连续性；
- 可视化抽样复核。

这些指标是量化回归指标，不是人体姿态真实准确率。

### Gate C：端侧运行时接入

- 新增 `EdgePoseEstimator`，不得改变现有 RuntimeEvent schema；
- 支持显式选择 `mediapipe_gpu / movenet_fp16 / movenet_int8`；
- Debug 面板显示模型、dtype、推理后端、平均/P95 延迟和 fallback；
- INT8 失败时明确失败，不静默回退并伪称端侧 NPU。

### Gate D：姿态与跌倒头量化

- 重新训练姿态头并修复验证集缺口；
- 将姿态和跌倒参数导出为固定点部署格式；
- 对现有 Python float 实现做逐值 parity 测试；
- 端侧部署包只包含一个视觉网络和两个极小参数头。

### Gate E：1 TOPS 预算实验

在没有真实 1 TOPS 芯片时只做预算仿真：

- 根据模型图统计每帧 ops；
- 设置 `1e12 ops/s` 与可配置有效利用率；
- 约束帧率、单线程后处理和内存队列；
- 记录端到端 P50/P95、积压、丢帧与事件延迟；
- 明确标记为模拟，不作为真实 NPU 结论。

拿到目标芯片 SDK 后追加：

- 编译器算子覆盖报告；
- NPU/CPU 分段情况；
- 实际功耗、温度、持续帧率和 P95；
- 禁止 CPU fallback 后重新验收。

## 5. 并行任务

### 主任务：Edge INT8

只修改：

- `backend/reme/runtime/perception/`
- `models/runtime/edge/`
- `scripts/edge/` 或 `scripts/tools/`
- 对应 tests、实验文档

不修改典型场景视觉样式。

### 并行任务：Frontend Demo Polish

独立 worktree 与分支：`feature/frontend-demo-polish`。

只修改 `frontend/` 和必要的前端说明，保持后端 HTTP/WS/Event schema 不变。具体任务见该 worktree 的 `.scratch/frontend-demo-polish/spec.md`。

## 6. 最短交付顺序

1. INT8 模型获取/转换与合法性检查；
2. FP16/INT8 同视频回归；
3. 接入独立 INT8 estimator；
4. 重新训练并量化姿态头；
5. 重新处理跌倒视频和 hard negatives；
6. 运行 1 TOPS 预算仿真；
7. 最后合并前端演示优化。

任何 Gate 失败都保留上一条可运行链路，不阻塞比赛演示。
