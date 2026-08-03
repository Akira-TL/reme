# LBX 四场景跨设备演示规格

- Type: spec
- Status: accepted-for-staged-implementation
- Owner: C（LBX）
- Date: 2026-08-02
- Branch boundary: 只允许提交到 `lbx`，只允许推送 `upstream/lbx`
- Related: `docs/adr/0008-event-scoped-family-media.md`、`docs/adr/0011-judge-demo-live-scene-projection.md`、`docs/adr/0012-demo-multipose-projection.md`、`docs/adr/0013-grant-bound-turn-for-public-media.md`

## 1. 用户目标

沿用主分支当前四场景视觉语言与任务路径，在手机监控端和评委只读端之间完成真实的共享演示，同时形成 LBX 的差异化：默认抽象、事件驱动、授权后才开放最少原画。

现场只有一个人使用 `monitor.reme.maniforld.com` 输入控制密钥、开启后置摄像头并扮演被照护者；评委打开 `reme.maniforld.com`，无需接管控制权即可看到同一会话的场景、骨架、家庭心跳卡和告警。

## 2. 非目标与诚实口径

- 不宣称固定背景是对真实家具的三维重建；它是与场景对应的通用环境抽象。
- 不宣称当前跌倒规则具有医疗准确率；它是会被真实动作触发、带失败可见性的演示启发式。
- 不把“切换到厨房”当作做饭识别结果；没有视觉判定证据就显示能力不可用或继续观察。
- 不把单机同页两个 Canvas 当作跨设备视频。
- 不增加长期录像、身份识别、连续云端视频上传或 DO 媒体存储。
- 不把 TURN-assisted WebRTC 描述为媒体完全本地或“从不经过第三方网络”；可识别实景仍只存在于 bounded grant，Reme DO 不接收/持久化媒体帧。

## 3. 四场景验收叙事

### 场景一：日常

- 监控端本地后置摄像头运行 MoveNet。
- 评委端显示同一实时火柴人/骨架，并叠加固定的客厅家具抽象。
- 页面明确写“通用场景抽象”，不写“已复原真实家具”。
- 关键点质量下降、无人或断线时，环境可保留，但人物必须进入明确降级/不可用状态。

### 场景二：做饭心跳

- 只有选择厨房后才启用低频最小视觉采样。
- 每次样本最多一张降采样 JPEG；控制端显示已发送、延迟、置信度和判定依据。
- 连续两个 `cooking` 且置信度达到阈值才确认“正在做饭”；`uncertain` 不累计。
- Relay 一次性消费真实识别 receipt，将公开 `activity-N` 绑定为 verified activity；普通客户端字段不能伪造该事实。
- 确认后创建 `local_only` 家庭心跳卡，并可在控制端内存中保留约 6 秒短片；card、Blob 与 live grant 是三个独立事实，短片不经 WebRTC 分享。
- 同一 verified activity 可签发单次最多 60 秒的 `kitchen_moment` 实时 grant；该 scope 不代表本人同意或分享录像。
- 未确认、识别不可用或无 active grant 时显示通用厨房抽象 + 骨架。verified + active grant 进入 credentialing/connecting/failed 或首帧前时，改为中性隐私背景 + 骨架 + 明确实景状态，不再把预制厨房图作为主视觉；fresh frame 到达后由真实视频完全替换背景与骨架。
- 切场景、采集代次/活动/session 变化或 grant TTL 到期立即停止 live；只要 verified fact 仍有效，操作者可显式继续开放新的最多 60 秒 grant。

### 场景三：完全隐私

- 兼容内部场景 ID `bathroom`，产品文案显示“完全隐私”。
- 两端只显示火柴人/骨架和纯色背景；固定家具、真实视频、媒体按钮全部隐藏。
- 即使上游误传 `privacy_mode=false` 或已有媒体授权，前端也 fail closed 到 skeleton。

### 场景四：跌倒

- 正常与候选阶段：火柴人 + 固定客厅抽象。
- 真实姿态流满足确定性转变门后进入 `checking`，评委端立即收到醒目的问询卡，但仍无原画。
- 明确“安全”关闭；明确“需要帮助”或完整问询窗无回应时，规则进入告警。
- 告警后触发震动/响铃/闪烁卡并签发 `fall_emergency` 短期媒体授权；评委端通过 WebRTC 查看真实后置摄像头。
- WebRTC 失败时告警保持有效，画面退回家具抽象 + 骨架并显示“告警已送达，视频连接失败”。
- `fall_emergency` late viewer 不继承旧 grant；同一权威告警未 resolved 时，操作者可显式向当前在线 viewer 新签最多 30 秒 grant。新 grant 使用同一 alarm event、新 grant ID 和新 audience 快照，不延长旧 grant。

## 4. 版本化事件合同

单人姿态合同保持 `movenet-17/v1-demo` 不变。可选的多人火柴人实验使用独立严格合同
`reme-pose-batch-17/v1-demo`（每帧 `0..4` 个匿名 17 点姿态），不得把数组扩展进单人合同，也不得进入
跌倒、做饭、语音、卡片、receipt 或媒体授权链。模式切换/隐藏/停止通过共享 frame cursor 的
`reme-pose-reset/v1-demo` 立即清场；controller 异常断开由 Relay 发带 `through_sequence` 的
`pose_projection_unavailable`，不消费 cursor，旧断线消息也不能清掉重连新帧。完整边界与 pending
目标手机 Gate 见 ADR-0012。新增事件使用：

