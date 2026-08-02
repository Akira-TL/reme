# Ticket 02：摄像头与 MoveNet 实时短跑记录

- Date: 2026-08-01
- Status: measured-smoke-test
- Device: 当前 CUDA 开发电脑
- Camera: HD Webcam `/dev/video0`
- Model: MoveNet SinglePose Lightning FP16 v4
- Runtime: LiteRT XNNPACK CPU，4 threads
- Raw frames written: false
- Raw video recorded: false

## 摄像头能力

`v4l2-ctl` 报告：

```text
/dev/video0
1280 × 720 @ 30 FPS, MJPG
640 × 480 @ 30 FPS, MJPG/YUYV
```

`/dev/video1` 属于同一摄像头的辅助节点，不提供普通 Video Capture 格式，因此默认使用 camera index 0。

## 300 帧短跑

运行配置：

```text
resolution: 1280 × 720
requested camera FPS: 30
actual camera FPS: 30
fourcc: MJPG
tracking crop: enabled
score threshold: 0.2
frames: 300
```

测量结果：

| 指标 | 结果 |
|---|---:|
| 处理帧数 | 300 |
| 总时长 | 12.486 s |
| 端到端输出 FPS | 24.027 |
| MoveNet invoke average | 4.017 ms |
| MoveNet invoke P95 | 4.859 ms |
| 单帧处理 average | 10.960 ms |
| 单帧处理 P95 | 13.570 ms |
| 人体检测帧 | 286 / 300 |
| 人体检测覆盖 | 95.33% |
| usable | 4 |
| degraded | 282 |
| unavailable | 14 |

结论：

- 当前电脑已经超过 Ticket 目标的 MoveNet 15 FPS；
- 摄像头、解码、跟踪裁剪和MoveNet合并后的事件输出约24 FPS；
- 没有写出原始帧或原始视频；
- 当前多数帧为 `degraded`，原因是桌面近距离取景下双膝和双踝未稳定完整入镜；
- 按用户要求，是否全身入镜和实际人员覆盖留到人工验收，不阻塞继续开发；
- 不通过降低0.2质量阈值来掩盖取景问题。

## 下肢诊断短跑

一次150帧诊断中，核心下肢点过0.2阈值比例约为：

| 点 | 过阈值比例 | 平均分数 |
|---|---:|---:|
| left_knee | 20.7% | 0.148 |
| right_knee | 23.3% | 0.152 |
| left_ankle | 10.7% | 0.124 |
| right_ankle | 14.7% | 0.132 |

这些数字只描述当时摄像头取景，不是模型准确率，也不用于判断Ticket是否最终通过。

## 已实现行为

- `live_camera`会话的实时摄像头读取；
- MoveNet Lightning FP16 LiteRT推理；
- 视频式tracking crop；
- FrameLandmarks RuntimeEvent；
- `session_id`和单调`sequence`；
- `person_detected=false`与`landmark_quality=unavailable`；
- 会话失效时停止事件并释放摄像头；
- 推理异常时释放摄像头；
- 按Ctrl+C结束并输出性能摘要；
- 默认不保存原始画面。

## Ticket 02 剩余验收

- 人工确认正式演示站位和全身入镜布局；
- 连续运行10分钟；
- 记录10分钟资源使用和错误；
- 接入C/B实际WebSocket传输后测量关键点到页面延迟；
- 将已验证模型从`/tmp`复制到Git忽略的正式`models/movenet/`路径。
