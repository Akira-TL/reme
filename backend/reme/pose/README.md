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
├── review.py            # 原视频与 MotionBERT Three.js 三维骨架验收页
├── review_server.py     # 支持视频 Range 请求的本地验收服务器
├── annotations.py       # 姿态和转变标注（后续 Ticket）
├── features.py          # 可解释几何特征（后续 Ticket）
├── posture.py           # 静态姿态分类（后续 Ticket）
└── transitions.py       # 静止与动作转变（后续 Ticket）
```

跨角色字段必须遵循 `.scratch/abc-interface/spec.md`。实验产物放入被 Git 忽略的 `artifacts/pose-classification/`，不得将大型视频、模型或逐帧结果提交到 Git。

兼容入口 `reme.scene_bundle` 暂时保留；新代码和新测试应直接使用 `reme.pose.*`。

## MotionBERT 可重复重建

MotionBERT 3D 结果不得只保存在 `/tmp`。比赛环境统一使用：

```text
models/motionbert/repo/
models/motionbert/checkpoints/motionbert_ft_h36m.pth
artifacts/pose-classification/scenes/<scene_id>/derived/
```

仓库版本：

```bash
git clone https://github.com/Walter0807/MotionBERT.git models/motionbert/repo
git -C models/motionbert/repo checkout 705d3a95354db8bdb696b3492e47a3b5537174ff
```

checkpoint 期望 SHA-256：

```text
d80af32396c60cf66fa5afb7ef7f7c869ae0851afd3d91a75d55e76c5a62cb23
```

生成持久 3D 源数据：

```bash
/home/akira/.local/share/mamba/envs/DL/bin/python \
  .scratch/motionbert-offline-demo/infer_motionbert.py \
  --keypoints artifacts/pose-classification/extractions/<scene_id>/keypoints.jsonl \
  --motionbert-repo models/motionbert/repo \
  --checkpoint models/motionbert/checkpoints/motionbert_ft_h36m.pth \
  --output artifacts/pose-classification/scenes/<scene_id>/derived/poses3d.source.json \
  --video-name source.mp4 \
  --width 1280 \
  --height 720 \
  --fps 30 \
  --device cuda \
  --window 243 \
  --stride 81 \
  --batch-size 4
```

再由 `reme.pose.review` 校验、转换并安装为共享接口的 `derived/poses3d.json`。CPU 降级时使用 `--device cpu --no-amp`，但必须重新记录运行时间，不能沿用 CUDA 性能数据。
