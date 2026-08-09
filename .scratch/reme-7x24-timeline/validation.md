# Reme 7×24 全屋时间线验证

## 数据合同

- 8 个日期均有深夜、清晨、上午、午后和夜晚五个时段，`coverageHours` 为 24。
- 每日总数为 27—38 条，形成 6 种不同统计；所有日期同时包含人体/空间、设备和主动关怀。
- `mock_pose_observation` 只描述可观察姿态与空间变化；`mock_device_event` 承担灯光、空调、音响、冰箱、烟灶、热水器、门锁等固定设备事实。
- MiMo 请求接受 `device` 事件但仍为严格白名单；摘要重点时间必须来自输入事件。

## 案例 2

- 8 月 9 日 10:42—10:56 包含取食材和烟灶联动。
- 11:36 MiMo 发问、11:39 本人回答菜名并同意分享、11:40 Mock 材料显示已发给女儿。
- 展开材料可见 1 问 1 答、3 条设备事实、18 秒匿名厨房骨架片段、接收对象和送达状态。

## 自动化与浏览器

- 在最新 `origin/lbx-frontend@7d8acd86` 整合基线上，前端 192/192、ESLint、Vite build、4/4 route build 全部通过。
- Python 完整测试通过（1 项既有 skip），MiMo 摘要定向测试 5/5；Ruff 与本次修改模块的严格 Mypy 通过。仓库级 Mypy 仍有 4 个与本次 diff 无关的既有感知模块错误。
- 360×800、390×844、832×1021 均无横向溢出；无重复 id、无 React 运行时异常。
- 截图与同视口对比见 `.scratch/reme-ai-diary-summary/audit/17-7x24-top-832x1021.png`、`18-cooking-share-daughter-832x1021.png` 和 `19-before-after-7x24-832x1021.png`。

## 保留边界

- 没有新增数据库、localStorage、Relay 写入或真实家庭通知。
- 没有上传或持久化真实媒体；附件和“已发给女儿”均为明确标记的 Mock。
- 本地 MiMo 或 Relay 不可用时保持失败可见，不伪造生成摘要或在线状态。
