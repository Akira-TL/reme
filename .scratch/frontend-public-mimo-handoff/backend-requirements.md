# Reme 公网 MiMo 日摘要：前端向 Backend / Relay 的合同需求

- 发起方：Frontend
- 接收方：Backend / Relay
- 日期：2026-08-09
- 状态：待 Backend / Relay 确认
- 对齐基线：`origin/feature/backend-cloud-demo-authority @ ab7fe54`

> 这是一份接口需求，不授权前端修改 Backend 安全状态机、
> `FamilyEvent`、媒体授权、TURN provider 或 Relay authority。

## 1. 问题

正式页面运行在：

```text
https://reme.maniforld.com/family
```

当前“MiMo 本日动态摘要”仍由 Family 浏览器请求：

```text
http://127.0.0.1:8770/api/diary/summary
```

在异地手机或任意公网设备上，`127.0.0.1` 指向访问者自己的设备，
因此页面必然显示“MiMo 未连接”。Family 浏览器也不应直接持有
`MIMO_API_KEY` 或访问小米 MiMo API。

## 2. 目标链路

期望链路：

```text
Home 侧 Local Runtime / Backend
  ↓ 结构化生活事件或固定 Demo fixture
Backend 调用 MiMo
  ↓ 严格校验后的最小摘要结果
Relay
  ↓ HTTPS / reme-viewer-v2
公网 Family Viewer
```

要求：

1. MiMo 调用和密钥只存在于 Backend。
2. Family 只读取 Relay 中已经形成的摘要状态，不向 MiMo 发请求。
3. Home / Backend 只需向外发起 HTTPS，不要求开放家庭网络入站端口。
4. 日摘要是独立合同，不加入现有 `reme-family-event/v1`。
5. 既有 `FamilyEvent`、告警、行动卡、`MediaAuthorization` 和
   `MediaGrant` 语义保持不变。

## 3. P0 数据边界：只支持公开 Mock 演示

当前固定公开房间没有家庭身份认证，也没有真实跨天历史数据库。
因此 P0 只允许处理下列数据集：

```text
dataset_id = reme-aug-2026-demo-v1
mode = mock_fixture
date = 2026-08-04 ... 2026-08-11
```

Backend 应拥有或加载这套固定 Demo fixture，并在服务端生成摘要。
前端不会把真实家庭生活记录提交到公开接口。

真实家庭跨天摘要需要另行完成：

- 家庭身份与成员授权；
- 数据来源、保留与删除策略；
- MiMo 数据外发同意与审计；
- 分页历史 API；
- household 级隔离。

这些不属于本次 P0。

## 4. 为什么不能复用 FamilyEvent

`reme-family-event/v1` 是当前安全状态的 Backend 权威投影，包含告警、
行动卡、隐私模式和媒体授权。日摘要是日期维度、可反复更新的记忆投影，
生命周期和权威用途不同。

将日摘要塞进 FamilyEvent 会造成：

- 安全 revision 与日记 revision 相互耦合；
- 日期切换依赖当前 CareDecision；
- Mock 历史影响实时告警状态；
- Relay 无法明确执行按日期快照与回放。

因此请求新增独立的 `DiarySummaryState` 合同。

## 5. 前端需要的最小读合同

### 5.1 HTTP 快照

建议接口：

```http
GET /api/family/diary-summary?dataset_id=reme-aug-2026-demo-v1&date=2026-08-09
Origin: https://reme.maniforld.com
```

Frontend 也接受 Backend / Relay 提供语义等价的最终路由，但需要在交接时
给出唯一正式 URL。

成功返回：

```json
{
  "schema_version": "reme-diary-summary-state/v1",
  "dataset_id": "reme-aug-2026-demo-v1",
  "mode": "mock_fixture",
  "date": "2026-08-09",
  "revision": 3,
  "status": "ready",
  "updated_at_ms": 1786330200000,
  "error_code": null,
  "summary": {
    "headline": "上午完成做饭与一次主动问候",
    "summary": "……",
    "highlights": [
      {"time": "10:42", "text": "从冰箱取出番茄、鸡蛋和生菜"},
      {"time": "11:39", "text": "本人同意把今天的菜分享给女儿"}
    ],
    "care_note": "一次主动关怀已收到回应。",
    "uncertainty": "medium",
    "source": "mimo",
    "model": "mimo-v2.5",
    "generated_at_ms": 1786330197000,
    "input_event_count": 38,
    "latency_ms": 9080.4,
    "attempts": 1
  }
}
```

