# A / B / C 共享实验接口合同

- Type: spec
- Status: accepted-for-demo
- Acceptance scope: 运行模式、字段语义、所有权和传输边界已接受
- End-to-end readiness: implementation-in-progress
- Date: 2026-08-01
- Owners: A / B / C
- Scope: 实时姿态感知、预录回放、MiMo 决策与软件演示之间的数据接口
- Version policy: `v0-experiment`，端到端验收前允许兼容性增补，不是永久产品合同

## 1. 当前目标

当前优先完成基本功能，而不是先固定比赛故事：

```text
实时摄像头
→ MoveNet 2D 关键点
→ 静态姿态分类与质量判断
→ B 的完整实时决策链路
→ C 的实时视频、2D/3D 展示与交互
```

同时保留稳定的预录回放模式：

```text
预录视频
→ 回放预计算感知结果
→ 回放预录决策结果
→ C 按同一接口稳定展示
```

具体比赛视频内容、剧情和录制计划后续单独讨论，不进入当前核心接口。牙疼、授权、行动卡、家属确认等故事字段不属于本版合同。

## 2. 模块职责

```text
C Demo Module
  ├─ RuntimeSessionRequest ───────────→ A Perception Module
  ├─ RuntimeSessionRequest ───────────→ B Decision Module
  └─ InteractionResponse ─────────────→ B Decision Module

A Perception Module
  ├─ RuntimeSessionStatus ────────────→ C Demo Module
  ├─ FrameLandmarks ──────────────────→ B / C
  ├─ PostureObservation ──────────────→ B / C
  └─ TransitionEvent ─────────────────→ B / C

B Decision Module
  ├─ RuntimeSessionStatus ────────────→ C Demo Module
  └─ CareDecision ────────────────────→ C Demo Module
```

边界：

- C 是运行模式的唯一发起者，负责开始、停止、切换和重置；
- A/B 必须回报实际生效状态，C 不得只根据自己的选择显示 `LIVE`；
- A 输出人体动作事实，不输出风险等级或是否通知家属；
- B 维护规则、MiMo调用和交互状态机；
- C 只渲染结果并提交回应，不复制 A/B 的分类和决策逻辑；
- 每次启动或切换模式必须创建新的 `session_id`；
- A/B/C 使用同一个 `session_id`，旧会话的迟到事件必须丢弃。

## 3. 运行模式

### 3.1 仅支持两个正式配置

| `profile` | `input_source` | `perception_mode` | `decision_mode` | 用途 |
|---|---|---|---|---|
| `live_camera` | `camera` | `live` | `live` | 当前主要开发与实时演示 |
| `recorded_video` | `video` | `recorded` | `recorded` | 后续比赛稳定回放 |

当前不把 `video + live perception`、`video + live decision`、`camera + recorded decision` 作为正式运行配置。算法离线重建使用开发命令完成，不通过 C 的演示模式表达。

### 3.2 RuntimeSessionRequest：C → A / B

```json
{
  "schema_version": "reme-runtime-session-request/v0-experiment",
  "session_id": "session-live-001",
  "profile": "live_camera",
  "scene_id": "live-camera-001",
  "input_source": "camera",
  "perception_mode": "live",
  "decision_mode": "live",
  "camera_id": "default",
  "manifest_path": null
}
```

预录回放：

```json
{
  "schema_version": "reme-runtime-session-request/v0-experiment",
  "session_id": "session-video-001",
  "profile": "recorded_video",
  "scene_id": "recorded-video-001",
  "input_source": "video",
  "perception_mode": "recorded",
  "decision_mode": "recorded",
  "camera_id": null,
  "manifest_path": "scenes/recorded-video-001/manifest.json"
}
```

约束：

- `live_camera` 必须提供 `camera_id`，不得提供 `manifest_path`；
- `recorded_video` 必须提供 `manifest_path`，不得提供 `camera_id`；
- 每次启动、重启或切换 profile 都必须使用新的 `session_id`；
- 当前实时设备是团队现有 CUDA 开发电脑；
- 当前只支持单摄像头、单人主体和固定室内区域；
- 多人出现时应输出降级或主体不确定，不得声称支持多人看护。

### 3.3 RuntimeSessionStatus：A / B → C

```json
{
  "schema_version": "reme-runtime-session-status/v0-experiment",
  "session_id": "session-live-001",
  "component": "perception",
  "requested_profile": "live_camera",
  "effective_profile": "live_camera",
  "state": "running",
  "reason": null
}
```

