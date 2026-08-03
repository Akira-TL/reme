# 单人 / 多人火柴人投影可行性规格

- Type: feasibility spec
- Status: accepted-for-experiment
- Capability gate: pending target-phone measurement
- Owner: C / Monitor + Viewer + Relay
- Date: 2026-08-02
- Branch boundary: 最终交付只允许进入 `lbx`；本规格不授权推送或部署
- Related: `CONTEXT.md`、ADR-0008、ADR-0010、ADR-0011、ADR-0012

## 1. 用户目标

在监控端提供一个清楚的二选一按钮：

- **单人火柴人**：沿用现有 MoveNet SinglePose 主路径；
- **多人火柴人 · 实验**：从同一后置摄像头逐帧检测并投影最多四个真实姿态候选。

评委端随最新有效姿态 schema 显示当前模式。两个模式都继续服从四场景视觉策略；它们不新增场景，也不改变日常、做饭、完全隐私或跌倒的媒体授权规则。

本实验只回答“目标手机能否稳定地产生并跨端展示匿名多人骨架”。它不回答多人跌倒归因、做饭主体归因、身份、跟踪、重识别、人员进出或可靠人数统计。

## 2. 当前证据与缺口

### 已知事实

- 现有 `movenet-17/v1-demo` 是严格单人合同，MoveNet Lightning 输出一组 17 点；它不能提供真实多人结果。
- 前端已经打包 `@mediapipe/tasks-vision`、本地 WASM 和 `pose_landmarker_lite.task`；当前单机 hook 使用 `PoseLandmarker` 且配置 `numPoses: 1`。
- 当前依赖的 MediaPipe 类型合同允许设置 `numPoses`，返回 `landmarks: NormalizedLandmark[][]`，其中每个数组元素是同一帧中的一个姿态候选。
- ADR-0011 已冻结完全隐私、实景替换、最后一帧清理、断线/隐藏 fail-close 和权威媒体 Gate；多人展示不得放宽这些边界。

### 尚未验证

- 仓库中的 lite 模型在目标手机、真实后置摄像头和 `numPoses: 4` 下是否能稳定返回多个不同人物；
- 两到四人遮挡、交叉、出入画和竖屏远近差异下的漏检、重复候选与点位质量；
- 多人推理对目标手机帧率、温升、内存、电量和 WebRTC/页面稳定性的影响；
- 多 viewer、模式切换、晚加入和断线恢复是否始终清除旧骨架且不污染权威事件状态。

因此当前 Capability Gate 为 `pending`。本地资产存在、API 接受 `numPoses`、单元测试通过或桌面浏览器显示多个假数据，都不能替代目标手机证据。

## 3. 研究问题与假设

### 研究问题

在路演指定手机、后置摄像头、竖屏构图和真实参与者条件下，MediaPipe 能否逐帧输出 `0..4` 个彼此独立的姿态候选，经严格 Relay 合同同步给多个 viewer，并在失败时清楚降级，而不影响任何安全或媒体授权链？

### 零假设 H0

目标设备上的多人输出存在不可接受的漏检、重复、错位、延迟、抖动或资源问题，或隔离边界无法稳定保证；多人按钮保持不可用或仅作为失败可见的实验入口，路演继续使用单人模式。

### 备择假设 H1

在预先冻结的目标条件下，MediaPipe 的真实多人候选达到团队事先确定的投影质量和性能目标，严格合同、跨端显示与 fail-close 均通过；多人模式可以作为 demo-only 的匿名视觉增强开放。

H1 不支持外推到其他家庭、人物、机位、手机、光线，也不支持安全检测、人数统计或身份相关声明。

## 4. 模式与运行边界

### 4.1 单人模式

- 提取器：现有 MoveNet SinglePose Lightning。
- Wire schema：`movenet-17/v1-demo`，不增删字段，不改变点序、质量判断或 Relay 校验。
- 权威消费者：保持现有行为；只有该既有单人链可以按既有 Gate 进入浏览器跌倒启发式。
- 多人进入画面时，只能显示模型实际选择的一组 pose；不得声称已选中某个身份或最需要照护的人。

### 4.2 多人模式

- 提取器：本地 MediaPipe Pose Landmarker，实验起始值 `numPoses: 4`、`outputSegmentationMasks: false`。
- Wire schema：只允许 `reme-pose-batch-17/v1-demo`。
- 输出：每帧 `0..4` 个匿名 pose；少于四个结果时原样发送较少数量，不补槽位。
- 消费者：仅 Relay 严格校验/最新快照与 viewer 骨架 renderer。
- 明确隔离：batch 帧不得传入 fall detection、MiMo scene/cooking request、voice、alarm、activity、card、receipt、verified activity、media grant 或 controller authority reducer。