生成中：

```json
{
  "schema_version": "reme-diary-summary-state/v1",
  "dataset_id": "reme-aug-2026-demo-v1",
  "mode": "mock_fixture",
  "date": "2026-08-09",
  "revision": 2,
  "status": "generating",
  "updated_at_ms": 1786330187000,
  "error_code": null,
  "summary": null
}
```

不可用：

```json
{
  "schema_version": "reme-diary-summary-state/v1",
  "dataset_id": "reme-aug-2026-demo-v1",
  "mode": "mock_fixture",
  "date": "2026-08-09",
  "revision": 2,
  "status": "unavailable",
  "updated_at_ms": 1786330200000,
  "error_code": "mimo_timeout",
  "summary": null
}
```

允许的 `status`：

```text
generating
ready
unavailable
```

允许的 `error_code`：

```text
mimo_not_configured
mimo_timeout
mimo_upstream_error
mimo_invalid_output
```

当该日期从未生成时，HTTP 可以返回：

```http
404 diary_summary_not_available
```

所有响应需要：

```text
Cache-Control: no-store
```

### 5.2 Viewer 实时更新

建议 `reme-viewer-v2` 增加独立消息：

```json
{
  "type": "diary_summary",
  "room_session_id": "room-xxx",
  "state": {
    "schema_version": "reme-diary-summary-state/v1",
    "dataset_id": "reme-aug-2026-demo-v1",
    "mode": "mock_fixture",
    "date": "2026-08-09",
    "revision": 3,
    "status": "ready",
    "updated_at_ms": 1786330200000,
    "error_code": null,
    "summary": {
      "headline": "上午完成做饭与一次主动问候",
      "summary": "……",
      "highlights": [
        {"time": "11:39", "text": "本人同意把今天的菜分享给女儿"}
      ],
      "care_note": "一次主动关怀已收到回应。",
      "uncertainty": "medium",
      "source": "mimo",
      "model": "mimo-v2.5",
      "generated_at_ms": 1786330197000,
      "input_event_count": 38,
      "latency_ms": 9080.4,
      "attempts": 1
    }
  }
}
```

要求：

- revision 在同一个 `dataset_id + date` 内单调递增；
- 相同 revision 的相同 payload 可幂等重放；
- 相同 revision 的不同 payload 必须拒绝；
- Viewer 重连后可通过 HTTP 重新取得选中日期快照；
- 日摘要消息不改变当前 `family_event` 或 `demo_state`。

如果 Relay 更适合只提供 HTTP 快照，P0 可以不做 WebSocket 广播；但每次
摘要更新后，前端必须能通过一个轻量、只读、无密钥的方式获知新 revision。

## 6. Backend → Relay 写入需求

具体写入路由由 Backend / Relay owner 决定。建议二选一：

```text
POST /api/runtime/diary-summary
```

或在现有：

```text
POST /api/runtime/event
```

中增加有明确 envelope 的新 event type。

无论采用哪种方式，都必须：

- 复用 server-to-server runtime ingest 鉴权，不向浏览器暴露 token；
- 严格校验 exact schema、字段长度、日期和 revision；
- 只持久化最小摘要状态，不持久化 MiMo prompt 或输入事件全文；
- 不依赖 Home 页面先创建 room session；
- 失败时不覆盖更高 revision 的已就绪结果；
- Backend 重试必须幂等。

## 7. MiMo 生成约束

Backend 需要继续遵守现有 MiMo 实验边界：

- 只提交服务端拥有的结构化 Demo fixture；
- 不提交 camera frame、JPEG、原始视频、原始音频或可识别人物数据；
- 输出必须严格 JSON 校验；
- headline 不超过 40 字；
- summary 不超过 240 字；
- highlights 最多 4 条；
- highlight 时间必须真实存在于输入事件；
- `care_note` 只描述问候是否发起、是否收到回应；
- 不诊断疾病，不推断情绪、意图、睡眠或健康状态；
- MiMo 结果不能改变或取消 Backend 确定性告警。

