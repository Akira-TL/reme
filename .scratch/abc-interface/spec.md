# A / B / C 共享实验接口合同

- Type: spec
- Status: accepted-for-demo
- Acceptance scope: 字段语义、所有权和适配边界已接受
- End-to-end readiness: implementation-in-progress
- Date: 2026-08-01
- Owners: A / B / C
- Scope: 姿态感知、MiMo 决策与软件演示之间的数据接口
- Version policy: `v0-experiment`，端到端验收前允许兼容性增补，不是永久产品合同

## 1. 目的

本文件是 A、B、C 之间接口命名、数据所有权、时间语义、失败状态和演示适配方式的唯一协调来源。

它解决以下问题：

1. A、B、C 不再分别维护互相冲突的字段名；
2. B 不需要消费逐帧骨架才能进行关怀决策；
3. C 不需要理解姿态模型或复制 B 的风险规则；
4. 离线回放、Mock 和在线 MiMo 使用同一业务数据形状；
5. `unknown`、低质量、超时和降级结果在接口中显式可见；
6. 字段语义接受后再拆分实现 Ticket，避免把冲突复制到每张票；
7. “合同已接受”和“端到端演示已验收”分别记录，不再用一个状态混合表达。

## 2. 模块与接口

项目采用三个外部接口和一个本地媒体引用：

```text
A Perception Module
  ├─ FrameLandmarkStream ─────────────→ C Demo Module
  ├─ PostureObservationStream ────────→ B Decision Module / C Demo Module
  ├─ TransitionEventStream ───────────→ B Decision Module / C Demo Module
  └─ SceneManifest + LocalMediaRef ───→ B Decision Module / C Demo Module

B Decision Module
  └─ CareDecisionStream ──────────────→ C Demo Module

C Demo Module
  └─ InteractionResponse ─────────────→ B Decision Module
```

接口设计原则：

- A 输出动作事实和质量信息，不输出“是否报警”等关怀结论；
- B 消费低频语义结果并输出业务决策，不要求逐帧消费 17 点数据；
- C 只渲染 A/B 的结果并提交用户回应，不自行分类姿态或推断风险；
- 原始视频通过受控本地引用交接，不嵌入 JSONL；
- 在线、Mock、录制回放是同一接口的不同 Adapter；
- 比赛感知输入采用多个预录视频场景包，不依赖现场摄像头实时推断；
- `demo_mode = live` 仅表示 B/MiMo 决策链路真实运行，不表示视频来源是实时摄像头。

## 3. 统一领域术语

| 术语 | 定义 | 所有者 |
|---|---|---|
| `FrameLandmarks` | 某个视频时间点的 17 点人体关键点与质量信息 | A |
| `PostureObservation` | 某个时间点的静态姿态观察，不表示跌倒或风险 | A |
| `TransitionEvent` | 一个时间窗口内的动作转变假设 | A |
| `CareDecision` | 根据感知、上下文和交互状态生成的关怀决策 | B |
| `InteractionResponse` | 老人端真实、模拟或超时回应 | C 提交，B 消费 |
| `PrivacyMode` | B 告知 C 如何展示原始画面的渲染指令 | B |
| `SceneBundle` | 一个演示场景的媒体、感知结果和可选录制决策集合 | A/B 生成，C 消费 |

必须区分：

- `posture = lying`：静态躺卧观察；
- `transition = fall_like_transition`：时间窗口内的跌倒式转变假设；
- `risk_level`：B 根据多项上下文给出的业务风险级别。

三者不得互相替代。

## 4. 全局约定

### 4.1 标识与版本

所有记录必须包含：

- `schema_version`：该记录类型的接口版本；
- `scene_id`：场景稳定标识。

推荐版本：

| 记录 | 版本 |
|---|---|
| 场景清单 | `reme-scene/v0-experiment` |
| 2D 关键点 | `movenet-17/v0-experiment` |
| 3D 关键点 | `reme-keypoints-3d/v0-experiment` |
| 姿态观察 | `reme-posture/v0-experiment` |
| 转变事件 | `reme-transition/v0-experiment` |
| 关怀决策 | `reme-care-decision/v0-experiment` |
| 交互回应 | `reme-interaction-response/v0-experiment` |

