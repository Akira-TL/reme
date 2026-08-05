# 姿态感知模块

`backend/reme/runtime/perception/` 是统一后端中的感知实现目录，负责从实时摄像头或预录视频中生成可验证、可复现的动作事实。它不是独立执行端，由 `reme.runtime.server` 在同一进程内创建并连接决策模块。

## 负责范围

- RuntimeSession 与 RuntimeEvent 合同；
- 当前电脑的单人摄像头实时感知；
- 场景数据包与共享接口校验；
- 2D关键点推理和预录3D关键点适配；
- 姿态标注读取与数据划分；
- 静态姿态特征、基线和分类器；
- 静止状态与动作转变候选；
- 向进程内决策模块和浏览器调试流发布实时事件；
- 离线结果生成与验收。

## 不负责范围

- MiMo 调用、隐私推理和关怀决策；
- 老人询问、家属通知和风险状态机；
- Web 页面、骨架渲染和现场交互；
- PPT、产品叙事和路演材料。

## 模块规划

```text
reme.runtime.perception
├── runtime.py           # C控制的实时/预录会话和事件信封
├── camera.py            # 摄像头采集、实时事件流和性能统计
├── movenet.py           # MoveNet Lightning LiteRT推理与跟踪裁剪
├── scene_bundle.py      # 预录 SceneManifest 与 FrameLandmarks 数据包
├── review.py            # 原视频与 MotionBERT Three.js 三维骨架验收页
├── review_server.py     # 支持视频 Range 请求的本地验收服务器
├── annotations.py       # 姿态片段与转变窗口标注合同
├── video_dataset.py     # 解压视频目录的选择、MoveNet提取和数据索引
├── posture.py           # 68维特征、轻量分类器和unknown拒判
├── posture_runtime.py   # 5–10Hz姿态事件、持续时间与运动等级
└── transitions.py       # 静止与动作转变（后续 Ticket）
```

跨角色字段必须遵循 `.scratch/abc-interface/spec.md`。实验产物放入被 Git 忽略的 `artifacts/pose-classification/`，不得将大型视频、模型或逐帧结果提交到 Git。

兼容入口 `reme.scene_bundle` 暂时保留；新代码和新测试应直接使用 `reme.pose.*`。

## 实时摄像头与 MoveNet

当前开发设备已识别：

```text
/dev/video0  HD Webcam 视频采集节点
/dev/video1  同一设备的辅助节点，不提供普通视频格式
```

推荐摄像头配置：

```text
1280 × 720
30 FPS
MJPG
```

运行依赖当前已安装在项目 `.venv`：

```text
ai-edge-litert 2.1.6
opencv-python-headless 5.0.0.93
numpy 2.4.6
```

将已验证模型放到 Git 忽略目录，例如：

```text
models/movenet/movenet_lightning_f16_v4.tflite
```

持续运行并向标准输出写 RuntimeEvent JSONL：

```bash
.venv/bin/python -m reme.pose.camera \
  --session-id live-camera-001 \
  --scene-id live-camera-001 \
  --camera 0 \
  --model models/movenet/movenet_lightning_f16_v4.tflite \
  --width 1280 \
  --height 720 \
  --fps 30 \
  --score-threshold 0.2 \
  --num-threads 4
```

按 `Ctrl+C` 停止。程序会释放摄像头，并把性能摘要写入标准错误。限定短跑时添加：

```bash
--max-frames 300
```

隐私边界：

- 默认只在内存中读取原始帧；
- 不保存原始帧；
- 不录制原始视频；
- 标准输出仅包含关键点与会话事件；
- C切换或重启session后，A必须停止旧流并释放设备。

当前摄像头取景是否能完整包含双膝和双踝由人工验收决定，不在代码中放宽质量阈值掩盖取景问题。

## 解压视频数据与弱标签训练

动作参考视频直接放在：

```text
artifacts/pose-classification/raw/downloads6/
```

选择清单：

```text
.scratch/pose-classification-owner-a/datasets/downloads6-catalog.json
```

清单只选择代表视频，不会默认处理目录中的全部文件。验证文件存在：

```bash
.venv/bin/python -m reme.pose.video_dataset validate \
  .scratch/pose-classification-owner-a/datasets/downloads6-catalog.json
```

提取 10Hz MoveNet 关键点；已有场景默认复用，只处理新增视频或重写标注：

