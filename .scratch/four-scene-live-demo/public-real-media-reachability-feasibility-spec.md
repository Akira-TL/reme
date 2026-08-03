# 公网实景可达性可行性规格

- Type: feasibility-spec
- Status: accepted-for-bounded-implementation
- Owner: C（Monitor / Viewer / Relay）
- Date: 2026-08-02
- Branch boundary: 只允许进入 `lbx`，只与 `upstream/lbx` 对账
- Architecture: `docs/adr/0013-grant-bound-turn-for-public-media.md`
- Implementation ticket: `issues/07-public-real-media-reachability.md`

## 1. 要回答的问题

在不把媒体帧交给 Reme Relay/Durable Object、不放宽厨房与跌倒权威 Gate 的前提下，Cloudflare TURN 短时 credential 能否让一台手机控制端向两个独立网络中的评委端稳定送达当前 grant 内的真实实时视频，并在授权结束时 fail closed？

本规格只测量“已获授权媒体能否抵达”。它不重新验证姿态准确率、MiMo 做饭准确率、跌倒准确率、家庭账户授权或生产扩展性。

## 2. 当前证据与根因假设

### 已观测证据

2026-08-02 对当前 production 做了不修改状态的浏览器/Relay 检查：

- monitor 与 viewer 使用的是同一批当前生产静态资源，不是前端版本或缓存分叉；
- Relay 有活跃 controller/viewer，viewer 收到了 `scene=fall`、权威 `alarm_state.phase=escalated` 与 active `fall_emergency` grant；
- UI 正确进入“告警已升级，正在接通实景”，但 `<video>` 的 `srcObject` 为空、无远端 track、`readyState=0`、尺寸为 `0×0`；
- grant 到期后页面回到骨架与固定环境抽象，说明授权时钟和视觉 fail-close 仍在工作。

该证据只能定位为“权威/授权成功，媒体 transport 未建立”，不能单独证明 NAT 类型或 TURN 一定能解决。

### 可证伪假设

> H1：当前公网无画面的主要瓶颈是 STUN-only ICE 无法在目标网络间建立可用 candidate pair。若双方在同一 active grant 下取得 Relay 校验过的短时 TURN 配置，则至少一个真实跨网 Holdout 可以选择 relay candidate，并在 grant 期限内交付持续新鲜的真实视频帧。

反证条件包括：

- 强制 relay 诊断仍无法形成 selected relay candidate；
- 有 selected relay candidate 但无远端 track/首帧，说明问题在 SDP、track、浏览器播放或生命周期，而非 NAT；
- 只有同 Wi-Fi 直连成功，跨网始终失败；
- grant 前、完全隐私或到期后仍能看到真实帧；
- 为了可达而必须把媒体正文送进 DO/WebSocket。

## 3. 冻结的产品矩阵

| 场景/状态 | 评委端必须看到 | 禁止出现 |
|---|---|---|
| 日常 | 通用家具抽象 + 当前有效单/多人骨架 | 真实像素、把背景称为家具复原 |
| 厨房未确认/识别不可用/无 active grant | 通用厨房抽象 + 当前有效骨架 | 真实像素、心跳假确认 |
| 厨房已 verified + active grant，credentialing/connecting/failed/尚无 fresh frame | 中性隐私背景 + 当前有效骨架 + 明确实景状态 | 预制厨房图作为主视觉、假 LIVE、真实像素 |
| 厨房连续两次真实 MiMo `cooking` 且 Relay verified，active grant 已有 fresh frame | 真实实时视频；视频替换背景与骨架；家庭心跳卡独立保留 | 固定厨房图冒充实景、骨架叠在真人上、把 6 秒本机 Blob 称为已分享录像 |
| 完全隐私（`bathroom`） | 纯色安全背景 + 当前有效骨架 | 家具、真实像素、最后一帧、任何 ICE/grant 绕过 |
| 跌倒 `checking` / 权威告警前 | 通用家具抽象 + 当前有效骨架 + 问询状态 | 真实像素、把候选称为已告警 |
| Relay 权威 `escalated` + matching grant | active `fall_emergency` grant 内的真实实时视频 + 告警；视频替换假背景与骨架 | MiMo/客户端候选绕过告警、视频失败取消告警 |

做饭场景的验收重点是：真实 MiMo Gate 成立且 grant active 后，评委不再把预制厨房图当作主视觉；credentialing/connecting/failed 或首帧前先显示中性隐私背景 + 骨架 + 实景状态，只有 fresh frame 到达后才由手机摄像头实时画面替换。预制厨房背景只属于未确认、识别不可用或没有 active grant 的状态。

## 4. 实验实现边界

### 4.1 Credential broker

