# Reme 前端架构

本文描述 Reme 黑客松前端当前可接受的工程边界。它是渐进式演进基线，
不是对 Backend、Relay 或安全策略的重新设计。

## 1. 目标与非目标

前端服务三类界面：居家采集端、家属端和工程调试端。工程目标是让实时媒体、
Relay 协议和 UI 呈现各自可定位、可失败、可验证，同时保持隐私默认关闭。

本阶段不引入 Next.js、React Router、Redux/Zustand、全量 TypeScript 迁移或 CSS
重写。现有 React 19 + Vite 8 SPA 和 pathname 路由继续使用。

## 2. 技术栈与依赖职责

| 技术 | 职责 | 约束 |
| --- | --- | --- |
| React 19 | 组件组合与 Hook 编排 | 不承载协议权威或安全定时器 |
| Vite 8 | 开发、构建、按路由动态分块 | 三个 pathname 共用一个 SPA 入口 |
| MUI 9 | 交互控件、图标、主题与无障碍语义 | 新交互组件优先使用 MUI |
| Emotion | MUI 主题运行时依赖 | 不新增零散的业务 styled 体系 |
| Tailwind 4 | 保留既有工具链能力 | 本阶段不扩张为第二套样式规范 |
| 原生 CSS | 产品布局、场景层、响应式与动画 | 按 surface/feature 维护 |
| Node test | 协议、Reducer、运行时纯逻辑 | 不替代真实浏览器验收 |
| Playwright | Chromium 路由、Canvas、WebSocket 与隐私回归 | 仅开发依赖，不进入产品 bundle |
| TypeScript `tsc` | 新增 JS 契约模块的窄范围 `checkJs` | 不产物、不全仓迁移 |

新增依赖必须说明 bundle、运行时与维护成本。`@playwright/test` 和
`typescript` 均为 devDependency，产品 bundle 成本为零。

## 3. 路由与装配

`src/main.jsx` 是唯一入口。`routing/appRoute.js` 只解析 pathname，随后动态导入：

| Path | App | 产品角色 |
| --- | --- | --- |
| `/home` | `apps/home/HomeApp.jsx` | 居家采集端 |
| `/family` | `apps/family/FamilyApp.jsx` | 家属端 |
| `/debug` | `apps/debug/DebugApp.jsx` | 工程验收端 |

旧路径只做显式 canonical redirect。业务组件不得自行读取 pathname 来重新实现
路由，也不得把三个 surface 合并成一个同步加载的大入口。

## 4. 权威边界

Backend 是以下事实的唯一权威：姿态/跌倒解释、CareDecision、安全超时、告警、
行动卡、FamilyEvent、MediaAuthorization。前端不得根据关键点、时间或 UI 状态
推断跌倒，不得用浏览器计时器触发安全升级，也不得自行生成告警或授权。

架构图中的 **A 明确指 Home 设备上的统一 Backend 进程，不是 Home 浏览器前端**。
Home 与 Family 都只消费 A 产出的同一组有序 17 点关键点：Home 为降低本机延迟，
直接消费 Backend `frame_landmarks`；Family 消费该结果经严格适配并由 Relay 转发的
`reme-pose-frame-17/v1`。两端传输入口不同，但权威来源相同，任何一端都不运行
MoveNet、MediaPipe、LiteRT，也不补造姿态帧。

Relay 是房间、租约、ACK、有界发布队列和 WebRTC 信令的传输权威。Relay JSON
不得携带 JPEG、视频、音频、Blob、data URL 或任何帧历史。

浏览器只拥有两类本地事实：媒体/网络能力状态，以及不改变权威身份的显示状态。

## 5. 分层与目录规则

前端依赖方向从 UI 向纯模块单向流动：

```text
apps / feature components
        ↓
hooks (React 生命周期编排)
        ↓
runtime (媒体、Canvas、Worker 生命周期)
        ↓
transport (wire schema、解析、队列、连接)
        ↓
domain/adapters (纯状态与合同映射)
```

