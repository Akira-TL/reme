# A 姿态感知工作目录

`backend/reme/pose/` 是成员 A 的正式后端实现目录，负责从本地视频和人体关键点中生成可验证、可复现的动作事实。

## 负责范围

- 场景数据包与共享接口校验；
- 2D/3D 关键点适配；
- 姿态标注读取与数据划分；
- 静态姿态特征、基线和分类器；
- 静止状态与动作转变候选；
- A 向 B/C 的离线结果生成与验收。

## 不负责范围

- MiMo 调用、隐私推理和关怀决策；
- 老人询问、家属通知和风险状态机；
- Web 页面、骨架渲染和现场交互；
- PPT、产品叙事和路演材料。

## 模块规划

```text
reme.pose
├── scene_bundle.py      # SceneManifest 与 FrameLandmarks 数据包
├── review.py            # 原视频与骨架同步视觉验收页
├── annotations.py       # 姿态和转变标注（后续 Ticket）
├── features.py          # 可解释几何特征（后续 Ticket）
├── posture.py           # 静态姿态分类（后续 Ticket）
└── transitions.py       # 静止与动作转变（后续 Ticket）
```

跨角色字段必须遵循 `.scratch/abc-interface/spec.md`。实验产物放入被 Git 忽略的 `artifacts/pose-classification/`，不得将大型视频、模型或逐帧结果提交到 Git。

兼容入口 `reme.scene_bundle` 暂时保留；新代码和新测试应直接使用 `reme.pose.*`。
