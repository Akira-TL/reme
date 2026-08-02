# ADR-0011: 评委路演的实景投影与场景视觉策略

- Status: Accepted for LBX demo feasibility
- Date: 2026-08-02
- Owner: C（LBX 公网共享 Demo）
- Depends on: ADR-0005、ADR-0008、ADR-0010
- Supersedes in part: ADR-0008 的厨房本人同意 Gate 与静态 audience 两点（仅本 ADR 所述 LBX 路演）

## 背景

LBX 双端演示已经能同步骨架、结构化场景、家庭心跳和权威告警，但当前评委端的视觉投影与最终路演叙事并不完全一致：日常和跌倒前需要保留环境线索，完全隐私需要彻底移除环境，真实做饭确认后需要让评委看到现场，而跌倒只有在服务端权威告警后才能开放现场。

厨房实景还与 ADR-0008 的“本人逐事件同意”规则冲突；晚加入评委的预期也与 ADR-0008 的静态 audience 冲突。该演示使用公开的只读评委入口，厨房实景会让人物可被识别，因此不能继续宣称评委端始终匿名化。本 ADR 接受一个范围很窄、时限明确、失败可见的路演例外，不把它外推为生产授权、账户或隐私模型。

## 决议

### 1. 评委端视觉投影

评委端按以下优先级投影，较高优先级必须覆盖较低优先级：

1. `bathroom`（产品文案“完全隐私”）：纯色安全背景与实时骨架，不显示固定家具、真实视频或最后一帧。
2. 与服务端权威 `alarm_state.phase=escalated` 匹配的有效 `fall_emergency` grant：真实实时视频。
3. 与真实做饭确认匹配的有效 `kitchen_moment` grant：真实实时视频。
4. `living`、厨房未确认/不可用状态、以及跌倒 `checking`：固定通用环境背景板与实时骨架。
5. 数据、媒体或连接不可用：回到当前场景允许的骨架/背景板，并明确显示降级；不得保留最后一帧冒充直播。

真实视频有效时，它替代骨架与固定背景板，不在视频上叠加火柴人。页面必须同时显示开放原因、实景状态和剩余时限。固定背景板是预制的通用视觉资产，不是从真实家庭画面重建或复原的家具；目标视口应保留其完整构图，不以严重裁切制造“复原”错觉。

### 2. 厨房实景 Gate

选择或恢复 `kitchen` 只改变展示场景，不代表正在做饭，也不能自行开放实景。厨房实景只有在以下条件同时满足后才可启用：

- 控制端仍持有当前会话的有效控制租约，且当前场景是 `kitchen`；
- 独立的做饭识别流程取得连续两次、达到当前实验 guardrail 的真实 MiMo `cooking` 结果；
- 结果来源是实际 `mimo_visual` 调用，不是 `manual_debug`、场景按钮、脚本标签或第五动作的场景提议；
- Relay 已把该真实识别证据绑定到当前公开活动事件，并校验活动事件与当前会话/场景匹配。

真实识别证据由 Relay 签发短期、不可由普通 `activity_state` 伪造的 receipt。receipt 只用于服务端在接受一次 `activity_state.phase=confirmed` 时完成一次性消费，并把其 `event_sequence` 绑定为 verified activity fact；公开的 card、grant 与媒体 `event_id` 始终保持 `activity-N`，不暴露或复用 receipt ID。之后首轮 grant、TTL 内晚加入和显式续开都按该 verified `activity-N` 查验，不能仅相信客户端发布的 `confirmed/source=mimo_visual` 字段。

verified activity fact 不另设会在同一有效采集内静默到期的墙钟 TTL。它只在离开厨房、发布新的/非 confirmed activity、停止或更换采集代次、页面隐藏、控制端断线、租约或 session 变化时失效；因此同一有效采集在超过三分钟后仍可显式续开，而停止再启动不能复用旧确认。

每个 grant 不超过 60 秒。沿用 wire scope 名称 `kitchen_moment` 仅为滚动兼容；它在本 ADR 中表示“真实做饭确认后的短期直播”，**不表示本人同意，也不表示分享已录制短片**。到期后必须由 Relay 权威时钟主动关闭且不得后台自动续期；只要同一 verified `activity-N`、厨房场景、摄像头与控制租约仍有效，操作者可通过显式“继续开放 60 秒”动作签发新的 bounded grant。离开场景、活动事实变化或会话变化后，必须取得新的真实做饭确认。

厨房活动的四个事实彼此独立：

- `activity_state.phase=confirmed` 表示实验识别 Gate 已满足；
- `care_card` 记录一个结构化家庭心跳，`share_state` 保持 `local_only`；
- 控制端可在内存中保留约 6 秒短片用于现场演示，但该 Blob 不经 WebRTC 分享、不进入事件、DO、KV、日志正文、浏览器持久存储或仓库，并按既有 TTL 释放。
- `kitchen_moment` live grant 只授权有界的当前实时 track；card 是否保留、Blob 是否已释放都不能签发、撤销或延长 grant。

因此厨房不再显示“本人同意分享短片”的伪语义，也不能把实景直播描述成云端录像。

### 3. 跌倒实景 Gate

`scene_id=fall`、MiMo 场景提议、浏览器侧候选或 `alarm_state.phase=checking` 都只允许固定通用家具背景板与骨架。只有 Relay 当前会话中的服务端权威告警已经进入 `escalated`，且 grant 与同一告警事件匹配并声明 `media_scope=fall_emergency`，才允许真实实时视频。

MiMo 失败、媒体连接失败或评委缺席都不能取消、降级或延迟权威告警；告警保持可见，视频失败则退回“家具抽象 + 骨架”并显示连接失败。

### 4. 晚加入 audience

