# 06 — 评委端视觉策略 v2 与短期实景边界

- Type: task
- Status: ready-for-human
- Owner: C / Monitor + Viewer + Relay
- Related: ADR-0005、ADR-0008、ADR-0010、ADR-0011
- Replaces for current work: issue 03 已完成实现中的旧厨房同意视觉语义，不改写其历史记录

## What to change

按 ADR-0011 收口控制端、Relay 与评委端的同一套状态事实。重点不是增加新的场景，而是修正四场景在真实媒体、骨架、背景板与心跳卡之间的投影：

| 场景/状态 | 评委端人物 | 环境 | 允许的实景 Gate |
|---|---|---|---|
| 日常 | 实时骨架 | 固定通用家具背景板 | 无 |
| 厨房，未确认/不可用 | 实时骨架 | 固定通用厨房背景板 | 无 |
| 厨房，连续两次真实 MiMo `cooking` confirmed | 真实视频 | 真实视频 | `kitchen_moment`，单次最多 60 秒 |
| 完全隐私（内部 ID `bathroom`） | 实时骨架 | 纯色安全背景 | 无，任何上游 grant 都 fail closed |
| 跌倒 `checking` / 未告警 | 实时骨架 | 固定通用家具背景板 | 无 |
| 服务端权威跌倒 `escalated` | 真实视频 | 真实视频 | 匹配告警的 `fall_emergency` |

真实视频出现时必须替换骨架和背景板，不把骨架叠在真实人物上。断流、失败、过期或撤销时必须立即回到表中对应的隐私化投影，不保留最后一帧。

## Protocol and state requirements

- [x] 保持 `reme-demo-event/v1` 与 wire scope `kitchen_moment`，但把厨房 eligibility 改为当前 `kitchen` + 连续两次真实 `mimo_visual cooking` confirmed；不再依赖 `care_card.share_state=consented`。
- [x] Relay 为真实 MiMo 连续证据签发短期 receipt，并在接受 confirmed activity 时一次性绑定 verified `activity-N`；grant、late join 与续开只查 verified `activity-N`，伪造客户端 activity 不得满足 Gate。
- [x] activity recognition 单飞不覆盖有效 inflight；重叠请求明确拒绝，旧 finish/cancel 不清理新代次，输入/MiMo/取消失败只释放自身 attempt，不能毒化后续识别。
- [x] `manual_debug`、场景按钮、恢复的 `scene_state` 和第五动作的 `kitchen` 提议都不能满足 cooking Gate。
- [x] 单个 grant 最长 60 秒且不后台自动续期；同一 verified activity/场景/采集代次/租约仍有效时只允许操作者显式“继续开放 60 秒”，包括超过 180 秒后的续开；离场、new/unavailable activity、停止/重启采集、断联或会话变化后必须重新真实确认。
- [x] `kitchen_moment` 只传当前摄像头的实时 WebRTC track，不传 6 秒 Blob；UI 不再把该 scope 解释为本人同意或录像分享。
- [x] cooking confirmed 后创建/更新家庭心跳卡，卡片保持 `share_state=local_only`。本机约 6 秒内存短片独立计时和释放，不进入事件、Relay/DO、信令、持久存储或日志正文。
- [x] 跌倒实景仍只接受服务端权威 `escalated` + 匹配 event/grant；`checking`、MiMo `fall` 和客户端场景状态不能绕过 Gate。
- [x] 不修改 `controller_ready` 的 3/5/6 精确滚动兼容，也不改变 watchdog/checkpoint 的服务端权威状态、时序和恢复语义。

## Viewer requirements

- [x] 日常和跌倒 `checking` 显示完整构图的固定通用家具背景板 + 骨架；文案只称“通用环境抽象”，不称“家具已复原”。
- [x] 厨房未确认、识别不可用或视频失败时显示固定通用厨房背景板 + 骨架；confirmed grant 有有效远端 track 时显示无骨架叠层的真实视频。
- [x] 完全隐私在任何事件顺序、恢复状态或非法 grant 下都只显示纯色背景 + 骨架。
- [x] 权威跌倒 grant 有有效远端 track 时显示真实视频；连接失败不撤销告警，回到家具背景板 + 骨架并显示失败。
- [x] 实景状态显示原因、剩余 TTL 与明确的连接/降级状态；不能出现“已连接”但视频尺寸、轨道或帧不可用的假成功。
- [x] grant 撤销、过期、切场景、session 变化、viewer 页面隐藏或断线时停止并清空远端媒体；恢复时不复用旧 `srcObject` 或最后一帧。
- [x] transport connected 或 `play()` 成功不等于 LIVE；首个真实可渲染帧才标 LIVE，之后 3 秒 decoded-frame freshness watchdog 防静默冻帧；track mute/ended、stalled/waiting/emptied/error 或尺寸归零都同步 fail close。

