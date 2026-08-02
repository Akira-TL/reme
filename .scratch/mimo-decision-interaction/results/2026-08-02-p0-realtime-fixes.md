# P0 修复批 · 实时联调阻塞项处置记录

- 范围：`257046d..b33b86b`
- 来源：A/B 对接四维分析（`wf_80d2319d-e28`）挖出的 5 个 P0——它们的共同特征是**单测全绿但联调必炸**，因为每一个都发生在 A 与 B 的接缝上，而接缝此前从未被真实事件驱动过。
- 编排：4 条 Opus 泳道（worktree 隔离、文件零交集）+ 主线程收口 + Codex 异构对抗复审。

## 五项修复

### P0-1 跌倒门限卡在 A 的产出区间内部（`guardrails.py`）

A 的 fall 分支置信度为
`clamp(0.55 + 0.12·min(drop/0.20−1,1) + 0.12·min(speed/0.65−1,1) + 0.08·r, 0, 0.95)`。
其 fall 门限强制两个 min 项 ∈ [0,1]，帧准入门限强制可见比例 r ∈ [0.5,1.0]，故**输出恒在 [0.59, 0.87]**（0.95 的上钳不可达）。用 A 自己的 `_classify` 扫描实测复核得 `[0.5900000000000001, 0.87]`，与解析一致。

原 `fall_confidence_min = 0.7` 落在该区间**内部**，静默丢弃 [0.59, 0.70) 的真跌倒——约占该置信度区间 39%。改为 `FALL_LIKE_CONFIDENCE_FLOOR = 0.59`（解析下界，不再低一步）。`detect_fall_trigger` 其余三条判据、`violates_risk_floor`、`_STATE_SEVERITY` 均未触碰。

新增测试里有一条**有意的耦合**：直接从 `TransitionDetectorConfig` 反算上下界，A 一旦重调 `fall_center_drop` / `fall_peak_speed` / `min_visible_keypoint_ratio`，该测试立即变红——门限漂移不会再无声发生。

依据已登记进 [证据台账](../../../docs/references/cognition-evidence.md) 末表；ADR-0006 的"不得放松跌倒规则"不变量加了脚注说明二者不冲突（上下文调制中该字段仍原样拷贝，本次改的是基线，且修的是静默丢弃而非降低判据强度）。

### P0-2 A→B 链路根本不通（新 `ws_client.py` + `PerceptionBridge`）

复审实测：B 无 WS 客户端、A 无出站 HTTP——A 是纯发送端、B 是纯接收端，**两边都在等对方**。补上 B 侧的客户端一半：

- `PerceptionEventClient`：纯 stdlib RFC6455 **客户端**（角色掩码规则与仓库既有服务端实现相反：客户端发出必须掩码、服务端来的不带掩码，故不可复用 `websocket.py` 的 `read_frame`），含握手 Accept 校验、分片重组、ping→pong、close 握手、1MiB 上限、带上限的退避重连、可从回调线程安全调用的 `stop()`。
- `PerceptionBridge`：把订阅绑到会话生命周期——`/api/session` 成功且 buffers 清空**之后**订阅，`/api/session/stop` 在 registry 忘记会话**之前**拆订阅，进程退出一并拆。
- **互斥**：两条入口写同一条 sequence 水位，同开必然互相把对方整批判成乱序。桥附着期间 `POST /api/events` 返回 409 `push_ingest_disabled`，把误配置暴露出来而不是变成"链路时通时不通"。
- CLI：`--a-events-url` 给了即 pull 模式，不给保持 push（回放、离线夹具、A 将来长出出站 HTTP）。

### P0-3 同帧派生事件共用 sequence（`stream.py`）

A 让一帧派生的三个事件共用同一个 `frame.sequence`（`camera.py:247` 源头，`posture_runtime.py:135` 与 `transitions.py:254` 原样透传）。B 的 per-session 严格递增水位因此在 posture 占掉 seq N 后，把同帧的 `TransitionEvent` 判 `bad_event` 丢弃——**丢的正是跌倒信号**。

水位键细化为 `(session_id, event_type)`。不选"同 sequence 内按 event_type 去重"的方案，因为后者只在同帧事件严格相邻到达时成立：一旦出现 `posture(5) → posture(6) → transition(5)` 这类交错（A 的两条派生流之间本无互序保证），transition 会被再次丢弃，故障只是被推后一帧。

保持不变：跨 session 仍拒、同类型内重复与倒序仍拒、时间戳非递减、缓冲上限、`reset_all` 清空全部 per-type 水位、`IngestError` 错误码语义。

### P0-4 超时升级在实时主路径从未执行（`state_machine.py`）

倒计时 `response_timeout_ms` 是"超时必须确定性升级"这条链路的载体。缺口不止一处：

1. 久坐首轮 check-in——`None`；
2. `unclear` 澄清轮——`check_in_timeout_ms if is_fall else None`，**字面意义上的"只对跌倒生效"**；
3. `need_help` 但无主诉的澄清轮——恒 `None`，久坐专属。第 3 条语义上最危险：老人说了"需要帮助"却讲不清，随后失声，永不升级。

三处统一为一条可陈述的不变量：**任何把会话留在 `awaiting_elder` 的决策都携带 `config.check_in_timeout_ms`**；措辞仍按触发类型区分。升级逻辑本身无需改动——`ResponseValue.NONE` 分支从不看 `escalation`，久坐与跌倒走同一条 `source=rule` 升级；问题纯粹是**可达性**（无倒计时 → C 渲染不出计时器 → 永不提交 timeout → 升级分支进不去）。

`CONSENT_REQUIRED` 两处刻意保留 `None`：其超时结果是保守 resolve 而非升级，代码里已注明是产品选择。留作单独排期的 UX 项。

### P0-5 纯 live 起不来（`config.py` + `server.py::main`）

`scenes_dir` 曾是必填位置参数且空 bundle 直接 `return 2`，而 live_camera 的感知来自会话事件流、根本不需要磁盘素材。改为可选（`nargs="?"`），record 模式在参数解析期即强制要求。旧用法行为不变。

## 验证

全量 **446 测试通过**（新增：P0-1 六项、P0-4 五项、P0-3 八项、P0-2 十五项、P0-5 四项、收口三项）、mypy strict 24 文件零 issue、ruff 清。

## Codex 异构对抗复审

（复审进行中，findings 与处置结论待补。）
