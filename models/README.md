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

本轮只预留目录，不移动现有模型，也不修改运行时默认路径。

当前仍在使用的已知位置：

- `models/movenet/movenet_lightning_f16_v4.tflite`
- `frontend/public/mediapipe/pose_landmarker_lite.task`
- `artifacts/pose-classification/` 下的本地训练模型与数据产物

后续由项目负责人手动确认并移动模型文件。每次迁移必须同时更新：

1. 后端或前端默认路径；
2. 构建复制脚本；
3. README 与快速启动文档；
4. 模型来源、大小和 SHA-256 记录；
5. 缺失模型时的降级说明。

## Git 规则

目录结构和说明文件进入 Git；模型二进制、训练检查点、逐帧数据及大型派生产物默认不进入 Git。已经被明确纳入演示版本的历史模型，在完成迁移决策前保持原状，不擅自删除或重新提交。
