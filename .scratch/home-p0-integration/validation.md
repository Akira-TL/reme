# Home P0 本地整合验收

日期：2026-08-09（America/New_York）

## 唯一基线与运行拓扑

- 唯一代码基线：`origin/lbx-frontend@961361dc`。
- 本地整合分支：`codex/lbx-frontend-p0`，是该基线的严格后代；未修改或推送任何远端 ref。
- 唯一本地验收链路：
  - 前端：`http://127.0.0.1:4274/home`、`/family`、`/debug`
  - 统一后端：`http://127.0.0.1:8870`
  - Relay：`http://127.0.0.1:8887`
- 已停止旧的 4176、4177 Vite 前端，避免页面、Relay 房间与后端会话混用。

### 本地成果分支对账

- `codex/public-dual-device-demo`、`codex/home-surface-refine`、`codex/frontend-role-routes` 与本分支都以 `origin/lbx-frontend` 为祖先。
- Home 三个纯 UI 补丁已在本分支按当前权限/模型基线重放并解决冲突；Family 时间线 `3ab92566` 已以等价补丁吸收为 `f038529b`。
- `codex/frontend-role-routes@587eebce` 是 time/voice/clock WIP、构建产物、Wrangler 本机缓存和截图证据混合提交，不属于本轮 P0，未整提交合并，避免把未独立验收的能力和生成物带回唯一成果线。

## P0 产品边界

- Home 是家中/全屋智能的数据采集端：本机相机或本地真实视频进入统一后端，输出姿态与事件。
- Family 是观察端：日常只接收匿名骨架、权威状态与必要事件，不请求相机或麦克风。
- Debug 保留完整工程控制与调试能力，但不进入 Home/Family 产品导航。
- Home 默认只有一个主动作“开启视频采集”；启动后才显示真实媒体源和连接事实。
- Relay 失败不会阻断已经成功的本机采集；所有降级均显式显示。

## 本轮发现并修复

Home 页面刷新会启动新的 `runtime_session_id`，但旧实现同时在浏览器发布队列和 Relay 中把新的较小 `state_revision` 判为倒序，导致 Family 继续显示上一轮“采集未开始”。修复后：

1. 发布队列检测到 runtime session 变化时，清空旧 state/pose in-flight 与 accepted cursor。
2. Relay 只在同一 runtime session 内强制 revision 单调递增；新 runtime 可从 revision 0 重新开始，并继续清除旧 pose、命令和媒体授权。
3. 新增浏览器队列与 Relay 端回归测试，覆盖刷新后新 session 接管及 late viewer replay。

## 自动验证

- Frontend：`npm test`，153/153 通过。
- Frontend：`npm run lint` 通过。
- Frontend：`npm run build` 通过，1010 modules，Home/Family/Debug 独立动态入口。
- Route build：`npm run test:route-build`，4/4 通过（本机监听测试在允许 loopback 后执行）。
- Relay：`npm test`，20/20 通过。
- Relay：`npm run typecheck` 通过。
- Backend 定向：pose fall、posture、runtime server、unified server、launcher 全部通过，1 项按环境 skip。
- 模型：`docs/assets/training-models.sha256` 38/38 校验通过。

`npm run check` 中的 `wrangler types --check` 仍会报告仓库已有的 `worker-configuration.d.ts` 与本机 Wrangler 版本不一致；本轮未修改 Worker binding，TypeScript typecheck 与 Relay 合同测试均已通过，未为此重写生成文件。

## 真实链路验收

本轮未使用 synthetic/debug scenario，也未记录或展示可识别原画。

1. Home 点击“开启视频采集”后取得本机相机权限并显示实际设备 `MacBook Air Camera (0000:0001)`。
2. 统一后端运行在 `live_camera` profile；MoveNet TFLite、姿态分类器、MIL v3 连续模型均报告 `loaded: true`、`fallback: false`。
3. 后端建立 session、事件 WebSocket 与 camera-input WebSocket，Home 从“等待后端关键点”切换为“后端实时关键点”。
4. 另用仓库外本机真实视频 `01_客厅日常.mp4` 验证文件源：Home 显示“本地视频已载入”，并持续得到后端实时关键点。
5. 独立 Family 页面加入同一 Relay 房间；Home 显示 Viewer 在线，Family 显示权威 runtime ready、capture active 和“关怀链路运行中”。
6. 直接读取本地 Relay Viewer WebSocket，确认收到同一 room/runtime 的：
   - `reme-demo-state/v1`，capture active、runtime ready；
   - 连续 `reme-pose-frame-17/v1`；
   - `person_detected: true` 时包含严格有序的 17 个 MoveNet 关键点。
7. 没有人体或当前帧质量不足时，Family 显示“等待当前运行时的可靠骨架”或“骨架质量较低”，不会补造画面或宣称一切正常。
8. Home 刷新并创建新 runtime session 后，Family 能接管新 revision，不再锁在旧的“采集未开始”时间线。
9. Family 时间线只记录本页打开后收到的权威 `demo_state` revision 与已应用的家属告警确认 ACK；相同 revision/ACK 去重，room session 切换清空，断线时旧记录明确标为历史，不再把“当前房间/运行时/在线人数”拼成伪历史。
10. 同为 idle 的决策文案变化不会制造“关怀已恢复”噪声，初始时间线也不会把“状态正常”当成现场事实；只记录采集、运行时、场景、授权、关怀阶段和家属回执等有意义变化。

## 结论

P0 通过：当前本地成果已统一到 lbx-frontend 后代的一套 Home/Family/Debug 前端、一套统一后端和一套 Relay；Home 的真实视频采集、模型推理、姿态发布与 Family 消费闭环已完成并有自动测试与运行证据。
