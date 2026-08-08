# 固定公开双端演示规格

- Status: accepted-for-local-implementation
- Type: prototype
- Date: 2026-08-08
- Base: `origin/develop/akira@0b3b5f6d912e9deef9de25bd6687014fe28b40fd`
- Related: ADR-0003, ADR-0005, ADR-0007, ADR-0008

## 1. 目标与假设

目标是在不恢复浏览器侧姿态模型的前提下，把最新 Akira 单页演示扩展成两个公开入口：

- `/`：Monitor，采集媒体、连接本地统一运行时并执行权威动作；
- `/viewer.html`：Viewer，显示家属端并允许一名在线 Viewer 远程控制路演。

本阶段要验证的假设是：桌面 Chrome 与手机浏览器可以通过同一个固定公开房间同步结构化状态、控制命令、17 点骨架与事件期短时 WebRTC 原画，同时保持浴室硬隐私门和确定性安全升级。

本地 Go 条件：自动测试、构建、同机双窗口和手机人工验收通过；本地 No-Go 不触发自动部署，记录失败能力和降级状态后停止在本地阶段。

## 2. 明确边界

- 固定房间名为 `shared-live-demo`，演示环境故意不做身份认证；它不是生产访问模型。
- 日常默认只向 Viewer 发布骨架与结构化状态；浴室无论命令、重连或迟到事件都不发布原画。
- 厨房只有当前运行时决策明确记录 `consent_granted` 后才可签发最长 60 秒原画 grant。
- 跌倒只有当前运行时的权威告警已升级后才可签发最长 30 秒原画 grant。
- 原画 grant 面向最多 5 名全部在线 Viewer；厨房 grant 的晚到 Viewer 可加入剩余窗口。
- 原始视频 RTP 只走 WebRTC；Worker 消息、SQLite、日志和事件 payload 禁止包含 JPEG、base64、Blob、音频或视频正文。
- 摄像头/麦克风、屏幕捕获、文件选择和全屏都必须由 Monitor 设备上的真实用户手势完成。远程命令只能进入等待本机确认状态。
- Viewer 不能取消、降低、伪造或延迟规则告警；MiMo 迟到结果仍受 ADR-0005/0007 约束。
- 不恢复 LBX 的浏览器 MoveNet、MediaPipe、LiteRT、多姿态或旧阈值；唯一感知事实来自最新 Akira 统一运行时。

## 3. 角色与生命周期

### Monitor producer

- 页面加载不显示密码；点击“开始演示”调用 `POST /api/monitor/claim` 获取 256-bit 短期 token 与新的 `room_session_id`。
- 同一房间仅一个 producer lease。lease 为 30 秒，Monitor 每 10 秒 heartbeat；有效 WebSocket 断开后立即关闭媒体 grant，lease 到期后允许新 Monitor 接管。
- Monitor 维护 `runtime_session_id`，只接收当前运行时会话的数据，并发布经严格校验的状态快照、骨架和事件。

### Viewer observer / controller

- Viewer 无凭证连接 `/ws/viewer`，最多 5 名；连接后得到不可预测的 `viewer_id`。
- 任一 Viewer 可发送 `control_claim`。同一时间仅一个 controller lease，30 秒有效并通过 10 秒 heartbeat 续租。
- controller 断开、页面隐藏、主动释放或 lease 到期即失去控制；其他 Viewer 可重新竞争。
- 所有 Viewer 都能看到状态与有效事件期原画，控制租约只限制命令发布。

## 4. 媒体源合同

统一媒体源描述：

```text
MediaSourceDescriptor {
  id: opaque string,
  kind: camera | display | file,
  label: string,
  facing_mode: user | environment | null,
  remote_video: available | local_only | unavailable,
  disabled_reason: string | null
}
```

- `camera` 使用 `getUserMedia`，授权后枚举设备，手机提供前/后摄像头切换。
- `display` 使用 `getDisplayMedia`；缺少 API 时禁用并解释。
- `file` 使用本地 `<input type=file accept="video/*">` 与对象 URL；缺少 `captureStream` 时仍进入本地推理，但 `remote_video=local_only`。
- 切源按顺序：提升 source generation → 撤销媒体 grant → 停旧轨道 → 清 video `srcObject/src` → revoke object URL → 装载新源。任何旧 generation 的异步结果都丢弃。

