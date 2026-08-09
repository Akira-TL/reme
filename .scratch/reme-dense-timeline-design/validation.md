# 验证记录

## 自动验证

- `npm test`：在最新 `origin/lbx-frontend@e474137c` 上 174/174 通过。
- `npm run lint`：通过。
- `npm run build`：通过，Vite 生成 Family/Home/Debug 与 shared chunks。
- `npm run test:route-build`：4/4 通过；首次在受限沙箱中因 `listen EPERM` 失败，允许本机临时监听后通过。

## 浏览器验证

- 应用：`/family` → `reme`。
- 主要视口：390×844，DPR 1。
- 补充视口：360×800、1280×720。
- 无横向溢出；控制台无应用 warning/error。
- 已验证日期切换、Mock 记忆周说明、全部/关怀筛选、时段折叠、普通片段分组详情、关怀详情与本人回应连接。
- 重放到最新 CareDecision v3 基线后，再次复核 390×844 页面与 18/2 摘要，无横向溢出。

## 边界检查

- 没有新增数据库、localStorage、Relay 写入或协议字段。
- 没有修改实时 Family timeline reducer、告警确认或媒体授权逻辑。
- 新增普通生活记录只存在于 `mock_fixture`，文案避免把意图、睡眠、健康或具体烹饪行为写成事实。
