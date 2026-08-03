# ADR-0012: 路演中的匿名多人姿态投影

- Status: Accepted for LBX demo feasibility
- Capability gate: Pending target-phone measurement
- Date: 2026-08-02
- Owner: C（LBX 公网共享 Demo）
- Depends on: ADR-0008、ADR-0010、ADR-0011

## 背景

LBX 评委端目前只接收严格的 `movenet-17/v1-demo` 单人姿态帧。用户希望在监控端提供“单人火柴人 / 多人火柴人”按钮，让评委在多人同时进入画面时看到多个真实检测到的匿名骨架。

现有 MoveNet Lightning 权重及其输出合同都是 SinglePose；把同一组关键点平移、复制或随机扰动成多个骨架会伪造能力，也会让人数、遮挡和失败状态不可验证。仓库已经随前端打包 MediaPipe Pose Landmarker 及本地模型资产，其 API 提供可配置的 `numPoses`，因此它可以作为多人候选提取器进入真实设备实验，但尚没有目标手机的多人覆盖率、性能或稳定性证据。

多人展示还会扩大占用人数和动作模式的可观察面。它不能被静默接入现有跌倒、做饭、语音、心跳卡或媒体授权链，也不能改变 ADR-0011 对完全隐私、实景替换和媒体失败的优先级。

## 决议

### 1. 两种投影模式

监控端提供一个显式的投影模式切换：

- `single`（“单人火柴人”）继续使用现有 MoveNet SinglePose 和 `movenet-17/v1-demo`，其字段、阈值、Relay 校验、跌倒消费者和回归合同全部保持不变。
- `multi`（“多人火柴人 · 实验”）使用 MediaPipe 的真实多人输出，并只发布新的 `reme-pose-batch-17/v1-demo`。每帧包含 `0..4` 个匿名姿态候选。

模式只决定抽象人物的投影来源，不是场景、身份或人数统计。切换模式不能创建、升级、解除或延迟任何既有告警，也不能自动启动 MiMo、音频采集、做饭识别、家庭心跳、receipt、verified activity、care card 或 media grant。既有服务端权威告警不会因切换模式被清除或降级。为避免把展示切换误当作安全开关，只要单人跌倒规则已启用或安全事件仍未回到 `idle`，控制端就禁止切入 `multi`；操作者必须先按既有权威流程关闭事件。

在 `multi` 下手动进入跌倒场景只切换视觉展示，不会预授权麦克风或启动单人 MoveNet 跌倒规则。控制端必须显式说明这一限制，并提供独立的“切为单人并启用真实跌倒规则”动作；该动作本身是操作者明确启用安全演示链路，不得由画面候选数自动执行。

多人模式的帧仅允许进入严格协议校验、最新帧快照和评委端骨架渲染。现有 fall/cooking/voice/card/receipt/grant 的生产者与消费者不得接受该批量帧作为证据。后续若希望多人姿态参与安全判断，必须另立可行性规格和 ADR。

### 2. 新的严格批量合同与清场合同

`reme-pose-batch-17/v1-demo` 顶层只允许以下精确字段：

```json
{
  "schema_version": "reme-pose-batch-17/v1-demo",
  "session_id": "opaque-session-id",
  "sequence": 42,
  "timestamp_ms": 1234.5,
  "source_width": 1280,
  "source_height": 720,
  "poses": [
    {
      "landmark_quality": "usable",
      "keypoints": [
        { "name": "nose", "x": 0.5, "y": 0.2, "score": 0.9 }
      ]
    }
  ]
}
```

上例为缩写；每个 `keypoints` 必须恰好包含以下 17 点，顺序与现有 MoveNet 合同完全一致：

`nose, left_eye, right_eye, left_ear, right_ear, left_shoulder, right_shoulder, left_elbow, right_elbow, left_wrist, right_wrist, left_hip, right_hip, left_knee, right_knee, left_ankle, right_ankle`。

合同不包含也不允许 `person_id`、`track_id`、姓名、embedding、框、轨迹、跨帧关联或重识别字段。`poses` 的数组下标只属于当前一帧；下一帧顺序可以变化，不能把颜色、位置或数组下标解释成同一个人。人物离开后不保留槽位，也不发送墓碑或历史轨迹。

其他不变量：

- `poses` 长度必须为 `0..4`；`0` 是有效的“当前没有可投影姿态候选”，不是协议错误。
- 每个 pose 只允许 `landmark_quality` 与 `keypoints`；`landmark_quality` 只允许 `usable | degraded`。没有达到最小躯干可见条件的候选不进入数组。
- 每个 keypoint 只允许 `name / x / y / score`；坐标与 score 必须是有限的 `[0,1]` 数。
- `session_id`、时间、尺寸与序列约束沿用现有单人帧；单人与多人模式共享同一个单调 `sequence` 游标，切换模式不得重置序号。
- Relay 对整帧做原子校验：未知字段、错误点序、缺点、超过四个 pose、非法数值、媒体字段或旧 session 均拒绝；不得只截取或修补其中一部分再广播。
- Relay 只保存当前会话最新一个被接受的姿态帧快照，无论其为单人或多人 schema；不持久化姿态历史。晚加入 viewer 只得到该最新快照。

模式切换、停止采集和页面隐藏不能等到新模型首帧才清场。控制端必须在同一个 frame cursor 上发布精确的 `reme-pose-reset/v1-demo`：

```json
{
  "schema_version": "reme-pose-reset/v1-demo",
  "session_id": "opaque-session-id",
  "sequence": 43,
  "timestamp_ms": 1235,
  "pose_mode": "multi"
}
```