- `apps/`：按 surface 装配，不实现协议。
- `shared-demo/`、`typical-demo/`：页面与 feature 组件；复杂副作用下沉。
- `hooks/`：组合 React 生命周期与底层 runtime。
- `runtime/`：浏览器资源所有权。对象必须有明确 `dispose/stop`。
- `transport/`：React-free 的精确 wire contract。
- `adapters/`、纯 helper：Backend 合同到 UI 可读模型的无副作用映射。

旧模块可逐步迁移；禁止为了目录整齐进行一次性重写。

## 6. 居家端媒体与感知链

首选采集与骨架分发链保持不变：

```text
Home 浏览器（只采集/编码）
  MediaStreamTrackProcessor → Worker → OffscreenCanvas
  → 384px JPEG（目标 10 FPS）
  → Home 本机 Backend :8770（A：MoveNet / 姿态 / 时序）
  → 权威 frame_landmarks
       ├─→ Home Canvas（只绘制）
       └─→ reme-pose-frame-17/v1 → Relay → Family Canvas（只绘制）
```

“与家属端使用同一骨架”指同一个 Backend 结果与同一个 17 点语义合同，不要求 Home
把本机显示绕行 Relay。让 Home 也经 Relay 回读会无谓增加云端/网络依赖，并不能提高
权威一致性。

当 TrackProcessor/Worker/OffscreenCanvas 不可用时可降级到主线程 Canvas pacer，
但降级必须在 `/debug` 可见。发送端使用 WebSocket `bufferedAmount` 进行背压；
忙时丢弃输入帧，而不是累积无界队列。前端只报告 dropped/backpressure，不把丢帧
解释为安全事件。

组件卸载、媒体源变化或会话停止时必须终止 Worker、关闭/释放 VideoFrame、取消
rAF/interval、移除监听并关闭 socket。媒体源 generation 可变化，Backend runtime
session 不应仅因摄像头切换而无条件重建。

## 7. Family 骨架显示

Family 同时维护三种不同状态，禁止混用：

1. **权威/领域状态**：最新合法 DemoState、FamilyEvent 与 Backend projection。
2. **传输状态**：room/runtime session、revision/sequence、连接、ACK、grant、lease。
3. **呈现状态**：Canvas 插值、短时 last-good hold、DPR 尺寸与动画帧。

`viewerState` 保存最新接受的 PoseFrame，包括明确的
`person_detected:false`，并另存最后一次检测到人的原始帧供显示选择。短时保持不会
改写 sequence、timestamp 或 `receivedAtMs`，也不会伪装成 Backend 新结果。

`runtime/viewer/posePresentation.js` 只决定是否显示 live/degraded/held/stale；新鲜度
基于本机接收时间，避免跨设备时钟偏差。`poseCanvasRuntime.js` 独占 ResizeObserver、
DPR resize、rAF 插值与 cleanup。runtime/session 变化、Relay 不可用或帧过期时清空。

## 8. Relay 协议与发布策略

`transport/relay/monitorProtocol.js` 是 Monitor wire boundary。它集中维护：

- `reme-demo-state/v1`
- `reme-pose-frame-17/v1`
- `reme-control-command/v1`
- `reme-media-signal/v1`
- claim、controller、ACK、grant 与 raw-media 拒绝规则

验证采用 exact keys、显式枚举、长度/数值上限和 session 绑定。协议错误必须可见，
不能容错成新的业务事实。

DemoState 和 PoseFrame 各自只有一个 in-flight 与一个 latest slot。新值可替换 latest，
不能无限排队。ACK 只推进匹配的 revision/sequence；断线后中断 in-flight 并按已有
退避策略重连。重连不得跨 room/runtime 复用旧 pose、grant 或控制租约。

## 9. FamilyEvent 与远程命令

家属端只呈现 `reme-family-event/v1`。行动卡与告警是两个不同产品状态：

- `acknowledge_alarm` 由 Backend 应用为 `alarm_acknowledged`；
- `confirm_action_card` 由 Backend 应用为 `card_confirmed`。

前端只发 exact `reme-control-command/v1` 并等待 Relay/Backend ACK 与后续权威投影。
收到 ACK 前不得本地宣告安全状态已改变；失败、拒绝、租约占用和超时必须显示。

