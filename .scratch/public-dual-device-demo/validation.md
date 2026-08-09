# 固定公开双端演示验收记录

- Date: 2026-08-08
- Branch: `codex/public-dual-device-demo`
- Base: `origin/develop/akira@0b3b5f6d912e9deef9de25bd6687014fe28b40fd`
- Status: local acceptance not passed
- Deployment gate: closed; no push and no deploy were performed

## 1. 结论边界

代码、模型资产、桌面 Chrome 协议链路和正式视觉 QA 已有实际通过证据。真实手机、摄像头前后切换、屏幕选择、原生文件选择、双设备 WebRTC/TURN、两名 Viewer、连续切换 20 次仍未完成，因此本轮不能写成“本地验收通过”，也不能进入公网部署阶段。

固定公开房间与事件期向全部 Viewer 开放原画是 ADR-0008 的演示例外，不是生产身份认证、隐私合规或医疗能力证明。

## 2. 验证环境

```text
OS:       Darwin 25.5.0 arm64
Python:   3.12.13
Node.js:  26.5.0
npm:      11.17.0
Wrangler: 4.120.0
```

测试工作区为 `/private/tmp/reme-public-dual-device-demo`。`models/trained/*` 是本机 ignored 资产，不属于 Git 交付物。

## 3. 自动验证

### Launcher 与后端

```bash
uv run --extra dev --extra pose pytest \
  tests/test_runtime_launcher.py \
  tests/test_pose_fall_runtime.py \
  tests/test_pose_fall_continuous_runtime.py \
  tests/test_unified_runtime_server.py \
  tests/test_pose_runtime_server.py
```

- 结果：`41 passed, 1 skipped`。
- Launcher 子集：`21 passed`，覆盖三进程命令、public host/IPv6 fail-fast、HTTPS 同源代理、SIGTERM/SIGHUP 和进程组清理。
- 唯一 skip：缺少带外 `fall bootstrap sample dataset`，不能把 skip 当作模型效果证据。
- 修改过的 3 个后端源文件 focused mypy 通过；修改过的 Python 文件 ruff 通过。

### 前端

- `npm test`：`103 passed`。
- `npm run lint`：通过。
- `npm run build`：通过，Vite 生成 Monitor 与 Viewer 双入口，`998 modules transformed`。
- 覆盖 exact protocol、旧会话/revision、ACK、本机确认动态复验、浴室硬门、授权时限、媒体 generation、WebRTC fail-close、手机三页、Viewer lease/cursor、state unavailable、JPEG WebSocket 1 MiB 背压上限等确定性逻辑。

### Relay

- `npm test`：`19 passed`。
- `npm run check`：Wrangler types 与 TypeScript 均通过。
- `npm run dry-run`：通过；`76.81 KiB / gzip 14.25 KiB`，没有部署。
- `npm audit --audit-level=high`：`0 vulnerabilities`。
- 覆盖无密码 producer claim、5 Viewer 上限、单 controller、跨会话隔离、严格 schema、终态幂等、controller 终结、state TTL、grant deadline、浴室/断线/场景/源变化撤销和 raw-media 拒绝。

### 模型包

- `models.zip` SHA-256：`00590419009ccb531d2fa9345eccf142d79f1d579a0dc761cd09a9bf64424aa4`。
- `unzip -tq`：全部条目通过。
- `shasum -a 256 -c docs/assets/training-models.sha256`：38 个条目全部 `OK`。
- `git check-ignore` 与 `git ls-files` 确认训练模型仍被忽略，只跟踪两个 `.gitkeep`。
- MoveNet SHA-256：`0fac2226112d0371903ca86e3853cec24ef603a0b2f96f589b180f0ebdd135ab`。

模型包不含最新 edge-int8 验收 bundle，也不含上述 bootstrap 数据集。本记录不声明 12/24/30 FPS Gate、跌倒准确率或医疗级能力。

## 4. 桌面 Chrome 实测

三进程本地入口：

- Monitor：`http://127.0.0.1:14174/`
- Viewer：`http://127.0.0.1:14174/viewer.html`
- backend：`127.0.0.1:18770`
- Relay：`127.0.0.1:18787`