MediaPipe `VIDEO` 运行时可能在库内部使用时序优化；Reme 不实现、导出或依赖任何跨帧对应。`poses[0]` 在下一帧仍可能代表另一组可见点。UI 不显示人物编号、姓名、稳定颜色或轨迹。

### 4.3 模式切换

- 切换是当前控制端的显式动作；默认保持 `single`，不得因画面看起来像多人而自动切换。
- 每次切换增加本地 perception generation，同步清除旧渲染；上一代异步推理结果不得发布。
- 两个 schema 共用当前 session 的一个单调 frame `sequence`；切换不重置 sequence，Relay/viewer 继续拒绝旧序号。
- 切换时先发布共享 cursor 上的 `reme-pose-reset/v1-demo` 清场；新模式随后发布有效姿态合同。多人模式即使无人也发布 `poses: []`，让 viewer 显示真实状态。
- 新模型加载、推理或合同失败时，UI 显示“多人姿态不可用”，不 clone、不回放最后一帧、不静默切换到演示数据。操作者可以明确切回单人模式。
- 每次推理必须绑定 capture/perception generation、当前 stream、同一个可靠解码计数器和单调起始时间；三秒内未 settle 或返回时已失鲜的结果不得发布、不得进入单人 fall detector。多人失败只清人物层并作废该 estimator，显式重试必须创建新实例，不能排在可能卡死的旧推理队列后。
- 切换不得更改、关闭或重新触发现有 authority 状态。已经服务端升级的告警和有效媒体 grant 继续按 ADR-0011 投影。
- 单人跌倒规则已启用或安全事件仍非 `idle` 时禁止切入 `multi`；展示模式不能成为暂停安全检测或规避既有事件的开关。
- `multi` 下手动进入跌倒场景只展示匿名骨架，不预授权麦克风、不启动单人跌倒规则；操作者必须另行点击“切为单人并启用真实跌倒规则”，才可同时完成显式模式切换与安全演示启用。

## 5. `reme-pose-batch-17/v1-demo` 精确合同

### 5.1 顶层

顶层必须恰好包含：

| 字段 | 类型与约束 | 语义 |
|---|---|---|
| `schema_version` | 固定字符串 `reme-pose-batch-17/v1-demo` | 与单人 schema 严格区分 |
| `session_id` | 当前非空 opaque session ID | 必须匹配活跃控制会话 |
| `sequence` | 非负 safe integer | 与单人帧共享单调游标 |
| `timestamp_ms` | 有限非负数 | 本机观察到该已确认解码帧时的 wall clock，不是 Relay 接收时间 |
| `source_width` | `1..16384` safe integer | 归一化坐标对应的源宽 |
| `source_height` | `1..16384` safe integer | 归一化坐标对应的源高 |
| `poses` | 数组，长度 `0..4` | 当前帧匿名姿态候选 |

未知顶层字段一律拒绝。`poses.length` 是当前模型返回的候选数量，不是经过校准的房间人数。

### 5.2 Pose 与 keypoint

每个 pose 必须恰好包含：

| 字段 | 类型与约束 |
|---|---|
| `landmark_quality` | `usable | degraded` |
| `keypoints` | 恰好 17 个点，使用下列固定顺序 |

固定点序：

1. `nose`
2. `left_eye`
3. `right_eye`
4. `left_ear`
5. `right_ear`
6. `left_shoulder`
7. `right_shoulder`
8. `left_elbow`
9. `right_elbow`
10. `left_wrist`
11. `right_wrist`
12. `left_hip`
13. `right_hip`
14. `left_knee`
15. `right_knee`
16. `left_ankle`
17. `right_ankle`

每个 keypoint 必须恰好包含 `name / x / y / score`。`name` 必须位于对应固定下标；`x / y / score` 必须是有限 `[0,1]` 数。禁止 NaN、Infinity、null、字符串数字、坐标外推、缺点、乱序、重复点或附加 `z`。

禁止在任何层级增加 `person_id`、`track_id`、embedding、姓名、年龄、性别、身份标签、轨迹、框、图像、Base64、Blob、SDP 或 ICE。媒体与信令继续走 ADR-0008 的独立平面。

### 5.3 质量语义

