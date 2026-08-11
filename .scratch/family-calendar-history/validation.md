# Reme 完整日历与 8 天数据边界验证

- Date: 2026-08-11
- Result: passed

## 来源核对

- 已执行 `git fetch origin lbx-frontend`；远端当前为 `a2c6e928`。
- 原完整 8 天脚本提交为 `7790c3e5 feat: expand reme to 24-hour whole-home memory`。
- 根因确认：后续 `d51dc614` 把前端 Mock 截到 8 月 10 日中午，并让 Backend
  精简 fixture 成为页面主数据；本修复恢复原前端脚本为 8 月 4–11 日的展示源。

## 8 天计数

| 日期 | 总片段 | 活动 | 设备 | 关怀 | 覆盖 |
| --- | ---: | ---: | ---: | ---: | --- |
| 08-04 | 32 | 16 | 14 | 2 | 24h |
| 08-05 | 30 | 14 | 14 | 2 | 24h |
| 08-06 | 29 | 14 | 13 | 2 | 24h |
| 08-07 | 28 | 12 | 14 | 2 | 24h |
| 08-08 | 27 | 11 | 14 | 2 | 24h |
| 08-09 | 38 | 22 | 13 | 3 | 24h |
| 08-10 | 29 | 14 | 13 | 2 | 24h |
| 08-11 | 30 | 13 | 15 | 2 | 24h |

## 自动验证

- Frontend Node tests: 236 passed。
- ESLint: passed。
- Contract TypeScript check: passed。
- Vite production build: passed。
- Route build: 5/5 passed，`/family`、`/home`、`/debug` SPA fallback 正常。

## 内置浏览器

- 390×844：完整 7 列月历显示 2026 年 8 月，`scrollWidth=innerWidth=390`。
- 可翻到 2026 年 7 月并选择 7 月 15 日；页面显示“这一天没有收到真实记录”，
  没有用 Mock 补空。
- 返回 8 月并选择 8 月 4 日，页面显示原脚本 32 个生活片段、全天关怀覆盖。
- 8 月 4 日客厅演示 MP4 `readyState=4`、自动播放、时长 9.916667 秒。
- 8 月 12 日在当前 8 月 11 日环境中作为未来日期禁用；纯函数测试确认其不在
  Mock 范围，`FAMILY_TIMELINE_REALTIME_START_DATE=2026-08-12`。
- 浏览器日志只有 Vite debug 与 React DevTools info，无产品 warning/error。

### 浏览器标注后的页面归属回归

- 首页在状态卡之后、最近动态之前显示唯一一块“今天录像回看”；8 月 11 日显示
  2 段明确标注的演示录像，390px 下无横向溢出。
- 点击首页 10:05 橙色段进入播放器，实际资源为
  `/mock-recordings/living-routine.mp4`，`readyState=4`、`paused=false`、时长
  9.916667 秒；返回按钮文案为“返回首页”。
- 关怀记录页的 `reme-activity-rhythm` 数量为 0；页面从完整月历直接进入 Reme
  本日摘要、30 条来源统计与下方生活记录，没有重复录像卡。
- 迁移后的浏览器日志仍只有 Vite debug 与 React DevTools info，无 warning/error。

证据：

- `evidence/17-complete-calendar-390x844.png`
- `evidence/18-real-history-empty-390x844.png`
- `evidence/19-home-recording-390x844.png`
- `evidence/20-reme-without-recording-card-390x844.png`