禁止使用含义不明的 `candidate-v1` 或仅写 `0.1`。

### 4.2 时间轴

- `timestamp_ms`、`start_ms`、`end_ms` 均表示从场景视频起点开始的毫秒偏移；
- 值允许为整数或小数，例如 30 FPS 视频可以输出 `33.333`；
- `frame_index` 从 `0` 开始；
- JSONL 按时间升序写入；
- 不在场景数据中混入系统墙上时间；
- B/C 需要墙上时间时应使用独立字段，不覆盖视频偏移时间。

### 4.3 枚举和值域

#### 静态姿态 `posture`

```text
standing
sitting
lying
bending_or_crouching
unknown
```

#### 动作转变 `transition`

```text
normal_transition
fall_like_transition
uncertain_transition
```

#### 运动程度 `motion_level`

```text
still
low
medium
high
unknown
```

#### 关键点质量 `landmark_quality`

```text
usable
degraded
unavailable
```

#### 不确定性 `uncertainty`

```text
low
medium
high
unknown
```

所有置信度字段范围为 `0.0..1.0`。置信度表示模型或规则的证据强度，不得表述为医疗准确率。

### 4.4 缺失与失败

- 已知无人体：`person_detected = false`；
- 人体存在但证据不足：`posture = unknown`；
- 关键点不可用：`landmark_quality = unavailable`；
- 转变无法判断：`transition = uncertain_transition`；
- MiMo 超时或结构校验失败：B 输出 `state = degraded`，不得让 C 猜测；
- 可空文本字段使用 JSON `null`，禁止使用空字符串表达“没有内容”。

## 5. SceneManifest：A → B / C

每个场景提供一个 `manifest.json`。

```json
{
  "schema_version": "reme-scene/v0-experiment",
  "scene_id": "fall_demo_01",
  "title": "疑似跌倒后无回应",
  "media": {
    "local_path": "media/source.mp4",
    "source_type": "prerecorded_video",
    "sha256": "6b17dd3c2efdba0e4dff19b6d72836580dafa6bbe632eee5d5430df2eb5743cc",
    "width": 1280,
    "height": 720,
    "fps": 30.0,
    "frame_count": 2370,
    "duration_ms": 79000,
    "demo_time_scale": 30.0
  },
  "streams": {
    "keypoints_2d": "keypoints_2d.jsonl",
    "keypoints_3d": "derived/poses3d.json",
    "posture_observations": "posture_observations.jsonl",
    "transition_events": "transition_events.jsonl",
    "recorded_decisions": null
  }
}
```

规则：

- `local_path` 只能是本地或演示包内引用，不是公网 URL；
- `source_type` 当前固定为 `prerecorded_video`；比赛通过多个 SceneBundle 切换视频场景，不依赖现场摄像头；
- `demo_time_scale` 为可选正数，默认 `1.0`；它只用于 C 的叙事时长换算，不改变任何真实 `*_ms` 时间戳；
- B 的规则阈值仍使用真实视频毫秒或独立场景配置，不得用 `demo_time_scale` 伪造感知数据；
- B 可以按 ADR-0003 从本地媒体抽取最小视觉上下文；
- A 不负责上传媒体；
- `streams` 中未提供的可选文件使用 `null`；
- C 以 manifest 作为场景入口，不猜测文件名；切换场景时必须清空上一场景的决策和交互状态。

## 6. FrameLandmarks：A → C

逐帧 2D 关键点保留现有 MoveNet 输出的核心形状，但增加 `scene_id` 和统一质量字段。

