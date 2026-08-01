# 实时姿态观察短跑

- Date: 2026-08-01
- Session: `live-posture-smoke`
- Camera: `/dev/video0`
- Frame model: MoveNet Lightning FP16
- Posture model: `posture-softmax-v3`
- Posture target rate: 7.5 Hz
- Run length: 120 camera frames

## 结果

```text
FrameLandmarks events: 120
PostureObservation events: 29
Elapsed: 5.165 s
Frame event rate: 23.231 FPS
Posture event rate: 5.615 Hz
MoveNet average: 3.491 ms
MoveNet P95: 4.164 ms
Frame processing average: 6.884 ms
Frame processing P95: 13.806 ms
Raw frames written: false
Raw video recorded: false
```

姿态输出：

```text
unknown: 29
```

本次人物坐在电脑摄像头近距离位置，关键点质量多为 `degraded`，人体检测覆盖为 24.17%。所有姿态观察安全拒判为 `unknown`。该结果证明：

- 摄像头、MoveNet、姿态模型和 RuntimeEvent 能在同一进程连续工作；
- `PostureObservation` 输出频率位于 5–10 Hz 目标区间；
- 证据不足时没有沿用旧标签或强制输出坐姿；
- 原始帧和视频未落盘。

该短跑不用于判断真人姿态准确率。正式全身站位、真人类别覆盖、页面端延迟和10分钟稳定性仍待人工验收。