实验适配器沿用当前展示层的 `0.2` 可见性 guardrail，但该数值不构成准确率或跨模型校准：

- 至少一个肩点和至少一个髋点的 `score >= 0.2`，才把该 MediaPipe 候选放入 `poses`；否则丢弃该候选。
- 上述躯干条件成立，且双肩、双髋、双膝、双踝都达到 guardrail 时为 `usable`；否则为 `degraded`。
- 不发送 `landmark_quality=unavailable` 的占位 pose；全帧没有合格候选时发送 `poses: []`。

MediaPipe 的 `score` 暂直接采用对应 NormalizedLandmark 的 `visibility`；它必须是实际 number、finite 且位于 `[0,1]`，否则该次推理显式失败，不截断、不强制转换，也不冒充可用候选。它只能表达该提取器在本次点位上的输入质量，不能与 MoveNet score 直接比较，也不能当作姿态、人数或事件置信度。Pilot 可以提出更改，但必须同时升级文档、测试和 schema 版本评审，不能静默改变语义。

### 5.4 MediaPipe 33→17 投影

适配器按固定索引一一读取每个 `landmarks[i]`，不做插值、复制或跨 pose 混合：

| 17 点名称 | MediaPipe 索引 | 17 点名称 | MediaPipe 索引 |
|---|---:|---|---:|
| nose | 0 | left_eye | 2 |
| right_eye | 5 | left_ear | 7 |
| right_ear | 8 | left_shoulder | 11 |
| right_shoulder | 12 | left_elbow | 13 |
| right_elbow | 14 | left_wrist | 15 |
| right_wrist | 16 | left_hip | 23 |
| right_hip | 24 | left_knee | 25 |
| right_knee | 26 | left_ankle | 27 |
| right_ankle | 28 |  |  |

`x/y` 使用对应 MediaPipe normalized landmark 并截断到 `[0,1]`；`z` 不离开本地适配器。若返回 pose 不是恰好 33 点，整条候选无效，不得用其他 pose 的点补齐。

### 5.5 原子校验、reset 与快照

- Relay 同时识别三个共享 cursor 的精确 wire schema：单人 `movenet-17/v1-demo`、多人 `reme-pose-batch-17/v1-demo` 与清场 `reme-pose-reset/v1-demo`，先按 `schema_version` 分派，再执行各自 exact-key 校验。
- 任一 batch 字段无效时拒绝整帧并保留上一条序列游标；不得广播有效子集或把数组截到四个。
- reset 精确包含 `schema_version/session_id/sequence/timestamp_ms/pose_mode`，不包含 pose；它消费同一个 frame cursor、替换 latest snapshot，并同步清除现有及晚加入 viewer 的人物层。
- controller 异常断开时 Relay 发送独立的 exact `pose_projection_unavailable`：`type/session_id/timestamp_ms/through_sequence/pose_mode`。它不消费或重建 frame cursor、不持久化；viewer 只清除 `sequence <= through_sequence` 的旧投影，忽略重连新帧之后才到达的旧 unavailable。
- 一个 session 只有一个 frame sequence 和一份 latest projection snapshot。接受更高 sequence 的任一姿态/reset schema 后，旧 snapshot 立即被替换。
- viewer 对新 sequence 做同样严格解析；切换 schema 时同步清空现有 Canvas，再绘制最新有效帧。
- late viewer 只收到 Relay 当前 latest projection snapshot，不接收历史、不重建轨迹；controller 已断开时不会回放旧人物层。

## 6. 评委端视觉与隐私验收

ADR-0011 的投影优先级保持不变：

| 场景/权威状态 | 单人模式 | 多人模式 | 实景覆盖 |
|---|---|---|---|
| 日常 | 通用家具抽象 + 最多一具骨架 | 通用家具抽象 + `0..4` 具骨架 | 无 |
| 厨房未确认/不可用 | 通用厨房抽象 + 最多一具骨架 | 通用厨房抽象 + `0..4` 具骨架 | 无 |
| 有效 `kitchen_moment` | 真实实时视频，骨架与背景板隐藏 | 真实实时视频，骨架与背景板隐藏 | 仅 Relay verified activity + 有效 grant |
| 完全隐私 | 纯色背景 + 最多一具骨架 | 纯色背景 + `0..4` 具骨架 | 永不允许 |
| 跌倒 `checking` / 未告警 | 通用家具抽象 + 最多一具骨架 | 通用家具抽象 + `0..4` 具骨架 | 无 |
| 权威跌倒 `escalated` + 有效 grant | 真实实时视频，骨架与背景板隐藏 | 真实实时视频，骨架与背景板隐藏 | 只接受匹配的 `fall_emergency` |

