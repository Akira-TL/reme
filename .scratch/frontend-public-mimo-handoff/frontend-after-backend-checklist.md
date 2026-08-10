# Backend 能力完成后的 Frontend 收口清单

- Status: waiting-for-backend
- Owner: Frontend
- Recorded: 2026-08-10
- Depends on: `backend-requirements.md` 中 DateIndex、TimelineDayState、CareThread、DiarySummaryState、材料附件与送达合同
- Scope: 不增加登录、账户、household member/role 或前端接收人选择
- Source boundary: `2026-08-10 12:00 Asia/Shanghai` 前为明确 Mock，之后只显示 Backend / Relay 实时记录

## 结论

Backend / Relay 完成历史时间线、MiMo 摘要、匿名材料和真实送达能力后，Frontend 仍需完成接口接入与产品状态呈现。Frontend 不重新实现 MiMo、关怀判断、媒体授权、持久化或送达权威。

## 当前代码的严格差额

已经完成：Reme 日期条、24 小时五时段、统计与筛选、CareThread/一问一答/材料卡 UI、固定 8 天 Mock、MiMo 摘要展示状态，以及当前会话的 `reme-viewer-v2` 接入。

仍未完成且只等待后端合同落地后接入：

1. DateIndex、TimelineDayState、CareThread、DiarySummaryState 的同源公网 client 与严格 parser；
2. 用 Backend 日快照承接混合数据源：8 月 10 日 12:00 前允许 Mock，之后只允许真实记录；
3. 把当前指向本地 `/api/diary/summary` 的摘要请求切换到 Backend 公网摘要状态接口；
4. 接入 `reme_day_revision` 或 Backend 最终选定的等价通知并处理重连；
5. 将 Backend CareThread 映射到现有一问一答、材料和送达 UI；
6. 若 Backend 返回真实匿名附件，则增加播放/过期/撤销状态；若返回 transport receipt，则展示真实送达状态；
7. 补齐合同、断线和三路由的自动化验证并发布。

除此之外，当前范围不需要新增登录、账户、成员选择、前端发送任务或新的产品页面。

## P0：公开演示接口接入

- 为 DateIndex、TimelineDayState、CareThread、DiarySummaryState 建立严格 schema 解析器；未知字段、倒退 revision 和错误日期 fail closed。
- 将 Reme 页截止点前的 fixture 迁到 Backend / Relay；截止点后的生产数据只消费实时投影，本地 fixture 不得越过边界。
- 接入 Backend 选定的 WebSocket、SSE、ETag 或短轮询 revision 通知；切换日期、刷新和断线重连后重新取得权威快照。
- 展示 loading、generating、partial、stale、unavailable 和 retry 状态；MiMo 不可用时不得用固定摘要冒充实时结果。
- 保留 `metadata_only` 附件和 `mock_delivered` 的明确演示标识。
- 生产浏览器只访问同源公网 API，不访问 localhost、MiMo API 或设备 API。

## P1：真实匿名材料附件

- 消费 Backend 返回的 `asset_id`、附件状态、隐私模式、时长和短期签名播放地址。
- 在材料卡中增加“生成中、可播放、仅元数据、已过期、已撤销、加载失败”状态。
- 播放前确认资源有效期；过期后向 Backend 重新申请短期地址，不缓存长期 URL。
- 默认不自动播放、不提供原始媒体入口；清晰视频始终 fail closed，`skeleton_only` 只允许明确声明的匿名骨架媒体，浴室和 `hidden` 按 Backend 权威策略不显示附件。

## P1：真实送达与回执

- 直接展示 CareThread 中由 Backend 配置并投影的固定接收对象；Frontend 不提供成员选择。
- 展示 Backend 投影的 `pending / delivered / failed` 等正式状态及时间戳；Reme 历史页不负责发起发送任务。
- 只有收到 Backend transport receipt 后才显示真实“已送达”；`mock_delivered` 永远显示为演示。
- 在同一 CareThread 中连续展示“观察 → 发问 → 回应 → 材料 → 送达”，但不在浏览器推断线程状态。

## 公开连接与隐私状态

- 继续使用现有公开连接和 Relay room/session；不增加登录、账户或成员权限页面。
- 对 400、404、503、资源撤销、数据删除和断线后的失效状态提供明确 UI。
- 不把 raw video、raw audio、逐帧骨架、MiMo prompt、密钥或完整原始对话写入浏览器持久存储、日志或分析事件。

## 验收与发布

- 为每个后端响应保存脱敏合同 fixture，并覆盖正常、过期、撤销、乱序、不可用和断线重连测试。
- 增加 `/family` 的端到端验证：8 天历史、动态摘要、案例 2、匿名附件和真实/Mock 送达状态不混淆。
- 验证 `/family`、`/home`、`/debug` 仍在同一域名的三个路由下工作。
- 完成后合并到 `lbx-frontend`，再执行 production build、route build 和公网 smoke test。

## Frontend 明确不承担

- MiMo 调用、prompt、缓存和限流；
- 生活事实、菜品、睡眠、健康或意图推断；
- 匿名视频生成、对象存储、签名 URL 权威和保留策略；
- 账户或成员体系、发送任务执行和 transport receipt 生成；
- 用 localStorage 代替 Backend 数据库或 Relay 权威。
