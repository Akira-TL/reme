# 四场景跨设备 Demo 自动化 Gate 结果

- Date: 2026-08-02
- Branch: `lbx`
- Scope: 协议、Relay、前后端回归、响应式布局与本地跨端控制面

## 资产核对

- 用户提供的 `movenet_lightning_f16_v4.tflite`：
  `0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab`
- 公网页面引用的版本化权重：同一 SHA-256，4,758,512 bytes。

## 自动化结果

- Frontend: `npm test` 62/62；`npm run lint`；`npm run build`（962 modules）。
- Backend: `uv run pytest` 605 passed / 1 skipped；strict mypy；Ruff。
- Relay: Vitest 18/18；Wrangler types check；TypeScript；production/staging dry-run。
- `git diff --check`：通过。

覆盖的失败路径包括：事件未知字段/乱序、浴室 fail-closed、checking 禁止媒体、厨房未同意禁止 grant、晚加入 viewer 不继承 grant、越权/过期信令拒绝、WebRTC 不支持/失败时保留告警、语音空录音与取消后释放锁、告警 TTS 去重。

## 浏览器与本地跨端结果

- 390×844：评委端、监控端锁定页和解锁后控制页文档宽度均与 viewport 相等；无横向滚动，四个场景按钮与控制按钮可触达。
- 430×932：评委端与监控端锁定页无横向滚动；文案完整。
- 1280 桌面：评委端双栏布局、固定环境抽象与状态侧栏正常。
- 本地 Worker + Vite：一个控制租约、三个 viewer 同时连接；三个 viewer 均回放同一 `bathroom` 场景；状态接口报告 `viewer_count=3`。
- 控制端快速连续切换厨房 → 完全隐私 → 跌倒后，评委端最终为跌倒场景且连接保持；事件序号预留回归通过。
- 完全隐私场景：评委端 `environment-private`，授权视频不可见，隐私条显示“始终只显示 17 点抽象骨架”。

## 尚未关闭的人工 Gate

- 需要使用目标手机各录一次真实做饭与非做饭，记录 MiMo 原始判定、阈值和延迟。
- 需要在安全保护条件下做一次真实跌倒动作，并以站立、坐下、弯腰作负例；当前不得陈述临床准确率。
- 需要在实际同 Wi-Fi 设备间验证授权视频轨道；跨网络当前仅 STUN，失败时应按设计显式降级。生产级跨网需要后续 TURN/SFU。
