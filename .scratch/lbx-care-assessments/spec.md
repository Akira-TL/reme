# 家属端主动关怀判断流规格

- Status: accepted-for-implementation
- Type: frontend + demo-state projection
- Date: 2026-08-09
- Branch: `codex/lbx-care-assessments`
- Merge target: `lbx-frontend`
- Related: ADR-0003, ADR-0005, ADR-0006, `.scratch/lbx-timeline/spec.md`

## 1. 产品目标

把独立时间线从“Relay/采集/运行时变化日志”升级为 Reme 的主动关怀着陆点。家属首先看到的是一条有边界的关怀判断，然后才是判断依据、建议动作和处理进展。

页面主线：

`可靠事件 → 关怀判断 → 判断依据与不确定性 → 建议动作 → 处理进展`

本轮不把 MiMo 包装成姿态模型、医疗诊断或唯一安全裁决者。确定性告警仍服从 ADR-0005；MiMo 只参与解释、沟通和建议，且界面必须显示 `rule / mimo / mock / record / degraded` 的真实来源。

## 2. 当前缺口

运行时 `CareDecision` 已包含：

- `reason_summary`
- `uncertainty`
- `source`
- `action`
- `action_card.suggested_action`
- `visual_context`

但 `reme-demo-state/v1` 只发布 `care.message`。该字段可能来自家属通知、老人端问话或判断摘要，家属端无法区分它们，也无法诚实声明 MiMo 是否使用了视觉上下文。

## 3. 合同决策

新增 `reme-demo-state/v2`，在 `state.care` 中增加必有、可空的 `assessment`：

```json
{
  "verdict": "今天午间活动比平时少，建议先问候确认。",
  "basis": "持续静坐触发轻量关怀事件",
  "uncertainty": "medium",
  "source": "mimo",
  "action": "ask_elder",
  "suggested_action": "已发起问候，等待本人回应",
  "status": "awaiting_response",
  "visual_context": {
    "sent_to_mimo": true,
    "type": "keyframes",
    "sample_count": 2
  }
}
```

边界：

- `assessment` 只投影关怀所需的最小字段；不包含原图、视频、音频、骨架正文或老人对话全文。
- `verdict` 优先使用家属通知，其次使用 `reason_summary`；不得使用老人端问询话术冒充判断。
- `basis` 使用已校验的 `reason_summary`。
- `suggested_action` 优先使用行动卡建议，否则由闭集 `action` 映射成中性动作说明。
- `status` 由 `CareDecision.state` 投影为闭集阶段，不制造“已完成”结果。
- 视觉字段只说明 MiMo 请求是否包含最小关键帧/片段及样本数，不证明模型判断正确。
- v2 是原子升级：Monitor、Relay 与 Viewer 同批更新；Relay 中遗留 v1 状态在新的 v2 状态到达前按不可用处理。

## 4. 时间线信息架构

主时间线只保留：

1. 关怀判断及其阶段变化；
2. 老人授权与事件期隐私结果；
3. 家属确认等处理回执。

场景、采集、运行时和同步变化不再生成独立主卡，只作为每条判断的可展开系统上下文。没有可靠判断时展示诚实空状态，不使用预置生活文案填满页面。

每张判断卡显示：

- 状态标签；
- 一句话关怀判断；
- 判断依据；
- 建议动作；
- 当前处理进展；
- 可展开的来源、不确定性、视觉上下文、状态版本和隐私说明。

## 5. 家庭端导航与 Mock 演示

家庭端底部导航收敛为三项：

1. `家`：合并原首页与看板，承载当前现场、关怀状态、同步摘要和能力可见性；
2. `reme`：取 “remember me / 记住我” 的含义，使用原看板心形图标，承载主动关怀时间线；
3. `设置`：保留隐私与提醒配置。

增加 2026-08-04 至 2026-08-11（首尾均含，共 8 个自然日）的固定 Mock 关怀记录，用于展示跨日信息架构：

- Mock 记录与 live reducer 分离，不进入 Relay、不写数据库；
- 每条都使用 `source = mock_fixture` 与 `assessmentSource = mock`；
- 页面持续显示“非真实家庭历史”说明，展开详情仍可识别 Mock 来源；
- Mock 文案使用“可能、疑似、持续观察”等不确定表达，不制造做饭、睡眠或医疗诊断事实；
- 日期选择上限允许访问 8 月 11 日，即使本机演示时钟早于该日；其后日期仍禁用。

## 6. 验收

- [x] `reme-demo-state/v2` 在 Monitor、Relay、Viewer 三处使用完全一致的闭集校验。
- [x] 非法来源、不确定性、动作、状态或视觉上下文被拒绝。
- [x] 时间线不会把 scene/capture/runtime 变化生成主事件。
- [x] 新 CareDecision 生成一条关怀判断，同一 decision 的 keepalive 不重复。
- [x] MiMo、规则、降级和视觉路径在卡片中有真实来源文案。
- [x] 建议动作与处理进展清晰可见，系统上下文仅在展开后显示。
- [x] 无关怀判断时显示诚实空状态；会话/日期/中断行为保持不变。
- [x] 8 月 4 日至 11 日每天都有明确标注的 Mock 记录，可按日期访问。
- [x] 家庭端底栏为 `家 / reme / 设置`，reme 使用心形图标。
- [x] 原首页与看板内容在 `家` 中合并显示，不再保留独立看板入口。
- [x] 前端测试、lint、build、route-build；Relay 测试与 typecheck 全绿。
- [x] 390×844 与桌面浏览器视觉检查通过，无横向溢出和控制台错误。

## 7. 非目标

- 数据库与跨天持久化；
- 发送或保存新增原始媒体；
- 自动识别“做饭、睡觉、牙疼”等未验证生活或医疗事实；
- 让 MiMo 覆盖确定性告警；
- 把 mock/record 结果标成 live MiMo 判断。
