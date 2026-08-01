# B：MiMo 决策与主动交互

- Type: spec
- Status: active planning
- Owner: B
- Shared contract: `../abc-interface/spec.md`

## 1. 角色目标

B 负责把 A 的结构化感知事实转换为稳定、可解释、可降级的关怀决策，并将结果交给 C。

当前 P0 是完整实时链路：

```text
实时摄像头
→ A 实时姿态
→ B 确定性状态机
→ 事件触发式 MiMo
→ C 主动交互和状态展示
```

预录视频模式后续只回放预录决策，不在现场重新调用 B/MiMo。

## 2. 职责边界

B 负责：

- 接收并确认 C 发起的 RuntimeSession；
- 消费 A 的 PostureObservation 和 TransitionEvent；
- 维护风险、询问、超时和家属通知状态机；
- 决定何时调用 MiMo；
- 校验 MiMo 结构化输出；
- 执行不可被 MiMo 取消的确定性升级规则；
- 输出 CareDecision 和决策可用状态；
- 明确记录是否发送视觉上下文。

B 不负责：

- 运行人体关键点模型；
- 修改 A 的姿态结果；
- 让 C 根据自然语言猜测业务状态；
- 持续逐帧调用 MiMo；
- 自动呼叫急救或报警机构；
- 牙疼、授权、行动卡等尚未确定的产品故事字段。

## 3. 运行模式

B 只接受两个 profile：

| profile | B 行为 |
|---|---|
| `live_camera` | 运行实时状态机和事件触发式 MiMo |
| `recorded_video` | 回放 `recorded_decisions.jsonl`，不现场调用 MiMo |

C 发起 RuntimeSessionRequest；B 返回 RuntimeSessionStatus。

B 必须：

- 使用 C 提供的 `session_id`；
- 在 `running` 前完成依赖检查；
- 不支持时返回 `degraded + reason`；
- 不得静默切换 profile；
- 丢弃不属于当前 `session_id` 的迟到事件；
- 模式切换后清空上一会话的姿态窗口、询问、倒计时和决策缓存。

## 4. B 的输入

B 默认消费：

```text
RuntimeEvent<PostureObservation>
RuntimeEvent<TransitionEvent>
InteractionResponse
可选视觉上下文
```

B 默认不消费逐帧17点。只有需要抽取视觉上下文时，才根据当前会话的本地媒体来源获取最小关键帧或短片段。

必要字段：

- `session_id`；
- `scene_id`；
- `timestamp_ms`；
- `posture`；
- `posture_confidence`；
- `posture_duration_ms`；
- `motion_level`；
- `landmark_quality`；
- 当前或最近的 `transition`；
- 最近 CareDecision 和 InteractionResponse。

## 5. CareDecision 输出

```json
{
  "schema_version": "reme-care-decision/v0-experiment",
  "scene_id": "live-camera-001",
  "decision_id": "decision-0007",
  "timestamp_ms": 12800.0,
  "state": "check_in_required",
  "risk_level": 2,
  "privacy_mode": "skeleton_only",
  "need_dialogue": true,
  "dialogue_goal": "confirm_safety",
  "elder_message": "您还好吗？需要我帮您联系家人吗？",
  "family_notification": null,
  "response_timeout_ms": 8000,
  "action": "ask_elder",
  "reason_summary": "检测到异常动作变化，建议确认安全状态。",
  "uncertainty": "medium",
  "fallback_used": false,
  "source": "mimo",
  "visual_context": {
    "sent_to_mimo": true,
    "type": "keyframes",
    "start_ms": 11100.0,
    "end_ms": 12700.0,
    "sample_count": 3
  }
}
```

### 5.1 `state`

```text
normal
observe
check_in_required
family_notification_required
urgent_attention
resolved
degraded
```

### 5.2 `action`

```text
none
observe
ask_elder
notify_family
show_urgent_attention
mark_resolved
```

### 5.3 `source`

```text
rule
mimo
record
degraded
```

C 必须能够只根据这些结构化字段渲染，不解析 `reason_summary` 推断业务状态。

## 6. 实时状态机

```text
normal
  ├─ 正常稳定 → normal
  └─ 轻度异常 → observe

observe
  ├─ 恢复 → normal
  ├─ 证据不足 → observe / degraded
  └─ 异常持续或规则触发 → check_in_required

check_in_required
  ├─ safe → resolved
  ├─ need_help → family_notification_required
  ├─ unclear → 最多一次澄清
  ├─ response_timeout_ms 到期 → family_notification_required
  └─ 输入或决策不可用 → degraded

family_notification_required
  ├─ 风险解除 → resolved
  └─ 风险继续上升或二次超时 → urgent_attention
```

“家属告警”只表示向家属端推送信息，不表示呼叫外部急救或报警服务。

## 7. MiMo 调用原则

MiMo 是事件触发式能力，不是持续视频分析循环。

```text
正常稳定
→ 不调用 MiMo

姿态或转变发生有效变化
→ 确定性规则先评估

需要解释、沟通或进一步判断
→ 调用 MiMo

视觉确有必要
→ 发送最小关键帧或短片段
```

