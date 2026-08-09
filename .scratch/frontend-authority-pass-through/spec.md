# Reme 前端去业务判断化 / 权威状态透传

你现在负责小米黑客松 Reme 项目的“前端去业务判断化 / 权威状态透传”。目标是让前端回归展示层，不再承担安全状态机职责。

当前合同基线是 `reme-care-decision/v1-experiment` 与
`reme-demo-state/v4`；家属侧产品形态以 B 输出的 `family_delivery` 为准。
语义详见 `docs/adr/0009-family-care-delivery-semantics.md`。

## 0. 当前工作区与 Git 边界

本任务只能在启动任务时已经分配给你的当前 Git worktree 中完成。不要切换到任何写死的绝对目录，也不要进入其他成员或其他 Agent 的工作区。

先在当前目录执行：

```bash
REME_REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REME_REPO_ROOT"
git status --short --branch
git rev-parse HEAD
git remote -v
```

后文所有路径都相对于 `$REME_REPO_ROOT`。

Git 约束：

- 以当前 worktree 已检出的 HEAD 为任务基线，不要假设基线是 `develop/akira`。
- 不要照搬其他成员工作区中的 `git fetch`、merge、rebase、cherry-pick、reset、checkout 或目录切换命令。
- 不要自动合并 `origin/develop/akira`。本提示词编写时，当前工作区基于 `lbx-frontend` 集成线，而不是 `develop/akira`。
- 如果当前是 detached HEAD，需要提交代码时，从当前 HEAD 创建一个未占用的 `codex/` 工作分支；不要为了获得分支名而切换基线。
- 任务开始前已有的修改属于用户或其他协作者：记录并保留，不暂存、不覆盖、不提交。
- 如果发现当前 HEAD 与预期工作项不一致，先报告 commit、分支包含关系和差异，不要自行同步其他分支。

这是多文件、跨前端与 Relay 协议的改动。遵循 Explore → Plan → Code → Commit：先完成调查并更新本目录下的 `plan.md`，列清状态来源、协议改动和 contract gap；计划获明确确认后再进入代码阶段。

## 1. 必读事实源

先阅读：

- `AGENTS.md`
- `CONTEXT.md`
- `.scratch/handoff/2026-08-01-product-mimo-handoff.md`
- `.scratch/abc-interface/spec.md`
- `.scratch/public-dual-device-demo/spec.md`
- `.scratch/public-dual-device-demo/validation.md`
- `.scratch/frontend-role-routes/spec.md`
- `.scratch/home-p0-integration/validation.md`
- `.scratch/family-event-timeline/spec.md`
- `.scratch/media-permission-recovery/spec.md`
- `docs/adr/0005-check-in-first-deterministic-escalation.md`
- `docs/adr/0008-public-demo-event-video.md`
- `backend/reme/runtime/decision/records.py` 中 `CareDecision`、`AlarmSignal` 及其 `to_payload()`，只把这里的实际合同当作后端字段事实，不修改 Python 状态机

再阅读当前实现：

- `frontend/src/hooks/useDecisionRuntime.js`
- `frontend/src/services/decisionClient.js`
- `frontend/src/typical-demo/useFallLiveLink.js`
- `frontend/src/typical-demo/TypicalDemoApp.jsx`
- `frontend/src/typical-demo/phoneState.js`
- `frontend/src/typical-demo/HomeCarePrompt.jsx`
- `frontend/src/typical-demo/monitorRelay.js`
- `frontend/src/typical-demo/remoteCommand.js`
- `frontend/src/shared-demo/ViewerApp.jsx`
- `frontend/src/shared-demo/viewerState.js`
- `frontend/src/shared-demo/familyPresentation.js`
- `frontend/src/shared-demo/protocol.js`
- `demo-relay/src/protocol.ts`
- `demo-relay/src/index.ts` 中 care 校验、media grant 与 alarm confirmation 相关逻辑

不要仅凭本提示词中的字段清单推断合同；以当前工作区代码和已接受 ADR 为准。若它们彼此冲突，在 `plan.md` 中列出证据与影响。

## 2. 背景

当前后端已经产生 authoritative `CareDecision`。与本任务直接相关的事实包括：

