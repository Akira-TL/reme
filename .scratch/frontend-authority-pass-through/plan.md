# 前端去业务判断化 / 权威状态透传实施计划

状态：Implemented（2026-08-09；前端/Relay 验证门已通过）
基线：`bf3c6999`（当前工作分支 `codex/frontend-authority-prompt`；已包含最新 Family care-assessment 集成）
范围：`frontend/`、`demo-relay/` 与本工作项文档；不修改 `backend/` Python 状态机

> 后续合同：本文件记录 v3 首次权威透传的实施过程。当前运行合同已由
> ADR-0009 升级为 `reme-demo-state/v4` +
> `reme-care-decision/v1-experiment`，并以 `family_delivery` 区分判词、普通
> 通知、行动卡和告警；当前实现与验收以
> `.scratch/family-care-semantics/` 为准。

## 1. 调查结论

### 1.1 当前权威事实源

- 当前后端 `CareDecision.to_payload()` 已完整发布安全事实，包括 `state`、`action`、`risk_level`、`alarm`、`family_notification`、`privacy_mode`、`consent_required` 与 `response_timeout_ms`。
- `alarm` 是可空字段；存在时包含闭集 `channels = vibrate | ring | flash` 与 `trigger`。它只允许出现在 `family_notification_required` / `urgent_attention`。
- ADR-0008 所需的跌倒视频授权可以直接绑定“当前、新鲜、同会话 CareDecision 的非空 `alarm`”；不需要前端构造另一份 `fallMediaAuthorization` 安全事实。
- 厨房授权仍需保存一次真实 `consent_granted` 交互产生的短期 transport grant。它不是安全状态机，继续绑定 request decision、result decision、scene 与单调时钟 TTL。

### 1.2 当前重复判断点

| 链路 | 当前重复状态/判断 | 改造方向 |
| --- | --- | --- |
| Home runtime | `armResponseTimeout()` 与录音失败分支 POST `none/timeout` | 只保留 UI 倒计时，到点清 presentation state |
| Home alarm | `safe/card_confirmed` 点击即本地清 alarm；新 decision 仅 `resolved` 才停 alarm | 每条当前 decision 直接替换 alarm snapshot；副作用只读当前 `alarm.channels` |
| Fall UI | `safetyLatch`、history、`fallEpisodeActive`、`currentAuthority` 合成 emergency | 当前 decision 的 `state` 纯映射为展示 phase；candidate 仅感知展示 |
| Monitor | `effectivePhase`、`alarmAuthoritative` 与旧 latch 选择 authority decision | 发布当前 scene 的 CareDecision；presentation phase 不参与授权或副作用 |
| Relay protocol | v2 care 被压缩成 `phase/decision_id/alarm_authoritative/message/assessment`；其中 assessment 也是从 decision 重投影 | 升级到 `reme-demo-state/v3`，透传 `care.decision`；Family 从该 snapshot 做纯展示投影 |
| Family | 从 `care.phase === emergency` 产生 modal、声光振动与视频权限 | 只从当前新鲜 `care.decision.alarm` 读取告警与 channels |
| Media grant | Monitor 与 Worker 从 phase/state/latch 重判“权威跌倒” | Monitor/Worker 直接校验当前 decision id 与非空 alarm；继续校验 session/revision/TTL/media/privacy |

### 1.3 合同冲突

当前后端并未实现提示词假设的 autonomous timeout。证据和最小后端工作记录在 `contract-gap.md`。本任务仍删除浏览器自动 timeout；在后端 owner 落地前，静默用户不会自动进入下一条 CareDecision。这一行为缺口必须显式可见，不能由前端重新承担。

## 2. 协议设计

### 2.1 Demo state v3

当前远端已由 Family care-assessment 工作占用 `reme-demo-state/v2`。本任务会把 `DEMO_STATE_SCHEMA` / `DEMO_STATE_SCHEMA_VERSION` 升级为 `reme-demo-state/v3`，避免在既有 v2 下原地改变 care 语义。

`state.care` 改为：

```json
{
  "phase": "idle | checking | emergency | resolved",
  "consent": "none | pending | granted | denied",
  "decision": {
    "schema_version": "reme-care-decision/v0-experiment",
    "scene_id": "fall",
    "decision_id": "...",
    "timestamp_ms": 0,
    "state": "family_notification_required",
    "risk_level": 4,
    "privacy_mode": "skeleton_only",
    "need_dialogue": false,
    "dialogue_goal": null,
    "elder_message": null,
    "family_notification": "...",
    "action": "notify_family",
    "reason_summary": "...",
    "uncertainty": "low",
    "fallback_used": false,
    "source": "rule",
    "demo_mode": "live",
    "consent_required": false,
    "response_timeout_ms": null,
    "action_card": null,
    "visual_context": null,
    "alarm": { "channels": ["vibrate", "ring"], "trigger": "visual_confirm" },
    "voice_asset": null,
    "confirm_channels": null
  }
}
```

