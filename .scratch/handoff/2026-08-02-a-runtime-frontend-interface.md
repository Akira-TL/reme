# A 实时感知接口交接（C媒体源）

- Date: 2026-08-02
- Owner: A
- Consumers: B / C
- Service: `reme-perception`
- Frontend schema: `reme-perception-frontend/v0-experiment`

## 1. 最终媒体所有权

```text
C采集视频与音频
├─ C camera WebSocket → A：JPEG视频帧 + scene_signal
├─ C原视频 → C页面：原画面展示
└─ C音频/用户输入 → B：交互与决策

A → B/C：FrameLandmarks / PostureObservation / TransitionEvent
```

约束：

- A正式链路不打开自己的摄像头；
- `local_camera`适配器只用于A本地测试；
- A不接收、不保存、不处理音频；
- A不把原视频重新传回C；
- C复用自己已有的camera WebSocket，A作为客户端订阅；
- 同一WebSocket在一个session内复用多个场景。

## 2. 启动A正式服务

```bash
.venv/bin/python -m reme.pose.runtime_server \
  --host 0.0.0.0 \
  --port 8770 \
  --input-adapter c_ws \
  --c-camera-ws-url ws://<C_HOST>:<C_PORT>/<CAMERA_PATH> \
  --movenet-model models/movenet/movenet_lightning_f16_v4.tflite \
  --posture-model artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json
```

A本地自测：

```bash
.venv/bin/python -m reme.pose.runtime_server \
  --host 127.0.0.1 \
  --port 8770 \
  --input-adapter local_camera \
  --camera 0
```

## 3. A控制与输出端点

```text
GET  /api/health
GET  /api/runtime/capabilities
GET  /api/runtime/status
POST /api/runtime/start
POST /api/runtime/stop
WS   /ws/events?session_id=<session_id>
```

A仅开放控制、状态和结构化事件接口。没有A→C视频预览端点，也没有C→A逐帧HTTP上传端点。

## 4. C启动流程

1. C生成新的`session_id`。
2. C保持自己的camera WebSocket可连接。
3. C用同一`session_id`启动A和B。
4. A连接C camera WebSocket并发送订阅消息。
5. A先回报`starting`；收到并成功处理首帧后回报`running`。
6. C连接A事件WebSocket并展示A的实际状态。
7. 停止或切换profile时使用新的`session_id`。

启动请求：

```json
{
  "schema_version": "reme-runtime-session-request/v0-experiment",
  "session_id": "live-camera-<uuid>",
  "profile": "live_camera",
  "scene_id": "default-scene",
  "input_source": "camera",
  "perception_mode": "live",
  "decision_mode": "live",
  "camera_id": "c-primary-camera",
  "manifest_path": null
}
```

`camera_id`是C侧摄像头流标识，不是A机器的设备号。

## 5. A向C camera WebSocket发送的订阅

```json
{
  "type": "subscribe",
  "consumer": "reme-perception",
  "session_id": "live-camera-<uuid>",
  "camera_id": "c-primary-camera",
  "initial_scene_id": "default-scene"
}
```

## 6. C camera WebSocket消息

### 场景信号

```json
{
  "type": "scene_signal",
  "session_id": "live-camera-<uuid>",
  "scene_id": "kitchen",
  "timestamp_ms": 0,
  "signal": "activate"
}
```

支持的`signal`：

```text
activate
switch
reuse
```

收到任一场景激活信号后，A：

- 保持同一camera WebSocket连接；
- 保持同一`session_id`；
- 更新当前`scene_id`；
- 清空姿态平滑和持续时间；
- 清空动作转变窗口与冷却状态；
- 不沿用上一个场景的动作状态。

### 帧格式A：JSON内嵌JPEG

```json
{
  "type": "frame",
  "session_id": "live-camera-<uuid>",
  "scene_id": "kitchen",
  "frame_index": 12,
  "timestamp_ms": 400.0,
  "jpeg_base64": "..."
}
```

### 帧格式B：元数据 + 二进制JPEG

先发送：

```json
{
  "type": "frame_meta",
  "session_id": "live-camera-<uuid>",
  "scene_id": "kitchen",
  "frame_index": 12,
  "timestamp_ms": 400.0
}
```

紧接着发送一个二进制WebSocket消息，内容为JPEG字节。

推荐C使用格式B，避免Base64体积开销。

允许发送：

```json
{"type":"heartbeat"}
```

或：

```json
{"type":"ping"}
```

A会忽略这两类应用层心跳。

## 7. A输出事件

```text
FrameLandmarks
→ PostureObservation（达到5–10Hz周期时）
→ TransitionEvent（形成确定性候选时）
```

事件信封：

```json
{
  "schema_version": "reme-runtime-event/v0-experiment",
  "session_id": "live-camera-<uuid>",
  "sequence": 128,
  "event_type": "posture_observation",
  "payload": {}
}
```

注意：

- `RuntimeEvent.sequence`在整个session内单调递增；
- C可以在场景复用时重置自己的`frame_index`或`timestamp_ms`；
- B只需消费`posture_observation`和`transition_event`；
- C可消费全部三类事件；
- C/B必须丢弃不属于当前`session_id`的事件。

## 8. 错误合同

```json
{
  "schema_version": "reme-api-error/v0-experiment",
  "code": "invalid_request",
  "message": "具体错误原因",
  "path": "/api/runtime/start"
}
```

C camera WebSocket断开、握手失败、消息格式错误或模型处理失败时，A回报`degraded`并关闭该session的A输出WebSocket。

## 9. 当前限制

- 正式输入仅支持C camera WebSocket上的JPEG帧；
- 不处理音频；
- 不支持多人主体；
- `fall_like_transition`是规则候选，不代表真实跌倒准确率；
- `recorded_video` Playback Adapter尚未接入当前A运行服务；
- 当前阶段先完成B/C接入，不执行联合长时间验收。