```json
{
  "schema_version": "movenet-17/v0-experiment",
  "scene_id": "fall_demo_01",
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

- `keypoints` 正常情况下包含 MoveNet 顺序的 17 点；
- `x_norm`、`y_norm` 范围为 `0.0..1.0`；
- 坐标原点为图像左上角，x 向右、y 向下；
- `score` 是单点可见性/模型分数；
- 不允许将低分点悄悄替换为 `(0, 0)`；
- 若缺点，保留该点名称并将坐标设为 `null`，分数保留实际值；
- C 根据 `frame_index` 或 `timestamp_ms` 同步，不重新运行模型。

B 默认不消费此逐帧流。B 需要视觉上下文时，通过 manifest 中的本地媒体引用抽帧，而不是让 A 把像素塞进关键点接口。

### 6.1 Keypoints3D：A → C（可选）

当前 MotionBERT 产物使用一个完整 JSON 文件，而不是 JSONL：

```json
{
  "schema_version": "reme-keypoints-3d/v0-experiment",
  "scene_id": "fall_demo_01",
  "source_schema": "motionbert-h36m-17/offline-demo-v1",
  "model": {
    "name": "MotionBERT DSTFormer",
    "representation": "monocular root-relative 3D pose estimate"
  },
  "video": {
    "fps": 30.0,
    "frame_count": 2370,
    "duration_seconds": 79.0
  },
  "coordinate_system": {
    "root_relative": true,
    "absolute_room_position": false
  },
  "joint_names": ["pelvis", "right_hip", "right_knee"],
  "edges": [[0, 1], [1, 2]],
  "frames": [[[0.0, 0.8, 0.0]]],
  "scores": [[0.9]],
  "runtime": {},
  "warning": "单目根节点相对三维估计，不是房间绝对坐标。"
}
```

约束：

- `frames` 的完整形状必须为 `frame_count × 17 × 3`；
- `joint_names` 固定为 H36M 17 点顺序，`edges` 只引用有效点索引；
- 所有坐标必须为有限数值；
- `scene_id` 和 `frame_count` 必须与 manifest 一致；
- C 可以通过 Three.js 渲染，但不得把它描述为真实房间坐标或医学测量；
- 该流用于可视化，不替代 2D 关键点、姿态观察或转变事件。

## 7. PostureObservation：A → B / C

```json
{
  "schema_version": "reme-posture/v0-experiment",
  "scene_id": "fall_demo_01",
  "timestamp_ms": 12500.0,
  "frame_index": 375,
  "person_detected": true,
  "posture": "lying",
  "posture_confidence": 0.88,
  "posture_duration_ms": 4200,
  "motion_level": "low",
  "visible_keypoint_ratio": 0.94,
  "landmark_quality": "usable"
}
```

约束：

- 字段统一使用 `posture`，禁止混用 `pose`、`pose_state`；
- 字段统一使用 `posture_duration_ms`，禁止混用 `pose_duration_ms`；
- `posture_duration_ms` 表示当前连续姿态段持续时间；
- `posture = unknown` 时仍需提供质量信息；
- 采样频率可以低于视频帧率，但必须按时间升序；
- C 在任意播放时刻使用“不晚于当前时间的最新观察”；
- B 可以按当前时间窗聚合最近观察，但不得修改 A 的原始结果。

## 8. TransitionEvent：A → B / C

```json
{
  "schema_version": "reme-transition/v0-experiment",
  "scene_id": "fall_demo_01",
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

- `end_ms >= start_ms`；
- `event_id` 在当前场景内唯一；
- 不再同时输出语义重复的 `candidate_event = possible_fall`；
- B 可以把 `fall_like_transition` 与后续姿态、静止、回应等组合为内部 `possible_fall` 上下文；
- `lying` 单独存在时不得生成 `fall_like_transition`；
- C 只显示 A 给出的转变标签和证据，不把它升级为关怀风险。

持续静止不放入该接口。A 通过 `posture_duration_ms` 与 `motion_level` 提供客观事实，由 B 根据产品策略判断是否构成需要关怀的持续状态。

## 9. B 内部决策输入

B 通过 `scene_id` 和时间轴组合：

- 最新 `PostureObservation`；
- 当前或最近的 `TransitionEvent`；
- 老人回应状态；
- 最近决策；
- 可选视觉上下文；
- Demo 模式。

B 可以形成内部 `DecisionContext`，但该内部对象不属于 A/C 必须学习的外部接口。

A 不需要为 B 再生成一份把所有字段复制到一起的“大 JSON”。

## 10. CareDecision：B → C

```json
{
  "schema_version": "reme-care-decision/v0-experiment",
  "scene_id": "fall_demo_01",
  "decision_id": "decision-0007",
  "timestamp_ms": 12800.0,
  "state": "check_in_required",
  "risk_level": 2,
  "privacy_mode": "skeleton_only",
  "need_dialogue": true,
  "dialogue_goal": "confirm_safety",
  "elder_message": "您还好吗？需要我帮您联系家人吗？",
  "family_notification": null,
  "consent_required": false,
  "response_timeout_ms": 8000,
  "action_card": null,
  "action": "ask_elder",
  "reason_summary": "检测到跌倒式转变，随后处于低运动状态。",
  "uncertainty": "medium",
  "fallback_used": false,
  "source": "mimo",
  "demo_mode": "live",
  "visual_context": {
    "sent_to_mimo": true,
    "type": "keyframes",
    "start_ms": 11100.0,
    "end_ms": 12700.0,
    "sample_count": 3
  }
}
```

### 10.1 `state`

```text
normal
observe
check_in_required
consent_required
family_notification_required
urgent_attention
resolved
degraded
```

### 10.2 `privacy_mode`

```text
visible
blurred
skeleton_only
hidden
```

### 10.3 `action`

```text
none
observe
ask_elder
notify_family
show_urgent_attention
mark_resolved
```

### 10.4 `source`

```text
rule
mimo
mock
record
degraded
```

### 10.5 `demo_mode`

```text
live
mock
record
```

### 10.6 `action_card`（可选）

行动卡只在“具体需求闭环”视频场景中出现；字段一旦非空，六项内容必须齐全：

```json
{
  "event": "长时间静坐 + 主诉牙疼",
  "elder_quote": "牙疼，饭咬不动。",
  "system_judgment": "疑似口腔问题影响进食，非紧急",
  "suggested_action": "本周内预约口腔科检查",
  "time_window": "3 天内",
  "status": "pending"
}
```

`status` 只允许：

```text
pending
confirmed
done
```

约束：

- `risk_level` 为 `0..4`；`state = consent_required` 仍属于风险等级 2，它表示等待授权，不表示风险升级；
- `need_dialogue = false` 时，`elder_message` 应为 `null`；
- `response_timeout_ms` 是从 C 收到当前 CareDecision 起计算的相对倒计时；使用相对时长是因为比赛输入为预录视频，交互可能发生在视频暂停或结束后；
- 高置信 `fall_like_transition` 触发询问时，`response_timeout_ms` 不得为 `null`；
- 超时收到 `response = none` 后，B 必须通过 `source = rule` 输出 `family_notification_required` 或 `urgent_attention`，不得等待 MiMo；
- MiMo 后到结果不得取消、降级或推迟已经触发的规则家属告警，只能补充解释文本；
- `consent_required = true` 且尚未收到 `consent_granted` 时，`action` 不得为 `notify_family`；
- `action_card` 非空时六项字段必须完整；
- `action = notify_family` 时，`family_notification` 不得为 `null`；
- MiMo 超时、非法输出或断网时必须输出合法的降级决策；
- C 根据 `privacy_mode` 渲染，不根据 `reason_summary` 猜测展示方式；
- C 根据 `action` 展示当前动作，不从自然语言推断下一步；
- `visual_context.sent_to_mimo` 必须反映真实行为。

## 11. InteractionResponse：C → B

```json
{
  "schema_version": "reme-interaction-response/v0-experiment",
  "scene_id": "fall_demo_01",
  "decision_id": "decision-0007",
  "timestamp_ms": 18600.0,
  "response": "need_help",
  "text": "牙疼，饭咬不动。",
  "source": "user_input",
  "demo_mode": "live"
}
```

### 11.1 `response`

```text
safe
need_help
unclear
none
consent_granted
consent_denied
card_confirmed
```

### 11.2 `source`

```text
user_input
family_input
script
timeout
```

约束：

- `decision_id` 必须对应触发本次询问的 CareDecision；
- `text` 为可空字段，只能在 `source = user_input | script` 时承载老人主诉或补充说明；`source = timeout` 时必须为 `null`；
- `none` 只能由超时或明确的脚本无回应触发；
- `consent_granted`、`consent_denied` 只响应 `consent_required = true` 的决策；
- `card_confirmed` 只能由家属视图以 `source = family_input` 提交；
- C 不直接把回应转换为家属通知；C 提交回应，B 返回下一条 CareDecision；
- B 最多允许一次澄清询问，避免无限交互循环。

## 12. SceneBundle 目录结构

```text
scene-bundle/
├── manifest.json
├── media/
│   └── source.mp4
├── keypoints_2d.jsonl
├── derived/
│   └── poses3d.json                # 可选，完整 JSON，不是 JSONL
├── posture_observations.jsonl
├── transition_events.jsonl
└── recorded_decisions.jsonl        # record 模式可选
```

职责：

- A 生成 manifest、2D/3D 关键点、姿态观察和转变事件；
- 每个 SceneBundle 对应一个预录视频场景；多个比赛场景通过多个 manifest 切换；
- B 在 record 模式生成 recorded decisions；
- C 只通过 manifest 定位其他文件；
- 大视频和模型产物放入 Git 忽略的 `artifacts/`；
- 可审查的规格、样例和测试夹具放入 `.scratch/abc-interface/`。

## 13. Adapter 约定

### 13.1 C 的感知 Adapter

C 应实现一个统一读取接口：

```text
loadScene(manifest)
getFrameLandmarks(timestampMs)
getPostureObservation(timestampMs)
getActiveTransitionEvents(timestampMs)
```

实现可以读取预生成文件，也可以以后连接实时流；页面组件不感知差异。

### 13.2 C 的决策 Adapter

```text
getCareDecision(context) -> CareDecision
submitInteractionResponse(response) -> CareDecision
```

至少存在两种 Adapter，接口才是真实 seam：

- Online/Mock Adapter：请求 B；
- Record Adapter：读取 `recorded_decisions.jsonl`。

C 页面不得直接依赖 MiMo 请求格式。

## 14. 离线多视频联合验收场景

比赛使用多个预录视频 SceneBundle，而不是现场摄像头实时输入。每个视频都预计算 A 的感知流；B 可以对该预录数据真实调用 MiMo，也可以切换 Mock/Record Adapter。

评委侧默认不展示可轻易识别人物的清晰画面：

| 视频场景 | 评委侧默认 `privacy_mode` | 说明 |
|---|---|---|
| 正常活动 | `blurred` | 展示系统不打扰，同时保留本地视频与骨架同步关系 |
| 隐私保护 | `skeleton_only` 或 `hidden` | 主动减少人物与家庭环境暴露 |
| 具体需求闭环 | `blurred` | 重点展示对话、授权、行动卡与家属回执 |
| 跌倒式转变 | `blurred` | 重点展示询问、倒计时和规则升级；发送给 MiMo 的视觉上下文与评委画面展示是两件事 |

家属视图默认使用 `skeleton_only`，不因 B 向 MiMo 发送了视觉上下文而自动展示清晰原图。`visible` 仅用于本地调试或经过团队明确批准的演示片段。

### 视频一：正常活动、不打扰

- A：`posture = standing | sitting`，无风险转变事件；
- B：`state = normal`、`risk_level = 0`、`action = none`；
- C：同步显示模糊视频与骨架，不展示主动询问。

### 视频二：隐私保护

- A：继续提供骨架和姿态事实；
- B：输出 `privacy_mode = skeleton_only | hidden`；
- C：立即隐藏清晰画面，骨架和必要状态仍可展示。

### 视频三：具体需求与行动卡闭环（素材待制作）

- 视频内容：长时间静坐或其他非紧急关怀触发动作；
- B：输出 `check_in_required + ask_elder`；
- C：提交 `response = need_help` 和主诉 `text = "牙疼，饭咬不动。"`；
- B：通过 MiMo 理解需求，输出 `consent_required = true`；
- C：提交 `consent_granted`；
- B：输出 `notify_family`、家属通知和六要素 `action_card`；
- 家属视图：提交 `card_confirmed + family_input`；
- B：输出 `mark_resolved` 和回执文案，行动卡状态变为 `confirmed | done`。

该视频尚未拍摄不影响字段合同保留，但在素材和 fixture 完成前不得宣称闭环已经端到端完成。

### 视频四：跌倒式转变后无回应

- A：输出高置信 `fall_like_transition`，之后姿态低位且运动低；
- B：先输出 `check_in_required`，并提供 `response_timeout_ms`；
- C：展示倒计时，到期提交 `response = none, source = timeout`；
- B：不等待 MiMo，通过 `source = rule` 返回 `family_notification_required`；
- C：展示家属告警；若二次超时或规则证据继续上升，可进入 `urgent_attention`；
- 任何后到的 MiMo 结果都不能撤销已经发出的规则告警。

### 系统模式：接口降级

降级不是独立视频，可在任意上述视频上触发：

- A 数据质量不可用或 B 的 MiMo 超时；
- B：输出 `state = degraded`、`fallback_used = true`；
- C：明确展示降级，并切换 Mock 或 Record 兜底，不伪装为正常在线推理。

## 15. 合同接受与端到端验收

这里使用两个独立维度，不再要求二选一：

- `Status: accepted-for-demo` 表示字段语义、所有权和模块边界已被接受，可以据此实现；
- `End-to-end readiness: implementation-in-progress` 表示运行时代码、视频素材和联合回放尚未全部完成。

### 15.1 已接受的语义决议

- [x] 统一使用 `posture`、`posture_duration_ms`、`landmark_quality`；
- [x] 所有感知时间均为视频起点毫秒偏移，倒计时使用相对 `response_timeout_ms`；
- [x] A 的逐帧关键点与低频语义结果分流；
- [x] 转变事件不重复输出 `possible_fall`；
- [x] 持续静止由 A 输出事实、B 解释是否需要关怀；
- [x] C 通过 manifest 读取并切换预录视频场景；
- [x] C 提交回应后由 B 决定下一步；
- [x] 具体需求闭环保留 `text / consent / action_card / family_input`；
- [x] 跌倒无回应采用规则确定性升级，MiMo 不可取消；
- [x] `live / mock / record` 共用 CareDecision 形状。

### 15.2 尚待端到端验收

- [ ] B/C 对新增可空字段完成契约测试；
- [ ] Visual 路径真实记录发送窗口、载荷类型和帧数；
- [ ] 四个预录视频场景的 manifest 和 fixture 准备完成；
- [ ] 具体需求闭环视频完成拍摄并通过全链路回放；
- [ ] 跌倒式转变规则倒计时与不可取消升级通过测试；
- [ ] 至少一组完整样例通过 A→B→C 人工回放评审。

端到端项目完成时，只更新 `End-to-end readiness` 和本节勾选项，不回退已经接受的字段语义。

## 16. 暂不冻结的内容

以下内容仍由实验决定，不在本合同中提前承诺：

- 姿态模型类型和最终准确率；
- 姿态观察采样频率；
- Conv1D 的窗口长度和置信度阈值；
- 跌倒式转变能否作为真实自动能力展示；
- Structured 或 Visual 哪条作为 MiMo 主路径；
- 具体 HTTP URL、框架和部署拓扑；
- Raspberry Pi 与涂鸦屏的最终角色；
- 医疗级判断或真实急救服务接入。
