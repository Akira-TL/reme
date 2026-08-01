# A / B / C 共享实验接口合同

- Type: spec
- Status: accepted-for-demo
- Date: 2026-08-01
- Owners: A / B / C
- Scope: 姿态感知、MiMo 决策与软件演示之间的数据接口
- Version policy: `v0-experiment`，联合验收前允许修改，不是永久产品合同

## 1. 目的

本文件是 A、B、C 之间接口命名、数据所有权、时间语义、失败状态和演示适配方式的唯一协调来源。

它解决以下问题：

1. A、B、C 不再分别维护互相冲突的字段名；
2. B 不需要消费逐帧骨架才能进行关怀决策；
3. C 不需要理解姿态模型或复制 B 的风险规则；
4. 离线回放、Mock 和在线 MiMo 使用同一业务数据形状；
5. `unknown`、低质量、超时和降级结果在接口中显式可见；
6. 接口冻结后再拆分实现 Ticket，避免把冲突复制到每张票。

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
- 在线、Mock、录制回放是同一接口的不同 Adapter。

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
    "local_path": "148703662.mp4",
    "sha256": "6b17dd3c2efdba0e4dff19b6d72836580dafa6bbe632eee5d5430df2eb5743cc",
    "width": 1280,
    "height": 720,
    "fps": 30.0,
    "frame_count": 2370,
    "duration_ms": 79000
  },
  "streams": {
    "keypoints_2d": "keypoints_2d.jsonl",
    "keypoints_3d": null,
    "posture_observations": "posture_observations.jsonl",
    "transition_events": "transition_events.jsonl",
    "recorded_decisions": null
  }
}
```

规则：

- `local_path` 只能是本地或演示包内引用，不是公网 URL；
- B 可以按 ADR-0003 从本地媒体抽取最小视觉上下文；
- A 不负责上传媒体；
- `streams` 中未提供的可选文件使用 `null`；
- C 以 manifest 作为场景入口，不猜测文件名。

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

约束：

- `risk_level` 为 `0..4`；
- `need_dialogue = false` 时，`elder_message` 应为 `null`；
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
  "response": "safe",
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
```

### 11.2 `source`

```text
user_input
script
timeout
```

约束：

- `decision_id` 必须对应触发本次询问的 CareDecision；
- `none` 只能由超时或明确的脚本无回应触发；
- C 不直接把回应转换为家属通知；C 提交回应，B 返回下一条 CareDecision；
- B 最多允许一次澄清询问，避免无限交互循环。

## 12. SceneBundle 目录结构

```text
scene-bundle/
├── manifest.json
├── keypoints_2d.jsonl
├── keypoints_3d.jsonl              # 可选
├── posture_observations.jsonl
├── transition_events.jsonl
└── recorded_decisions.jsonl        # record 模式可选
```

职责：

- A 生成 manifest、2D/3D 关键点、姿态观察和转变事件；
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

## 14. 联合验收场景

### 场景一：正常站立

- A：`posture = standing`，无转变事件；
- B：`state = normal`、`risk_level = 0`、`action = none`；
- C：同步显示骨架与正常状态，不展示主动询问。

### 场景二：隐私状态

- A：继续提供骨架和姿态事实；
- B：输出 `privacy_mode = skeleton_only` 或 `hidden`；
- C：立即按模式隐藏/遮挡原图，骨架仍可展示。

### 场景三：跌倒式转变后无回应

- A：输出 `fall_like_transition`，之后姿态低位且运动低；
- B：先输出 `check_in_required`；
- C：展示询问并提交 `response = none`；
- B：返回 `family_notification_required`；
- C：展示家属通知。

### 场景四：接口降级

- A 数据质量不可用或 B 的 MiMo 超时；
- B：输出 `state = degraded`、`fallback_used = true`；
- C：明确展示降级，不伪装为正常在线推理。

## 15. 接口冻结条件

在拆分 A/B/C 实现 Ticket 前，三方必须确认：

- [ ] 统一使用 `posture`；
- [ ] 统一使用 `posture_duration_ms`；
- [ ] 统一使用 `landmark_quality`；
- [ ] 所有时间均为视频起点毫秒偏移；
- [ ] A 的逐帧关键点与低频语义结果分流；
- [ ] 转变事件不重复输出 `possible_fall`；
- [ ] 持续静止由 A 输出事实、B 解释是否需要关怀；
- [ ] C 通过 manifest 读取场景；
- [ ] C 提交回应后由 B 决定下一步；
- [ ] `live / mock / record` 共用 CareDecision 形状；
- [ ] Visual 路径真实记录发送窗口和帧数；
- [ ] 至少准备一组完整样例通过 A→B→C 人工回放评审。

三方确认后：

1. 将 Status 改为 `accepted-for-demo`；
2. 同步更新 A/B/C 各自规格中的冲突示例；
3. 为各接口建立可执行契约测试；
4. 再执行 `/to-tickets` 拆分实现工作。

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
