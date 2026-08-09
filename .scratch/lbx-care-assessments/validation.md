# 验证记录

日期：2026-08-09

## 自动化

- Frontend `npm test`: 167/167 passed.
- Frontend `npm run lint`: passed.
- Frontend `npm run build`: passed.
- Frontend `npm run test:route-build`: 4/4 passed（需本机临时监听回环地址）。
- Demo Relay `npm test`: 21/21 passed.
- Demo Relay `npm run typecheck`: passed.
- `git diff --check`: passed.

## 浏览器

- Family bottom navigation: `家 / reme / 设置` 均可切换，选中态和可见标签正确。
- `家`: 同时包含实时状态与原看板摘要，无独立 `看板` 入口。
- `reme`: 8 月 4 日和 8 月 11 日均可访问，各显示两条 Mock 判断；单元测试覆盖 4–11 日全部日期。
- Expanded card: 显示 Mock 来源、不确定性、系统上下文与隐私边界。
- Responsive: `390×844` 与 `1440×894` 均无横向溢出。
- Console: 修复 MUI Fragment 问题后无 warning/error。

视觉对比详见项目根目录 `design-qa.md`，结论为 `passed`。