真实视频有效时不绘制任何单人或多人骨架。媒体失效、过期、隐藏、断线、尺寸归零或帧停滞时立即清理真实视频与最后一帧，再按当前场景和当前姿态模式回到允许的抽象投影。

多人 Canvas 不显示编号、姓名、稳定颜色或轨迹尾巴。所有候选使用同一套既有骨架颜色，不能用调色板暗示人物槽位或跨帧连续身份。

## 7. 权威链零影响矩阵

切换到 `multi`、接收 batch 或 batch 中 pose 数量变化，必须对下列事实保持零影响：

| 权威面 | 多人帧允许的操作 | 明确禁止 |
|---|---|---|
| Scene | 只读取当前场景决定背景 | 自动切 scene、调用 MiMo scene recognition |
| Fall | 显示既有 `alarm_state` | 调 fall detector、创建 checking/escalated/resolved、改 deadline |
| Voice | 显示既有问询结果 | 请求麦克风、发 voice HTTP、消费预算 |
| Kitchen | 显示既有 activity/card/grant | 触发 cooking sampling、累计 consecutive、签 receipt/verified fact |
| Care card | 只读现有卡片 | 新建、更新或过期卡片 |
| Media | 服从现有 grant 的视频覆盖 | request/revoke/renew grant、建立额外 peer |
| Controller | 只使用当前有效 session/sequence 发布姿态 | 改租约、恢复记录、watchdog/checkpoint |

自动化必须在切换前后比较 Relay authority snapshot，至少覆盖 events、alarm/checkpoint、activity recognition evidence、verified activity、care cards、active grants、voice budget 和 lease；除了 latest pose snapshot 与 frame sequence 外不得变化。

## 8. 实验素材与步骤

### 8.1 素材矩阵

仅使用知情团队成员和非敏感场地。Pilot 与 Holdout 分开，Holdout 人员组合或片段不得用于阈值调节。每种输入至少覆盖：

- 空画面与家具负例；
- 单人全身、半身和边缘入画；
- 两人、三人、四人静止与独立动作；
- 人物交叉、部分遮挡、远近尺度差、同时进出画；
- 五人及以上的上限暴露，验证 UI 只声称“最多四个候选”；
- 竖屏/横屏旋转、后置摄像头、低光和短时失焦；
- 切 single→multi→single、页面隐藏/恢复、停止/重启、断网和 viewer 晚加入。

原始素材只在明确同意的本地实验生命周期中使用，不提交仓库、不进入 Relay/DO/KV 或普通日志。结果记录素材哈希、参与者数量标注、设备/浏览器/分辨率/光线和测试时间，不记录身份。

### 8.2 Pilot

1. 固定目标手机、浏览器版本、本地模型/WASM 版本和后置摄像头参数。
2. 验证 MediaPipe `numPoses: 4` 实际返回不同的 `landmarks[i]`，并冻结 33→17 mapping、输入尺寸、采样频率与 GPU/CPU fallback。
3. 用已知人数帧记录候选数、漏检、重复候选、关键点质量、推理时延、交付帧率、帧年龄、内存和温升趋势。
4. 记录模式切换、多人交叉与页面生命周期的所有可见失败，不删除失败样本。
5. 在 Pilot 结束后、Holdout 开始前冻结 Go/No-go 数值目标、评价脚本、匹配规则和停止条件。

### 8.3 Holdout

使用未参与 Pilot 调参的真实目标手机素材，按冻结顺序运行。对每帧预测与人工标注做匿名的帧内匹配；匹配只用于离线评价，不能写回运行时 ID 或轨迹。

至少报告：

- 按真实人数 `0/1/2/3/4/5+` 分层的候选数混淆矩阵；
- exact-count frame rate、漏检候选、重复/ghost 候选和超四人截断表现；
- 每个匹配 pose 的 17 点覆盖、`usable/degraded` 分布和不可投影帧；
- 遮挡、交叉、边缘、远近、低光和旋转的失败分层；
- 推理 P50/P95、发布帧率、viewer 帧年龄、长任务/掉帧、内存峰值和连续运行温升；
- 单人模式回归对照，确认 `movenet-17/v1-demo`、fall/voice/watchdog/checkpoint 不变；
- 多 viewer 下的 Relay 消息大小/频率、晚加入快照和断线恢复；
- 所有硬 Gate 通过/失败及原始测试顺序。

