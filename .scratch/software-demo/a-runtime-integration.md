# C 前端接入 A 感知运行时

- 日期：2026-08-02
- 前端分支：`develop/jiang`
- A 接口基线：`origin/develop/akira@8ef0df8`
- A 交接文档：`.scratch/handoff/2026-08-02-a-runtime-frontend-interface.md`

## 已确认的 A 接口

```text
GET  /api/health
GET  /api/runtime/capabilities
GET  /api/runtime/status
POST /api/runtime/start
POST /api/runtime/stop
WS   /ws/events?session_id=<session_id>
```

前端使用 `reme-runtime-session-request/v0-experiment` 创建 `live_camera` 会话，并校验：

- `reme-runtime-session-status/v0-experiment`
- `reme-runtime-event/v0-experiment`
- `movenet-17/v0-experiment`
- `reme-posture/v0-experiment`
- `reme-transition/v0-experiment`

事件必须属于当前 `session_id`；`sequence` 允许同一帧的不同事件类型复用相同序号，但拒绝倒退和重复事件。

## 最终采用的浏览器输入方向

产品期望链路：

```text
浏览器（WS Client） -> A（WS Server）
```

前端不托管 WebSocket 服务。浏览器将同一会话内的摄像头数据直发 A：

1. `scene_signal`
2. `frame_meta`
3. binary JPEG

帧率为 10 FPS，最长边 640px，JPEG quality 0.72；只在输入 WS 已连接时编码和发送。

建议 A 输入端点：

```text
WS /ws/camera-input
```

可通过 `VITE_REME_PERCEPTION_INPUT_WS_URL` 覆盖，因此 A 最终采用其他路径时无需改前端代码。

## 当前接口缺口

`develop/akira@8ef0df8` 尚未实现浏览器可连接的输入 WS。该版本新增的是跌倒候选模型训练，未改变运行时媒体接口。当前 A 的 `c_ws` 适配器仍是 A 作为客户端反向连接 C Camera WebSocket，这与已确认的产品拓扑不一致。

因此当前联调状态是：

| 能力 | 状态 |
|---|---|
| HTTP capabilities/start/status/stop | 前端已接入 |
| A -> 前端事件 WS | 前端已接入 |
| 前端 -> A 摄像头输入 WS | 前端已实现客户端，等待 A 提供服务端路由 |
| A landmarks 覆盖本地绘制 | 已实现 |
| A 不可用时本地降级 | 已实现并显式显示 |
| A 恢复后的前端手动重连 | 已实现，点击状态标签创建新会话 |
| schema 与消息顺序合同测试 | 已实现 |
| B 风险决策 | 未接入 |

## 风险语义边界

- `fall_like_transition` 只是 A 的动作候选，不等同于跌倒结论。
- 前端收到候选后只提示“等待 B 决策确认”，不触发正式紧急弹窗。
- 当前高保真原型的风险弹窗属于脚本演示，不代表 A 的识别准确率或 B 已完成接入。
- 原始视频不持久化；浏览器只有在 A 输入 WS 成功连接后才发送压缩帧。

## A 端最小改动请求

1. 新增浏览器可连接的 `/ws/camera-input`。
2. 接收已有 `scene_signal`、`frame_meta + binary JPEG` 合同，不另造帧 schema。
3. 按 `session_id` 将输入绑定到 `POST /api/runtime/start` 创建的会话。
4. 断开、schema 错误或帧解析失败时回报 `degraded` 与明确 `reason`。
5. 保持现有 `/ws/events` 作为只读结构化输出通道。
