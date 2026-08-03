# ADR-0013: 公网实景使用 grant-bound 短时 TURN

- Status: Accepted for LBX demo feasibility
- Capability gate: Pending target-network measurement
- Date: 2026-08-02
- Owner: C（LBX 公网共享 Demo）
- Depends on: ADR-0008、ADR-0011
- Clarifies: ADR-0008 的事件媒体网络路径、ADR-0011 的跨网风险与跌倒晚加入重新授权

## 背景

LBX 评委端已经按 ADR-0011 实现了四场景视觉权威：日常和跌倒告警前显示环境抽象与骨架，完全隐私只显示骨架，厨房真实确认和权威跌倒告警后才允许短期真实视频。现网审计还证明 Relay 能发布匹配的 `media_grant`，但评委 `<video>` 没有收到远端 track、首帧或有效尺寸。场景、活动/告警权威和 grant 都已成立，失败发生在 STUN-only WebRTC 建链这一独立接缝。

STUN 不能保证运营商 CGNAT、对称 NAT 或受限企业网络之间的点对点可达。把 JPEG、Base64 或视频帧塞进 Durable Object 虽可能绕过 NAT，却会直接违反 ADR-0008 的媒体平面边界，并把短期 P2P 演示变成应用服务器可见的媒体中转。

Cloudflare Realtime TURN 支持由后端使用长期 TURN key 生成短时 ICE credentials。Cloudflare 当前官方接口是 `POST https://rtc.live.cloudflare.com/v1/turn/keys/{TURN_KEY_ID}/credentials/generate-ice-servers`；长期 key 应保留在服务端，浏览器只取得短时 credentials。官方返回的备用 port 53 URL 已知会被浏览器阻塞，因此浏览器配置前必须过滤。来源：[Generate Credentials](https://developers.cloudflare.com/realtime/turn/generate-credentials/)、[TURN Service](https://developers.cloudflare.com/realtime/turn/)。

## 决议

### 1. 场景权威不因 TURN 改变

TURN 只补足已经获准的 WebRTC 媒体传输，不生产活动、告警、授权或场景。评委端仍按以下矩阵投影：

| 场景/权威状态 | 评委端投影 | 实景条件 |
|---|---|---|
| 日常 | 固定通用家具抽象 + 当前有效骨架 | 永不开放 |
| 厨房未确认、识别不可用或无 active grant | 固定通用厨房抽象 + 当前有效骨架 | 永不开放 |
| 厨房已 verified 且 grant active，但 credentialing/connecting/failed/尚无 fresh frame | 中性隐私背景 + 当前有效骨架 + 明确实景状态 | 不显示预制厨房图，也不显示真实像素 |
| 厨房连续两次真实 MiMo `cooking`，Relay 已绑定 verified `activity-N`，且 active grant 已收到 fresh frame | 真实实时视频替换背景与骨架 | 同一事件的 active `kitchen_moment` grant 内，单次最多 60 秒 |
| 完全隐私（`bathroom`） | 纯色安全背景 + 当前有效骨架 | 任意 grant、ICE 或迟到信令均 fail closed |
| 跌倒 `checking` / 告警前 | 固定通用家具抽象 + 当前有效骨架 | 永不开放 |
| Relay 权威 `escalated` | 真实实时视频替换背景与骨架 | 同一告警事件的 active `fall_emergency` grant 内，单次最多 30 秒 |

场景按钮、MiMo 自动场景提议、连接成功、ICE credential 成功或 TURN relay 候选都不等于媒体授权。只有 `<video>` 收到持续新鲜、可渲染的真实帧后才可显示 `LIVE`；失败必须回到该场景允许的隐私化投影，不保留最后一帧或假背景冒充实景。

### 2. 媒体拓扑与数据边界

- 视频继续由控制端摄像头通过 WebRTC 发给当前 grant audience。SDP、ICE candidate、短时 TURN credential 和授权元数据可以经过 Relay；视频帧、音频帧、Base64、Blob 与录像不得进入 Durable Object、KV、事件表、日志正文或仓库。
- TURN 是 WebRTC 的网络 relay，不是 Reme 的媒体存储。使用 TURN 时，Cloudflare 可能转发加密的 WebRTC 媒体包；因此不得宣称“授权实景从未经过第三方网络”。可宣称的边界是“Reme Relay/DO 不接收或持久化媒体帧，应用只在短期 grant 内向获准 viewer 建立 WebRTC”。
- 浏览器使用 `iceTransportPolicy=all` 时可优先直连并在需要时使用 TURN。是否实际选择 relay candidate 必须由 `getStats()` 实测，不能仅凭返回 TURN URL 宣称已走 TURN。
- 本 ADR 不引入 SFU、服务器解码、转码、录像或多人媒体分发。每个 viewer 仍对应一个控制端 P2P peer；当前最多五名 viewer 的路演限制继续有效。

### 3. 长期 secret 与短时 credential broker

生产和 staging 各自配置 `TURN_KEY_ID` 与 `TURN_KEY_API_TOKEN` 为 Worker secret。二者不得写入 `wrangler.jsonc`、前端 bundle、仓库、WebSocket、HTTP 响应、客户端存储或日志。浏览器不得直连 Cloudflare credential API。

Relay 新增 `POST /api/media/ice`。请求 body 精确为：

```json
{
  "grant_id": "grant-id"
}
```

Controller 使用现有 control token 作为 Bearer；Relay 必须重新验证当前租约、session、active grant、grant event/scope 与控制 socket。Viewer 只有在被纳入 active audience 后才会在对应 `media_grant` event 之后收到独立、精确的能力消息：

```json
{
  "type": "media_ice_capability",
  "grant_id": "grant-id",
  "bearer_token": "64-lowercase-hex",
  "expires_at_ms": 0
}
```

该 token 绑定当前 WebSocket attachment、`viewer_id`、session 与 grant；服务端只在当前 socket attachment 保存 token hash，不写入 Durable Object SQL 表。viewer 以该 token 调用同一端点时，Relay 必须再次确认该 socket 仍在、grant 仍 active、viewer 仍属于 audience 且 session 未变化。公开 `viewer_id`、另一个 viewer 的 token、旧 socket token、过期 token 或仅有 `media_grant` 回放都不得换取 credential。

`viewer_ready` 必须继续保持既有精确 `{type, viewer_id}` 且为首条消息；不得为了 TURN 增加字段。新能力使用独立消息，使旧前端可以忽略，新前端连接旧 Relay 时则看不到能力并安全降级。

成功响应精确为：

```json
{
  "ice_servers": [
    { "urls": ["stun:stun.cloudflare.com:3478"] },
    {
      "urls": ["turn:turn.cloudflare.com:3478?transport=udp"],
      "username": "short-lived-username",
      "credential": "short-lived-credential"
    }
  ],
  "expires_at_ms": 0,
  "ttl_ms": 0
}
```

`ice_servers` 是精确 union：STUN entry 只允许 `urls:string[]`，TURN entry 只允许 `urls:string[] / username:string / credential:string`；至少保留一条非 port 53 的 STUN URL 和一条非 port 53 的 TURN URL。Relay 必须校验 provider HTTP 状态、JSON 外形、有限字符串/数组上限与允许的 ICE scheme，并在返回浏览器前删除 port 53 URL。provider 的未知字段不能透传。

错误合同为：

- `400 invalid_media_ice_request`；
- `401 missing_media_ice_token | invalid_media_ice_token`；
- `403 media_ice_not_authorized`；
- `409 media_ice_request_in_progress`；
- `429 media_ice_rate_limited`；
- `503 turn_not_configured`；
- `502 turn_provider_unavailable | turn_provider_invalid_response`。

所有响应均 `Cache-Control: no-store`，只接受既有 exact `ALLOWED_ORIGINS`。日志只允许记录随机 request ID、actor 类别、grant hash/前缀、provider 状态、耗时、过滤前后 URL 数与结果枚举；不得记录 control/viewer bearer、TURN username/credential、完整 SDP/ICE candidate 或媒体正文。

### 4. TTL、并发与 fail-close

Relay 在服务端权威时钟上计算 provider credential TTL：

```text
min(75 秒, ceil(active_grant_remaining_ms / 1000) + 15 秒)
```

15 秒只给 ICE gathering/建链留余量，不延长应用授权。上式是 Cloudflare provider credential 的物理 TTL；成功响应中的 `expires_at_ms / ttl_ms` 表示应用可使用 ICE 配置的授权窗口，按 `min(grant remaining, current lease remaining, provider remaining)` 计算，因此不超过厨房 60 秒、跌倒 30 秒及当前租约剩余时间。grant `expires_at_ms` 仍是媒体显示与发送的唯一权威截止时间。

每个 `(session, grant, actor)` 只允许一个在途 provider 请求，并使用有界的每 grant/actor 配额；并发或超额必须按精确错误显式失败，不能绕到匿名公共 credential。Credential 不跨 grant、session、viewer socket 或 audience 复用，也不进入浏览器持久存储。TURN username/credential 不写入 DO SQL 表；只允许在当前 DO isolate 的有界内存 cache、当前 HTTP 响应和对应浏览器 peer 的内存生命周期存在，并在 grant/session 失效时清理 cache。

公开 viewer 到 controller 的媒体信令同样必须有界：每个 `(viewer socket, grant)` 最多转发 64 条 ICE candidate 与 4 条 answer；每个 grant 的 viewer 信令全局预算为 340 条，viewer 断开或重连不退款。预算必须在转发前以 Durable Object 持久状态扣减；超限消息不得到达 controller，并先清除该 viewer 的 audience/capability/cache，再返回精确错误并以 policy violation 断开。grant 撤销、到期或 session 重置时才清除对应预算。

grant 到期、撤销、scene/event 不匹配、控制租约失效、控制端或 viewer 隐藏/断线时，沿用 ADR-0011 的同步 fail-close：停止/移除 sender 或远端 track、关闭 peer、清空 `srcObject` 与最后一帧，并由 Relay 的权威 alarm 广播 grant 终止。Cloudflare credential 最多可比 grant 多存活 15 秒且总 TTL 不超过 75 秒；当前初始实现不承诺调用 provider username revoke。因此 credential TTL 只是泄露半径上限，不能代替应用 grant 撤销，亦不能被 UI 当作继续播放许可。

### 5. STUN 降级边界

本次发布冻结为**不自动回退 STUN-only**。双方只有取得 Relay 校验过、同时包含至少一条非 port 53 STUN 与一条非 port 53 TURN URL 的 ICE 配置后才创建对应 grant 的 `RTCPeerConnection`。旧 Relay、TURN 未配置、provider 失败、能力缺失、credential 合同失败或取配置超时，都直接回到当前场景允许的隐私投影并明确显示实景传输不可用；不得新建仅含仓库默认 STUN 的 peer，也不得显示“已连接”“TURN 已就绪”或“公网稳定”。

STUN-only 只作为既有历史基线和未来可能的显式同网诊断候选保留在规格中，本次不提供 UI 开关。以后若要重新引入，必须另行安全审查、明确标为 `STUN_ONLY_DEGRADED`，并受同一 grant、首帧/新鲜度和完全隐私 fail-close 约束。

### 6. 跌倒晚加入与显式重新授权

`fall_emergency` 继续使用签发时静态 audience。晚加入或刷新后的 viewer 只回放权威告警与“家具抽象 + 骨架”，不得继承旧 grant、ICE capability、credential、offer 或远端 track。

当同一 Relay 权威 `escalated` 告警尚未 resolved、当前场景仍为 `fall`、控制租约/采集/页面可见性均有效且没有 active fall grant 时，控制端可以显式执行“向当前在线评委重新开放 30 秒”。Relay 必须重新读取当前在线 viewer 快照，为同一 alarm `event_id` 签发新的 `grant_id` 与最多 30 秒 TTL。该动作不改变、重放或延长旧 grant，不重置 watchdog/checkpoint，不重新触发告警/语音，也不让后续 late viewer 继承新 grant。

刷新、恢复 socket、收到 alarm replay、TURN credential 获取成功或 ICE failure 都不能自动执行该动作。无当前 viewer 时不签空 grant，并把原因明确返回控制端。

## 被拒绝的替代

- **把帧/Base64/录像发进 Durable Object 或普通 WebSocket**：违反 ADR-0008，扩大可识别媒体的应用服务器暴露面。
- **把长期 TURN key 放在浏览器或 Vercel 静态环境变量中**：任何访客都可滥用 key 生成 credential。
- **公开、无 grant 的 TURN credential endpoint**：会把付费 relay 变成匿名滥用入口。
- **只凭 `viewer_id` 鉴权**：ID 是路由标识，不是当前 socket 的媒体凭证。
- **把 credential TTL 当作 grant TTL**：provider 余量不能延长 UI/track 授权。
- **修改 `viewer_ready` 或 `controller_ready` 的既有精确字段**：会破坏 3/5/6 滚动兼容；TURN 使用独立能力消息/端点。
- **fall late viewer 自动继承旧 grant**：扩大事故现场可识别画面的 audience，违反 ADR-0011。
- **用固定厨房背景冒充已授权做饭实景**：真实做饭 Gate 成立但媒体不可达时必须明确显示降级。

## Capability Gate 与不可宣称项

本 ADR 接受的是可行性实现边界，不是公网能力已经通过。Go/No-go 证据见 `.scratch/four-scene-live-demo/public-real-media-reachability-feasibility-spec.md`。在目标手机、两个独立 viewer、至少两个有记录的跨网组合与强制 relay 诊断通过前，不得宣称：

- 任意公网、运营商、企业网、浏览器或手机都能稳定播放；
- 返回 TURN 配置等于实际媒体走过 TURN；
- TURN 成功证明 MiMo 做饭识别、跌倒识别或医疗告警准确；
- 厨房/跌倒真实视频仍是匿名化、不可识别或“完全本地”；
- 应用级 session/grant/audience 绑定是 Cloudflare TURN 服务自身强制的 recipient ACL；
- 该 demo credential broker 是生产账户、审计、抗滥用、计费或媒体架构。

如果跨网 Holdout 无法在有效 grant 内取得持续新鲜首帧，或 credential 泄露、越权签发、应用媒体轨道/画面越过 grant 到期、完全隐私出像、媒体进入 DO 任一发生，则公网实景 Gate 为 No-go，评委端必须回到明确降级的隐私投影。

## 后果

- 厨房和权威跌倒不再把“grant 已签”误当成“视频已到”；TURN 成为独立、可测量的传输适配器。
- Reme Relay 仍不接触媒体帧，但隐私口径必须披露获准实景可能经 Cloudflare TURN 转发。
- 增加 Worker secrets、外部 provider 调用、credential 端点、短时 viewer capability、费用/配额与跨网真机 Gate。
- 跌倒晚加入保持 fail-closed，同时用一个明确的新 30 秒 grant 满足现场演示重新开放需求。
- TURN 不可用时仍保留告警、心跳卡、场景与骨架主链；不得用假背景或假 LIVE 掩盖媒体失败。
