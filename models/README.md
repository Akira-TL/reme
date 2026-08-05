# Reme 模型目录

该目录只定义模型资产的稳定落位，不代表所有模型已经放入仓库。

## 目录约定

```text
models/
├── runtime/
│   ├── movenet/      # A 侧运行时 MoveNet / LiteRT 权重
│   └── mediapipe/    # C 侧浏览器运行时 MediaPipe 模型
├── trained/
│   ├── posture/      # 姿态分类训练产物
│   └── fall/         # 跌倒与转变分类训练产物
└── vendor/           # 外部仓库、检查点或第三方模型
```

## 当前迁移状态

2026-08-05 已完成运行时与训练模型归档：

- `models/runtime/movenet/`：比赛仓库跟踪的 MoveNet Lightning 权重及来源说明；
- `models/trained/posture/`：4 个姿态 Softmax 版本，以及 12 组 `posture-sweep-20260801` 训练组合；
- `models/trained/fall/`：MIL v1、v2、v3 模型与对应训练报告。

MoveNet 的大小、张量合同和 SHA-256 见 `models/runtime/movenet/README.md`。训练模型只存在于本地工作区并受 `.gitignore` 管理，其完整 SHA-256 台账见 `docs/assets/training-models.sha256`。

当前运行时默认路径：

- `models/runtime/movenet/movenet_lightning_f16_v4.tflite`
- `frontend/public/mediapipe/pose_landmarker_lite.task`
- `models/trained/posture/posture-sweep-20260801/seed-42-lr-0.04/model.json`
- `models/trained/fall/mil-v3/model.json`

后续修改或替换运行时模型时，必须同时更新：

1. 后端或前端默认路径；
2. 构建复制脚本；
3. README 与快速启动文档；
4. 模型来源、大小和 SHA-256 记录；
5. 缺失模型时的降级说明。

## Git 规则

目录结构和说明文件进入 Git；训练检查点、逐帧数据及大型派生产物默认不进入 Git。比赛演示已经明确纳入的 MoveNet 权重和浏览器 MediaPipe `.task` 文件继续由 Git 跟踪，移动或替换时必须保留来源记录并重新校验哈希。
