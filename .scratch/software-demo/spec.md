# C：软件演示与运行控制

- Type: spec
- Status: open
- Owner: C
- Shared contract: `../abc-interface/spec.md`

## 1. 角色目标

C 负责运行控制、实时展示和用户交互。

当前优先完成：

```text
摄像头实时视频
→ A 实时2D关键点和姿态
→ C 实时2D骨架与展示型3D
→ B 完整实时决策
→ C 展示询问、回应和结果
```

预录视频模式用于后续稳定回放，具体视频内容和故事暂不冻结。

## 2. 职责边界

C 负责：

- 发起、停止、切换RuntimeSession；
- 创建新的 `session_id`；
- 展示A/B实际回报的运行状态；
- 播放摄像头或预录视频；
- 展示2D骨架、3D视图、姿态、质量和决策；
- 提交InteractionResponse；
- 丢弃旧会话迟到事件；
- 明确展示降级、视觉发送和运行来源。

C不负责：

- 自行分类姿态；
- 自行判断风险或通知家属；
- 直接调用MiMo；
- 在A/B失败时伪装为实时成功；
- 自动静默切换到预录模式；
- 实现牙疼、授权、行动卡等尚未确定的故事界面。

## 3. 运行模式控制

C只提供两个正式入口：

### 3.1 实时摄像头

```text
profile = live_camera
input_source = camera
perception_mode = live
decision_mode = live
```

C提供：

- 摄像头选择；
- 启动；
- 停止；
- 重置；
- 当前session信息；
- A感知状态；
- B决策状态。

### 3.2 预录视频

```text
profile = recorded_video
input_source = video
perception_mode = recorded
decision_mode = recorded
```

C选择manifest并回放预计算感知和预录决策。演示时不重新运行A/B。

### 3.3 模式切换

- C每次启动或切换都创建新的 `session_id`；
- C分别向A和B发送RuntimeSessionRequest；
- A/B都回报 `running` 后才显示会话可用；
- A或B回报 `degraded` 时，页面显示具体原因；
- 切换时清空上一会话的骨架、姿态、决策、倒计时和回应状态；
- 旧session事件必须丢弃；
- 失败后由用户显式选择是否切换预录模式。

## 4. 运行状态页面

页面必须同时显示：

- `session_id`；
- 请求profile；
- A实际profile和状态；
- B实际profile和状态；
- 摄像头或manifest来源；
- 感知是否可用；
- 决策是否可用；
- 视觉上下文是否发送给MiMo。

C不能只根据按钮状态显示 `LIVE`。

## 5. A → C 接口

C通过WebSocket接收RuntimeEvent：

```text
frame_landmarks
posture_observation
transition_event
```

C必须：

- 校验 `session_id`；
- 按 `sequence` 处理当前会话事件；
- 显示 `unknown`、`degraded` 和 `unavailable`；
- 不把 `lying` 自行解释为跌倒；
- 不把 `fall_like_transition` 自行升级为通知家属。

## 6. B → C 接口

C通过WebSocket接收：

```text
RuntimeSessionStatus
a RuntimeEvent<CareDecision>
```

C直接使用：

- `state`；
- `risk_level`；
- `privacy_mode`；
- `need_dialogue`；
- `elder_message`；
- `family_notification`；
- `response_timeout_ms`；
- `action`；
- `reason_summary`；
- `uncertainty`；
- `fallback_used`；
- `source`；
- `visual_context`。

C不从自然语言推断业务状态。

## 7. C → B 回应

当前只支持：

```text
safe
need_help
unclear
none
```

来源：

```text
user_input
script
timeout
```

C通过HTTP提交InteractionResponse，并明确展示提交成功或失败。

倒计时：

- 收到非空 `response_timeout_ms` 时，从收到决策的现实时间开始；
- 视频暂停或结束不暂停交互倒计时；
- 到期提交 `none + timeout`；
- 当前不显示或计算绝对截止墙上时间；
- 未来审计需要时，再显示“锚点 + 时长”。

## 8. 页面结构

```text
┌──────────────────────────────────────────────────────────┐
│ Profile / Session / A状态 / B状态 / 来源                 │
├───────────────────────────┬──────────────────────────────┤
│ 摄像头或预录视频          │ 2D / 3D骨架                 │
├───────────────────────────┼──────────────────────────────┤
│ 姿态、置信度、质量、运动  │ CareDecision与MiMo状态       │
├───────────────────────────┴──────────────────────────────┤
│ 主动询问 / 回应按钮 / 倒计时 / 家属通知 / 时间线         │
└──────────────────────────────────────────────────────────┘
```

