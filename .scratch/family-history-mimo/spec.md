# Family 历史回放与 MiMo 摘要修正

## 缺陷

1. Family 首页录像入口只按“今天”查询，因此当前日期没有录像时，8 月 4—11 日的内置 Mock 录像虽然随构建发布，却没有可发现入口。
2. Family 的丰富 Mock 时间线固定传入空摘要，没有消费 Relay 已冻结的 `reme-diary-summary-state/v1`，导致页面把“Mock 行为输入”错误等同于“Mock 摘要”。
3. VPS 的一次性 history loader 显式传入 `--skip-summaries`，所以即使 Backend 已配置 MiMo Key，也不会生成真实摘要。

## 范围与边界

- 只复用仓库现有 Backend/Relay 合同和 Backend MiMo client；不改 `backend/`、`demo-relay/`，不新增摘要 API。
- MiMo Key 只保留在 VPS Backend env；前端只读取 Relay 的 Family API。
- 行为数据始终标为 `mock_fixture`；MiMo 成功时明确标为 MiMo 生成，失败时显示“摘要暂不可用”，绝不使用固定摘要兜底。
- 摘要必须与当前日期一致，且 `input_event_count` 必须与当前 Family Mock 日的生活片段总数一致；不一致时 fail closed，不把另一份或旧 revision 的摘要显示到页面。
- Backend 现有 summary cache 继续按日期、timeline revision 和规范化输入 hash 复用；前端使用 Relay revision 通知刷新，不持久缓存权威摘要。
- 录像仍是明确标注的内置演示素材，不把它描述为真实家庭历史，也不经 Relay/MiMo 传输媒体字节。

## 实现

1. 首页录像卡增加单行紧凑日期 `<select>`：默认选择最近一个有录像的日期，列出 8 月 4—11 日及当前日期，显示每日电影片段数；切换后同一卡片更新橙色录像段。
2. 在 Viewer 根组件持续启用 `useRemeHistory`，按已选日期与 Relay `reme_day_revision` 拉取 day/summary；渲染前按日期拒绝旧响应，防止串日。
3. Mock 时间线继续保留完整丰富展示，但摘要只显示经过日期和输入数量匹配校验的 Backend/Relay MiMo 结果。
4. 摘要文案明确分层：`行为来源 · Mock 演示数据`、`摘要来源 · MiMo`；成功文案为“基于 N 条 Mock 结构化生活记录，由 MiMo 生成”。
5. VPS compose 的 history loader 不再跳过摘要生成，继续复用持久化 Backend cache volume。

## 验收

- 单元测试覆盖默认录像日期、日期列表、跨日/数量不匹配摘要拒绝和正确 MiMo 摘要选择。
- `npm run typecheck:contracts`、`npm test`、`npm run lint`、`npm run build`、`npm run test:route-build` 全绿。
- Backend history/summary 和 Relay 合同测试全绿，证明未修改权威合同。
- 本地浏览器确认日期选择器能进入历史 Mock 录像，时间线成功/失败摘要文案符合来源边界。
- VPS 重新发布后，history loader exited 0；公开 Family API 返回 ready MiMo 摘要或明确 unavailable，公网 Family 显示与 API 一致。
