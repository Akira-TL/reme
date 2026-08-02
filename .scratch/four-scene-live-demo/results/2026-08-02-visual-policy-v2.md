# 评委端视觉策略 v2 自动化结果

- Date: 2026-08-02
- Base: `e465fd73` + detached auto-scene `ede3b8f4`
- Release boundary: 本结果只来自 `/tmp/reme-auto-scene`；未移动 `lbx`，未 push，未部署

## 已通过

- Frontend：最终静止代码 `npm test` 137/137；`npm run lint`；`npm run build`（972 modules）。覆盖 pending ACK 代次、fall scene 绑定、首帧 LIVE、首帧后的 3 秒静默冻帧 watchdog、hidden/mute/ended/stalled fail-close、offer 防 ICE 淘汰和 recorder settlement watchdog。
- Relay：最终静止代码上三次独立、连续的 `npm test -- --reporter=dot` 均为 57/57；包含 legacy backfill 与 strict MiMo，不以定向测试替代。`npm run check`（Wrangler types current + `tsc --noEmit`）通过。
- Wrangler：`npm run dry-run` 的 production 与 staging 均通过；两端 bundle 均为 150.87 KiB / gzip 26.49 KiB，未部署。
- 视觉视口：390×844、430×932 与 1440×900 本地预览无横向溢出；家具背景使用完整构图，文案明确为固定通用示意而非现场复原。
- 协议/媒体：公开 event ID 保持 `activity-N`；Relay 一次性消费真实 MiMo receipt 并绑定 verified activity，零 viewer 可先签发，TTL 内晚加入只增量建立 peer且不延长原 `expires_at_ms`；跌倒 late viewer 不继承原画。
- fail-close：完全隐私拒绝所有实景；pending ACK 在 hide/switch/stop/restart 后立即撤销；控制端隐藏/断线撤销 grant；viewer hidden 同步停轨，只有首帧可渲染后才显示 LIVE，断流/失败/权威到期不保留最后一帧。
- 权威时钟：DO alarm 同时覆盖 watchdog、lease 与 active grant；双方 idle 时也由服务端主动广播 `expired`。客户端 fallback 使用服务端事件 duration 上限。
- 独立事实：家庭心跳卡保持 `local_only`，6 秒 Blob 本机独立释放，live grant 独立到期；三者互不冒充或耦合。
- 自动场景：recorder stop settlement 有界；`kitchen/fall` 自动结果只切展示，Relay authority snapshot 明确覆盖 activity evidence 表，不产生音频、告警、活动、卡片、grant 或 cooking authority。
- 回归边界：未修改 `controller_ready` 的精确 3/5/6 parser；跌倒媒体请求移到 Relay 权威 alarm acknowledgement 之后；watchdog/checkpoint 状态机与恢复语义未改。
- 稳定性：测试 cleanup 使用 Durable Object 侧 reset barrier，完整套件不再由旧 hibernating WebSocket 污染；`git diff --check` 与独立 P0/P1 终审通过，最新 activity single-flight P2 已闭合。

## 仍需人工证据

- 目标手机 + 两个真实评委设备完成厨房 late join、到期、页面隐藏/恢复、断网、租约释放与权威跌倒 late join。
- 真实做饭与非做饭各采样，保存连续 MiMo 原始结果、条件与延迟；本次实现不产生准确率声明。
- 安全保护下验证真实跌倒与负例；本次实现不产生临床能力声明。
- 跨网络 STUN-only 失败时核对显式降级；TURN/SFU 仍未实现，不能宣称公网普遍可用。
- 当前前端测试覆盖 selector、协议、媒体会话与信令竞态；真实 `<video>` 帧可用性和隐藏/恢复仍以目标设备验收为最终 Gate。