已有真实冒烟显示单次响应约 9 秒，因此建议保留现有日摘要预算：

```text
20 秒单次超时
不自动重试
```

Backend 应按规范化输入 hash 缓存相同请求，避免日期切换和页面刷新重复
消耗 MiMo 额度；缓存和限流策略由 Backend owner 决定，前端不实现。

## 8. 禁止进入 Relay / 浏览器的数据

下列数据不得出现在 HTTP 读响应、Viewer 消息、日志或前端 bundle：

```text
MIMO_API_KEY
MiMo prompt / system prompt
MiMo 原始 completion
结构化输入事件全文
camera frame / JPEG / base64 image
raw video / raw audio
MoveNet landmarks / skeleton history
模型内部 debug payload
老人原话或真实家庭身份信息
```

Relay 只保存严格校验后的 `DiarySummaryState`。

## 9. Demo 数据准备

为了让 8 月 4—11 日在公网立即可演示，Backend 需要提供一种服务端启动方式：

1. 加载 `reme-aug-2026-demo-v1` 固定 fixture；
2. 为 8 个日期生成或读取已缓存的真实 MiMo 摘要；
3. 发布每个日期的 ready / unavailable 状态到 Relay；
4. 重复启动不会产生 revision 冲突或重复计费。

前端不会调用“开始生成”或提交任意 prompt；公开 Family Viewer 只读。

当前 UI fixture 的事实源在：

```text
origin/lbx-frontend @ c452ff5b
frontend/src/shared-demo/familyTimelineMock.js
frontend/src/shared-demo/familyTimelineMimoSummary.js
```

Backend 不应在运行时导入前端 JS。合同确认后，Frontend 可以将这两处数据
冻结导出为独立、版本化的 `reme-aug-2026-demo-v1.json`，供 Backend fixture
loader 使用；JSON 内容仍只包含显式 Mock 的结构化事件。

## 10. Frontend 承诺的接入范围

Backend / Relay 确认合同后，Frontend 只做：

1. 删除 Family 对 `127.0.0.1:8770/api/diary/summary` 的调用；
2. 通过正式 Relay URL 读取选中日期的 `DiarySummaryState`；
3. 对字段闭集、revision、日期和状态做严格解析；
4. 映射 `generating / ready / unavailable` UI；
5. invalid/stale payload 保持失败可见，不回退固定文案冒充 MiMo；
6. 保留“Mock / 非真实家庭历史”披露；
7. 保持统计筛选和 Mock 时间线不影响实时 `FamilyEvent`；
8. 不修改 Backend、Relay、TURN 或权威业务逻辑。

## 11. Backend / Relay 验收条件

### 公网行为

- 在家庭网络之外打开 `https://reme.maniforld.com/family`，8 个日期均能读取
  ready 或明确 unavailable 的摘要状态；
- 浏览器 Network 中不存在 `127.0.0.1:8770` 和小米 MiMo API 请求；
- 浏览器 bundle、响应和日志中不存在 MiMo 密钥；
- 刷新和 Viewer 重连后仍能恢复选中日期快照；
- 同一日期产生新摘要时 revision 严格递增。

### 合同与边界

- `reme-viewer-v2` 和 `reme-family-event/v1` 既有测试保持通过；
- 日摘要不能触发 alarm、action-card 或 media grant；
- Relay 拒绝额外字段、非法日期、倒退 revision 和 prompt/raw-media 字段；
- MiMo 不可用或输出非法时返回明确状态，不生成 Mock 替代摘要；
- 匿名公开房间只处理 `mock_fixture`，不接真实家庭历史。

## 12. 请 Backend / Relay owner 回填

请在实现前确认以下内容：

1. 最终 HTTP 读 URL；
2. 是否提供 WebSocket `diary_summary` 消息；
3. Backend → Relay 最终写入 URL 与 envelope；
4. `DiarySummaryState` schema 是否按本文件冻结；
5. 8 日 Demo fixture 的服务端来源和启动命令；
6. 公网部署所需的非前端环境变量名称；
7. 可供 Frontend 联调的分支、提交和测试地址。

前端收到这 7 项后再开始接入，不会在 `lbx-frontend` 中先造另一套
Backend / Relay 实现。