## Late viewer and lifecycle requirements

- [x] 活跃 `kitchen_moment` TTL 内，Relay 可把新加入 viewer 动态追加到 audience，并只通知当前 lease owner 建立新增 peer；不得延长 TTL 或改变 event/grant ID。
- [x] 新增厨房 peer 不应断开已经在看的 viewer；viewer 不能自行伪造 audience 或信令权限。
- [x] `fall_emergency` 保持签发时静态 audience，晚加入 viewer 不继承实景，只回放权威告警与抽象画面。
- [x] 控制端页面隐藏、停止采集、断线、租约释放/丢失、场景退出或 session 变化时撤销 grant 并停止本地发送轨道。
- [x] viewer 页面隐藏/断线至少关闭该 viewer 的远端轨道；重新出现时厨房按仍有效 grant 重新接纳，跌倒不继承。
- [x] viewer hidden 同步停轨与清 `srcObject`；Relay 断开时移除旧 audience 并通知 controller 清掉 stale peer，信令缓冲不得让 ICE 淘汰唯一 offer。
- [x] request-in-flight 记录 scope/event/scene/capture generation/visibility/alarm 上下文；hide/switch/stop/restart 后迟到 ACK 立即 revoke 且不建 peer。
- [x] Relay alarm 以 `min(watchdog, lease expiry, active grant expiry)` 重排；双方 idle 时也主动广播 grant expired，heartbeat 后早醒 alarm 必须重排。客户端 timer 以服务端事件 duration 为上限。
- [x] Relay 重启、租约/事件不匹配、乱序、未知字段、媒体或信令校验失败均 fail closed。
- [x] 自动场景 recorder stop/error 有有界 settlement watchdog；自动 `kitchen/fall` 只切展示，不产生 audio、alarm、activity/card/grant 或 cooking authority。

## Acceptance and evidence

- [x] 前端状态/组件测试覆盖四场景矩阵、视频替换骨架、无帧假连接、过期、切换、隐藏、断线和恢复。
- [x] Relay 完整测试连续三轮覆盖真实 cooking receipt→verified activity、伪造拒绝、零 viewer 后 late join、同 grant增量/移除 peer、TTL 不延长、idle alarm 主动过期、>180 秒续开、stop/restart 不复用、scene/disconnect/release 撤销，以及 fall late join 不继承。
- [x] 既有权威 fall、voice `controller_ready` 3/5/6、watchdog/checkpoint、legacy backfill、strict MiMo/schema 与媒体拒绝测试在同一完整套件中连续三轮通过。
- [x] 390×844、430×932 和桌面评委端检查背景板完整构图、实景无骨架叠层、隐私纯骨架、告警卡和 TTL 状态。
- [x] 前端完整 tests/lint/build、Relay tests/typecheck，以及 staging/production Wrangler dry-run 通过；本票不得自行推送或部署。
- [ ] 至少一台目标监控手机与两个评委设备实测：已有 viewer + 厨房 late join、厨房过期、fall late join、页面隐藏/恢复、断网和租约释放。
- [ ] 跨网络只用 STUN 失败时显示降级并记录网络条件；TURN/SFU 未实现前不宣称公网普遍可用。
- [ ] 真实做饭/非做饭各记录连续 MiMo 原始结果、条件和失败；Gate 前不宣称准确率，也不把固定背景称为家具复原。

## No-go conditions

- 厨房实景由场景按钮、恢复状态、`manual_debug` 或 MiMo 场景提议直接打开。
- UI、事件或日志把 `kitchen_moment` 描述为本人同意或已分享 6 秒录像。
- 骨架覆盖在厨房/跌倒真实视频上，或断流后保留最后一帧。
- 完全隐私出现固定环境或任何真实像素。
- 跌倒 `checking`、客户端场景或 late join 绕过服务端权威告警 Gate。
- grant 到期、页面隐藏、停止、断线或租约释放后仍有媒体轨道存活。
- 为本票破坏 voice 滚动兼容、watchdog/checkpoint 权威语义，或把 STUN-only 演示包装成生产媒体能力。
