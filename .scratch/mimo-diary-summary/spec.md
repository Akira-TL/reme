# MiMo 本日动态摘要（实验）

> 公网接入说明（2026-08-09）：本文件中的
> `POST http://127.0.0.1:8770/api/diary/summary` 仅是本机实验接口，
> 不属于公网 Family 合同。`/family` 不得在访问者浏览器继续调用该地址，
> 也不得把 MiMo 代理逻辑加入 Relay。公网所需的 Backend / Relay 合同需求
> 见 `../frontend-public-mimo-handoff/backend-requirements.md`；合同确认前，
> Frontend 只保留失败可见状态，不自建服务端替代方案。

## 假设

把选中日期内已经形成的结构化生活事件一次性提交给真实 MiMo，可以稳定返回一份短、事实化、可校验的日记摘要；失败时前端明确显示不可用，不使用本地 Mock 文案冒充模型结果。

## 边界

- 浏览器不持有 `MIMO_API_KEY`；请求经过本地统一后端。
- 输入仅允许日期、时刻、片段类型、时段和简短描述，不接收图片、音频、视频、人物身份或任意扩展字段。
- 输出采用 `reme-diary-summary/v0-experiment`，字段闭集为标题、摘要、重点片段、关怀备注和不确定性。
- 模型只做事实整理，不诊断、不推断情绪或意图、不影响确定性安全规则。
- `live` 模式使用真实 MiMo；`mock` / `record` 模式不生成替代摘要。

## 请求

`POST /api/diary/summary`

```json
{
  "schema_version": "reme-diary-summary-request/v0-experiment",
  "date": "2026-08-09",
  "events": [
    {
      "time": "07:12",
      "kind": "activity",
      "period": "清晨",
      "description": "从床边起身"
    }
  ]
}
```

## 返回

```json
{
  "schema_version": "reme-diary-summary/v0-experiment",
  "date": "2026-08-09",
  "headline": "上午节奏平稳，期间完成一次主动问候",
  "summary": "……",
  "highlights": [{"time": "10:08", "text": "本人回应正在听广播"}],
  "care_note": "一次主动关怀已收到回应。",
  "uncertainty": "medium",
  "source": "mimo",
  "model": "mimo-v2.5",
  "generated_at_ms": 0,
  "input_event_count": 20,
  "latency_ms": 0,
  "attempts": 1
}
```

## 验收

1. 单元测试证明请求拒绝原始媒体和额外字段，模型输出严格校验。
2. 服务端路由在未配置/模型失败时返回显式错误，不回退 Mock。
3. 前端日期或事件集合变化时重新请求，并呈现 loading/live/unavailable 状态。
4. 真实 API 冒烟记录模型、延迟、输入条数与结构校验结果，但不记录密钥。

## 2026-08-09 真实冒烟

- 模型：`mimo-v2.5`
- 输入：6 条结构化生活事件，无媒体
- 结果：返回 `reme-diary-summary/v0-experiment`，严格解析通过，4 个重点片段均带合法时间
- 首轮：默认 8 秒单次预算连续超时
- 复测：单次 25 秒预算下 9.08 秒成功
- 落地：日记摘要使用单次 20 秒预算、无自动重试；不改变安全决策和危险确认链路的既有预算