`component`：

```text
perception
decision
```

`state`：

```text
starting
running
degraded
stopped
```

约束：

- `running` 时 `effective_profile` 必须等于 `requested_profile`；
- `degraded` 必须有明确 `reason`；
- A/B 不得静默切到另一个 profile；
- 失败时 C 明确显示降级，只有用户操作后才能切换预录模式；
- 模式切换必须创建新会话，不自动延用旧会话状态。

## 4. RuntimeEvent 事件信封

持久化数据记录不写死运行时 `session_id`；实时传输和回放传输统一包装为：

```json
{
  "schema_version": "reme-runtime-event/v0-experiment",
  "session_id": "session-live-001",
  "sequence": 18,
  "event_type": "posture_observation",
  "payload": {
    "schema_version": "reme-posture/v0-experiment",
    "scene_id": "live-camera-001",
    "timestamp_ms": 1266.7,
    "posture": "standing"
  }
}
```

`event_type`：

```text
frame_landmarks
posture_observation
transition_event
care_decision
interaction_response
```

约束：

- `sequence` 在当前发送方和会话内单调递增；
- C/B 接收事件前必须校验 `session_id`；
- 旧会话事件即使结构合法也必须丢弃；
- `payload` 继续遵循其自身 schema，不因实时或回放而改变形状。

## 5. 时间语义

系统存在两个可能脱钩的时间轴：

- **感知时间**：视频起点或实时会话起点的毫秒偏移；
- **交互时间**：C 收到某条决策后经过的现实时间。

规则：

- `timestamp_ms`、`start_ms`、`end_ms` 表示感知时间；
- 实时摄像头以当前 session 启动为 `0 ms`；
- 预录视频以视频起点为 `0 ms`；
- `response_timeout_ms` 表示从 C 收到 CareDecision 起计算的相对交互时长；
- 预录视频暂停或结束后，`response_timeout_ms` 仍然有效；
- 当前不使用绝对截止时间；未来需要审计时采用“墙上时间锚点 + 相对时长”双字段，而不是替换 `response_timeout_ms`。

## 6. 统一枚举

### 6.1 静态姿态 `posture`

```text
standing
sitting
lying
bending_or_crouching
unknown
```

`walking` 当前不作为静态姿态类别，由 `motion_level` 表达运动程度。

### 6.2 运动程度 `motion_level`

```text
still
low
medium
high
unknown
```

### 6.3 动作转变 `transition`

```text
normal_transition
fall_like_transition
uncertain_transition
```

跌倒不是静态姿态标签，必须通过时间窗口事件表达。

### 6.4 关键点质量 `landmark_quality`

```text
usable
degraded
unavailable
```

### 6.5 不确定性 `uncertainty`

```text
low
medium
high
unknown
```

所有置信度字段范围为 `0.0..1.0`，只表示实验模型或规则的证据强度，不得表述为医疗准确率。

## 7. SceneManifest：预录视频模式

SceneManifest 只用于 `recorded_video`，不用于实时摄像头会话。

```json
{
  "schema_version": "reme-scene/v0-experiment",
  "scene_id": "recorded-video-001",
  "title": "预录视频 001",
  "media": {
    "local_path": "media/source.mp4",
    "source_type": "prerecorded_video",
    "sha256": "6b17dd3c2efdba0e4dff19b6d72836580dafa6bbe632eee5d5430df2eb5743cc",
    "width": 1280,
    "height": 720,
    "fps": 30.0,
    "frame_count": 2370,
    "duration_ms": 79000,
    "demo_time_scale": 1.0
  },
  "streams": {
    "keypoints_2d": "keypoints_2d.jsonl",
    "keypoints_3d": "derived/poses3d.json",
    "posture_observations": "posture_observations.jsonl",
    "transition_events": "transition_events.jsonl",
    "recorded_decisions": "recorded_decisions.jsonl"
  }
}
```

规则：

- C 通过 manifest 定位预录媒体和结果，不猜测文件名；
- `recorded_video` 回放预计算感知和预录决策，不在演示时重新运行 A/B；
- `demo_time_scale` 只用于叙事显示，不改变真实感知时间；
- 具体录制哪些视频和故事后续决定；
- 源视频和大型派生产物保存在 Git 忽略的 `artifacts/`。

## 8. FrameLandmarks：A → B / C

