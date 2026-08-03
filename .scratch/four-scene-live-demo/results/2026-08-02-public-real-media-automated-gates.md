# 公网实景与短时 TURN 自动化 Gate 结果

- Date: 2026-08-02
- Base: `c126958a109c82b579bdcf7de76be91da5901a1d`
- Implementation commit: `c39d5d20e669b196f58c5a89f660d64016bef0e5`
- Integrated LBX code boundary: `e9312aedc9e4016dec280a48bb47c4b72552f434`（在实现与证据提交之上保留原本仅本地的 danger voice 修复）
- Release status: 本地自动化与独立审查通过；尚未 push、部署或完成真实公网媒体 Gate。

## 静止代码门禁

- Frontend：`npm test` 244/244；`npm run lint`；`npm run build`（977 modules）均通过。
- Integrated LBX：重放既有 danger voice 修复后，frontend `npm test` 245/245、lint、977-module build 与 `git diff --check upstream/lbx..HEAD` 再次通过。
- Relay：静止代码上的完整 `npm test -- --reporter=dot` 连续三轮均为 102/102；`npm run check` 通过。
- Wrangler：production 与 staging `npm run dry-run` 均通过；两端 bundle 均为 180.35 KiB / gzip 31.75 KiB，未部署。
- Git hygiene：`git diff --check`、冲突标记扫描、staged secret/bundle scan 均通过；前端构建中没有 `TURN_KEY_ID`、`TURN_KEY_API_TOKEN` 或 provider credential endpoint。
- 两路独立只读终审最终均为 P0=0、P1=0、P2=0；整链安全审查为 P0=0、P1=0，剩余项仅为下方已接受的 demo 运营风险。

## 已证明的行为

- 评委端投影矩阵保持：日常为家具抽象 + 骨架；完全隐私为纯色 + 骨架；跌倒 checking 为家具抽象 + 骨架。厨房与权威跌倒只有在 matching active grant、经校验的 STUN+TURN 配置和持续新鲜首帧同时成立后才显示真实实时视频。
- 厨房 credentialing、connecting 或失败时使用中性隐私背景 + 骨架，不再用固定厨房图冒充直播；真实首帧成立后同时移除固定背景与骨架。
- grant 到期/撤销、场景切换、hidden/pagehide、stop、socket/lease/session 变化、track mute/ended、stalled、尺寸归零或 3 秒无新解码帧均 fail closed，并清 `srcObject` 与最后一帧。
- 跌倒首次自动开放必须仍处于同一可见、采集中、视频轨存活、token/session 有效且 controller ready/open 的上下文。stop/release/pagehide/session invalidate/socket close 会在 fail-close 前清除资格；恢复、重连和 alarm replay 不自动重签。
- controller replacement Peer 使用精确 record identity；旧 Peer 的 close 或迟到 offer/answer rejection 不能关闭新 Peer。OPEN socket `send()` 抛错在双方都 fail closed。
- Relay `/api/media/ice` 重新校验 grant/audience/session/lease/controller 或精确 viewer socket capability；长期 TURN key 只允许 Worker secret，响应与缓存均不持久化长期 key。
- Cloudflare provider 返回必须同时含非 port 53 的 STUN 与 TURN，且 URL、字段、长度和 HTTP 201 精确；本票不自动回退 STUN-only。
- viewer 信令每 socket/grant 最多 64 条 ICE、4 条 answer；每 grant 全局非退款预算 340。超限在转发前拒绝，并清 audience/capability/cache 后以 policy violation 断开。
- `controller_ready` 3/5/6、voice、watchdog/checkpoint、verified activity、idle grant alarm、late kitchen viewer、fall late viewer 与多人展示隔离回归均保留。

## 视觉基线

- 在 in-app browser 默认 1280×720、同一等待状态下分别捕获 production `https://reme.maniforld.com/` 与本地候选；两张截图 SHA-256 均为 `3ac42343fd047f8e4c7112b0bf5cecb6271bbc4ddf6e86726e58b28e58bf54a6`，基线布局逐像素一致。
- 该证据只证明等待状态没有视觉漂移；真实厨房/跌倒视频切换仍需目标手机与真实 grant/track 验收，不能由静态截图替代。

## Cloudflare 外部状态

- 用户已授权创建 TURN key、写入 staging/production Worker secrets 并在门禁通过后部署。
- Cloudflare Realtime 激活页显示当前应付 `$0`、每月含 1000GB，超出后 `$0.05/GB`；该账号尚无付款方式，控制台要求用户填写卡或 PayPal 与账单地址后才能激活。
- 因付款信息必须由用户本人处理，本轮尚未创建 TURN key、尚未写入 `TURN_KEY_ID` / `TURN_KEY_API_TOKEN`，也未部署 staging、production Relay 或 Vercel frontend。不得把授权或 dry-run 写成已配置/已发布。

## 已接受的 demo 运营风险

- viewer 入口仍是匿名演示入口；攻击者可以占满 5 个席位或耗尽当前 grant 的有界信令/provider 预算，造成演示可用性下降。
- provider credential 物理 TTL 最长 75 秒；Cloudflare 媒体平面不能强制 Reme 的 audience recipient ACL。18 次只限制 credential provider 调用次数，不限制获授权 viewer 在短时窗口内可能消耗的 TURN 字节。
- 生产应增加 Cloudflare WAF/连接速率策略、用量告警和 key 轮换/删除流程；这些运营控制尚未配置，不能宣称费用完全封顶或具备生产级抗滥用能力。

## 仍待人工 / 外部 Gate

- 用户完成 Cloudflare Realtime 付款方式与激活；随后创建 key、分别写入 staging/production secrets，按 staging → production 顺序部署并留证。
- 目标手机 + 两个 viewer 完成同网基线、两个跨网 Holdout 与强制 relay candidate 诊断，记录设备、浏览器、网络、build/Worker version 和 selected candidate type。
- 真实厨房正/负样本完成连续两次 MiMo verified → 心跳卡 → 真实 live，确认评委端不再显示预制厨房背景或骨架。
- 安全跌倒完成 checking 无视频 → 权威 escalated 有视频 → late viewer 不继承 → 显式新 30 秒 grant 后可见。
- 真机验证 hidden/refresh/disconnect/lease release/grant expiry/provider failure 均无最后一帧或假 LIVE。
