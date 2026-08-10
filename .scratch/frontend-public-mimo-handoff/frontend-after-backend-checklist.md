# Backend 能力完成后的 Frontend 收口清单

- Status: waiting-for-backend
- Owner: Frontend
- Recorded: 2026-08-10
- Depends on: `backend-requirements.md` 中 DateIndex、TimelineDayState、CareThread、DiarySummaryState、材料附件与送达合同

## 结论

Backend / Relay 完成历史时间线、MiMo 摘要、匿名材料和真实送达能力后，Frontend 仍需完成接口接入与产品状态呈现。Frontend 不重新实现 MiMo、关怀判断、媒体授权、持久化或送达权威。

## P0：公开演示接口接入

- 为 DateIndex、TimelineDayState、CareThread、DiarySummaryState 建立严格 schema 解析器；未知字段、倒退 revision 和错误日期 fail closed。
- 将 Reme 页的 8 月 4—11 日数据源从 `familyTimelineMock.js` 切到 Backend / Relay；本地 fixture 只保留为明确标注的开发/故障演示模式。
- 接入 Backend 选定的 WebSocket、SSE、ETag 或短轮询 revision 通知；切换日期、刷新和断线重连后重新取得权威快照。
- 展示 loading、generating、partial、stale、unavailable 和 retry 状态；MiMo 不可用时不得用固定摘要冒充实时结果。
- 保留 `metadata_only` 附件和 `mock_delivered` 的明确演示标识。
- 生产浏览器只访问同源公网 API，不访问 localhost、MiMo API 或设备 API。

## P1：真实匿名材料附件

- 消费 Backend 返回的 `asset_id`、附件状态、隐私模式、时长和短期签名播放地址。
- 在材料卡中增加“生成中、可播放、仅元数据、已过期、已撤销、无权限、加载失败”状态。
- 播放前再次确认当前 household 权限和资源有效期；过期后向 Backend 重新申请短期地址，不缓存长期 URL。
- 默认不自动播放、不提供原始媒体入口；清晰视频始终 fail closed，`skeleton_only` 只允许明确声明的匿名骨架媒体，浴室和 `hidden` 按 Backend 权威策略不显示附件。

## P1：真实家庭送达与回执

- 从 Backend 的 household member 列表选择被授权的接收人，不能由自由文本冒充成员身份。
- 发起 Backend 定义的发送任务，并展示 `pending / delivered / failed` 等正式状态及时间戳。
- 只有收到 Backend transport receipt 后才显示真实“已送达”；`mock_delivered` 永远显示为演示。
- 根据 Backend 合同提供安全的重试或取消入口；按钮操作必须幂等，刷新不能重复发送。
- 在同一 CareThread 中连续展示“观察 → 发问 → 回应 → 材料 → 送达”，但不在浏览器推断线程状态。

## 账户、权限与隐私状态

- 接入登录、household 选择、成员角色和会话过期处理。
- 对 401、403、404、资源撤销、家庭切换和删除后的失效状态提供明确 UI。
- 不把 raw video、raw audio、逐帧骨架、MiMo prompt、密钥或完整原始对话写入浏览器持久存储、日志或分析事件。

## 验收与发布

- 为每个后端响应保存脱敏合同 fixture，并覆盖正常、过期、撤销、乱序、无权限和断线重连测试。
- 增加 `/family` 的端到端验证：8 天历史、动态摘要、案例 2、匿名附件和真实/Mock 送达状态不混淆。
- 验证 `/family`、`/home`、`/debug` 仍在同一域名的三个路由下工作。
- 完成后合并到 `lbx-frontend`，再执行 production build、route build 和公网 smoke test。

## Frontend 明确不承担

- MiMo 调用、prompt、缓存和限流；
- 生活事实、菜品、睡眠、健康或意图推断；
- 匿名视频生成、对象存储、签名 URL 权威和保留策略；
- household 权限判定、发送任务执行和 transport receipt 生成；
- 用 localStorage 代替 Backend 数据库或 Relay 权威。