- `TURN_KEY_ID`、`TURN_KEY_API_TOKEN` 仅存 staging/production Worker secrets。
- Controller 以现有 control Bearer 调用 exact `POST /api/media/ice`；viewer 以 Relay 经当前 audience socket 下发的 grant-bound 64hex capability Bearer 调用。
- body 精确为 `{ "grant_id": "..." }`；成功只返回 `{ ice_servers, expires_at_ms, ttl_ms }`。
- provider 调用使用 Cloudflare 当前 `generate-ice-servers` 端点。provider credential TTL 为 `min(75s, ceil(grant_remaining/1s)+15s)`；对客户端公开的应用可用期限不超过 grant/lease 剩余时间。
- provider 响应必须精确校验，浏览器收到的 STUN/TURN URL 都过滤 port 53，且至少各保留一条可用 URL；缺任一类即失败。viewer token hash 只留在当前 socket attachment；TURN username/credential 不写 DO SQL 表，只可在当前 isolate 的有界 grant/actor cache、HTTP 响应和浏览器 peer 内存中存在。
- 本次生产主路径不做自动 STUN-only fallback：旧 Relay、缺 secret、provider/合同错误或 capability 缺失都直接回到隐私骨架并显示明确降级。STUN-only 只保留为历史基线和未来可能的显式同网诊断候选，本票不实现该开关。
- `viewer_ready` 与 `controller_ready` 精确字段保持不变；新能力走独立 `media_ice_capability` 消息与 HTTP 端点。

### 4.2 媒体与权威隔离

- 只有 active `media_grant` 才能请求 ICE 配置和创建 `RTCPeerConnection`。
- TURN credential、SDP 与 ICE 是 transport metadata；媒体 track 仍直接走 WebRTC，DO 不接收媒体正文。
- scene/activity/alarm/grant 的 eligibility 与 ADR-0011 完全不变。自动场景 `kitchen/fall` 仍只切展示，不产生 activity/card/alarm/grant/ICE 请求。
- grant 撤销、到期、离场、隐藏、stop、socket/lease/session 变化时，先同步停 sender/remote track、close peer、清 `srcObject`/最后一帧，再显示降级。Credential 的额外 15 秒 provider 余量不能延长应用授权。
- 当前实现不持久化 provider username，也不宣称 provider-level revoke；最大 75 秒 credential TTL 是残余能力的有界风险，不替代 grant authority。

### 4.3 跌倒显式重新开放

- 跌倒 late viewer 不继承旧 `fall_emergency` grant。
- 同一权威 `escalated` 尚未 resolved 且无 active fall grant 时，控制端显示“向当前在线评委重新开放 30 秒”。
- 点击后 Relay 以当前在线 viewer 快照、新 `grant_id`、同一 alarm `event_id` 签发新 grant；不延长旧 grant，不重置 watchdog/checkpoint/voice，不自动包含后续 viewer。
- refresh/reconnect/alarm replay/ICE failure 都不能自动触发重新开放。

## 5. 实验设计

### 5.1 自动化层

1. **Relay contract**：exact request/response、CORS/no-store、secret 缺失、provider 非 201、超时、非法 JSON、未知字段、超长字段、无 STUN、无 TURN、port 53 过滤后为空。
2. **授权**：controller token 只可取本 session active grant；viewer token 只可取其 socket/session/grant/audience；伪造 viewer ID、另一个 grant、断线/移除 audience、过期/撤销、旧 token 全部拒绝。
3. **并发/配额**：同 actor/grant 单飞；并发为 409，超额为 429；provider failure 不返回静态测试 credential。
4. **Frontend**：双方都等到有效 ICE config 才建 peer；缺 capability/503/502/超时显示明确 TURN 降级且不建 STUN-only peer；首帧前不 LIVE，3 秒无新解码帧、track mute/ended、尺寸归零立即 fail closed。
5. **视觉矩阵**：厨房 verified + active grant 的 credentialing/connecting/failed 使用中性隐私投影而非预制厨房主背景；fresh 真实视频替换厨房/跌倒的背景和骨架；日常、厨房未确认、完全隐私、跌倒 checking 永不因 ICE 状态出像。
6. **跌倒重新开放**：late viewer 不继承旧 grant；显式动作生成同 event/新 grant/当前 audience/30 秒；空 audience、resolved alarm、错误 scene、hidden/stopped/旧 ACK 均拒绝。
7. **不变量**：`controller_ready` 3/5/6、voice、watchdog/checkpoint、verified activity、idle grant alarm、多人投影隔离的既有全套回归继续通过。

### 5.2 真机 Pilot

先冻结并记录：

- monitor 手机型号、OS、浏览器版本、前/后置摄像头；
- viewer 设备/浏览器；
- monitor 与 viewer 的接入网络、运营商/路由类型（能取得时）、是否 VPN/企业代理；
- build commit、Worker version、TURN key 环境、测试时刻；
- scene、grant/event ID 的脱敏后缀、grant 秒数与 viewer 加入顺序。

Pilot 依次执行：