本规格不预设性能或质量数字，避免把未测目标写成能力。阈值必须由团队在 Pilot 证据上明确冻结，Holdout 后不得为通过而回调。

## 9. 自动化与人工 Gate

### 9.1 不需要模型质量即可自动化的硬 Gate

以下任一失败即 No-go：

1. 多人画面由复制、偏移、镜像或随机化单人骨架生成。
2. batch 合同允许未知字段、ID/track/embedding、错误点序、`>4` poses、媒体字段或部分接受。
3. 切换模式重置 sequence、让旧 generation 回写，或 viewer 保留上一模式的最后骨架。
4. multi 帧或按钮直接/间接改变 alarm、activity、voice、card、receipt、verified fact、grant、lease、watchdog 或 checkpoint。
5. 完全隐私出现家具/真实像素，或媒体失效后最后一帧仍可见。
6. Relay/DO、浏览器持久存储或日志保存原始帧、姿态历史或跨帧人物关联。
7. 模型不可用时静默 clone、回放 scripted skeleton 或把单人结果标为多人成功。

自动化应覆盖：

- 33→17 固定 mapping、不同 MediaPipe pose 保持不同、0/1/4 候选与无效 33 点输入；
- batch exact-key parser/creator、所有边界与恶意字段拒绝；
- Relay 三个 cursor-bearing schema 共用 sequence/latest snapshot、late join、乱序和旧 session；
- reset/unavailable 精确清场、旧断线消息不消费/破坏新 session cursor；
- viewer 0..4 绘制、schema 切换清场、失鲜/隐藏/断线 fail-close；
- decoded counter 不可用/交替/停滞、推理永不 settle、dispose 永不 settle 仍须有界清场并允许新采集；
- multi 对权威快照零影响，以及 single 的 fall/voice/controller-ready 3/5/6、watchdog/checkpoint 全套回归；
- frontend tests/lint/build、Relay tests/check、双环境 dry-run 与 diff-check。

### 9.2 必须在真实设备完成的能力 Gate

- 指定监控手机的真实 0..4 人 Pilot/Holdout；
- 至少两个 viewer 的同步、晚加入和模式切换；
- 目标视口构图与多人骨架可读性；
- 连续运行、温升、前后台恢复和网络故障；
- 超过四人、交叉遮挡和低光失败文案是否诚实可见。

桌面浏览器、fake landmarks 或单元测试不能替代这些 Gate。

## 10. Go / Conditional go / No-go

### Go

所有自动化硬 Gate 通过；目标手机 Holdout 完整；团队按 Pilot 前冻结的质量、性能和稳定性目标接受结果。只有此时可把“多人火柴人 · 实验”作为路演可用按钮。

### Conditional go

隔离与隐私硬 Gate 全部通过，但只有特定手机、分辨率或最多某个人数范围达到已冻结目标。UI 必须锁定已通过的设备/上限并明确标注限制；其他条件显示 unavailable，不做静默降级宣传。

### No-go

任一硬 Gate 失败，或目标手机证据不足/未达到冻结目标。保留单人 MoveNet 作为路演路径；多人入口隐藏或显示未通过，不以 clone、录像或 scripted fallback 冒充成功。

## 11. 不能声称

- 不能说系统识别了具体某个人、持续跟踪同一人或可重识别。
- 不能把数组下标、颜色、姿态形状或移动路径称为身份。
- 不能把最多四个候选称为准确的房间人数或人员进出统计。
- 不能说 MoveNet 本身支持多人；多人候选来自独立的 MediaPipe 实验适配器。
- 不能把 MediaPipe API 支持 `numPoses` 或桌面测试通过说成目标手机能力已通过。
- 不能说多人骨架能检测谁跌倒、谁在做饭或谁在求助。
- 不能说 batch 的 `score` 是校准概率或与 MoveNet 分数可直接比较。
- 不能说固定背景来自真实家具复原，或完全隐私允许真实像素。
- 不能编造检出率、准确率、帧率、时延、温升或跨设备泛化结论。

## 12. 证据输出

建议路径：

- `.scratch/four-scene-live-demo/results/<date>-multipose-pilot.md`
- `.scratch/four-scene-live-demo/results/<date>-multipose-holdout.md`
- `.scratch/four-scene-live-demo/results/<date>-multipose-measurements.jsonl`

结果必须记录不可变 commit、模型/依赖版本、设备与浏览器、测试素材哈希、冻结阈值、完整运行顺序和失败，不得只保存成功截图。
