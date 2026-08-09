# Reme 三角色前端本地整合规格

- Status: accepted-for-local-implementation
- Date: 2026-08-09
- Base: `origin/lbx-frontend@961361dcd3b843d8e56ae20b5bf0025b3cdfed3c`
- Scope owner: frontend / local demo
- Cloud gate: closed

## 1. 目标

在不改动 A/B/MiMo、Relay 协议与安全策略的前提下，把现有双设备演示收口为一个 Vite 工程里的三个明确角色入口：

- `/home`：家中端。唯一拥有本机媒体源、感知会话和老人交互的产品入口。
- `/family`：家属端。只消费 Relay 的权威状态、匿名骨架、事件通知和当前授权媒体。
- `/debug`：工程验收端。完整保留 Akira ABC 同屏演示、手机模拟、场景注入、验收控制和原始状态。

本轮只在本地分支实现、验证和提交，不 push、不部署，不修改 Vercel、Cloudflare、DNS 或 GitHub 远端状态。

## 2. 入口与兼容行为

- 使用同一个 `frontend/index.html` 和 pathname dispatcher；三个角色按 `React.lazy` 独立加载。
- `/` 本地跳转到 `/home`。
- `/viewer.html` 作为旧链接兼容入口，跳转到 `/family`。
- 未知路径显示明确的入口不存在状态，不静默挂载摄像头或 Debug。
- 路由不依赖 React Router，不增加新的运行时依赖。

## 3. 角色边界

### `/home`

- 保留真实 camera/display/file 输入、本机权限确认、统一后端 JPEG 感知、A/B/MiMo 状态、Relay producer 与 grant-bound WebRTC。
- 点击开始后必须在当前本机手势中立即请求媒体权限；Relay producer claim 与本机采集并行，Relay 失败只能降级家庭同步，不能阻断或撤销本机媒体。
- 默认从 `living` 场景开始；场景切换继续调用真实后端，不注入合成关键点。
- 不渲染 `ChildPhone`、`AcceptanceControls`、`RuntimeDebugPanel`、Debug 重置或人工 fall trigger。
- 不向远程 Viewer 暴露场景注入、媒体源控制、本人回应或重播语音等工程命令；家属只可确认当前权威告警。
- 服务失败时显示 unavailable/degraded，不使用 synthetic fallback。

### `/family`

- 复用 `ViewerApp` 的 Relay、权威快照、匿名骨架、告警、授权媒体与通知能力。
- 不请求 camera/microphone，不导入家中端运行时模块。
- 不显示远程路演控制抽屉；保留当前告警的家属接管与确认动作。
- 原画仍严格受 ADR-0008 演示 grant、浴室硬门、会话/source generation 和 Relay authority 约束。
- 所有公开房间、在线 audience 和 demo-only 隐私例外继续如实披露，不包装成生产账号体系。

### `/debug`

- 完整保留当前 `TypicalDemoApp` 行为和布局，包括同屏家中端、家属手机壳、Monitor 控制、Acceptance 控制与 Runtime Debug。
- 显著标记为 Debug/工程验收，不作为产品视觉口径。
- 允许脚本场景和人工触发，但必须继续显示真实 runtime、source 与 degraded 状态。

## 4. 视觉与响应式

- `/home` 与 `/family` 使用原生浏览器全视口布局；禁止手机边框、假状态栏、Dynamic Island 和固定 390×780 外壳。
- 使用 `100dvh`、`env(safe-area-inset-*)`，支持 320/360/375/390/412/430 px 手机宽度、横屏、平板与桌面。
- 家中端核心正文不小于 20 px，主操作点击区不小于 44 px；一次只突出一个主要动作。
- 家属端保持江姐稿的暖橙、圆角、卡片层级与三页导航，但动态内容只来自真实状态，不恢复硬编码健康指标。
- `/debug` 可继续使用桌面验收密度和手机模拟，因为其角色就是工程同屏演示。
- 尊重 `prefers-reduced-motion`，不依赖闪烁传达唯一状态。

## 5. 不做

- 不改 backend、模型、MiMo prompt、事件 schema、阈值或安全时序。
- 不恢复浏览器 MediaPipe/MoveNet/LiteRT。
- 不新增生产鉴权、账号配对、持久媒体、TURN 付费配置或云端部署。
- 不把 ADR-0008 的无鉴权公开房间例外描述成生产隐私方案。
- 不声称真机、跨 NAT WebRTC 或连续 20 次切源已通过，除非本轮实际测完。

## 6. 验收

自动验证：

```bash
cd frontend
npm test
npm run lint
npm run build
```

必须新增或更新的确定性断言：

- pathname 精确映射 `/home`、`/family`、`/debug` 与兼容重定向；
- family 入口 chunk 不静态导入 camera/runtime/debug 模块；
- home 模式不注册 Debug/媒体控制/场景注入远程动作；
- debug 模式保持完整工程动作；
- 三入口 build 产物可从 SPA fallback 打开。

浏览器验收：

- `/home`：390×844、430×932、1440×900，无手机外框、无横向滚动，媒体权限与失败状态可见；
- `/home` 在 Relay 离线时仍触发本机媒体权限并开放媒体源操作，同时把家庭同步明确显示为不可用；
- 手机局域网 HTTP 必须明确提示使用受信任 HTTPS；摄像头授权成功后的预览/系统策略错误不得再标记为“用户拒绝”；
- `/family`：390×844 与桌面，无手机外框、无远程路演控制，首页/看板/设置可用；
- `/debug`：1920×1080 保留 ABC 同屏、手机模拟和 Debug；
- 未启动后端/Relay时三个入口均 fail-visible，控制台无新增错误；
- 参考视觉与实现同视口并排检查，P0/P1/P2 清零后才交付。