1. 同 Wi-Fi 作为直连/浏览器链路基线；
2. 手机蜂窝网络 → 独立宽带/Wi-Fi viewer；
3. 宽带/Wi-Fi monitor → 手机蜂窝 viewer；
4. 在独立诊断 build 中强制 `iceTransportPolicy=relay`，确认 selected candidate pair 的 candidate type 为 `relay`；该开关不进入路演 UI；
5. 每个网络组合分别走厨房 verified grant、fall checking→escalated、grant 到期、viewer hidden/refresh、controller stop/disconnect；
6. 两个 viewer 同时在线，再让第三个 viewer 晚加入，分别验证厨房动态 audience 与跌倒静态 audience；
7. 跌倒旧 grant 到期后，由已升级告警显式重新向当前 viewer 开放 30 秒。

每次记录：credential/provider outcome、ICE gathering/connection state、selected local/remote candidate type、从 grant accepted 到 remote track/首个新鲜帧的时长、连续新鲜帧时长、失败原因、授权结束后的最后帧时间。日志不得包含 credential、完整 SDP/ICE candidate 或媒体正文。

### 5.3 Holdout

Pilot 后先冻结：目标浏览器集合、首次可见帧时限、允许重试次数、最小连续播放窗口及失败计数门槛。随后选至少两个未参与调参的真实跨网组合做 Holdout。不得在看见 Holdout 结果后调阈值再把同一轮计为通过。

## 6. Go / No-go Gate

### 自动化 Go

- 全部 exact/auth/fail-close 测试通过，无 secret/credential/媒体正文进入日志、存储或 bundle；
- frontend tests/lint/build、Relay tests/types/check、staging/production dry-run、`git diff --check` 全绿；
- 既有权威与滚动兼容全套无回归。

### 真机 Go

- 至少两个已记录的跨网 Holdout 均在 active grant 内收到真实远端 track 和持续新鲜帧；至少一轮强制 relay 诊断显示 selected candidate type=`relay`；
- 厨房连续两次真实 MiMo verified + active grant 后，credentialing/connecting/failed 先使用中性隐私投影，fresh frame 到达后评委真实看到手机实时做饭画面且背景/骨架被移除；grant 到期或撤销、已无 active grant 后才回到厨房抽象 + 骨架；
- fall checking 抓包/track 检查无视频；Relay 权威 escalated 后既有 audience 可见真实视频；late viewer 不继承；显式 30 秒新 grant 后它才可见；
- 完全隐私在所有迟到 grant/capability/offer、refresh、网络恢复顺序下都无真实像素和最后一帧；
- grant expiry/revoke、hidden、stop、disconnect、lease/session change 后不再有 sender/remote track/可渲染最后帧；告警与结构化信息仍在；
- TURN provider/secret 故障时 UI 明确说明实景传输不可用，不创建 STUN-only peer，不显示假 LIVE。

### No-go

下列任一项成立即 No-go，不得发布为“公网实景可用”：

- 只有同网成功，跨网 Holdout 无 relay candidate 或无首帧；
- kitchen verified + active grant 后仍显示预制厨房背景，却宣称正在播放；
- scene button、自动场景结果、客户端伪造 activity/alarm 可取得 ICE 或原画；
- fall late viewer 自动继承旧 grant，或重新开放复用/延长旧 grant；
- 完全隐私、grant 前、checking、到期/隐藏/断联后出现真实像素或最后一帧；
- 长期 key 出现在前端、响应、日志或仓库，viewer credential 可跨 socket/session/grant 使用；
- 媒体帧/Base64/Blob 进入 DO、普通 WebSocket、KV 或持久日志；
- 为 TURN 改坏 voice 3/5/6 ready、watchdog/checkpoint、verified activity 或多人投影隔离。

## 7. 不可宣称项

Gate 通过也只证明记录条件下的路演可达性，不得宣称：

- 公网普遍稳定、所有 NAT/运营商/企业网络均支持；
- 医疗级、保证跌倒识别、做饭识别准确率或跨家庭泛化；
- 真实厨房/跌倒画面经过匿名化；
- TURN relay 等于媒体完全本地、或 Cloudflare 从不转发加密媒体包；
- `kitchen_moment` 是云端录像、6 秒短片分享或本人长期同意；
- 固定环境图是家具复原、分割、三维重建或数字孪生；
- 短时 credential 的应用绑定等于生产账户授权、审计或 provider recipient ACL；
- 成功返回 ICE 配置等于 selected relay candidate、首帧或持续直播已经成立。

## 8. 外部依赖与停线条件

创建 Cloudflare TURN key、启用可能产生的服务用量、写入 staging/production secrets 与部署都属于外部账号动作。用户已在 2026-08-02 明确授权本次创建 key、配置 staging/production secrets，并在代码/测试全绿后部署验证；实际 key ID、secret 写入与部署版本仍须由执行结果逐项证明，授权本身不能勾掉配置或真机 Gate。未配置时必须显示 `turn_not_configured` 对应降级，不能使用仓库内测试 key 或硬编码公共 credential 顶替；若后续范围或费用边界实质扩大，需重新确认。