MiMoDecisionAdapter 负责：

- 调用 MiMo API；
- Structured 与 Visual 两条路径；
- 超时和至多一次重试；
- 校验结构化结果；
- 记录延迟、载荷类型、时间窗口和样本数；
- 不维护业务状态机。

## 8. 确定性规则

必须在 MiMo 之外实现：

- 输入不可用时进入 `degraded`；
- 高置信异常转变可触发 `check_in_required`；
- 需要回应时输出 `response_timeout_ms`；
- 超时无回应后通过 `source = rule` 升级家属通知；
- 超时升级不得等待 MiMo；
- MiMo 后到结果不得撤销、降低或推迟已经发出的规则通知；
- MiMo 只能补充解释文本。

当前采用相对 `response_timeout_ms`。未来需要绝对审计截止时间时，增加“墙上时间锚点 + 相对时长”，不替换现有字段。

## 9. InteractionResponse

当前只支持：

```text
safe
need_help
unclear
none
```

来源：

```text
user_input
script
timeout
```

本版不包含自由文本主诉、授权、行动卡或家属确认。

## 10. 传输

- C → B 会话启动、停止和切换：HTTP；
- A → B 感知事件：WebSocket；
- B → C 状态和 CareDecision：WebSocket；
- C → B InteractionResponse：HTTP，并明确返回成功或失败；
- 所有事件使用 RuntimeEvent 包装并校验 `session_id`。

具体URL和框架后续实现时确定。

## 11. 降级与隐私

- MiMo超时或断网不影响A继续输出姿态；
- B返回 `degraded`，C分别显示感知可用与决策不可用；
- 不自动把实时会话切换为预录会话；
- 视觉上下文发送必须符合ADR-0003；
- `visual_context.sent_to_mimo` 必须反映真实行为；
- 不保存无关私人对话；
- 不把内部推理过程暴露给C或日志。

## 12. 性能目标

- MiMo触发后首个合法CareDecision：目标不超过8秒；
- 状态机和确定性规则不等待MiMo即可运行；
- 当前会话事件处理不被旧session污染；
- 完整实时链路连续运行至少10分钟无阻断错误。

这些是目标，必须通过实测报告证明。

## 13. P0任务

1. 实现 RuntimeSessionRequest/Status 接入；
2. 接收带 `session_id` 的 A 感知事件；
3. 实现基础状态机；
4. 实现 InteractionResponse；
5. 接入 Structured MiMo；
6. 接入按需 Visual MiMo；
7. 实现 schema 校验和降级；
8. 实现超时确定性升级；
9. 通过实时10分钟联合测试。

## 14. P1任务

- 生成预录 `recorded_decisions.jsonl`；
- Playback Adapter；
- 比赛具体视频和故事；
- Mock/Record路演兜底；
- 更完整的审计导出。

## 15. 验收标准

- [ ] C可以启动 `live_camera`，B回报真实 `running`；
- [ ] 旧 `session_id` 的感知事件被拒绝；
- [ ] 正常稳定时不持续调用MiMo；
- [ ] 事件触发时可以获得合法CareDecision；
- [ ] 视觉发送记录与真实请求一致；
- [ ] MiMo失败时返回合法degraded；
- [ ] 超时无回应由规则升级，且后到MiMo不能撤销；
- [ ] 连续实时运行10分钟无阻断错误；
- [ ] `recorded_video` 不现场调用MiMo；
- [ ] 输出中不存在牙疼、授权或行动卡强制字段。

## 16. 认知增强层（S10，ADR-0006）

B 内部三层确定性上下文，全部注入 MiMo 提示词并在硬安全界内调制阈值；不改 A/B/C 合同任何字段，C 无需感知：

- **行为语义** `decision/behavior.py`：回看窗口时序特征（体位变化率/静止片段/坐立·躺起转换/主导体位）+ `TransitionEvent.evidence` 休眠超集空间线索（下坠时长/质心下降比/落地残余运动）与跌倒动力学合理性筛查。
- **长期记忆** `decision/memory.py`：分时段（0-23）EWMA 活动基线 + 里程碑事件史（主诉/跌倒/告知/化解），JSON 持久化跨会话；偏离度 ≥1.5 倍才写进提示词。
- **全屋上下文** `decision/home.py`：房间×时刻语义翻转（卫生间 0.5×且 LYING 进关注体位；卧室夜间 3×；夜间其余 0.75×），跌倒规则/超时/隐私档位在调制中原样拷贝。

CLI：`--home-script`（时间线 JSONL，示例 `examples/decision/home_context/night_bathroom.jsonl`）或 `--home-room`+`--local-hour`（静态）；`--memory-file`；`--no-cognition` 一键回退 v1 行为。

大样本实验台 `reme-mimo-experiment`（B spec P1-1）：8 场景 × v1-stock/v2-context 变体，度量 JSON 率/schema 率/期望分支命中/称呼合规/P50/P95，结果落 `results/`。