- `schema_version`
- `scene_id`
- `decision_id`
- `timestamp_ms`
- `state`
- `action`
- `risk_level`
- `alarm`
- `alarm.trigger`
- `alarm.channels`
- `family_notification`
- `privacy_mode`
- `consent_required`
- `response_timeout_ms`

前端目前又维护了一套二次业务状态，例如：

- `phase`
- `effectivePhase`
- `safetyLatch`
- `currentAuthority`
- `fallEpisodeActive`
- `alarmAuthoritative`
- 本地业务 timeout timer
- Home / Monitor / Relay 中重新构造的 care state

结果变成“后端决定一次，前端再决定一次”。

## 3. 核心职责边界

前端以后只负责：

`接收后端事实`
→ `做 UI vocabulary 映射`
→ `展示`
→ `执行后端明确授权的客户端副作用`

前端不能自行决定：

- 是否发生业务 timeout
- 是否需要升级报警
- 当前是否属于 authoritative emergency
- 是否因本地状态机而通知 Family
- 是否因本地 `phase`、history、connection 或 latch 创造新的安全事实

Relay 可以校验 schema、session、revision、TTL 与消息新鲜度，但不能重做安全决策。

## 4. P0：删除前端业务 timeout

检查 `frontend/src/hooks/useDecisionRuntime.js` 中所有会自动产生业务提交的计时或失败分支，不只检查函数名。

必须删除的行为包括：

```text
window.setTimeout(...)
→ submitFor(payload, "none", "timeout")
```

以及因麦克风、TTS、ASR、录音或 prompt 失败而由浏览器自动合成的：

```text
response=none / source=timeout
```

后端负责 autonomous timeout 与后续 authoritative transition。

前端仍可根据 `response_timeout_ms` 显示倒计时，也可以在归零时清掉倒计时 UI；但归零只能改变 presentation state，不能 POST、不能升级、不能创建 alarm，也不能伪造一条 InteractionResponse。

不要误删：

- Family 用户真实点击产生的 response
- `safe`、`need_help`、`consent_granted`、`consent_denied`、`card_confirmed` 等真实交互
- 实际录到并提交给专用语音端点的用户音频
- 只服务于语音播放、采集窗口、UI 刷新、授权 TTL 或连接生命周期的非业务 timer

判断标准不是“是否使用 `setTimeout`”，而是“计时结束是否创造了新的业务事实”。

## 5. P1：收缩前端安全状态机

重点检查 `frontend/src/typical-demo/useFallLiveLink.js`、`frontend/src/hooks/useDecisionRuntime.js` 与 `frontend/src/typical-demo/phoneState.js`。

UI vocabulary 映射可以保留，例如：

- `check_in_required` → `checking`
- `consent_required` → `checking`
- `family_delivery=notification | action_card` → `attention`
- `family_delivery=alarm` → `emergency`
- `resolved` → `resolved`
- 其他无家属投递的状态 → `idle`

但它必须是可测试的纯展示映射，例如：

```js
const displayPhase = mapCareDecisionToPhase(decision);
```

不要综合 history、latch、connection、perception 或旧 phase，重新判断当前是不是 authoritative emergency。

约束：

- `history` 可以用于时间线或调试展示，但不能成为当前 safety authority。
- reconnect 后不能用旧 local latch 恢复或伪造 emergency。
- 当前 authoritative snapshot 必须由当前 runtime/session 中的新鲜 CareDecision 决定。
- 为兼容 UI 暂时保留的 `phase` 必须明确命名或注释为 presentation-only，任何副作用与授权逻辑不得读取它。
- 优先删除 `safetyLatch`、`currentAuthority`、`fallEpisodeActive`、`alarmAuthoritative` 等重复 authority 状态；若有不能删除的字段，在交付说明中逐项证明它只承担显示或 transport 职责。

### candidate 例外

`fall_like_transition → candidate` 可以保留，但 `candidate` 只是 perception/UI visualization state。

它不能：

- 触发 alarm 或客户端 alarm 副作用
- 通知 Family
- 开放事件原画
- 触发 MiMo/Miloco 业务交互
- 生成 safety latch
- 替代 CareDecision

只有后端 CareDecision 是 safety authority。

## 6. P2：Relay 透传 authoritative decision

当前 Home / Monitor 把后端状态压成 `phase`、`alarm_authoritative`、`message`，Family 再从 `care.phase === "emergency"` 推导告警。这层必须收缩。