ADR-0008 的静态 audience 规则在本路演中只对 `fall_emergency` 保持不变：跌倒告警后的晚加入者不继承原画授权，只看到权威告警与隐私化投影。

对仍在 TTL 内的 `kitchen_moment`，Relay 可以把新加入的只读评委动态加入该 grant 的 audience，并通知当前控制端为该 viewer 建立 WebRTC peer。动态加入不得延长 `expires_at_ms`、改变 `event_id`、创建第二个媒体范围，或允许 viewer 自行声明授权。此例外意味着厨房实景在评委入口内是 demo-only 的公开投影风险；控制端和评委端都必须明确披露，正式产品不得复用为家庭授权模型。

viewer 断开时 Relay 必须立即把它从 active audience 删除并把完整的剩余 audience 回告控制端；旧 peer、offer 或 ICE 不得在短 TTL 内累积。信令缓冲必须保留有效 offer，不能让大量 ICE 把唯一 offer 挤出。

### 5. 生命周期与 fail-close

以下任一条件发生时必须停止相应媒体轨道、清除 `srcObject`/最后一帧并回到当前场景的隐私化投影：

- grant 到期、被撤销或事件不再匹配；
- 离开厨房/跌倒场景或切到完全隐私；
- 控制端页面隐藏、停止采集、断线或释放/失去控制租约；
- viewer 页面隐藏或断线（至少关闭该 viewer 的远端轨道）；
- 当前会话变化，或媒体/信令合同校验失败。

控制端发出 grant request 后必须记录请求代次及 scope、event、scene、capture generation、页面可见性和告警上下文；ACK 到达时重新复核。切场景、停止采集、页面隐藏或采集代次变化后的迟到 ACK 必须立即 revoke，且不得创建 peer。

viewer 页面隐藏时必须同步清空 `srcObject`、停止远端轨道并关闭媒体会话，不能只等待 socket 的异步 close。viewer 只有在 transport 已连接且 `<video>` 收到首个可渲染真实帧后才可显示 `LIVE`；首帧后继续以 decoded-frame freshness watchdog 复核，连续 3 秒没有新帧即 fail-close。track `mute/ended`、尺寸归零、`stalled/waiting/emptied/error` 同样立即 fail-close，不保留最后一帧。

viewer 恢复可见或重新连接时，不得复用旧的本地媒体对象。若厨房 grant 仍有效，Relay 可按上节重新动态接纳；跌倒 viewer 必须等待新的授权，不能继承既有 grant。WebRTC 失败不会使 UI 留在“已连接”但无有效画面的状态。

Relay Durable Object 的 alarm 是 grant 与控制租约的权威时钟。每次重排选择 `min(active watchdog deadline, lease expiry, active grant expiry)`；即使双方在签发后不再发送 WebSocket 消息，grant 到期也必须主动向 controller 与全部 audience 广播 `status=expired` 并停止流。heartbeat 延长 lease 后旧 alarm 可以早醒，但必须按剩余最早 deadline 重排。客户端 timer 只是更早 fail-close 的兜底，并以服务端事件的 `expires_at_ms - timestamp_ms` 作为上限，不能因客户端慢时钟延长授权。

### 6. 与 ADR-0008、ADR-0010 的关系

本 ADR 只在 LBX 评委路演范围内取代 ADR-0008 的两点：

1. 厨房从“真实识别后再由本人逐事件同意”改为“连续两次真实 MiMo cooking 确认后开放最多 60 秒直播”；
2. 厨房 grant 的 audience 从签发时静态快照改为 TTL 内可由 Relay 动态追加晚加入 viewer。

ADR-0008 的媒体不进 DO、完全隐私 fail-close、跌倒权威升级、短时 grant、显式状态与其他生命周期约束继续有效。ADR-0010 也继续有效：一次“真实识别 · MiMo”场景提议只切换 `scene_state`，不触发 cooking activity、6 秒短片、家庭心跳或任何媒体 grant；即使提议结果为 `kitchen`，仍需独立做饭识别 Gate。

自动场景录制必须有有界的 recorder stop/error settlement watchdog；浏览器不触发 `stop/error` 时回到 keyframe 或明确失败，不能永久停在 capturing。自动分类返回 `kitchen` 或 `fall` 仍只改变展示，不请求音频、不武装跌倒检测、不生成 alarm/activity/card/grant，也不写入做饭 receipt/verified fact。

## 风险与验证 Gate

- 厨房实景会让当前人物可识别。路演只能使用知情的演示人员与非敏感环境，不能以老人真实家庭素材做无同意展示。
- 当前 WebRTC 为 STUN-only 点对点演示路径；不同运营商、企业网或对称 NAT 下可能失败。完成目标手机、目标网络和晚加入真机 Gate 前，不宣称公网普遍可用。
- 做饭确认阈值仍是未校准的实验 guardrail；必须保存真实正/负样本条件、原始结果与失败，不宣称准确率。
- 固定背景板不构成家具复原、分割或三维重建能力。
- 自动场景、厨房识别、短片、心跳卡、媒体 grant 与跌倒权威状态必须继续分别测试，不能用一个成功替代另一个 Gate。

## 后果

- 评委端四场景与最终路演叙事一致：日常/跌倒前保留环境抽象，完全隐私纯骨架，真实做饭确认与权威跌倒告警后显示短期现场。
- 旧 scope 名称继续兼容，但 UI、测试和文档必须移除 `kitchen_moment = 本人同意/录像分享` 的旧解释。
- 厨房 late join 更适合多评委依次打开页面，但扩大了可识别画面的公开面；该取舍只被接受用于当前 LBX demo feasibility。
- 正式产品若要保留厨房直播，必须另立身份、本人/家庭授权、审计、撤销、TURN/SFU 与媒体保留策略 ADR。
