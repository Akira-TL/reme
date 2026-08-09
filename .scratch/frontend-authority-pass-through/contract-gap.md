# Contract gap：浏览器退出后无法自主 timeout

状态：Resolved in `.scratch/cross-boundary-contract-fixes/`（2026-08-09）
发现日期：2026-08-09
本工作项原处理：前端删除自动 timeout；后续工作项已补 B runtime deadline

> 解决摘要：`MonotonicDeadlineScheduler` 在 B runtime 中按 scene + decision
> 注册 deadline；`DecisionService` 在锁内复验当前 authority 后调用状态机
> `on_timeout`，并在 response/new decision/reset/session stop/shutdown 时取消旧
> deadline。CareDecision 现携带 `response_deadline_ms` 供 C 只读呈现。

## 现状证据

1. `CareDecision.response_timeout_ms` 只提供相对展示时长，没有 server-side deadline id 或绝对截止时间。
2. `backend/reme/runtime/decision/state_machine.py` 文件头明确说明模块“不持有 timers / IO”，timeout transition 只在收到 `InteractionResponse(response=none, source=timeout)` 后执行。
3. `docs/adr/0005-check-in-first-deterministic-escalation.md` 当前仍把 C 提交 `none/timeout` 写为触发升级的步骤。
4. 当前前端 `useDecisionRuntime.js` 的倒计时和录音失败分支正是上述 InteractionResponse 的实际生产者。

因此，提示词要求的“关闭、冻结或后台化 Home 浏览器不影响 timeout”在当前 backend contract 下尚不可成立。删除浏览器提交后，用户静默不会自动生成下一条 authoritative CareDecision，直到后端 owner 增加 autonomous timeout。

## 为什么前端不能填补

- 浏览器 timer 会被后台节流、冻结或页面退出中断。
- 客户端相对倒计时在重连/重复投递时会重新起算，无法成为单一审计事实。
- TTS、ASR、麦克风或网络失败不是用户“无回应”的权威业务事实。
- 继续由前端提交 timeout 会让安全升级依赖展示端存活，违背本工作项职责边界。

## 最小后端增量

后端 owner 至少需要：

1. 在产生需回应 CareDecision 时，以 `session_id + scene_id + decision_id` 注册 server-owned deadline。
2. deadline 使用后端单调/持久化可恢复的时钟语义；重复发布同一 decision 不得重启窗口。
3. 收到有效真实 response、新 decision、scene reset/switch 或 session stop 时原子取消旧 deadline。
4. deadline 到期后由后端规则路径直接应用等价的 timeout transition，并通过现有 RuntimeEvent 发布新的 CareDecision；前端不发送伪造 InteractionResponse。
5. 明确进程重启、重复 alarm、迟到 response、同 decision 并发 response 的幂等规则。
6. 更新 ADR-0005、ABC contract 与 API handoff，删除“C 必须提交 timeout”的现行描述。

## 调用方影响

- Home：继续显示 `response_timeout_ms` 的 presentation countdown，但归零只清 UI。
- Monitor / Relay / Family：只等待后端发布的新 CareDecision；不会自行升级或延续 alarm。
- 自动化验收：必须新增“关闭 Home 页面后仍按 server deadline 发布升级 decision”的后端集成测试。

## 临时可见行为

在后端增量落地前，前端会诚实停留在最后一条 CareDecision（直到收到新 decision、session 失效或状态重置），而不是伪装自动升级成功。该缺口不能被发布文案描述为已完成的端到端 autonomous timeout。