优先让 Relay 的 `care` 携带一份 1:1 的 authoritative decision snapshot，而不是复制多个彼此可能漂移的 boolean。至少保留：

- `schema_version`
- `scene_id`
- `decision_id`
- `timestamp_ms`
- `state`
- `action`
- `risk_level`
- `family_delivery`
- `action_card`（完整对象，允许为 `null`）
- `alarm`（完整保留 `trigger` 与 `channels`，允许为 `null`）
- `family_notification`
- `privacy_mode`
- `consent_required`
- 本任务确实需要的最小授权字段

实现可以选择嵌套 `care.decision`，也可以在兼容现有协议的前提下一一透传字段；但不能只留下重新派生的 `phase` 或 `alarm_authoritative`。

Family Viewer 必须根据 authoritative 字段渲染：

- `family_delivery=none` 只展示判词或过程状态，不能制造通知、行动卡或告警。
- `family_delivery=notification` 展示普通通知，不制造待办或告警副作用。
- `family_delivery=action_card` 且 `action_card != null` 时展示非紧急家庭待办；牙疼只是这一流程的脚本示例，不是检测器或安全警告。
- 只有 `family_delivery=alarm` 且 `alarm != null` 才展示 alarm UI，并按 `alarm.channels` 执行对应副作用。
- `state=family_notification_required` 但 `family_delivery!=alarm` 时，不能凭 phase 制造声、光、振动、紧急 modal 或跌倒原画授权。
- 如果兼容 UI 暂时保留 `phase`，它只能是 derived presentation field；关键操作不得依赖它。

保留并正确使用 Relay 的 transport freshness 事实：

- room session
- runtime session
- state revision / sequence
- decision id

stale room、stale runtime、旧 revision 或重连前缓存不能被当作当前 alarm。

同步修改并测试所有实际协议边界：

- Monitor 生产端：`frontend/src/typical-demo/monitorRelay.js`
- Family 消费端：`frontend/src/shared-demo/protocol.js`、`viewerState.js`、`ViewerApp.jsx`
- Relay Worker：`demo-relay/src/protocol.ts`、`demo-relay/src/index.ts`

## 7. P3：客户端 alarm 副作用

浏览器仍可执行：

- vibration
- ringtone
- flash
- emergency modal

触发条件必须直接来自当前新鲜 CareDecision 的 `alarm`，并尊重 `alarm.channels`；不能来自 MIL probability、transition、phase、safety latch、history、connection 或 local timeout。

例如：

```text
alarm.channels = ["vibrate", "ring"]
→ 当前客户端执行振动和响铃
```

没有对应 channel 就不要补做该副作用。Family 的确认或静音 UI 不能把后端 alarm 改写成已解除，也不能降低或取消 deterministic alarm。

## 8. P4：视频开放不能由前端重判安全事实

检查前端和 Relay Worker 中所有与事件原画有关的条件，包括：

- `currentAuthority`
- `effectivePhase === "emergency"`
- `fallMediaAuthorization`
- `mediaAuthorityEligibility`
- Relay media grant eligibility / request validation

前端或 Relay 可以做：

- 检查授权和 grant 是否过期
- WebRTC 生命周期与 media grant transport
- 检查页面是否实际有 camera stream
- room/runtime/decision 绑定与新鲜度校验
- fail-close
- 浴室永远不发送原画

前端或 Relay 不应推导“当前跌倒事件是否已经 authoritative emergency”。这个事实必须直接来自当前后端 CareDecision 或后端明确发布的最小授权字段，不能从 `phase`、candidate 或 local latch 重建。

如果当前 backend contract 已足够，直接消费。如果缺少一个无法安全获得的 authority 字段：

1. 在 `.scratch/frontend-authority-pass-through/contract-gap.md` 记录现有字段、无法表达的判断、最小新增字段及调用方。
2. 不修改 Python 后端状态机。
3. 不用前端规则填补缺口。
4. 与后端 owner 对齐后再进入依赖该字段的实现；其余不依赖部分继续推进。

## 9. 必须保持的产品规则

不要修改：

