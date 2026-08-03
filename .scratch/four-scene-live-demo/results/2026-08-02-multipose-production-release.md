# 单人 / 多人匿名火柴人公网发布证据

- Date: 2026-08-02
- Release code commit: `448905595d9a8ef210aa2fd54e0961b7567fb213`
- Integrated feature commit: `f131b74b50605dce8232bd2565d330ee7dee7532`
- Delegated source commit: `855a1467d4d07b657005aa59020a973eece6f07c`
- Production baseline: `2122e02ef3fae0eb0994d2600546dec67b620716`
- Capability status: automated/release gates passed; target-phone capability gate pending

## 发布结果

- Cloudflare staging Relay：version `1c473562-cf48-49a0-9b45-1fc852deb133`，URL `https://reme-demo-relay-staging.lx-0506.workers.dev`。
- Cloudflare production Relay：version `8b7ee3c2-bc45-4097-97a2-fc34a23f91a3`，custom domain `https://relay.reme.maniforld.com`。
- Vercel production：deployment `dpl_Bvb4qPBHR96ZtCbjDNUo1jCXy25i`，build URL `https://reme-4nqhwx5jp-lx050s-projects.vercel.app`；alias 清单确认 `reme.maniforld.com` 与 `monitor.reme.maniforld.com` 均指向该 deployment。
- 发布顺序为 staging Relay → staging 真实协议 smoke → production Relay → production capability smoke → production frontend → 双域名显式 alias。新 Relay 的 pose capability 使用独立 exact 消息，不改变旧前端依赖的 `relay_capabilities`；新前端在旧 Relay 下只继续单人帧，确认前不发送 batch/reset。

## 静止代码门禁

- Frontend：最终静止代码 `npm test` 202/202、ESLint、Vite production build 通过；本地与 Vercel 构建均为 975 modules。
- Relay：最终 Relay 代码 `npm test -- --reporter=dot` 70/70 连续三轮；Wrangler types、TypeScript check 通过。
- Wrangler production 与 staging dry-run 均通过：157.23 KiB / gzip 27.58 KiB，Wrangler 4.118.0。
- `git diff --check` 与冲突标记扫描通过；三路独立只读终审最终均为 P0=0、P1=0、P2=0。
- release blocker 回归覆盖：独立 capability 单调协商、旧 Relay 下 batch/reset 零发送、controller 断线时 grant/activity evidence 优先 fail-close、单人模型惰性加载的 arm-operation generation、旧 unavailable sequence barrier，以及只有当前帧真实发送后才显示绿色 `PUBLISHING`。
- 文档明确保留同步 `MediaPipe.detectForVideo` 的主线程边界：Promise deadline 无法抢占底层同步阻塞，不能把三秒 timer 声称为 Worker 级硬时限。

## staging 真实协议 smoke

使用真实 staging Worker、短期控制租约、一个 controller 和一个 viewer；只发送严格匿名测试关键点，不发送图片、音频、MiMo 请求或媒体信令。结果：

- `controller_ready` 成功；既有 activity capability 仍为独立两字段 exact 消息。
- 新能力精确声明 `pose_projection_capabilities / anonymous-pose-batch/v1`。
- 单人 `movenet-17/v1-demo` seq 0 被 Relay 接受并到达 viewer。
- 两候选 `reme-pose-batch-17/v1-demo` seq 1 被接受并原子到达 viewer。
- `reme-pose-reset/v1-demo` seq 2 清场成功；随后单候选 batch seq 3 恢复。
- controller 断线后 viewer 收到匹配 seq 3、mode `multi` 的 `pose_projection_unavailable`；租约随后显式释放，最终未遗留 controller。

## production 与公网静态 smoke

- production Relay 在没有活跃 controller 时取得短租约，仅读取 ready 与两条 capability 后释放；确认新 pose capability exact，旧 activity capability exact，`frames_published=0`。当时已有两个 viewer 在线，因此没有向生产发送任何合成姿态帧。
- `reme.maniforld.com` 与 `monitor.reme.maniforld.com` 均 HTTP 200。共享入口脚本按 hostname 把 monitor 域动态加载到 `monitor-main-DcIeUfGk.js`，评委域加载 `viewer-main-DVzwMW5A.js`。
- 发布 bundle 可见 `anonymous-pose-batch/v1`、`pose_projection_capabilities`、`reme-pose-batch-17/v1-demo`、“多人 · 实验”和本地 `pose_landmarker_lite.task` 引用。
- `https://monitor.reme.maniforld.com/mediapipe/pose_landmarker_lite.task` 返回 200，`Content-Length: 5777746`；原始视频仍不进入该静态资产或 Relay。
- CSP 继续仅允许同源脚本/模型与 `relay.reme.maniforld.com` 的 HTTPS/WSS，保留 `Permissions-Policy: camera=(self), microphone=(self), geolocation=()`、`Referrer-Policy: no-referrer` 与 `X-Frame-Options: DENY`。
- Chrome 扩展的公网自动导航在本次发布中超时，未形成可信的生产渲染截图，因此本证据不把公网视觉截图冒充为已完成 Gate；HTTP、静态 bundle 和真实 WebSocket 协议 smoke 独立通过。

## 仍未通过的人工 Gate

- 指定监控手机、真实后置摄像头和知情参与者的 `0/1/2/3/4/5+` 人 Pilot/Holdout；当前不能声称多人检出率、准确人数、遮挡质量或跨设备泛化。
- 目标手机上的推理 P50/P95、交付帧率、主线程长任务、内存、温升、连续运行与前后台恢复。若同步 `detectForVideo` 阻塞不可接受，本 Gate 为 No-go；硬抢占需要 Worker/离主线程架构。
- 真实手机 + 至少两个评委设备的模式切换、late join、断线恢复、完全隐私、厨房真实视频覆盖与权威跌倒覆盖。
- 摄像头/麦克风真实权限、事件触发语音停顿体验、STUN-only 跨网络与安全跌倒演示；不能声称公网普遍稳定、常驻热词唤醒或医疗级能力。
