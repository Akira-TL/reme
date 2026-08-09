# 验证记录（7×24 扩展后）

## 自动验证

- `npm test`：在最新 `origin/lbx-frontend@7d8acd86` 整合基线上 192/192 通过。
- `npm run lint`：通过。
- `npm run build`：通过，Vite 生成 Family/Home/Debug 与 shared chunks。
- `npm run test:route-build`：4/4 通过；首次在受限沙箱中因 `listen EPERM` 失败，允许本机临时监听后通过。

## 浏览器验证

- 应用：`/family` → `reme`。
- 主要视口：390×844，DPR 1。
- 补充视口：360×800、1280×720。
- 无横向溢出；控制台无应用 warning/error。
- 已验证日期切换、全部/设备/关怀筛选、五时段折叠、普通片段分组详情、设备来源详情、关怀问答与家庭材料连接。
- 8 月 4—11 日每天覆盖 24 小时且不少于 27 条；8 月 8 日为 27 条，8 月 9 日为 38 条，统计与内容均有明显差异。

## 边界检查

- 没有新增数据库、localStorage、Relay 写入或协议字段。
- 没有修改实时 Family timeline reducer、告警确认或媒体授权逻辑。
- 新增生活与设备记录只存在于 `mock_fixture`；文案避免把意图、睡眠或健康写成视觉事实，具体菜名只来自本人 Mock 回答。