- Routine 默认 skeleton
- Bathroom 永远不开放原画
- Kitchen 需要当前 consent
- Fall 只有 authoritative escalation 才允许短时原画
- clear-video grant TTL
- Family 无法降低或取消 deterministic alarm
- Home / Family / Debug 三角色结构
- 固定 demo room 设计
- WebRTC / Relay 基本机制
- ADR-0008 只是固定公开演示例外，不扩张为生产隐私或鉴权设计

这次不是产品规则重做，而是把业务事实来源从前端收回后端。

## 10. 代码质量与范围

优先减少状态，不要增加另一层“权威适配状态机”。目标是：

```text
one backend fact → one frontend representation
```

而不是：

```text
backend state → frontend derived state A → state B → state C
```

约束：

- 不要把新逻辑继续堆进 `TypicalDemoApp.jsx`、`ViewerApp.jsx` 或 `useDecisionRuntime.js`。
- 可以抽出纯函数 mapper、authoritative decision selector 或 protocol adapter，并为其写确定性测试。
- 不借机大规模改 UI、路由或 WebRTC 架构。
- 不自行修改 `backend/` Python 状态机；后端 owner 负责 autonomous timeout、authoritative transition 与 CareDecision/alarm publication。
- 本任务可以修改 `frontend/` 和 `demo-relay/` 中为 authoritative passthrough 所必需的协议、校验、reducer、展示和客户端副作用代码。

## 11. 最低测试覆盖

至少新增或修改测试证明：

1. 前端收到 `check_in_required + response_timeout_ms` 后可以显示倒计时。
2. 倒计时归零时不会 POST `response=none`，也不会通过其他失败分支提交 `source=timeout`。
3. 只有收到后端新的、当前 session 的 `alarm` 后才启动对应 alarm UI/副作用。
4. 只有 perception `fall_like_transition` 时最多显示 candidate，不报警、不通知、不开放原画。
5. `state=family_notification_required` 但 `alarm=null` 时，不凭 phase 制造声光 alarm。
6. Family Viewer 直接根据 authoritative care/alarm 字段展示。
7. Relay 协议原样保留 `alarm.trigger`、`alarm.channels` 和关键 CareDecision 字段。
8. stale Relay state 不会被当成当前 alarm。
9. reconnect 后不能用旧 local latch 伪造 authoritative emergency。
10. kitchen consent 与 60 秒演示 grant 继续正常。
11. bathroom 原画继续绝对禁止。
12. fall clear-video grant 只能基于后端 authoritative decision，并保持 30 秒上限。
13. Family 不能通过确认命令降低或取消 deterministic alarm。
14. Home / Family / Debug 路由构建全部通过。

优先更新这些现有测试边界；需要时再新增小型纯函数测试：

- `frontend/src/typical-demo/phoneState.test.js`
- `frontend/src/typical-demo/monitorRelay.test.js`
- `frontend/src/shared-demo/protocol.test.js`
- `frontend/src/shared-demo/viewerState.test.js`
- `frontend/src/shared-demo/familyPresentation.test.js`
- `demo-relay/test/relay.test.ts`

## 12. 验证命令

所有命令从仓库根目录执行。不要在仓库根目录直接运行不存在的 `npm test`。

```bash
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix frontend run test:route-build
npm --prefix demo-relay test
npm --prefix demo-relay run check
npm --prefix demo-relay run dry-run
git diff --check
```

若依赖缺失，先报告缺失项与 lockfile 状态；不要顺手升级依赖或重写 lockfile。

## 13. 验收链路

最终必须证明：

```text
后端发布 check-in CareDecision
→ UI 显示询问与可选倒计时
→ 倒计时结束，前端不产生业务提交
→ 后端自行发布新的 alarm CareDecision
→ Home 收到 authoritative alarm
→ Relay 原样透传并校验新鲜度
→ Family 收到、展示，并按 alarm.channels 执行客户端副作用
```

关闭、冻结或后台化 Home 浏览器，不应该改变后端是否发生 timeout。

完成后交付：

- 删除了哪些前端业务判断与自动提交路径
- 仍保留哪些纯 UI 派生状态，以及为什么它们不构成 authority
- Relay authoritative payload 的前后对比
- 是否存在 backend contract gap
- 全部验证命令与实际结果
- 只暂存本任务文件，检查 staged diff，并创建一个描述性 commit
- 不 merge 到 `develop/akira`，不 push，除非用户另行明确要求