```json
{
  "schema_version": "reme-demo-event/v1",
  "session_id": "uuid",
  "event_sequence": 0,
  "timestamp_ms": 0,
  "event_type": "scene_state | activity_state | care_card | alarm_state | media_grant",
  "payload": {}
}
```

所有 envelope 与 payload 都使用精确字段集合。事件序号按控制会话单调递增，与姿态帧序号独立。允许值：

- `scene_state`: `scene_id` 为 `living|kitchen|bathroom|fall`；`visual_mode` 为 `abstract_environment|skeleton_only`。
- `activity_state`: `activity` 为 `cooking`；`phase` 为 `sampling|candidate|confirmed|unavailable`；`source` 为 `mimo_visual|manual_debug`，正式路演不得把 `manual_debug` 显示为自动识别。
- `care_card`: `kind=family_heartbeat`，包含 ID、标题、正文、活动发生时间和 `share_state=local_only|consent_pending|consented|denied|expired`。
- `alarm_state`: `phase=checking|escalated|resolved`，包含事件 ID、触发源、提示、规则期限和 `media_scope=none|fall_emergency`。
- `media_grant`: `scope=kitchen_moment|fall_emergency`，包含 grant/event ID、到期时间和 `active|revoked|expired`。

WebRTC 信令另用 `reme-media-signal/v1`，只允许 SDP offer/answer 与 ICE candidate；不得在事件 envelope 中夹带媒体或 Base64。

## 5. Relay 与授权

- 一个 Durable Object 对应一个 demo 房间。
- Viewer 默认仍只读；仅在其 attachment 含有效 `grant_id` 时，允许发送该 grant 的 WebRTC answer/ICE。
- 控制端只能在有效控制租约中发送事件和信令。
- 跌倒媒体 grant 只授予签发瞬间已连接的 viewer；晚加入者继续看骨架与事件状态，除非操作者对仍有效的权威告警显式新签 30 秒 grant。厨房 active grant 可按 ADR-0011 在原 expiry 内动态加入晚到 viewer，不延长 TTL。
- DO 可持久化当前会话的最新结构化场景/卡片/告警，用于晚加入回放；不得持久化媒体。
- Active grant 的双方必须先通过 ADR-0013 的 exact `/api/media/ice` 取得同时含非 port 53 STUN+TURN 的短时配置，再创建 peer。viewer capability 绑定当前 socket/session/grant/audience；长期 TURN key 只在 Worker secrets。
- 本次 production 不自动回退 STUN-only。旧 Relay、缺 secret、provider/合同失败直接明确降级，不得显示假 LIVE。
- 解锁失败、第二控制端、乱序事件、未知字段、超长消息、媒体字段和越权信令必须被拒绝并测试。

## 6. 可行性 Gate

1. **主分支移植 Gate**：只移植局部语义，不引入厨房未同意原画、`checking` 原画、iOS 录音回退或浴室泄露。
2. **布局 Gate**：390×844 和 430×932 视口中，监控端解锁、场景选择、采集、同意和停止均无需横向滚动；评委告警卡不遮挡视频关闭状态。
3. **做饭 Gate**：至少一段真实做饭和一段非做饭现场各连续采样；记录每次原始判定、阈值与延迟。未测前 UI 标为“实验识别”。
4. **跌倒 Gate**：真实动作可触发一次候选与一次问询；正常站立/坐下/弯腰不应在同一验收回合升级。记录条件，不报告准确率。
5. **告警 Gate**：完整问询窗口未回应后，评委端在不依赖 MiMo 的情况下进入告警；告警响铃去重。
6. **媒体 Gate**：厨房 verified + active grant 前和跌倒 `checking` 阶段抓包无视频轨道；厨房/权威告警后既有 viewer 收到真实 track 与 fresh frame；授权到期后轨道停止。
7. **跨网 Gate**：目标手机 + 两个 viewer 至少完成两个有记录的跨网 Holdout，并在独立强制 relay 诊断中确认 selected candidate type=`relay`。ICE config 200、同 Wi-Fi 或 active grant 无首帧都不能代替；Gate 前不能宣称普遍可用。
8. **回归 Gate**：前端、后端、Relay 全套测试/类型检查/构建通过；纯骨架公网演示仍可用。

## 7. 实施顺序

1. 固定协议、ADR 和测试样例。
2. 引入本地主分支的“先问再告警、超时不得早于提示完成、告警语音去重”安全语义；保留 LBX 无固定截断录音和隐私层。
3. Relay 增加结构化事件、严格信令和短期 grant。
4. 监控端增加四场景、活动识别、确定性跌倒状态机和媒体发送。
5. 评委端增加场景环境、心跳卡、告警和授权视频。
6. Relay 以 Worker secret 为 active grant 签发短时 TURN ICE 配置，前端只在 exact 配置成功后建 peer；补 fall 显式新 30 秒 grant。
7. 完成手机/跨端 Gate 后只提交并推送 `upstream/lbx`。
