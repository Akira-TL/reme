# Reme 实时链路稳定性验收

- 报告版本：`reme-runtime-reliability/v0-experiment`
- 开始：`2026-08-01T15:03:31.164429Z`
- 结束：`2026-08-01T15:13:32.034089Z`
- 结论：**未通过**
- 命令：`python -m reme.pose.runtime_benchmark --duration-seconds 600 --restart-after-seconds 60 --camera 0 --width 1280 --height 720 --fps 30 --movenet-model /home/akira/Projects/reme/models/movenet/movenet_lightning_f16_v4.tflite --posture-model /home/akira/Projects/reme/artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json --session-prefix runtime-reliability-20260801 --report-json .scratch/perception-runtime/results/2026-08-01-runtime-reliability.json --report-markdown .scratch/perception-runtime/results/2026-08-01-runtime-reliability.md`

## 核心指标

| 指标 | 实测 |
|---|---:|
| 摄像头有效运行 | 600.056 s |
| FrameLandmarks | 11702 帧 / 19.502 FPS |
| PostureObservation | 3420 条 / 5.699 Hz |
| MoveNet 推理 | avg 3.574 ms / P95 4.399 ms |
| 单帧处理 | avg 5.890 ms / P95 9.012 ms |
| 首帧启动 | 728.529 ms |
| 姿态事件生成延迟 | avg 6.472 ms / P95 9.492 ms |
| WebSocket 关键点延迟 | avg 6.436 ms / P95 9.694 ms |
| WebSocket 姿态延迟 | avg 9.518 ms / P95 45.596 ms |
| 内存 | start 40.727 MB / peak 212.785 MB / end 206.316 MB |
| 内存增长 | 165.590 MB |
| 摄像头释放 | avg 65.692 ms / max 75.992 ms |

## Session 与客户端证据

- 重启旧 session：是
- 旧 WebSocket 正常关闭：是
- 旧 WebSocket 未收到新 session：是
- 新 session 未收到旧事件：是
- 慢客户端未阻塞推理：是
- 异常断开后服务继续运行：是
- 原始帧落盘：否
- 原始视频录制：否

## 验收检查

- ✅ `ten_minute_camera_run`
- ✅ `frame_landmarks_fps`
- ✅ `posture_observation_hz`
- ✅ `first_frame_startup`
- ✅ `posture_generation_latency`
- ✅ `websocket_frame_latency`
- ✅ `websocket_posture_latency`
- ❌ `memory_growth`
- ✅ `camera_release`
- ✅ `restart_performed`
- ✅ `old_websocket_closed`
- ✅ `old_websocket_rejects_new_events`
- ✅ `new_session_rejects_old_events`
- ✅ `slow_client_non_blocking`
- ✅ `abnormal_disconnect_resilience`
- ✅ `no_raw_frame_persistence`
- ✅ `no_runtime_errors`

## 内存判定说明

本次 RSS 起点位于 LiteRT、OpenCV 和模型首次初始化之前。起止增长包含原生运行时初始化与分配器缓存，不能仅据此判定内存泄漏。因此保留失败项，并要求后续增加预热后基线和多次 session 重启斜率验证。

## 分 Session 指标

### `runtime-reliability-20260801-old`

- 摄像头有效运行：60.077 s
- FrameLandmarks：1407 / 23.368 FPS
- PostureObservation：358 / 5.946 Hz
- 首帧：728.529 ms
- 摄像头释放：75.992 ms

### `runtime-reliability-20260801-new`

- 摄像头有效运行：539.980 s
- FrameLandmarks：10295 / 19.065 FPS
- PostureObservation：3062 / 5.670 Hz
- 首帧：554.540 ms
- 摄像头释放：55.393 ms

## 隐私与解释边界

本验收默认仅在内存中处理摄像头帧，不保存原始帧或视频。延迟和置信度是工程测量，不代表医疗准确率或跌倒识别准确率。
