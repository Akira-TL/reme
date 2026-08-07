# Reme → Miloco 最小紧急事件接入

> 核实日期：2026-08-07  
> 范围：只允许 Reme 向 OpenClaw/Miloco 单向发布已经完成安全决策的紧急事件。

## 1. 冻结边界

Reme 是安全判断的唯一事实源。Miloco 不参与摄像头感知、姿态判断、跌倒判断、模型评分或普通生活状态判断。

第一版只允许以下两个 `CareDecision.state` 出域：

- `family_notification_required`
- `urgent_attention`

以下状态一律不发布：

- `normal`
- `observe`
- `check_in_required`
- `consent_required`
- `resolved`
- `degraded`

Miloco 不获得 Reme 的任何查询接口；Reme 不新增 `/status`、`/history`、`/camera`、骨架或姿态查询端点。

## 2. 出域合同

唯一允许发送的 JSON 字段：

```json
{
  "schema_version": "reme-emergency-event/v1",
  "event_id": "reme-<opaque-id>",
  "type": "family_intervention_required | urgent_attention",
  "severity": "high | critical",
  "summary": "固定的最小行动摘要",
  "occurred_at": "RFC3339 UTC timestamp"
}
```

禁止发送：

- `scene_id` / 房间或场景详情；
- JPEG、视频、音频或 ASR 原文；
- 17 点骨架、姿态类别、transition/fall 内部证据；
- `risk_level`、模型概率、MIL 分数、uncertainty；
- `reason_summary`、`family_notification`、`action_card`、`visual_context`；
- 普通行为历史、长期生活状态和任何完整 `CareDecision.to_payload()`。

`event_id` 由 Reme 内部场景标识、decision id 与 decision timestamp 派生为 opaque id；这些内部字段本身不会出域。

## 3. 入口选择

### 默认：OpenClaw inbound hook

使用专用 mapping，例如：

```text
POST /hooks/reme-emergency
Authorization: Bearer <dedicated-hooks-token>
Content-Type: application/json
```

OpenClaw 当前正式 hook 配置支持独立 `hooks.token`、`allowedAgentIds` 和 `hooks.mappings`。mapped agent hook 的 HTTP `200` 表示 Agent runner 已被接纳，不表示完整 Agent 任务已经执行完成；`409/502/503` 属于 admission/pre-run 失败语义。

Reme 只对明确的 `409/502/503` 做有界重试。网络超时或连接中断的投递结果可能不确定，因此不会自动重发，避免同一紧急动作执行两次。

### 不作为默认入口：Miloco `/miloco/webhook`

Miloco 当前插件确实注册：

```text
POST /miloco/webhook
```

但该 route 使用 `auth: "gateway"`，而 `agent` action 会同步等待 subagent 完成，默认等待可达 180 秒；此外 route 会把完整 `payload` 写入日志。它适合 Miloco 自身后端协作，不适合成为 Reme 安全状态机旁路的默认外部入口。

因此 Reme 不使用 Gateway token，也不把 Miloco 自带 webhook 作为 v1 默认合同。

## 4. OpenClaw 建议配置

在实际 Miloco/OpenClaw 主机上配置独立 hook。`<miloco-agent-id>` 必须替换为实际加载 Miloco 插件能力的 Agent ID，并用 `allowedAgentIds` 限死。

```json5
{
  hooks: {
    enabled: true,
    token: "<dedicated-reme-hook-token>",
    path: "/hooks",
    allowRequestSessionKey: false,
    allowedAgentIds: ["<miloco-agent-id>"],
    mappings: [
      {
        match: { path: "reme-emergency" },
        action: "agent",
        agentId: "<miloco-agent-id>",
        name: "Reme Emergency",
        sessionMode: "isolated",
        wakeMode: "now",
        deliver: false,
        messageTemplate: "Reme external emergency event. event_id={{event_id}}; type={{type}}; severity={{severity}}; occurred_at={{occurred_at}}; summary={{summary}}. Treat this as an already-decided emergency signal. Execute only the configured family notification or emergency automation. Do not request camera frames, skeletons, pose data, model scores, voice transcripts, or normal-life state from Reme."
      }
    ]
  }
}
```

建议继续在 OpenClaw 侧使用专门的 agent/tool policy，只保留紧急通知和必要的家庭设备执行能力；不要给该入口额外的 Reme 数据读取工具。

## 5. Reme 配置

Reme 只读取两个专用环境变量：

```bash
REME_MILOCO_WEBHOOK_URL=http://127.0.0.1:18789/hooks/reme-emergency
REME_MILOCO_WEBHOOK_TOKEN=<dedicated-reme-hook-token>
```

不要配置或复用 `OPENCLAW_GATEWAY_TOKEN` 给 Reme。

两个变量都未设置时，Miloco 集成关闭；只设置其中一个时，Reme 会打印告警并禁用 Miloco 集成，但本地 Decision Runtime 仍正常启动。

## 6. 运行时结构

```text
perception
   ↓
posture / transition / fall
   ↓
decision state machine
   ↓
CareDecision
   ├─→ RuntimeDecisionPublisher → C / WebSocket
   └─→ EmergencyDecisionPublisher → bounded queue → OpenClaw hook → Miloco
```

外部 HTTP 永远不在 DecisionService 的同步安全路径中执行。Miloco 超时、5xx、认证错误或下线都不能回滚或降低 Reme 的本地告警结果。

## 7. 当前实现文件

```text
backend/reme/runtime/integrations/
  emergency.py
  miloco.py
```

接线点：

- `backend/reme/runtime/decision/runtime_glue.py`
- `backend/reme/runtime/decision/config.py`
- `backend/reme/runtime/decision/server.py`

测试：

- `tests/test_emergency_integration.py`
- `tests/test_miloco_integration.py`

## 8. 当前外部依据

- Miloco 主仓库：https://github.com/XiaoMi/xiaomi-miloco
- Miloco OpenClaw webhook route：`plugins/openclaw/src/webhooks/index.ts`
- Miloco Agent webhook：`plugins/openclaw/src/webhooks/agent.ts`
- OpenClaw Hooks configuration reference：https://docs.openclaw.ai/gateway/configuration-reference

这些外部接口会变化；后续升级 Miloco/OpenClaw 版本时，应重新核实 hook 认证、admission 返回语义和 mapping 配置。
