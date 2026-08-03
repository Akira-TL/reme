# 07 — 公网实景可达性与短时 TURN

- Type: task
- Status: claimed
- Owner: C / Relay + Monitor + Viewer
- Related: ADR-0008、ADR-0011、ADR-0013
- Spec: `../public-real-media-reachability-feasibility-spec.md`

## Problem

生产评委端能收到当前场景、权威告警与 active media grant，但当前只配置 STUN 的实现没有取得远端 track/首帧，所以厨房真实确认或跌倒权威升级后仍会回到预制背景与骨架。必须补齐公网媒体 transport，同时保持“媒体不进 DO”和四场景权威矩阵。

## Frozen acceptance matrix

| 状态 | 评委端 |
|---|---|
| 日常 | 家具抽象 + 骨架 |
| 厨房未 confirmed / 无 active grant | 厨房抽象 + 骨架 |
| 厨房 verified + active grant，credentialing/connecting/failed/无 fresh frame | 中性隐私背景 + 骨架 + 明确实景状态；不显示预制厨房主背景 |
| 连续两次真实 MiMo cooking、Relay verified、active grant、首帧新鲜 | 真实实时视频；移除全部背景与骨架 |
| 完全隐私 | 纯色背景 + 骨架；任意媒体 fail closed |
| 跌倒 checking | 家具抽象 + 骨架 |
| Relay 权威 escalated + matching grant + 首帧新鲜 | 真实实时视频；告警保持可见 |

## Relay / credential broker

- [x] 实现仅从 staging/production Worker secrets 读取 `TURN_KEY_ID`、`TURN_KEY_API_TOKEN`；缺失返回 `503 turn_not_configured`，不打印或透传 secret。实际 secret 写入状态仍由下方 external gate 单独留证。
- [x] 新增 exact `POST /api/media/ice`，body 只允许 `{grant_id}`，成功只允许 `{ice_servers,expires_at_ms,ttl_ms}`，全部 `no-store` 与 exact CORS。
- [x] controller Bearer 重新验证 lease/session/socket/active grant；viewer Bearer 是随 grant audience 经当前 socket 下发的 64hex capability，绑定 socket attachment/viewer/session/grant。
- [x] 保持 `viewer_ready={type,viewer_id}` 为首条精确消息；viewer 被纳入 grant 后，在 grant event 之后发送独立 exact `{type:"media_ice_capability",grant_id,bearer_token,expires_at_ms}`。
- [x] viewer 断开、移出 audience、grant 到期/撤销、session/lease 变化时使 capability 立即失效；公开 viewer ID、旧 token、跨 grant/token 复用均拒绝。token hash 只留在当前 socket attachment，不写 SQL；TURN username/credential 也不写 DO 表，只允许有界 grant/actor 内存 cache 并随失效清理。
- [x] 调用 Cloudflare 当前 `generate-ice-servers` 端点；provider TTL=`min(75s, ceil(grant remaining/1s)+15s)`，公开应用 expiry/ttl 不超过 grant/lease 剩余授权。
- [x] 精确校验 provider 201/JSON/字段长度/scheme；过滤全部 port 53 URL；结果至少含一条非 53 STUN 与一条非 53 TURN，否则 `502 turn_provider_invalid_response`。
- [x] 实现精确错误：400 invalid request；401 missing/invalid token；403 not authorized；409 in progress；429 rate limited；503 not configured；502 provider unavailable/invalid。
- [x] 每 `(session,grant,actor)` 单飞与有界配额；provider failure 不缓存静态 credential，不向下一 grant 复用。
- [x] viewer 到 controller 信令每 socket/grant 最多 64 条 ICE、4 条 answer，grant 全局非退款预算 340；超限消息在转发前拒绝并移除 audience/capability/cache。
- [x] 日志仅含脱敏 request/grant 标识、actor、provider status/latency、URL count 与 outcome；禁止 token、TURN username/credential、完整 SDP/ICE 与媒体正文。

## Monitor / Viewer transport

