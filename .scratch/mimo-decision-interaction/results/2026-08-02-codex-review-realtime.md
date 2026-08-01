# Codex 异构对抗复审 · 实时批次处置记录

- 复审范围：5ab0828..dd82c14（RuntimeSession/WebSocket/事件入口/接线），Codex session `019fbe08-ec9e-7e30-b509-40eb4a0c0d32`
- 结论：9 P1 / 7 P2 → **10 项已修，6 项文档化接受**（联调期收口项）
- 复审确认无误：分片状态机与控制帧插入、掩码批量 XOR 边界、EOF/协议错分流、close_connection 时机与 rfile 缓冲保留、明文下逐连接 send 锁无交错无死锁、状态广播线格式与合同一致、EventIngest 无锁序死锁、previous_id 去重无漏发路径

## 已修（本轮提交）

| Finding | 修法 |
|---|---|
| P1 帧长在读入后才检查（内存 DoS 面） | `read_frame` 在读载荷**之前**按声明长度拒绝（`_MessageTooBig`→1009）；碎片累计口径保留 |
| P1 close_all 不唤醒阻塞 recv 线程 + 新连接漏关 | `shutdown_socket()`（SHUT_RDWR）唤醒阻塞读；hub `_closing` 旗标拒绝新注册（含握手后竞态窗口） |
| P1 会话切换不失效决策状态（旧 MiMo 可套新会话信封） | `DecisionService.reset_all_scenes()`（全场景 epoch 递增使在途 CAS 全部作废），挂进 `_announce_session` |
| P1 sequence 分配与广播非原子（线上可现 n+1 先于 n） | publisher 内 `_order_lock` 把取号+广播锁成一步 |
| P1 profile 与服务 demo_mode 不一致仍返回 running | `/api/session` 前置一致性闸：record 服务只收 recorded_video、live/mock 只收 live_camera，违者 409 `profile_mismatch` |
| P1 TLS 握手阻塞 accept 循环 | 监听层 `do_handshake_on_connect=False`，握手移到 worker 线程 `setup()`（10s 超时） |
| P2 Sec-WebSocket-Key 未验 base64/16 字节（非 ASCII 可炸未捕获异常） | 严格 `b64decode(validate=True)` + 16 字节校验，失败走 WebSocketError 零字节写出 |
| P2 入站 sequence 无高水位（重复/倒序通过） | EventIngest 按 session 维护严格递增水位（bad_event 拒绝），reset_all 清零，水位仅在事件完整接受后推进 |
| P2 任意 scene_id 可在会话下解析 | registry 增 `active_scene_id()`；resolver 场景绑定，其余 scene 保持严格 404 |
| P2 /api/scene/reset 不清实时缓冲 | reset 连带 `ingest.reset_scene`（否则重放撞时间戳水位） |

新增回归测试 8 个（超长声明帧头即拒、坏 key 两类零字节、close_all 唤醒+拒新连、重复/倒序序列、profile 不匹配 409 等），全套件 233 测试绿。

## 文档化接受（联调期收口）

| Finding | 接受理由与缓解 |
|---|---|
| P1 TLS 下 recv 与广播并发操作同一 SSLSocket | 演示规模决策低频、连接个位数；HTTP 轮询是 TLS 安全的兜底通路；根治需单 IO owner+发送队列，联调期视需要做 |
| P1 广播串行 fan-out 慢客户端阻塞 | 连接个位数+帧小；死连接在写失败即剔除；根治=有界发送队列 |
| P1 registry/ingest TOCTOU（切换窗口接受旧事件） | 需要跨组件生命周期锁/generation token 协议；切换是罕见人工操作，接受 |
| P2 close 载荷未全验（非法 code/UTF-8 reason） | 宽松回显不影响我方状态机 |
| P2 非最短长度编码接受 | 无害宽松 |
| P2 后台评估失败仅 stderr（C 无感） | 记录：联调期换受监督队列+`mark_degraded` 广播 |
