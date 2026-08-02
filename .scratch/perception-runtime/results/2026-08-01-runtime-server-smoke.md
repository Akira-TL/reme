# A侧实时会话服务短跑（2026-08-01）

## 目标

验证C可通过HTTP控制A的`live_camera`会话，并由标准WebSocket接收同一`session_id`下的实时关键点和姿态观察。

## 环境

- 设备：当前开发电脑
- 摄像头：`/dev/video0`
- A控制地址：`http://127.0.0.1:8770`
- WebSocket：`ws://127.0.0.1:8770/ws/events?session_id=session-live-smoke`
- MoveNet：`models/movenet/movenet_lightning_f16_v4.tflite`
- 姿态模型：`posture-sweep-20260801/seed-42-lr-0.04/model.json`

## 结果

1. `POST /api/runtime/start`立即返回`starting`；
2. 摄像头打开并完成首帧推理后，`GET /api/runtime/status`返回`running`；
3. 标准WebSocket握手返回HTTP 101；
4. 客户端收到同一session的2个`FrameLandmarks`和1个`PostureObservation`；
5. `POST /api/runtime/stop`返回`stopped`；
6. `/dev/video0`无遗留占用；
7. 8770端口和tmux服务均已关闭。

本次姿态观察为`unknown`，因为短跑时人体关键点不可用；这不影响传输验收，也没有用旧标签伪装成功。

## 边界

- 当前A服务只支持`live_camera`；`recorded_video`后续由独立回放Adapter实现；
- 当前WebSocket只发送A的`FrameLandmarks`和`PostureObservation`；
- `TransitionEvent`尚未接入；
- B和C实际消费者尚未联调；
- 10分钟连续运行与端到端页面延迟仍待完成。
