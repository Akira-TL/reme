# LiteRT + MoveNet 火柴人识别可行性实验

- Type: prototype
- Status: measured
- Date: 2026-08-01

## 要回答的问题

在不保存或对外展示原始视频帧的前提下，LiteRT 能否在团队提供的视频上运行 MoveNet SinglePose Lightning，并输出连续、可用于后续姿态分类的 17 点人体骨骼？

本实验只回答姿态提取问题，不接受以下推论：

- 骨骼提取成功不等于站、坐、躺分类成功；
- 单帧躺卧不等于跌倒；
- 笔记本运行成功不等于树莓派 4B 性能达标；
- 目标视频未实测前，不报告准确率、FPS 或支持动作数量。

## 假设

1. `ai-edge-litert` 的 Interpreter API 可以直接运行 MoveNet `.tflite` 模型。
2. MoveNet Lightning 的 17 个关键点足以生成不可轻易辨认身份的火柴人视图。
3. 对同一视频逐帧输出关键点、置信度和推理耗时，可以为后续与 MediaPipe Pose Landmarker 的对比提供证据。

## 实验输入

- 一段团队明确有权使用的单人动作视频；
- 官方 MoveNet SinglePose Lightning TFLite 模型；
- 本机 Python 3.11 环境。

团队目标视频 `148703662.mp4` 已完成全帧测试。详细测量见 `results/2026-08-01-video-148703662.md`。

## 2026-08-01 烟雾测试

使用官方 MoveNet Lightning float16 TFLite 模型和官方教程引用的人体样例图生成的 12 帧临时视频，已完成端到端烟雾测试：

- LiteRT 成功加载模型并启用 XNNPACK CPU delegate；
- 模型输入为 `[1, 192, 192, 3]`、`uint8`；
- 模型输出为 `[1, 1, 17, 3]`、`float32`；
- 成功生成 12 行关键点 JSONL、可播放的骨骼 MP4 和 summary JSON；
- 临时样例上的 12 帧均满足本实验的躯干可见定义。

烟雾测试观测到 `invoke()` 平均约 4.8 ms、P95 约 9.9 ms，但该数字来自本机、重复静态样例和仅 12 帧输入，只能证明执行链路可工作，不能作为目标视频性能或树莓派性能结论。

## 实验输出

默认仅生成以下派生产物：

- `skeleton.mp4`：黑色背景上的骨骼点和连线；
- `keypoints.jsonl`：逐帧 17 点坐标、置信度和时间戳；
- `summary.json`：检测覆盖率、推理延迟和资源摘要。

原始帧只在内存中解码，不写入输出目录。

## 运行方式

安装本实验依赖：

```bash
uv pip install --python .venv/bin/python \
  'ai-edge-litert==2.1.6' \
  'numpy>=2.0' \
  'opencv-python-headless>=4.10'
```

下载官方 MoveNet SinglePose Lightning float16 TFLite 模型：

```bash
curl -L \
  'https://tfhub.dev/google/lite-model/movenet/singlepose/lightning/tflite/float16/4?lite-format=tflite' \
  -o /path/to/movenet_lightning_f16.tflite
```

运行。视频模式应默认使用逐帧跟踪裁剪；简单整帧 letterbox 仅保留为对照基线：

```bash
.venv/bin/python experiments/litert-movenet-feasibility/run.py \
  --model /path/to/movenet_lightning_f16.tflite \
  --video /path/to/input.mp4 \
  --output-dir /tmp/reme-litert-result \
  --tracking-crop
```

快速抽样：

```bash
.venv/bin/python experiments/litert-movenet-feasibility/run.py \
  --model /path/to/movenet_lightning_f16.tflite \
  --video /path/to/input.mp4 \
  --output-dir experiments/litert-movenet-feasibility/results/smoke \
  --sample-every 5 \
  --max-frames 300
```

## 目标视频结论

在 `148703662.mp4` 的 2370 帧完整测试中，MoveNet Lightning FP16 配合逐帧跟踪裁剪达到 100% 躯干覆盖，2369/2370 帧的双肩、双髋、双膝和双踝置信度均达到 0.2。生成的 79 秒骨骼视频没有空白帧。

该结果通过姿态提取 Gate，可以进入姿态标注与分类实验；它不构成姿态分类、跌倒识别、跨场景泛化或树莓派性能结论。

## 测量定义

- `processed_frames`：实际送入 LiteRT 的帧数；
- `torso_detected_frames`：至少一个肩点和至少一个髋点置信度达到阈值的帧数；
- `detection_coverage`：`torso_detected_frames / processed_frames`；
- `inference_ms`：仅 `Interpreter.invoke()` 的耗时，不含视频解码、缩放和绘制；
- `end_to_end_fps`：完整处理链路的处理帧数除以总耗时。

这些指标衡量提取链路，不是姿态分类准确率。

## Go / Conditional Go / No-Go

- **Go**：关键动作片段中骨骼连续，躯干和四肢多数时间位置合理，可进入姿态标注与分类实验。
- **Conditional Go**：躯干稳定但手脚抖动或局部缺失；可先验证站、坐、躺，不宣称精细动作或跌倒检测。
- **No-Go**：人体长期漏检、关键点大范围跳动或遮挡后不能恢复；需要更换视频、机位或姿态提取器。

## 官方依据

- LiteRT 官方 Python 包：`https://pypi.org/project/ai-edge-litert/`
- LiteRT 官方样例：`https://github.com/google-ai-edge/litert-samples`
- MoveNet 官方教程及模型下载：`https://www.tensorflow.org/hub/tutorials/movenet`