信息优先级：

1. 当前是否真的运行；
2. 当前姿态和数据质量；
3. 当前风险、动作和询问；
4. 是否降级；
5. 是否发送视觉内容；
6. 技术指标与日志。

## 9. 视频模块

实时模式：

- 使用当前电脑摄像头；
- 目标预览约30 FPS；
- 默认不录制；
- 摄像头失败时显示degraded；
- 不自动切换视频。

预录模式：

- 通过SceneManifest加载视频；
- 支持播放、暂停、seek和重置；
- 按视频时间同步记录流；
- 切换manifest创建新session。

## 10. 2D与3D展示

### 10.1 实时

```text
MoveNet 2D关键点
→ 2D骨架
→ 映射到Three.js平面或浅深度空间
```

页面标记：

```text
2D关键点三维可视化
```

不得标记为实时MotionBERT 3D推理。

### 10.2 预录

如果manifest提供 `keypoints_3d`：

- 使用MotionBERT根节点相对3D；
- 支持旋转、缩放、正视、侧视、俯视和重置；
- 明确不是房间绝对坐标或医学测量。

否则退化为2D映射展示，并明确标记。

## 11. 隐私与视觉发送

ADR-0001和ADR-0003共同约束：

- 实时摄像头默认只在内存处理；
- 不默认保存原始帧或录制视频；
- C不提供默认截图留存；
- B可按需向MiMo发送最小关键帧或短片段；
- C显示 `visual_context.sent_to_mimo`、类型、窗口和数量；
- 页面展示是否清晰与MiMo是否收到视觉内容是两个独立状态；
- C按照 `privacy_mode` 渲染，不自行决定隐私策略。

## 12. 降级与失败

- A失败：保留视频，显示感知不可用；
- B失败：继续显示感知，显示决策不可用；
- WebSocket断开：显示断线状态并停止接受旧事件；
- MiMo超时：显示B返回的degraded；
- 不静默切换profile；
- 用户选择预录模式时创建新session；
- 页面不得把Record结果伪装成实时结果。

## 13. 传输与Adapter

- Runtime控制：HTTP；
- 感知事件：WebSocket；
- CareDecision：WebSocket；
- InteractionResponse：HTTP；
- `LiveAdapter` 连接实时A/B；
- `PlaybackAdapter` 读取manifest和记录流；
- 页面组件只消费共享payload，不感知数据来自模型还是文件。

## 14. 性能目标

- 摄像头预览约30 FPS；
- 关键点页面延迟P95不超过300 ms；
- 姿态标签页面延迟P95不超过500 ms；
- MiMo首个决策目标不超过8秒；
- 页面与A/B完整实时运行至少10分钟无崩溃；
- 切换session后不显示上一会话事件。

目标必须通过真实测量验证。

## 15. P0开发顺序

1. RuntimeSession控制界面；
2. A/B状态回报；
3. 实时摄像头显示；
4. 实时2D骨架；
5. 展示型3D；
6. 姿态与质量状态；
7. B完整实时决策接入；
8. 回应和倒计时；
9. 降级与session隔离；
10. 10分钟联合测试。

## 16. P1开发内容

- PlaybackAdapter；
- 预录视频和记录流；
- MotionBERT预录3D；
- 比赛具体视频内容；
- Mock/Record兜底；
- 路演快速入口和脚本。

## 17. 验收标准

- [ ] C可以启动和停止实时摄像头会话；
- [ ] A/B实际状态分别显示；
- [ ] 旧session事件被丢弃；
- [ ] 实时视频、2D骨架和展示型3D同步；
- [ ] 姿态、置信度和质量清晰可见；
- [ ] B完整实时决策可接入；
- [ ] 回应和倒计时可运行；
- [ ] 失败时不伪装、不自动切换；
- [ ] 实时摄像头默认不落盘；
- [ ] 10分钟联合运行无阻断错误；
- [ ] 预录模式回放记录内容，不现场重跑A/B；
- [ ] 页面中不存在牙疼、授权或行动卡的强制界面。