## 10. 隐私与 WebRTC

清晰原画必须同时满足：

1. 当前 Backend MediaAuthorization 为 active；
2. decision、event、scene、scope 与 runtime/session 一致；
3. Relay MediaGrant 为 active 且未过期；
4. 本地高隐私开关未主动隐藏；
5. 场景和 privacy mode 允许。

`bathroom`、`hidden`、`skeleton_only` 任一条件出现即 fail closed。授权过期、场景切换、
track ended、Relay 断开、WebRTC 协商失败或 source generation 变化时立即回退骨架。

WebRTC 只传事件期 RTP。Relay 只转发 SDP/ICE JSON，不保存 RTP。TURN 凭证必须短期、
由 Relay HTTP 配置返回；无 TURN 时 UI 应明确标记 local-network-only/stun-only，不能
承诺公网可达。

## 11. MiMo 边界

日常连续摄像头帧和姿态流不发送给 MiMo。只有 Backend 明确进入需要语义判断的事件
窗口时，才可按既有合同选择单帧/短片或问询语音。前端展示 MiMo 请求状态和来源，
但不得把 MiMo 文案升级为未经 Backend 接受的安全事实。

## 12. 样式职责

- MUI：Button、Dialog、Drawer、Switch、IconButton、主题 token、图标与交互语义。
- 原生 CSS：页面结构、场景视觉层、Canvas/video 叠层、响应式与产品动效。
- Tailwind：只保留现有能力；除非有独立 ADR，不再扩张工具类与原生 CSS 的重叠面。
- Emotion：供 MUI theme 使用，不新建分散的业务 styled component 体系。

新组件先复用已有 class/token。禁止用第三套颜色/间距常量悄悄建立局部设计系统。

## 13. 类型、测试与可观测性

`tsconfig.contracts.json` 只检查新增 transport/runtime JS。扩展协议或资源 runtime 时，
优先补 JSDoc 类型和 `// @ts-check`；业务组件仍可按风险渐进迁移。

本地质量门：

```bash
npm run typecheck:contracts
npm test
npm run lint
npm run build
npm run test:route-build
npm run e2e
```

Playwright 使用真实 Chromium 和精确 HTTP/WebSocket fixture，覆盖三路由装配、Family
Canvas 像素、告警/行动卡命令语义及浴室隐私。真实摄像头、后台标签页 FPS、物理设备、
Backend/Relay/TURN 联调仍是单独的本地验收门，不能由 mock E2E 代替。

`/debug` 至少展示：最新帧龄、输入丢帧、背压、capture transport、Relay status、
state ACK、pose offered/in-flight/ACK、协议错误、WebRTC mode/status/peer/reason。
这些工程指标不得出现在家属产品界面。

## 14. 启动、安全上下文与发布

- 本机开发可使用 `localhost`/`127.0.0.1` 获取安全上下文例外。
- 局域网手机访问摄像头、麦克风、Worker 与 WebRTC 时应使用 HTTPS。
- 环境变量只提供服务地址和非秘密配置；长期 TURN 密钥不得进入 Vite 客户端变量。
- `/home`、`/family`、`/debug` 的服务端 fallback 必须返回同一 SPA 入口。

黑客松允许的例外（公开演示房间、有限 Viewer、短期授权）必须在 UI 和文档中明确，
不能自然演化为生产默认。生产 P1 包括身份认证、房间授权、审计、CSP/安全头、TURN
凭证轮换、可访问性审计、真实移动设备矩阵和长期性能基线。

## 15. 变更检查清单

任何涉及实时前端的 PR 至少回答：

1. 权威事实由谁产生，前端是否只呈现？
2. room/runtime/source generation/revision 如何隔离旧状态？
3. 队列上限和背压是什么？
4. 断线、过期、unmount、track ended 时释放哪些资源？
5. 隐私失败是否默认回到骨架/不可用？
6. Debug 能否看见失败而产品 UI 不泄漏工程噪声？
7. Node、构建、路由、Playwright 与物理设备中哪些已验证，哪些仍待验证？
