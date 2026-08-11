# Reme 家属端信息层级精简规格

- Status: accepted-for-local-implementation
- Date: 2026-08-11
- Base: `810af77f`
- Branch: `codex/family-home-simplify`
- Scope: `/family` presentation only; `/debug` capability and diagnostics remain unchanged

## 1. 用户目标

家属打开页面时只需要回答三个问题：

1. 家中现在是否有需要关注的变化；
2. 最近发生了什么；
3. 自己现在需要做什么。

运行时、Relay、协议、revision、媒体源、RTC/TURN、控制租约和能力诊断不属于家属首页信息。

## 2. 展示裁决

### 家属端保留

- 一个可信的当前结论；离线时明确没有最新状态，不沿用旧“正常”。
- 权威行动卡和紧急告警及其处理动作。
- 最近收到的家属关怀事件与处理回执。
- 家中设备的简明在线/离线信息。
- 日常隐私保护说明。
- 原画真正开放时的剩余时间与当前可见人数。

### 家属端移除或降级

- 常驻公开演示连接横幅与非事件期 Viewer 数量。
- `WAITING`、能力状态、同步版本、revision、媒体源和连接诊断。
- 无可靠输入时的大面积骨架画面占位。
- 重复的“当前状态不可用”提示。
- 设置中的房间会话、TURN、Relay、MiMo 载荷等工程信息。

### Debug 保留

- 不修改 `/debug` 的运行时、媒体、协议、Relay、场景和验收能力。
- 非 family 的 Viewer 看板代码继续保留，便于演示诊断。

## 3. 隐私不变量

- 家属端不伪造正常状态、事件或历史。
- 浴室继续硬拒绝原画。
- 事件期原画授权、时限与 fail-close 逻辑不变。
- 原画开放时必须显示剩余秒数和当前可见人数。
- 当前公开演示无账号验证的事实保留为简短隐私说明，不再占据首页主视觉。

## 4. 验收

- `/family` 无活动原画授权时不显示公开连接横幅、在线访问端、同步版本、状态 revision、当前能力或原画窗口。
- 离线/未发布时只出现一个主要状态结论，骨架舞台不渲染。
- 运行时与采集均 ready/active 时仍可显示真实隐私骨架。
- 最近动态只消费 family-facing event 与处理 ACK，不展示 demo-state 诊断记录。
- 底部导航使用“首页 / 关怀记录 / 设置”。
- `/debug` 行为和可见能力不变。
- `npm test`、`npm run lint`、`npm run build`、`npm run test:route-build` 通过，并完成 family 页面视觉截图复核。

## 5. 本地实现结果

- `/family` 等待态在 `390×844` 实测只显示一个当前结论、最近动态、隐私说明和三项底部导航；`viewer-stage` 数量为 0。
- 等待态 DOM 不再包含“公开演示连接”“本次同步摘要”“同步版本”“当前能力”“WAITING”或“原画窗口”。
- `390×844` 与 `1280×720` 均实测 `overflowX=0`；底部导航为“首页 / 关怀记录 / 设置”。
- 家属设置页只保留提醒、隐私和必要的公开演示说明，不再展示房间会话、Relay、TURN 或媒体诊断。
- 应用内浏览器 fresh-load 的 `/family` console error/warning 为 0。
- `/debug` 实测仍保留全屏、媒体、四场景、演示动作与 Debug 控件。
- 自动验证通过：`npm test` 225/225、`npm run lint`、`npm run build`、`npm run test:route-build` 5/5。
- 视觉证据：
  - `evidence/family-final-390x844.png`
  - `evidence/family-final-1280x720.png`
  - `evidence/family-settings-bottom-390x844.png`