```json
{
  "schema_version": "movenet-17/v0-experiment",
  "scene_id": "live-camera-001",
  "frame_index": 375,
  "timestamp_ms": 12500.0,
  "person_detected": true,
  "landmark_quality": "usable",
  "coordinate_space": "normalized_image_top_left",
  "smoothed": false,
  "keypoints": [
    {
      "name": "nose",
      "x_norm": 0.4989,
      "y_norm": 0.409892,
      "score": 0.551507
    }
  ]
}
```

约束：

- 正常情况下包含 MoveNet 顺序的 17 点；
- 坐标范围为 `0.0..1.0`，原点在图像左上；
- 低分点不得偷偷替换为 `(0, 0)`；
- 人离开画面时输出 `person_detected = false`；
- B 默认消费姿态和事件，不要求逐帧消费全部关键点。

## 9. PostureObservation：A → B / C

```json
{
  "schema_version": "reme-posture/v0-experiment",
  "scene_id": "live-camera-001",
  "timestamp_ms": 12500.0,
  "frame_index": 375,
  "person_detected": true,
  "posture": "standing",
  "posture_confidence": 0.88,
  "posture_duration_ms": 4200,
  "motion_level": "low",
  "visible_keypoint_ratio": 0.94,
  "landmark_quality": "usable"
}
```

约束：

- 字段统一使用 `posture` 和 `posture_duration_ms`；
- 证据不足时必须输出 `unknown`，不得强制分类；
- 姿态输出目标频率为 `5–10 Hz`，不要求与摄像头帧率相同；
- C 使用最新有效观察；B 可聚合最近窗口，但不得修改 A 的原始结果。

## 10. TransitionEvent：A → B / C

```json
{
  "schema_version": "reme-transition/v0-experiment",
  "scene_id": "live-camera-001",
  "event_id": "transition-0003",
  "start_ms": 11100.0,
  "end_ms": 12700.0,
  "transition": "fall_like_transition",
  "transition_confidence": 0.76,
  "evidence": {
    "center_height_change": 0.41,
    "peak_keypoint_speed": 0.18,
    "posture_before": "standing",
    "posture_after": "lying"
  },
  "landmark_quality": "usable"
}
```

约束：

- `lying` 单独存在时不得生成跌倒事件；
- A 不输出风险等级、报警或通知家属；
- 持续静止由 `posture_duration_ms + motion_level` 提供事实，B 决定是否需要关怀；
- 跌倒式转变属于姿态分类完成后的时序能力，不阻塞第一版实时静态分类。

## 11. CareDecision：B → C

```json
{
  "schema_version": "reme-care-decision/v0-experiment",
  "scene_id": "live-camera-001",
  "decision_id": "decision-0007",
  "timestamp_ms": 12800.0,
  "state": "check_in_required",
  "risk_level": 2,
  "privacy_mode": "skeleton_only",
  "need_dialogue": true,
  "dialogue_goal": "confirm_safety",
  "elder_message": "您还好吗？需要我帮您联系家人吗？",
  "family_notification": null,
  "response_timeout_ms": 8000,
  "action": "ask_elder",
  "reason_summary": "检测到异常动作变化，建议确认安全状态。",
  "uncertainty": "medium",
  "fallback_used": false,
  "source": "mimo",
  "visual_context": {
    "sent_to_mimo": true,
    "type": "keyframes",
    "start_ms": 11100.0,
    "end_ms": 12700.0,
    "sample_count": 3
  }
}
```

`state`：

```text
normal
observe
check_in_required
family_notification_required
urgent_attention
resolved
degraded
```

`privacy_mode`：

```text
visible
blurred
skeleton_only
hidden
```

`action`：

```text
none
observe
ask_elder
notify_family
show_urgent_attention
mark_resolved
```

`source`：

```text
rule
mimo
record
degraded
```

约束：

- B 的状态机持续实时运行，但 MiMo 只在事件触发时调用，不持续逐帧调用；
- 正常稳定状态不调用 MiMo；
- 姿态变化先经过确定性规则，再决定是否调用 MiMo；
- 视觉上下文只在确有必要时显式抽取最小关键帧或短片段；
- `visual_context.sent_to_mimo` 必须反映真实行为；
- 需要回应时使用 `response_timeout_ms`；
- 超时无回应后的确定性升级不得等待 MiMo；
- MiMo 后到结果不得撤销、降级或推迟已触发的规则家属通知；
- MiMo 超时、非法输出或断网时输出合法 `degraded` 决策；
- 本版不包含牙疼、授权、行动卡或家属确认字段。

