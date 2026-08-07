# 鼻子保留端侧模型与 1 TOPS 预算实验

- 日期：2026-08-06
- 分支：`feature/edge-int8`
- 状态：软件量化 Gate 与算力预算 Gate 通过；目标 NPU 尚未验证
- 前端：未修改

## 1. 头部节点策略

MoveNet 仍输出标准 COCO 17 点以保持运行时事件合同兼容。姿态分类头不再使用双眼和双耳，只保留 `nose` 作为头部代理点。

最终候选 `nose_body_geometry` 使用：

- 鼻子；
- 双肩、双肘、双腕；
- 双髋、双膝、双踝；
- 17 个几何特征。

最终活动特征数为 56。双眼、双耳在紧凑姿态头中没有活动权重。

## 2. 鼻子保留逐视频留一结果

归档：

```text
artifacts/training/edge-int8/refine-nose-loso-20260806-1340
```

选中配置：

- 模式：`nose_body_geometry`
- seed：2026
- learning rate：0.01
- OOF accuracy：0.581171
- OOF macro-F1：0.518116
- 最弱已知类 F1：0.342913

完全去掉头部的 `body_geometry` 基线 macro-F1 为 0.531654，因此保留鼻子带来约 0.0135 的 macro-F1 下降，但满足头部跟踪要求。该指标仍是动画视频和文件名弱标签的逐视频留一结果，不能表述为真人场景准确率。

## 3. 固定点导出迭代

以下归档均保留，未删除：

1. `bundle-nose-20260806-1350`
   - 姿态 INT8 头在 7,053 个抽样特征上有 27 个最终预测分歧；
   - 跌倒 INT8 头在 36,019 个窗口上有 1 个阈值分歧；
   - 作为失败对照保留。
2. `bundle-nose-int16-20260806-1400`
   - 抽样 Gate 为零分歧；
   - 但遍历全部 22,255 帧时发现 1 个置信度阈值边界分歧；
   - 作为边界版本保留。
3. `bundle-nose-int16-v3-20260806-1415`
   - 姿态权重改为逐输入特征 INT16 尺度；
   - 导出 Gate 遍历全部持久化关键点记录；
   - 为当前推荐 bundle。

## 4. 推荐 bundle

```text
artifacts/training/edge-int8/bundle-nose-int16-v3-20260806-1415/
├── manifest.json
├── verification.json
├── one-tops-budget.json
├── models/
│   ├── pose_int8.tflite
│   ├── posture_head.int16.json
│   └── fall_head.int16.json
└── reference/
    ├── posture_head.float.json
    └── fall_head.float.json
```

模型大小：

| 组件 | 大小 |
|---|---:|
| INT8 MoveNet | 2,894,840 bytes |
| INT16 姿态头 | 14,074 bytes |
| INT16 跌倒头 | 3,790 bytes |

量化回归：

| Gate | 样本 | 最大概率误差 | 最终分歧 |
|---|---:|---:|---:|
| 姿态 | 22,255 帧 | 0.001112487 | 0 |
| 跌倒 | 36,019 窗口 | 0.000055381 | 0 |

运行时加载器再次逐帧比较浮点参考与紧凑姿态头：22,255 帧标签分歧为 0，四舍五入后的最大概率差为 0.000279。

bundle 状态：

```text
budget_and_quantization_gate_passed_target_npu_unverified
```

## 5. 运行时接入

新增 `reme.runtime.perception.edge_bundle`：

- 校验 bundle manifest 和 SHA-256；
- 防止模型路径逃逸 bundle 根目录；
- 加载保留鼻子的紧凑姿态头；
- 加载紧凑跌倒头；
- 原有浮点 JSON 模型继续兼容；
- 只有显式传入 bundle 模型路径时才启用紧凑模型。

现有 CLI 可直接使用：

```bash
BUNDLE=artifacts/training/edge-int8/bundle-nose-int16-v3-20260806-1415
uv run --extra pose python -m reme.runtime.server \
  --input-adapter local_camera \
  --movenet-model "$BUNDLE/models/pose_int8.tflite" \
  --posture-model "$BUNDLE/models/posture_head.int16.json" \
  --fall-mil-model "$BUNDLE/models/fall_head.int16.json"
```

## 6. 1 TOPS 预算

每帧估算：

- MoveNet：541,099,008 ops；
- 姿态线性头：448 ops；
- 跌倒线性头：每窗口 62 ops。

30 FPS 理论需要约 0.016233 TOPS，占 1 TOPS 的 1.6233%。

### 0.1 TOPS 有效吞吐

1 TOPS、10% 有效利用率，相当于 0.1 TOPS，理论服务时间 5.41099 ms。

| 视频 | 目标 | 服务 P95 | 结果 |
|---|---:|---:|---|
| 站立/伸展 | 30 FPS | 5.41099 ms | 通过 |
| 躺下 | 30 FPS | 6.373684 ms | 通过 |
| 跌倒合集 | 24 FPS | 5.41099 ms | 通过 |

躺下视频人体检测覆盖率为 0.82，分类中 `unknown` 较多；这是感知质量问题，不是算力超限。

### 计算边界

同一站立视频：

| 有效吞吐 | 理论最大 FPS | 服务 P95 | 30 FPS |
|---:|---:|---:|---|
| 0.02 TOPS | 36.961812 | 27.05495 ms | 通过 |
| 0.015 TOPS | 27.721359 | 36.073267 ms | 按预期失败 |

因此该图在纯运算预算下的 30 FPS 边界约为 0.01623 TOPS。该实验使用软件计时和理论固定吞吐节流，不是目标 NPU 的编译器覆盖、内存、功耗、温度或硅片实测。

## 7. 声明边界

- 鼻子只是 2D 头部代理点，不是头部姿态角模型；
- 眼睛和耳朵只从下游分类特征移除，MoveNet 骨干仍输出标准 17 点；
- 当前 bundle 通过软件量化与算力预算 Gate，不代表已适配某个具体 1 TOPS NPU；
- 跌倒模型仍是弱监督候选增强器，不得报告跌倒 precision、recall、F1 或医疗级结论；
- 当前姿态数据仍存在域偏差和弱标签问题，不自动替换比赛演示默认模型。

## 8. 工程检查

- Ruff：通过；
- Python `compileall`：通过；
- 端侧专项测试：42 passed；
- 全量测试：575 passed、25 个既有决策合同失败；
- `frontend/` Git 差异：空；
- 历史 FP16 MoveNet、姿态模型和 MIL v3 的 SHA-256 与训练前一致；
- 当前环境未提供 `mypy` 可执行文件，因此本轮无法执行静态类型检查；运行时协议和紧凑模型加载由专项测试覆盖。