- `decision` 允许为 `null`，表示当前 scene 尚无后端决策。
- `phase` 仅为展示词汇，来源是纯函数 `mapDecisionStateToPhase()`；Worker grant、Family alarm、命令安全锁均禁止读取它。
- `consent` 仅描述当前 kitchen transport authorization；它不参与跌倒安全判断。
- v2 新增的 care assessment UI 继续保留，但改由 Family 直接从 `care.decision` 做纯展示投影；不再在 Monitor 与 Relay 协议中携带另一份可能漂移的 `assessment` authority copy。
- Monitor 只投影当前后端 payload 的已知合同字段，不修改值。前端与 Worker 都做 exact-shape / 枚举 / bounds 校验。
- room session、runtime session、revision、state freshness 与 Relay-owned media grant 规则维持不变。

### 2.2 当前与历史状态

- Viewer 收到 fresh v3 snapshot 后，以其中 `care.decision` 作为当前事实。
- Relay unavailable/stale 时可保留最后一次 alarm snapshot 供“历史告警”文案展示，但必须带 `stateStale`，不得触发 modal、振动、铃声、闪光、命令确认或媒体 grant。
- 新 decision 到达时，即使其 state 仍为 family notification，只要 `alarm=null`，所有客户端 alarm 副作用立即停止。

## 3. 实施步骤

1. 在 `decisionClient.js` 删除浏览器可提交的 `none + timeout` source 组合；保留真实用户、语音与 family response。
2. 在 `useDecisionRuntime.js`：
   - 将业务 timeout 改为 presentation countdown；所有失败分支不再合成 InteractionResponse。
   - 删除 passive observation 拦截、`safetyLatch`、`fallMediaAuthorization` 与 response 点击后的预先清 alarm。
   - 每个新 decision 直接替换当前 alarm；按 `alarm.channels` 启停本机振动/铃声/闪光能力。
3. 在 `phoneState.js` / `useFallLiveLink.js` 提供并使用纯展示映射；candidate 不进入 authority、命令锁、告警或媒体授权。
4. 在 `TypicalDemoApp.jsx` / `remoteCommand.js` 发布当前 CareDecision v3 snapshot；移除 `alarmAuthoritative`、`currentFallAuthority` 和 fall 本地 TTL；命令安全锁直接读取当前 authoritative decision/alarm。
5. 同步 `frontend/src/shared-demo/protocol.js` 与 `demo-relay/src/protocol.ts` 的 v3 exact validator，并把现有 care assessment 改为 Family 侧纯展示投影。
6. 修改 Relay Worker：fall grant 与 grant revoke 直接绑定 fresh `care.decision.decision_id + alarm`；alarm command lock 直接绑定 `alarm`；bathroom、runtime/capture、room/runtime/revision/TTL 校验不变。
7. 修改 `viewerState.js` / `ViewerApp.jsx` / `useAlertEffects.js` / family timeline：
   - message 与展示 phase 从 decision 派生；
   - modal 与副作用只使用 fresh `alarm`；
   - 严格执行 `vibrate/ring/flash` channels；
   - stale snapshot 只作为历史信息。
8. 更新受影响测试与协议 fixtures，补充 P0/P1/P2/P3/P4 回归覆盖。

## 4. 验证门

必须全部实际通过：

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

另做静态反证：

```bash
rg -n 'submitFor\([^\n]*"none"|source[^\n]*timeout|alarm_authoritative|safetyLatch|fallMediaAuthorization|currentAuthority' frontend demo-relay
```

允许命中测试中的反例名称或 backend contract-gap 文案；运行时代码不得再有这些重复 authority 路径。

实施结果：上述验证门全部实际通过。前端共 172 项测试通过，Relay 共 22 项测试通过；三角色 production preview、Worker 类型检查与 dry-run 均通过。静态反证在运行时代码中零命中。

## 5. 提交边界

- 只暂存本计划列出的前端、Relay、测试与本工作项文档。
- 提交信息使用描述性标题；不 push，除非用户另行要求。
- 若实现中发现 CareDecision 无法表达新的安全授权需求，先补充 `contract-gap.md`，不修改 Python，不在前端猜测。