## 12. InteractionResponse：C → B

```json
{
  "schema_version": "reme-interaction-response/v0-experiment",
  "scene_id": "live-camera-001",
  "decision_id": "decision-0007",
  "timestamp_ms": 18600.0,
  "response": "safe",
  "source": "user_input"
}
```

`response`：

```text
safe
need_help
unclear
none
```

`source`：

```text
user_input
script
timeout
```

约束：

- `decision_id` 必须对应触发本次询问的 CareDecision；
- `none` 只能由超时或明确脚本触发；
- C 不直接生成家属通知；
- B 最多允许一次澄清询问，避免无限循环；
- 自由文本主诉和具体产品故事暂不进入本版接口。

## 13. 2D 推理与 3D 展示

实时模式：

```text
MoveNet 2D 推理
→ C 将 2D 关键点映射到 Three.js 平面或浅深度空间
→ 展示型 3D
```

必须标注为“2D关键点三维可视化”，不得声称实时 MotionBERT 3D 推理。

预录模式可以使用：

```text
MoveNet 2D
→ MotionBERT 根节点相对 3D
→ Three.js
```

预录 `poses3d.json` 使用 `reme-keypoints-3d/v0-experiment`，其坐标不是人物在房间中的绝对位置，也不是医学级测量。

## 14. 传输与 Adapter

协议类型冻结为：

- C → A/B 启动、停止、切换：HTTP 请求；
- A → B/C 关键点、姿态和事件：WebSocket 事件流；
- B → C 决策和状态：WebSocket 事件流；
- C → B 用户回应：HTTP 请求并返回明确成功或失败；
- 预录模式通过 Playback Adapter 读取 manifest 和记录流，但页面组件消费同一种 payload。

具体 URL、Web框架和进程部署拓扑暂不冻结。

## 15. 实时性能目标

以下是目标，不是已经测得的结果：

| 指标 | 目标 |
|---|---:|
| 摄像头预览 | 约 30 FPS |
| MoveNet 推理 | 至少 15 FPS |
| 姿态分类输出 | 5–10 Hz |
| 关键点到页面延迟 | P95 ≤ 300 ms |
| 姿态标签到页面延迟 | P95 ≤ 500 ms |
| MiMo 触发后首个决策 | 目标 ≤ 8 s |
| 连续运行 | 至少 10 分钟无崩溃 |

所有指标必须记录测试设备、模型、分辨率和场景，不能把目标写成实测结论。

## 16. 隐私、存储与失败

实时摄像头默认：

- 画面只在内存中处理；
- 原始帧不落盘；
- 原始视频不自动录制；
- 允许保存关键点、姿态、事件、决策和性能日志；
- 只有用户明确开始录制时才建立录像会话。

预录演示视频是团队明确准备的受控素材，不属于“默认录制实时摄像头”。

失败策略：

- 摄像头、A或B失败时回报 `degraded`；
- C 明确显示错误，不伪装为实时成功；
- 不自动、静默切换预录模式；
- 用户显式切换时创建新的 `session_id`；
- B/MiMo失败不影响A继续输出感知状态，但C必须分别显示感知和决策可用性。

## 17. 当前验收顺序

### P0：现在完成

1. RuntimeSession 请求、状态和事件信封；
2. 当前电脑摄像头实时取帧；
3. MoveNet 2D 实时关键点；
4. 静态姿态分类与 `unknown`；
5. C 实时视频、2D骨架和展示型3D；
6. B 完整实时状态机和事件触发式 MiMo；
7. A/B/C 在同一个 `session_id` 下连续运行10分钟。

### P1：基础能力稳定后

1. `fall_like_transition` 和持续静止；
2. 预录视频 Playback Adapter；
3. 预录感知与预录决策结果生成；
4. 比赛视频内容、故事和录制计划；
5. Mock/Record兜底和路演脚本。

## 18. 暂不冻结

- 比赛最终录制几个视频；
- 每个视频的故事内容；
- 牙疼、授权、行动卡等产品叙事；
- 最终姿态模型类型和准确率；
- Conv1D窗口和阈值；
- Structured或Visual哪条是MiMo主路径；
- 精确HTTP URL、框架和部署拓扑；
- 树莓派和涂鸦屏角色；
- 多人姿态；
- 医疗级判断或真实急救服务接入。