该 reset 不包含 pose，消费共享 `sequence`，替换 Relay 的 latest snapshot，并让现有与晚加入 viewer 清除人物层。它不进入任何事件或媒体权威链。

控制 socket 异常消失时，Relay 另发不消费 cursor、也不持久化的 `pose_projection_unavailable`，其中 `through_sequence` 指明最多可清除到哪个旧帧。viewer 只在当前帧序号不高于该边界时清场，因此旧 controller 的迟到 close 不能清掉重连 controller 的新帧。该消息也不修改 lease、event cursor、activity、grant、watchdog 或 checkpoint。

### 3. 真实检测，不制造多人

多人候选必须逐一来自同一次 MediaPipe `PoseLandmarker` 结果中的不同 `landmarks[i]`。实现可以把 MediaPipe 33 点投影为合同所需的 17 点，但不得：

- 复制 MoveNet 的单人结果；
- 对同一 pose 做平移、缩放、镜像或噪声扰动来填满槽位；
- 用 scripted/fallback 骨架冒充真实多人检测；
- 在只返回一个候选时凭画面人数猜出额外 pose。

MediaPipe 在 `VIDEO` 模式中可能使用库内部的时序优化；Reme 不读取、输出或依赖任何跨帧关联，也不把它描述成身份跟踪。应用层每帧重新接收匿名数组，并丢弃上帧的人物对应关系。

目标上限 `4` 是路演的带宽和构图边界，不是“房间最多四人”的结论。画面超过四人时只能说明最多展示四个候选，UI 不得把 `poses.length` 包装成可靠的实际人数。

### 4. 场景、媒体与 fail-close

ADR-0011 的视觉优先级继续高于单/多人投影：

1. 完全隐私仍为纯色安全背景 + 当前有效骨架，禁止家具和真实像素。
2. 有效的权威跌倒或真实做饭 media grant 仍以实时视频替换所有骨架和背景板。
3. 日常、厨房未确认和跌倒 `checking` 才显示通用环境抽象 + 当前模式的骨架。
4. 连接、模型、协议或帧新鲜度失败时清除人物层并明确显示不可用；不得保留最后一帧、克隆单人或静默切换到演示数据。

模式切换必须使用采集代次防止旧异步结果回写。切换后先同步清除旧人物层；只有新代次的有效帧可重新显示。页面隐藏同步增加推理代次并发布 reset；恢复可见时重置新鲜度期限，但仍必须等同一个解码计数器严格增长后才恢复推理。停止采集、session/租约变化或断线仍按既有生命周期 fail close。浏览器若没有可靠的单调解码帧计数、计数连续三秒不增长，或单次推理三秒内不能 settle，人物层必须在有界时间内清除；不得使用裸 `currentTime`、交替计数 API 或重复媒体事件给最后一帧续命。多人推理超时/失败后原 estimator 必须作废，显式重试加载新实例；资源释放不得反向卡住摄像头停止、控制权释放或新一代采集。

多人姿态仍是由本机原始摄像头帧计算出的派生数据。原始帧不进入姿态 WebSocket、Durable Object、事件合同或持久存储；批量关键点也不得进入浏览器持久存储或历史日志。评委会看到多个骨架，因此路演必须使用知情参与者，并明确这是匿名姿态候选而非身份或人数识别。

## Capability Gate

本 ADR 接受的是隔离后的实验边界，不是多人能力已经通过。以下证据仍为 pending：

- 目标手机上 `0..4` 人的实际检出、漏检、重复候选和遮挡/交叉失败；
- MediaPipe 33→17 投影后的关键点可用性与可见失败；
- 与现有单人模式相比的推理时延、交付帧率、帧新鲜度、内存、温升和页面稳定性；
- 竖屏后置摄像头、前后台恢复、进入/离开画面和超过四人的表现；
- 监控端、Relay 与多个 viewer 在模式切换、晚加入、乱序、断线和恢复时的 fail-close；
- batch 帧对 alarm/activity/voice/card/receipt/grant 权威快照确实为零影响。

Pilot 必须先冻结目标手机、模型选项、输入尺寸、采样频率、匹配方法和 Go/No-go 阈值，再用未参与调参的 Holdout 裁决。当前不得编造人数准确率、姿态准确率、帧率、时延或泛化结论。

## 不接受的替代

- **把单人骨架 clone 成多人**：拒绝。它是伪造画面，不是模型能力。
- **修改 `movenet-17/v1-demo` 兼容数组**：拒绝。会破坏严格单人合同和现有安全回归；多人必须使用新 schema。
- **给 pose 分配稳定 ID 或颜色并跨帧关联**：拒绝。超出当前隐私与可行性范围。
- **用多人帧直接驱动跌倒/做饭/语音/卡片/授权**：拒绝。当前实验只验证投影，不验证多主体安全语义。
- **模型失败后静默回放或复制 fallback**：拒绝。必须清除人物层并显示不可用，允许操作者显式切回单人模式。
- **把四候选上限称为准确人数统计**：拒绝。截断、遮挡和重复候选尚未测量。

## 后果

- 评委端可在同一四场景视觉语言中切换单个或多个匿名火柴人，而不改写现有单人 MoveNet 和权威告警链。
- Relay 与 viewer 需要严格支持两个姿态数据 schema、一个共享 cursor 的 reset schema，以及不消费 cursor 的断线 unavailable 消息；四者必须共享同一 fail-close 生命周期而不进入事件权威面。
- 多人模式引入额外本地计算和占用信息暴露，只有目标手机 Gate 通过后才能作为路演主路径；否则保留明确不可用状态与单人 fallback。
- 本 ADR 不接受多主体跌倒归因、身份持续性、人员进出统计、家庭成员识别或生产级多人监控。
