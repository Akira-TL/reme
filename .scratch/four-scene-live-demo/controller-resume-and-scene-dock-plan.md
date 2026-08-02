# LBX 控制会话恢复与四场景 Dock 计划

- Status: completed
- Branch: `lbx`
- Date: 2026-08-02

## 目标

让一台手机在现场演示时始终能单手切换四个场景；短暂断网自动恢复控制链路；同一标签页刷新后恢复原控制租约和场景，不再次要求输入原始密钥。

## 安全与生命周期合同

1. 原始控制密钥只用于 `POST /api/unlock`，成功后立即清空，不写入任何浏览器存储。
2. 仅在 `sessionStorage` 保存版本化的短期不透明控制 capability：`token / session_id / lease_expires_at_ms / scene_id`。它跨刷新、限当前标签页，并随关闭标签页失效；不使用 `localStorage`。
3. 刷新和短暂断线只关闭控制 WebSocket、停止本地摄像头与事件视频；不主动释放控制租约。Relay 继续在控制 socket 消失时立即撤销全部媒体授权，控制租约只保留到短期 TTL。
4. 只有明确点击“释放控制权”才清除 capability 并调用认证 release；租约过期或服务端 session 不匹配时也必须 fail closed 回到密钥页。
5. 刷新后不自动重新申请摄像头权限。恢复范围只包括租约、场景和控制 WebSocket，采集仍由用户显式点击开启。

## 恢复协议

1. Relay 为每个活跃 session 持久化最后接受的事件序号和骨架序号；不持久化骨架帧或媒体。
2. `controller_ready` 返回 `session_id / lease_expires_at_ms / last_event_sequence / last_frame_sequence`。
3. 监控端收到并校验 `controller_ready` 后才标记连接成功，先对齐两个序号，再发布恢复后的当前场景。
4. WebSocket 打开后立即 heartbeat；`heartbeat_ack` 更新 `sessionStorage` 中的 TTL。
5. 意外断线使用单实例指数退避自动重连，约为 `0.5s / 1s / 2s / 4s / 5s` 封顶；`online` 与 `pageshow` 触发即时重试。连接恢复或明确释放时清除重试计时器。
6. 到达已知 TTL 后停止重试并清除本地 capability。重连不会恢复已撤销的事件视频授权。

## 四场景移动布局

1. 摄像头预览不再被大场景徽标遮挡；场景编号、名称和说明移到预览外的摘要条。
2. 桌面端继续在右侧控制栏显示四场景选择。
3. `<= 620px` 时四个按钮成为底部安全区上方的四等分常驻 Dock：`日常 / 做饭 / 隐私 / 跌倒`，始终单手可达。
4. 当前场景使用实心 Reme 橙色；“跌倒”只有真正升级为告警时才出现红色提示，避免把场景选择误解成告警发生。
5. “释放控制权”保持在内容末端，不进入 Dock，避免误触。

## 验证

- Frontend：凭证严格校验、过期清除、密钥字段拒绝、退避序列、`controller_ready` 校验、全量单测、lint、production build。
- Relay：初始/恢复 ready 游标、事件与骨架续号、同 token TTL 内重连、并发 controller 拒绝、显式 release 失效、媒体断线即撤销、typecheck 与 production/staging dry-run。
- Browser：390×844 同视口比较；确认 Dock 不遮挡预览/主操作，刷新后无需密钥，断线状态可见并自动恢复。
- Git/发布：只提交并推送 `upstream/lbx`；不处理 fork/origin/main。