```bash
.venv/bin/python -m reme.pose.video_dataset extract \
  .scratch/pose-classification-owner-a/datasets/downloads6-catalog.json \
  --model models/movenet/movenet_lightning_f16_v4.tflite \
  --output-dir artifacts/pose-classification/datasets/downloads6
```

训练四类已知姿态，并以置信度和特征距离输出 `unknown`：

```bash
.venv/bin/python -m reme.pose.posture train \
  artifacts/pose-classification/datasets/downloads6/dataset-index.json \
  --model-output artifacts/pose-classification/models/posture-softmax-v3/model.json \
  --metrics-output artifacts/pose-classification/models/posture-softmax-v3/metrics.json \
  --max-samples-per-scene 400
```

该数据来自动画动作参考和文件名弱标签，指标只能用于方案筛选与接口联调，不能作为真人准确率。

实时同时输出关键点和姿态观察：

```bash
.venv/bin/python -m reme.pose.camera \
  --session-id live-camera-001 \
  --scene-id live-camera-001 \
  --camera 0 \
  --model models/movenet/movenet_lightning_f16_v4.tflite \
  --posture-model artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json \
  --posture-hz 7.5
```

`FrameLandmarks` 逐帧输出，`PostureObservation` 以 5–10Hz 输出。下跪、俯卧撑和其他未支持低位动作当前应拒判为 `unknown`。

## 实时网页预览

使用同一个后端摄像头流展示左侧原始画面、右侧 Three.js 节点骨架和姿态分类：

```bash
.venv/bin/python -m reme.pose.live_preview \
  --host 127.0.0.1 \
  --port 8765 \
  --camera 0 \
  --movenet-model models/movenet/movenet_lightning_f16_v4.tflite \
  --posture-model artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json
```

浏览器打开：

```text
http://127.0.0.1:8765/live
```

左侧通过本机 MJPEG 显示内存中的摄像头帧；右侧将同一帧的 MoveNet 2D 关键点映射到可旋转的浅深度 Three.js 空间。该页面明确标记为“展示型3D”，不声称实时 MotionBERT 三维推断。停止服务使用 `Ctrl+C`。

## 统一后端中的实时感知

正式链路由浏览器采集视频和音频。统一后端接收视频帧与场景信号；感知事件通过 `reme.runtime.transport` 直接进入决策模块。音频继续由前端与决策接口处理。

浏览器输入模式：

```bash
uv run --extra pose python -m reme.runtime.server \
  --host 0.0.0.0 \
  --port 8770 \
  --input-adapter c_ws_server \
  --browser-input-mode auto
```

本地摄像头只用于开发测试：

```bash
uv run --extra pose python -m reme.runtime.server \
  --host 127.0.0.1 \
  --port 8770 \
  --input-adapter local_camera \
  --camera 0
```

控制入口：

```text
POST /api/runtime/start
POST /api/runtime/stop
GET  /api/runtime/status
GET  /api/runtime/capabilities
GET  /api/health
WS   /ws/events?session_id=<session_id>
```

`POST /api/runtime/start` 只接受共享合同中的 `live_camera` 请求。HTTP 响应先返回 `starting`；收到首个有效帧后，`GET /api/runtime/status` 才返回 `running`。浏览器可通过 `/ws/events` 观察同一 `session_id` 下的 `FrameLandmarks`、`PostureObservation` 和确定性 `TransitionEvent` 候选；决策模块不订阅该 Socket，而是直接消费进程内 Broker。每帧先更新姿态上下文，再分析转变，最后按关键点、姿态、转变的顺序发布。`fall_like_transition` 只是待验证候选，不代表已证明的跌倒识别。

摄像头 WebSocket 在一个 session 内保持连接并复用多个场景。`scene_signal` 的 `activate`、`switch` 或 `reuse` 会切换当前 `scene_id`，同时清空姿态平滑、持续时间和转变窗口；不会重启 session。事件 `sequence` 在整个 session 内单调递增，即使前端按场景重置自己的 `frame_index`。统一后端默认监听 `127.0.0.1:8770`；需要局域网访问时显式指定 `--host 0.0.0.0`。`GET /api/runtime/capabilities` 返回当前输入所有权、事件类型、schema 与端点。

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
  experiments/motionbert-offline-demo/infer_motionbert.py \
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