## 5. Relay 协议

消息 JSON 最大 16 KiB，必须是 exact-shape，所有 ID 只允许长度不超过 128 的字母数字、`_`、`-`。二进制 WebSocket 帧拒绝。

### 权威状态

`reme-demo-state/v1`：

```json
{
  "schema_version": "reme-demo-state/v1",
  "room_session_id": "room-...",
  "runtime_session_id": "runtime-...",
  "state_revision": 12,
  "timestamp_ms": 0,
  "state": {
    "scene_id": "living",
    "capture": {},
    "runtime": {},
    "care": {},
    "media_grant": null
  }
}
```

Relay 只接受当前 producer 的严格递增 revision。新 Viewer 先收到 `viewer_ready`，再收到最新快照与不超过 2.5 秒的新鲜骨架。

### 远程命令

`reme-control-command/v1`：

```json
{
  "schema_version": "reme-control-command/v1",
  "room_session_id": "room-...",
  "command_id": "cmd-...",
  "command_sequence": 3,
  "issued_at_ms": 0,
  "expires_at_ms": 0,
  "expected_state_revision": 12,
  "command": { "name": "select_scene", "scene_id": "kitchen" }
}
```

命令 union：

- `select_scene(scene_id)`；
- `select_source(source_id)`；
- `start_capture` / `stop_capture`；
- `run_demo_scenario(scenario=normal|fall)`；
- `reset_demo`；
- `start_conversation(scenario=proactive_check_in|kitchen_share)`；
- `submit_response(decision_id,response=safe|need_help|consent_granted|consent_denied)`；
- `confirm_alarm(decision_id)`；
- `replay_voice(decision_id)`。

Relay 校验 controller lease、房间会话、序号、过期时间、revision 与 payload 后转发给 Monitor。`command_id` 幂等，终态结果在房间会话内缓存；Viewer 重发得到原结果。

`control_ack` phase：

- `received`：Relay 已接受并转发；
- `awaiting_local_confirmation`：Monitor 需要本机用户手势；
- `applied`：底层动作和对应权威 state 已完成；
- `rejected`：权限、会话、过期、隐私或安全规则拒绝；
- `failed`：执行失败且状态未伪装成功。

Viewer 不做乐观更新，只以 `state_revision` 收敛。

### 骨架与媒体

- 骨架继续采用最新后端返回的 17 点结构；无可靠人形时发布 unavailable/reset，不制造假骨架。
- WebRTC 信令采用 `reme-media-signal/v1`，只允许 `offer|answer|ice_candidate`，并绑定 `grant_id` 与目标 Viewer。
- grant 到期、场景/运行时会话/媒体源变化、capture 停止、Monitor 断开时 fail-close。

## 6. UI 行为

Monitor 首屏在 1920×1080 内显示媒体源、实时画面、手机模拟、运行时健康、公开房间状态、Viewer 数、controller、远程命令和验收动作。公开模式警示常驻。

Viewer 按江姐稿重建首页、看板、设置：

- 首页动态显示骨架、授权原画、关怀卡、时间线和紧急 sheet；
- 看板使用本次演示真实事件与连接数据，不伪造准确率或医疗指标；
- 设置中的“高隐私显示”只允许主动隐藏授权原画；通知开关真实控制本页声音、震动和闪烁；
- 控制抽屉显示租约、命令 pending/ACK 和全部路演动作。

## 7. 验收

- Relay：公开 producer claim、单 controller、5 Viewer 上限、exact schema、revision/sequence、幂等 ACK、断线/到期 alarm、grant audience 与 fail-close。
- 前端：三类媒体源、前后摄像头、资源释放、旧 generation 屏障、命令适配器、Viewer 三页、浴室硬门、通知与隐私开关。
- 集成：正常/厨房/浴室/跌倒；两 Viewer 与晚加入；后端、Relay、媒体失败；连续切换 20 次。
- 视觉：江姐 7 张参考与同视口实现截图并排 QA，P0/P1/P2 清零。
- 模型：只安装并校验 ignored 的 `models/trained/*`；不提交、不产生新性能或准确率口径。

## 8. 部署门

本规格只授权本地实现、测试和提交。公网发布、TURN 生产 secret、域名与费用属于下一阶段，必须在本地验收通过后单独执行。