2026-08-09T02:28:35.308Z 后 fresh reload 的实测结果：

- `/` 无密码直接 claim producer，Relay 显示 `1/5 Viewer`；
- Viewer 竞争到单一 30 秒 controller，远程切换客厅得到 terminal `applied · scene_selected`；
- Viewer 请求屏幕源时先显示 `awaiting_local_confirmation`，Monitor 出现本机确认队列；本机拒绝后收到 `local_confirmation_denied`，没有乐观假成功；
- Monitor “收回”立即撤销 controller，Viewer 回到可接管状态；
- 浴室场景切换成功，Viewer 仍只显示骨架/状态，没有原画开放；
- 首页、看板、设置三页可导航；高隐私与风险提醒开关均实际从 on→off→on；
- Monitor `1920×1080 @ DPR1`、Viewer `390×844 @ DPR1` 均 `overflowX=0`；
- fresh reload 后 Monitor/Viewer console `error=0, warn=0`；
- backend `/api/health` 与 `/api/runtime/capabilities` 可访问；向本地 camera-input WebSocket 发送 4 帧本地 JPEG 后，`/api/runtime/status` 明确返回 `running`，MoveNet、posture 与 MIL v3 的 `loaded=true`，Monitor 显示“后端模型链路已就绪”。JPEG 只进入本机后端，没有经过 Relay。

该 4 帧 smoke 直接验证后端协议和模型状态，不等于浏览器原生文件选择、摄像头或 WebRTC 媒体链已通过。

## 5. 视觉 QA

- 正式报告：`.scratch/public-dual-device-demo/design-qa.md`。
- source：`frontend/src/assets/reference/*.png`；实现没有把参考截图当底图。
- 首页、看板、设置均以 `390×844 @ DPR1` 截图；参考图归一到相同像素后放入同一张并排比较图。
- 最新 fresh reload 确认三页顶部都持续显示“固定公开演示房间”，底部导航与核心交互在手机视口可见。
- 最终结果：`passed`；只保留不阻断交付的 P3 字号/静态 chevron 打磨项。

## 6. 部分验证与明确阻塞

- Vite HTTPS、同源 runtime/Relay HTTP+WS proxy 与 SAN 参数已有 Launcher 单测和本地技术冒烟；尚未在手机安装/信任证书。
- Chrome 文件选择扩展没有启用 file URL 权限，原生 picker 选取 `/private/tmp/reme-living-room-loop.mp4` 未完成；本轮不把直接 JPEG smoke 冒充 file-source 验收。
- 当前桌面 Chrome 没有提供可用摄像头/授权，页面正确停在“等待本机授权/媒体源连接中”；前后镜头、USB 摄像头和权限拒绝后重试仍待真机。
- 本地无 TURN，UI 明确显示“原画仅局域网”；跨 NAT 原画未验证。

## 7. 尚未验证

- 真实手机分别作为 Monitor 与 Viewer；
- 手机前后摄像头、电脑/USB 摄像头、屏幕捕获和浏览器原生本地视频；
- 两台真实设备之间的 WebRTC 原画、两 Viewer 同时观看和晚到 Viewer 加入剩余 grant；
- 厨房当前明确授权 60 秒、跌倒权威升级 30 秒的完整人工媒体链；
- 无 TURN 的同一 LAN 实际连通与跨 NAT 显式失败；
- 连续切换媒体源/场景 20 次并检查重复轨道、WebSocket、RAF 和旧状态回流；
- MiMo 真实 key 下的本轮双端交互；
- 公网 TURN、域名、Cloudflare 部署或任何费用操作。

## 8. 下一步验收顺序

1. 用可信 SAN 证书在同一 LAN 完成手机 Monitor/Viewer 与媒体权限。
2. 完成摄像头前后切换、屏幕、原生文件四类源和连续 20 次切换。
3. 完成双 Viewer、晚加入、厨房/跌倒 grant 倒计时与 WebRTC fail-close。
4. 所有本地硬件门关闭后，再单独评审公网 TURN 与部署。

在这些手工项关闭前，保持“不推送、不部署”。
