# 后端权威超时收口

## 目标

把 `response_timeout_ms` 的到期判定从浏览器迁回 `DecisionService`。前端可以继续渲染倒计时，但安全状态转移不再依赖浏览器 `setTimeout()` 或 `response=none/source=timeout` POST。

## 既有语义

- 状态机仍由 `on_response(... ResponseValue.NONE / ResponseSource.TIMEOUT ...)` 负责超时后的确定性升级，不重写告警规则。
- 当前服务端 TTS 保护语义是：decision 发出后可开始超时窗口；若该 decision 的 TTS synthesis 开始，则暂停旧窗口；TTS synthesis 结束（`mark_decision_voice_ready`，当前由 `finally` 调用）后重新给完整 `response_timeout_ms` 窗口。
- 无 TTS 请求、浏览器断开或 WebSocket 断开时，后端仍必须自行到期。
- `response_timeout_ms` 保留为 C 的展示字段。

## 实现边界

1. 为 `DecisionService` 注入可测试的 timeout scheduler 和 monotonic clock。
2. 每个 scene runtime 同时最多保留一个 timeout handle。
3. 新 decision commit 时取消旧 timeout；若新 decision 带 `response_timeout_ms`，由后端自动注册。
4. `mark_decision_voice_started` 暂停当前 decision 的 timeout；`mark_decision_voice_ready` 从当前时刻重新注册完整窗口。
5. timeout callback 只生成等价的 `InteractionResponse(response=none, source=timeout)`，继续调用 `DecisionService.submit_response()`，不得直接构造 alarm。
6. callback 在提交前/提交时重新校验 scene epoch、pending decision_id、timeout 字段与 TTS 状态；用户回应、danger confirm、reset、session stop、shutdown 都必须使旧 callback no-op。
7. `DecisionRuntime.shutdown()` 关闭 scheduler。

## 不在本任务范围

- 前端删除本地 timeout（交给前端任务）。
- Relay / Family 协议收口。
- Miloco payload。
- MoveNet / MIL / 跌倒阈值。
- danger 现有 `frame` confirm 测试与当前 `FALL_CONFIRM_CHANNELS=("voice",)` 的基线不一致。

## 验收

- 无浏览器 timeout POST 时，fall check-in 可自动升级并发布 `AlarmTrigger.CHECK_IN_TIMEOUT`。
- 用户在到期前回应时旧 timer 无效。
- reset / session stop / 新 decision / TTS race 不产生重复告警。
- 使用可控 scheduler / clock 测试，不依赖真实 sleep。