- [x] 双方只有拿到经校验且同时含非 53 STUN+TURN 的 ICE config 后才创建对应 grant peer；生产本票不做自动 STUN-only fallback。
- [x] 旧 Relay、capability 缺失、secret/provider/合同错误或 fetch 超时直接显示 `TURN/实景传输不可用` 并回到场景允许的隐私投影，不显示“已连接”。
- [x] grant request/ACK、ICE fetch、offer/answer、track 与 frame guard 全部绑定 scene/event/scope/session/capture/visibility generation；迟到结果不得建 peer。
- [x] 厨房 verified + active grant 一进入 credentialing/connecting/failed 就移除固定厨房主背景，显示中性隐私背景 + 骨架 + 明确实景状态；fresh live frame 才替换全部背景与骨架。grant 过期/撤销后同步清 track/srcObject/最后一帧；无 active grant 时才恢复厨房抽象 + 骨架。
- [x] 跌倒 active live frame 必须替换家具背景与骨架，同时保留权威告警；媒体失败不得 resolve/降级告警。
- [x] 完全隐私优先级最高；迟到 credential/offer/track/frame 均不得显示。
- [x] 继续要求首个真实可渲染帧才 LIVE、decoded-frame 3 秒 freshness、mute/ended/stalled/尺寸归零 fail-close。
- [x] grant 到期/撤销、scene 切换、hidden/pagehide、stop、socket/lease/session change 时同步 close peer、停 sender/remote track、清 srcObject；provider 15 秒余量不延长应用授权。

## Fall explicit regrant

- [x] `fall_emergency` late viewer 仍不继承旧 grant 或 ICE capability。
- [x] 权威 escalated 尚未 resolved、场景/采集/可见/lease 有效且无 active fall grant 时，提供“向当前在线评委重新开放 30 秒”。
- [x] Relay 以当前在线 viewer 快照、同一 alarm event、新 grant ID、新最多 30 秒 TTL 签发；旧 grant 不延长/复用，后续 viewer 不继承。
- [x] 空 audience、resolved、错误 scene、hidden/stopped、旧请求 ACK 均拒绝；动作不重置 watchdog/checkpoint/voice 或重新告警。
- [x] refresh/reconnect/alarm replay/ICE failure 不自动 regrant。

## Automated verification

- [x] Relay 定向覆盖 endpoint exact union、provider failure/port 53、controller/viewer auth、token lifecycle、single-flight/rate limit、grant/lease expiry。
- [x] Frontend 定向覆盖双方等 ICE 后建 peer、无自动 STUN fallback、四场景视频替换矩阵、迟到与 fail-close、fall explicit regrant。
- [x] 现有 `controller_ready` 3/5/6、voice、watchdog/checkpoint、verified activity、idle grant alarm、late kitchen viewer、fall late viewer、多人投影隔离回归全部保留。
- [x] 前端全套 tests/lint/build；Relay 全套至少连续三轮、types/check、staging+production dry-run；`git diff --check`。

## Human / external gates

- [x] 用户已于 2026-08-02 明确授权创建 Cloudflare TURN key、写入 staging/production secrets，并在代码/测试全绿后部署验证。
- [ ] 实际创建 key、写入两环境 secrets 与部署版本逐项留证；授权完成不等于配置、媒体或跨网 Gate 已通过。
- [ ] 目标手机 + 两个 viewer 完成同网基线、两个跨网 Holdout、强制 relay 诊断，记录设备/浏览器/网络/build/Worker version 与 selected candidate type。
- [ ] 真实厨房正/负样本完成两次 MiMo verified→心跳→真实 live；评委确认不再显示预制厨房背景。
- [ ] 安全跌倒完成 checking 无视频→权威 escalated 有视频→late viewer 无继承→显式新 30 秒 grant 后可见。
- [ ] hidden/refresh/disconnect/lease release/grant expiry/provider failure 全部实测 fail closed，无最后一帧或假 LIVE。

## No-go / release blockers

- 任何媒体正文进入 DO、普通 WebSocket、KV、持久日志或仓库。
- 长期 TURN key/token 出现在客户端、响应、bundle、日志或非 secret 配置。
- 未在 active audience 的 viewer 可取得 ICE credential，或 credential capability 可跨 socket/session/grant 使用。
- 生产在 TURN 不可用时静默退回 STUN-only 并宣称实景已接通。
- 厨房 verified 后仍用预制背景冒充直播，或真实视频上叠骨架。
- 完全隐私、跌倒 checking、grant 前/后、隐藏/断联后出现真实像素或最后一帧。
- fall late viewer 自动继承旧 grant，或 regrant 延长/复用旧 grant。
- 破坏 voice 3/5/6 ready、watchdog/checkpoint、真实 MiMo verified activity、grant 权威 alarm 或多人展示隔离。

## Results

- 自动化与静止代码证据：`../results/2026-08-02-public-real-media-automated-gates.md`
- Cloudflare Realtime 仍等待用户本人完成付款方式与激活；key、secrets、部署和跨网真机 Gate 均未完成。不得把 dry-run、ICE config 200 或同网成功替代跨网真机 Gate。
