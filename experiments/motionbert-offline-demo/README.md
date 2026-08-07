# MotionBERT 离线双屏 Demo

## 当前已生成结果

- 视频：`/home/akira/Projects/reme/148703662.mp4`
- 2D 关键点：`/tmp/reme-litert-lightning-f16-tracking-full/keypoints.jsonl`
- 3D Web 数据：`/tmp/reme-motionbert-output/poses3d.json`
- 原始 3D NumPy：`/tmp/reme-motionbert-output/poses3d.raw.npy`
- 测量摘要：`/tmp/reme-motionbert-output/poses3d.summary.json`

`/tmp` 中的文件重启后可能被清理。比赛前应重新生成，或由团队手动复制到已被 Git 忽略的 `artifacts/motionbert/`。

## 运行 Web Demo

```bash
.venv/bin/python experiments/motionbert-offline-demo/server.py \
  --video 148703662.mp4 \
  --poses /tmp/reme-motionbert-output/poses3d.json \
  --host 127.0.0.1 \
  --port 8765
```

打开：

```text
http://127.0.0.1:8765/prototype/motionbert
```

首次启动会把 Three.js 和 OrbitControls 缓存到 `/tmp`；之后页面可在断网情况下运行。

## 重新执行 MotionBERT

需要：

- MotionBERT 官方仓库克隆；
- OpenMMLab MotionBERT finetuned H36M checkpoint；
- 支持 CUDA 的 PyTorch 环境。

本轮使用：

```text
MotionBERT repo: /tmp/reme-motionbert
checkpoint: /tmp/reme-motionbert-checkpoints/motionbert_ft_h36m.pth
CUDA Python: /home/akira/.local/share/mamba/envs/DL/bin/python
```

运行：

```bash
/home/akira/.local/share/mamba/envs/DL/bin/python \
  experiments/motionbert-offline-demo/infer_motionbert.py \
  --keypoints /tmp/reme-litert-lightning-f16-tracking-full/keypoints.jsonl \
  --motionbert-repo /tmp/reme-motionbert \
  --checkpoint /tmp/reme-motionbert-checkpoints/motionbert_ft_h36m.pth \
  --output /tmp/reme-motionbert-output/poses3d.json \
  --video-name 148703662.mp4 \
  --width 1280 \
  --height 720 \
  --fps 30 \
  --device cuda \
  --window 243 \
  --stride 81 \
  --batch-size 4
```

## 页面操作

- 播放、暂停和拖动时间轴；
- 0.5×—1.5× 回放速度；
- 鼠标拖动旋转，滚轮缩放；
- 正视、侧视、俯视、重置视角；
- 地面网格、空间边界、自动环绕开关；
- 空格播放/暂停，左右方向键前后跳 2 秒。

## 能力边界

这是单目视频推断出的根节点相对三维人体姿态。显示比例被归一化为演示尺度，不能解释为真实身高、人物离摄像头距离或人在房间中的绝对位置。
