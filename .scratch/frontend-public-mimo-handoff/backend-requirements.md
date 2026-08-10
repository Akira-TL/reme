# Reme 页面完整后端能力：Frontend → Backend / Relay 需求合同

- 发起方：Frontend
- 接收方：Backend / Relay
- 日期：2026-08-10
- 状态：待 Backend / Relay 确认
- 当前前端分支：`origin/lbx-frontend @ 818fb693`
- 既有权威基线：`origin/feature/backend-cloud-demo-authority @ ab7fe54`
- 页面：`https://reme.maniforld.com/family` 中间的 `reme` 标签
- 范围更正：当前产品不增加登录、账户、household member/role 或接收人选择系统；继续沿用现有公开连接、Relay room/session 与固定演示数据范围。
- 数据来源边界：`2026-08-10 12:00 Asia/Shanghai` 前允许明确标注的 `mock_fixture`；该时刻起只允许 Backend / Relay 真实记录，无数据时保持空白。

> 本文把原《公网 MiMo 日摘要需求》扩展为整个 Reme 页的数据与服务需求。
> 它不授权 Frontend 修改 Backend 安全状态机、`FamilyEvent`、告警、
> `MediaAuthorization`、`MediaGrant`、TURN provider 或 Relay authority。

## 1. 结论

Reme 页不是一个“日摘要组件”，而是一份持续形成的家庭记忆投影。当前页面同时展示：

1. 可选择的历史日期；
2. MiMo 本日动态摘要；
3. 当日 24 小时覆盖和三类统计；
4. 人体与空间生活片段；
5. 全屋设备事件；
6. 主动关怀判断；
7. MiMo 发问与本人回应；
8. MiMo 整理后的家庭材料；
9. 隐私安全附件元数据；
10. 接收对象与送达状态；
11. 当前 Relay 会话形成的实时关怀记录。

目前 8 月 10 日中午前的第 1—10 项主要来自 Frontend 固定 Mock，第 11 项只存在于当前 Relay 会话；中午后的页面不得继续用 Mock 填充。
旧 Backend / Relay 合同提供的是“当前权威安全状态”，不是可按日期查询的跨天历史。

因此 Backend 需要新增一个与 `FamilyEvent` 分离的 **Reme History / Memory
Projection**。最小组成是：

- 版本化事件输入；
- 日时间线快照；
- 主动关怀线程；
- 日摘要状态；
- revision 与重连恢复；
- P1 的持久数据库、来源隔离、保留和删除。

### 1.1 后端工作包总览

对后端来说，可拆成八个独立工作包：

1. **Source Adapter**：接收姿态/空间、全屋设备和关怀流程的结构化事件；
2. **Event Normalizer**：统一时间、房间、来源、幂等 ID 和事实边界；
3. **History Store / Projector**：把事件投影为按日可重放的 Reme 时间线；
4. **Proactive Care Engine**：形成个人基线、发现值得问候的偏离、调用 MiMo 并记录依据；
5. **CareThread**：保存判断、发问、回应、材料和处理进展的一问一答链；
6. **Material / Delivery**：生成隐私安全材料，区分 Mock 送达和真实 transport receipt；
7. **MiMo Diary Summary**：按日、按 timeline revision 生成动态摘要；
8. **Family Read API / Realtime**：提供日期索引、日快照、revision 通知与重连恢复。

P0 可以让前 1—3 项在截止点前读取固定 fixture，并在截止点后接当前真实来源；P1 再增加长期数据库。第 4—8 项的合同形状在 P0、P1 应尽量一致，使 Frontend 不需要维护两套页面。

## 2. 哪些能力已经属于旧合同

以下能力以旧交接合同和 `ab7fe54` 为准，本文件不要求 Backend 重新设计：

- Backend autonomous deadline；
- authoritative `FamilyEvent`；
- `reme-viewer-v2` 与最新 `FamilyEvent` 快照；
- `acknowledge_alarm` 与 `confirm_action_card`；
- Backend `MediaAuthorization`；
- Relay `MediaGrant` 与事件期 WebRTC；
- `/api/rtc-config`；
- 多 Viewer 与单 controller lease；
- Home 执行 `privacy_mode`。

Frontend 仍需单独完成这些旧合同的接入；这和本文新增的历史能力是两项工作。

### 2.1 不得复用 FamilyEvent 承担历史

`reme-family-event/v1` 是当前安全状态投影。它不能被扩成日记数据库，因为这样会：

- 把安全 revision 与历史 revision 耦合；
- 让 Mock 历史影响 alarm、action-card 或媒体授权；
- 让日期切换依赖当前 CareDecision；
- 让当前状态和历史记录的删除、保留周期无法分开。

本文要求的 Timeline、CareThread、Material 和 DiarySummary 都是独立合同。

## 3. 当前 Reme UI 与后端能力映射

| Reme UI 区块 | Backend / Relay 需要提供 | 当前状态 |
|---|---|---|
| 8 天日期条 | 可用日期索引、日期状态、家庭时区、来源模式 | Frontend 固定 8 月 4—11 日 |
| MiMo 本日动态摘要 | 服务端调用 MiMo、摘要状态、输入 revision | 浏览器请求本机 `127.0.0.1` |
| 今日 24 小时与统计 | 覆盖完整性、人体/设备/关怀数量 | Frontend 从 Mock 计算 |
| 五时段时间线 | 按日读取的稳定事件快照 | Frontend 固定 Mock |
| 人体与空间行 | 去标识后的结构化生活片段 | Frontend 固定 Mock |
| 全屋设备行 | 设备适配、规范化设备事实 | Frontend 固定 Mock |
| 主动关怀卡 | CareDecision 的历史投影和依据 | 仅当前 FamilyEvent 可用 |
| MiMo 发问 → 本人回应 | 关怀线程和回应状态 | Frontend 固定 Mock |
| 家庭材料卡 | MiMo 整理、事实引用、附件元数据 | Frontend 固定 Mock |
| “已发给女儿” | 接收对象、发送任务、送达/已读回执 | 只有 Mock 文案 |
| 本次会话关怀 | 当前状态转历史的幂等 projector | 浏览器内存，刷新后丢失 |

## 4. 分阶段范围

### 4.1 P0：公开比赛演示（历史 Mock + 截止点后实时）

P0 展示固定历史和真实实时窗口：

```text
dataset_id = reme-aug-2026-demo-v1
date = 2026-08-04 ... 2026-08-11
timezone = Asia/Shanghai
mock_fixture < 2026-08-10T12:00:00+08:00
realtime >= 2026-08-10T12:00:00+08:00
```

P0 的截止点前数据可以使用版本化 JSON fixture，不要求先建立真实家庭数据库，但必须：

- fixture 位于 Backend 所有的版本化数据源中；
- 公网 Family 只能读取，不提交 prompt 或任意历史数据；
- MiMo 只在 Backend 调用；
- 每条日期、关怀、材料和送达状态都携带真实来源；
- 8 月 4—9 日为全天 `mock_fixture`，8 月 10 日仅 00:00—11:59 为 `mock_fixture`；
- 8 月 10 日 12:00 起以及 8 月 11 日只接受 Backend / Relay 实际产生的记录；
- 截止点后没有真实数据时返回空列表或 `partial/unavailable`，不得生成补位 Mock；
- 重启、重复加载和重试幂等；
- 不把 Mock 数据写入当前 `FamilyEvent`。

### 4.2 P1：真实来源与跨天记录

真实跨天 Reme 必须增加：

- 持久数据库；
- 来源设备标识与数据范围隔离；
- 真实姿态/空间事件接入；
- 真实全屋设备适配；
- 数据保留、删除、导出和审计；
- 真实材料附件的隐私处理、短期地址和撤销；
- 真实发送任务和送达回执。

本阶段不新增登录、账户、household member/role 或前端接收人选择。接收目标由 Backend 场景配置并通过 CareThread 投影为只读标签。

### 4.3 P2：当前页面不需要

以下能力以后另开合同，不阻塞当前 Reme 页：

- 本周/月度 AI 复盘；
- 搜索和自然语言问历史；
- APNs / FCM 等离线推送；
- 多家庭共享、医生或机构角色；
- 医疗判断、睡眠判断或情绪判断。

## 5. 目标数据链

```text
本地姿态/空间衍生事件 ─┐
全屋设备事件 ─────────┼→ Backend 事件规范化与幂等写入
CareDecision/回应/回执 ─┘                 ↓
                                  Reme 事件存储
                                        ↓
                    ┌───────────────────┼───────────────────┐
                    ↓                   ↓                   ↓
              日时间线 Projector   CareThread Projector   MiMo 日摘要 Job
                    └───────────────────┼───────────────────┘
                                        ↓
                           Relay HTTPS / Viewer revision
                                        ↓
                                公网 Family / reme
```

Home / Backend 只需向公网发起出站 HTTPS；不能要求家庭网络开放入站端口。

## 6. 新合同 A：可用日期索引

建议接口：

```http
GET /api/family/reme/dates?dataset_id=reme-aug-2026-demo-v1&from=2026-08-04&to=2026-08-11
```

建议返回：

```json
{
  "schema_version": "reme-date-index/v1",
  "dataset_id": "reme-aug-2026-demo-v1",
  "mode": "hybrid",
  "timezone": "Asia/Shanghai",
  "realtime_cutoff_at_ms": 1786334400000,
  "revision": 1,
  "dates": [
    {
      "date": "2026-08-09",
      "source_mode": "mock_fixture",
      "status": "ready",
      "timeline_revision": 3,
      "summary_revision": 3
    },
    {
      "date": "2026-08-10",
      "source_mode": "hybrid",
      "status": "partial",
      "timeline_revision": 4,
      "summary_revision": 4
    },
    {
      "date": "2026-08-11",
      "source_mode": "realtime",
      "status": "partial",
      "timeline_revision": 1,
      "summary_revision": 0
    }
  ]
}
```

日期状态允许：

```text
ready
partial
unavailable
```

要求：

- 日期按家庭时区定义，不能使用访问者浏览器本地时区；
- 不返回未来日期；
- revision 单调递增；
- `source_mode` 只允许 `mock_fixture | hybrid | realtime`；
- `realtime_cutoff_at_ms` 固定为 `1786334400000`，Frontend 不自行猜测边界；
- 只返回当前公开演示或 Relay room/session 配置允许的数据日期。

## 7. 新合同 B：日时间线快照

建议接口：

```http
GET /api/family/reme/day?dataset_id=reme-aug-2026-demo-v1&date=2026-08-09
```

建议顶层结构：

```json
{
  "schema_version": "reme-timeline-day-state/v1",
  "dataset_id": "reme-aug-2026-demo-v1",
  "mode": "hybrid",
  "date": "2026-08-10",
  "timezone": "Asia/Shanghai",
  "realtime_cutoff_at_ms": 1786334400000,
  "revision": 3,
  "updated_at_ms": 1786330200000,
  "status": "partial",
  "coverage": {
    "status": "partial",
    "start_at_ms": 1786291200000,
    "end_at_ms": 1786377599999,
    "observed_hours": 12,
    "missing_intervals": [
      {
        "start_at_ms": 1786334400000,
        "end_at_ms": 1786377599999,
        "reason": "awaiting_realtime"
      }
    ]
  },
  "counts": {
    "total": 17,
    "activity": 9,
    "device": 7,
    "care": 1
  },
  "items": []
}
```

### 7.1 coverage 不能伪造

`complete` 只表示数据源确实覆盖整日。真实设备离线、Runtime 停止或数据缺口必须返回：

```text
partial
unavailable
```

并给出 `missing_intervals`。不能因为 UI 设计为五个时段就声称已经观察 24 小时。
8 月 10 日的 Mock 覆盖最多只能计为 12 小时；截止点后的覆盖必须来自真实来源。

### 7.2 统计口径

- `activity`：人体/空间生活片段数量；
- `device`：全屋设备事实数量；
- `care`：主动关怀线程数量；
- `total = activity + device + care`；
- 回应、材料和送达属于关怀线程内部状态，不重复计入 `care`；
- 一个合并生活片段可携带 `occurrence_count`，统计必须使用同一稳定口径。

## 8. 日时间线 item

顶层 `items` 只允许三类：

```text
activity
device
care_thread
```

每个 item 的 `source.mode` 必须与时间边界一致。`occurred_at_ms >= 1786334400000` 时，
`source.mode=mock_fixture` 必须被 Backend / Relay 拒绝。

Frontend 负责图标、颜色、折叠、筛选和五时段布局；Backend 不发送 CSS tone、图标名或展开状态。

### 8.1 人体与空间 LifeMoment

```json
{
  "event_id": "evt-pose-20260809-1102",
  "kind": "activity",
  "occurred_at_ms": 1786330920000,
  "recorded_at_ms": 1786330921200,
  "room": "kitchen",
  "fact_type": "posture_activity",
  "fact": "灶台与水槽之间出现站立和短距离移动",
  "detail": "只描述姿态和空间变化，不据此判断菜品或进食结果。",
  "occurrence_count": 2,
  "related": [
    {"occurred_at_ms": 1786331100000, "fact": "移动到餐桌附近"}
  ],
  "source": {
    "type": "pose_observation",
    "mode": "mock_fixture",
    "confidence": null
  }
}
```

要求：

- 只持久化粗粒度去标识事件，不持久化逐帧 landmarks；
- 卧姿只能写“卧姿/长时卧姿”，不能直接写“睡着”；
- 站在厨房不能直接写“正在做某道菜”；
- 不从姿态推断身份、情绪、疾病或意图；
- `event_id` 幂等，乱序到达时保留真实 `occurred_at_ms`。

### 8.2 全屋设备 DeviceMoment

```json
{
  "event_id": "evt-device-20260809-fridge-1042",
  "kind": "device",
  "occurred_at_ms": 1786329720000,
  "recorded_at_ms": 1786329720400,
  "room": "kitchen",
  "device": {
    "device_id": "demo-fridge-1",
    "device_type": "refrigerator",
    "capability": "inventory_event"
  },
  "action": "items_removed",
  "value": {
    "items": ["番茄", "鸡蛋"]
  },
  "fact": "冰箱取出番茄和鸡蛋",
  "occurrence_count": 1,
  "source": {
    "type": "smart_home_event",
    "mode": "mock_fixture",
    "adapter": "demo_fixture"
  }
}
```

至少要能规范化以下类别：

- 门锁：出门、回家；
- 灯光：开启、关闭、场景切换；
- 空调：开启、关闭、目标温度；
- 音响：播放、停止、内容类型；
- 冰箱：门开关；只有来源实际提供时才允许记录取出/放入物品；
- 烟机/灶具：开启、关闭、联动场景；
- 热水器：用水/沐浴场景；
- 洗衣机、扫地机器人等运行状态。

禁止把“冰箱门打开”扩写成“取出了番茄”，也不能从烟机开启直接断言已经做饭或吃饭。

同样：

- 单个门锁事件不能证明具体成员已经出门或回家，除非 presence/场景来源能够支持；
- 热水器开启只能证明用水或场景状态，不能单独证明本人已经沐浴；
- 卧室长时卧姿不能单独证明睡眠；
- 能力不足时宁可保留“设备开启/场景启动”，不要生成更具体的生活结论。

### 8.3 主动关怀判断引擎

Reme 卡片中的“比近期习惯更长”“活动间隔拉长”不能由 Frontend 计算。Backend 需要：

1. 按家庭时区和时段维护个人行为基线；
2. 从规范化 LifeMoment 计算候选偏离，例如连续坐姿时长、起身间隔、活动切换次数；
3. 在样本不足时输出 `baseline_unavailable`，不能编造“近期习惯”；
4. 把结构化窗口、基线摘要、设备上下文和当前不确定性送入 MiMo；
5. 严格校验 MiMo 输出，只允许形成非诊断性的说明、问候建议或材料摘要；
6. 把依据窗口、基线版本、模型来源和不确定性写入 CareThread；
7. 高风险安全升级继续由确定性 Backend 规则负责，MiMo 和历史基线都不能撤销告警。

P0 可以使用固定 `mock_baseline`，但必须显式标注。P1 的真实基线依赖持久数据库，并应至少记录：

```text
baseline_version
window_start_at_ms
window_end_at_ms
comparison_period
sample_count
deviation_type
uncertainty
```

当视觉上下文确实有必要时，Backend 可以沿既有隐私 ADR 使用经过选择的最小关键帧或短片调用
MiMo；不能连续上传原画。对 Family / Reme 只投影：

```text
sent_to_mimo
type = keyframes | clip
sample_count / duration
```

不投影关键帧、视频内容或 MiMo 原始 completion。

### 8.4 主动关怀 CareThread

一个关怀线程把“观察 → 判断 → 发问 → 回应 → 整理 → 家庭送达”保存在同一 `thread_id` 下：

```json
{
  "event_id": "care-20260809-1136",
  "kind": "care_thread",
  "thread_id": "thread-20260809-1136",
  "occurred_at_ms": 1786332960000,
  "status": "delivered",
  "assessment": {
    "title": "午饭准备完成，MiMo 邀请把今天的菜分享给女儿",
    "basis": "冰箱、烟机/灶具和匿名姿态形成多源记录；菜名只采用本人确认。",
    "suggested_action": "先询问本人是否愿意分享",
    "uncertainty": "low",
    "source": "mimo",
    "baseline": {
      "version": "mock-baseline-v1",
      "comparison_period": "same_daypart",
      "sample_count": 7
    },
    "visual_context": {
      "sent_to_mimo": false,
      "type": null,
      "sample_count": null
    }
  },
  "check_in": {
    "asked_at_ms": 1786332960000,
    "prompt": "午饭做好了吗？要不要把今天的菜告诉女儿？"
  },
  "response": {
    "received_at_ms": 1786333140000,
    "status": "received",
    "summary": "本人确认菜品并同意分享给女儿。",
    "consent_scope": "family_material_share"
  },
  "material": {
    "material_id": "material-20260809-lunch",
    "status": "ready",
    "label": "今日午饭 · 家庭分享",
    "summary": "本人确认今天准备了两道菜，并同意与女儿分享。",
    "facts": [
      {"event_id": "evt-device-20260809-fridge-1042", "text": "10:42 冰箱取出番茄和鸡蛋"}
    ],
    "attachment": {
      "type": "skeleton_clip",
      "status": "metadata_only",
      "duration_seconds": 18,
      "privacy_mode": "skeleton",
      "asset_id": null
    },
    "generated_by": "mimo"
  },
  "delivery": {
    "recipient_label": "女儿",
    "status": "mock_delivered",
    "delivered_at_ms": 1786333200000,
    "transport_receipt_id": null
  },
  "source": {
    "mode": "mock_fixture"
  }
}
```

允许的线程状态：

```text
observing
asked
responded
material_ready
delivery_pending
delivered
closed
unavailable
```

要求：

- `decision_id` / `thread_id` 幂等关联，不能因刷新重复生成线程；
- 当前 CareDecision 仍以 `FamilyEvent` 为权威；CareThread 只是历史投影；
- 确定性告警、行动卡和普通关怀不能仅靠文案推断；
- MiMo 只生成说明、问候文案和材料摘要，不能改变告警等级；
- 公共 Demo 的回应必须是 Mock，真实公网匿名房间不得出现老人原始逐字对话；
- 没有真实发送任务和 transport receipt 时，生产状态不得写 `delivered`；
- P0 使用 `mock_delivered`，Frontend 必须显示为演示状态。

## 9. 当前会话如何进入历史

Backend 需要一个幂等 History Projector，订阅或读取：

- authoritative FamilyEvent；
- InteractionResponse；
- action-card / alarm acknowledgement；
- MiMo 问候和材料生成结果；
- 送达回执。

Projector 按 `decision_id` / `thread_id` 更新同一 CareThread，并发布新的日时间线 revision。

它不能依赖 Family 浏览器一直打开。浏览器内存中的“本次会话关怀”不是数据库，也不能作为历史事实源。

## 10. 新合同 C：MiMo 本日动态摘要

建议接口：

```http
GET /api/family/diary-summary?dataset_id=reme-aug-2026-demo-v1&date=2026-08-09
```

建议状态：

```json
{
  "schema_version": "reme-diary-summary-state/v1",
  "dataset_id": "reme-aug-2026-demo-v1",
  "mode": "hybrid",
  "date": "2026-08-09",
  "revision": 3,
  "input_timeline_revision": 3,
  "status": "ready",
  "updated_at_ms": 1786333200000,
  "error_code": null,
  "summary": {
    "headline": "上午完成午饭准备与一次家庭分享",
    "summary": "今天的结构化记录覆盖五个时段……",
    "highlights": [
      {"time": "10:42", "text": "从冰箱取出番茄和鸡蛋"},
      {"time": "11:39", "text": "本人同意把今日午饭分享给女儿"}
    ],
    "care_note": "一次主动关怀已收到回应并整理为家庭材料。",
    "uncertainty": "medium",
    "source": "mimo",
    "model": "mimo-v2.5",
    "generated_at_ms": 1786333197000,
    "input_event_count": 38,
    "latency_ms": 9080.4,
    "attempts": 1
  }
}
```

状态允许：

```text
generating
ready
unavailable
```

错误码允许：

```text
mimo_not_configured
mimo_timeout
mimo_upstream_error
mimo_invalid_output
timeline_not_ready
```

### 10.1 动态更新

- 每个规范化 Timeline revision 都可以使摘要失效并触发重算；
- Backend 应对短时间连续事件做 debounce/coalescing，不能按相机帧调用 MiMo；
- `input_timeline_revision` 必须表明摘要实际吸收到了哪一版时间线；
- 旧请求迟到时不能覆盖新 revision；
- 相同规范化输入 hash 应缓存，避免刷新、日期切换重复计费；
- 生成中或失败必须明确展示，不能回退固定 Mock 文案冒充 MiMo；
- 8 月 10 日摘要可以同时吸收截止点前 Mock 与截止点后真实记录，但不得吸收截止点后的 Mock；
- 实时窗口没有事件时允许保持 `unavailable/timeline_not_ready`，不得生成“看起来完整”的摘要；
- P0 只做本日摘要，本周摘要以后使用独立合同。

P0 建议沿用已验证的生成预算：

```text
单次最多 20 秒
每个规范化输入 revision 默认 1 次，不自动重试
```

人工重试或后端策略重试必须产生可观察的新 attempt，并保持幂等缓存键。

### 10.2 MiMo 输出边界

- headline 不超过 40 字；
- summary 不超过 240 字；
- highlights 最多 4 条，时间必须存在于输入事件；
- `care_note` 只描述问候、回应和材料状态；
- 不诊断疾病，不推断情绪、意图、睡眠或健康状态；
- MiMo 结果不能触发、取消或降低确定性告警。

## 11. 新合同 D：实时 revision 与重连

P0 最少需要 HTTP 快照，并提供轻量 revision 通知。建议 Viewer v2 增加：

```json
{
  "type": "reme_day_revision",
  "dataset_id": "reme-aug-2026-demo-v1",
  "date": "2026-08-09",
  "timeline_revision": 4,
  "summary_revision": 3,
  "summary_status": "generating"
}
```

Frontend 收到后重新读取日快照和摘要。Backend / Relay 也可以提供语义等价的 SSE、
ETag 或短轮询合同，但必须给出唯一正式方案。

要求：

- revision 在同一个 `dataset_id + date` 内单调递增；
- 同 revision 同 payload 可幂等重放；
- 同 revision 不同 payload 必须拒绝；
- 重连后可重新获取当前日期快照；
- 历史 revision 不改变当前 `family_event` 或 `demo_state`。

### 11.1 HTTP 共同要求

所有 Reme Family 读响应至少需要：

```text
Content-Type: application/json
Cache-Control: no-store
```

并且：

- P0 CORS 只允许正式 Frontend Origin 和明确的本地开发 Origin；
- 非法日期、dataset 或字段返回 400；
- 日期不存在返回 404；
- 数据源或投影服务不可用返回 503 或合同内 `unavailable`；
- P0 公开读只能访问 allowlist 中的 dataset，并严格执行其 `mock_fixture/hybrid/realtime` 来源边界；
- 本合同不新增登录、账户或成员权限接口。

## 12. Backend 写入与来源适配

具体写入 URL 由 Backend / Relay owner 决定，可以是新的：

```text
POST /api/runtime/reme-event
```

也可以复用现有 `/api/runtime/event` 的明确 envelope。无论采用哪种方式，都必须：

- server-to-server bearer 鉴权，不向浏览器暴露 token；
- exact schema 校验；
- `event_id` 幂等；
- 接受有限乱序并区分 `occurred_at_ms` 与 `recorded_at_ms`；
- 拒绝未来时间、超大字段、未知 source 和原始媒体；
- 不依赖 Home / Monitor 先创建 room session；
- 不把 timeline 写入作为安全状态推进条件。

### 12.1 P0 Fixture loader

Backend 需要：

1. 加载 `reme-aug-2026-demo-v1`；
2. 只加载 8 月 4 日至 8 月 10 日 11:59 的 Mock fixture；
3. 为 8 月 10 日 12:00 后与 8 月 11 日接受真实投影，未收到时保持空白；
4. 产生 8 个日期的 TimelineDayState，并正确标记 `mock_fixture/hybrid/realtime`；
5. 仅为已有输入的日期生成或读取 MiMo 摘要缓存；
6. 提供案例 2 的完整 CareThread；
7. 重复启动不冲突、不重复计费。

Frontend 可以在合同冻结后，把当前结构化 Mock 导出为独立 JSON；Backend 运行时不能导入 Frontend JS。

### 12.2 P1 真实来源

至少需要三类 adapter：

- 姿态/空间衍生事件 adapter；
- 全屋设备事件 adapter；
- CareDecision/InteractionResponse/ack projector。

设备 adapter 应保持厂商协议与 Reme 规范事件解耦。本文不声称已经接入米家，也不要求
Frontend 直接调用家居设备 API。

## 13. 数据库与存储

### 13.1 P0

截止点前的固定公开演示可以使用只读 JSON fixture + 摘要缓存，不强制数据库；截止点后的实时记录可沿用当前 Relay/session 存储能力，不得回写成 fixture。

### 13.2 P1

真实跨天 Reme 必须有持久数据库。数据库产品由 Backend owner 选择；从能力上至少需要：

- source device 与 source health；
- 规范化 event；
- 日时间线 revision / snapshot；
- care thread 与 response；
- material 与 attachment metadata；
- delivery task / receipt；
- diary summary state；
- audit、retention、deletion tombstone。

要求：

- dataset / source 范围隔离；
- event 唯一键和幂等约束；
- 时间索引与日期索引；
- 可执行按 dataset/日期删除；
- 删除后缓存、摘要和材料引用同步失效；
- 不把 raw video、raw audio、逐帧 skeleton 或 MiMo prompt 当作普通历史持久化。

## 14. 材料附件与送达

### 14.1 P0

- 截止点前只提供 `metadata_only` 的匿名骨架短片元数据；
- 不生成、上传或伪造真实视频 URL；
- `mock_delivered` 明确表示演示，不等于真实送达回执。
- 截止点后没有真实附件或 receipt 时，材料/送达状态保持为空或 unavailable，不能复制历史 Mock。

### 14.2 P1

如需真实“18 秒匿名骨架片段”，Backend 还需要单独完成：

- 本地去标识渲染；
- 明确授权与素材来源记录；
- 加密对象存储；
- 短期签名 URL；
- TTL、撤销、删除和访问审计。

这和当前事件期 `MediaGrant` 不同：MediaGrant 是实时、短期 WebRTC 权限；历史材料是持久资产，
必须另有 ADR 和保留政策。

真实“发给女儿”还需要 Backend 预配置接收目标、发送任务和 transport receipt。旧合同明确没有离线 Push，
因此 P0 不能把 UI 文案当成真实消息送达能力。

## 15. 禁止进入 Relay / 公网 Frontend 的数据

```text
MIMO_API_KEY
MiMo system prompt / 原始 completion
camera frame / JPEG / base64 image
raw video / raw audio
逐帧 MoveNet landmarks / skeleton history
完整原始对话或老人真实逐字原话
模型内部 debug payload
真实家庭身份或设备密钥
```

Relay 只保存或转发严格校验后的最小 Reme 状态。

## 16. Frontend 负责什么

Backend 合同确认后，Frontend 只负责：

- 日期选择、五时段布局、折叠和筛选；
- 图标、颜色、文案层级和响应式设计；
- 严格解析 DateIndex、TimelineDayState、CareThread 和 DiarySummaryState；
- 对 revision、日期、字段闭集和状态做校验；
- 展示 loading / partial / unavailable / stale；
- 明确展示 Mock → realtime 截止点和每条记录的来源；
- 显示 Mock、隐私和非诊断披露；
- 通过旧权威合同处理当前 FamilyEvent、告警、行动卡和事件期视频。

Frontend 不负责：

- 调用 MiMo 或持有 MiMo key；
- 把姿态推断成做饭、睡觉、疾病或意图；
- 从设备门开关猜测物品；
- 创建历史事实、送达回执或媒体授权；
- 在 localStorage 冒充家庭数据库；
- 修改 Backend / Relay authority。

## 17. P0 验收

### 17.1 公网页面

- 家庭网络之外打开 `https://reme.maniforld.com/family` 可读取 8 月 4—11 日；
- 每日日期、统计、五时段和事件都由 Backend / Relay 读取，不再从 Frontend bundle 固定生成；
- 8 月 4—9 日为完整 Mock 展示；8 月 10 日上午为 Mock、12:00 后为实时；8 月 11 日只显示实时；
- 实时窗口没有事件时明确留空，不宣称覆盖人体/空间、设备或关怀三类；
- 8 月 9 日包含“做饭 → 发问 → 本人同意 → 材料 → Mock 送达女儿”完整线程；
- 日摘要随 Timeline revision 更新；
- 页面刷新、断线重连和日期切换不会丢失快照；
- 浏览器不存在 `127.0.0.1:8770`、MiMo API 或设备 API 请求。

### 17.2 数据边界

- 截止点前的 P0 历史明确为 `mock_fixture`，截止点后不得出现任何 `mock_fixture`；
- summary、timeline、material 不改变 alarm、action-card、Authorization 或 MediaGrant；
- Relay 拒绝额外字段、倒退 revision、prompt、raw media 和未知来源；
- MiMo 不可用时返回明确 unavailable，不生成固定替代摘要；
- 无真实 asset 时附件只能是 `metadata_only`；
- 无真实 receipt 时送达只能是 `mock_delivered`；
- Backend 重启与重复 fixture 加载幂等。

## 18. 请 Backend / Relay owner 回填

请确认：

1. DateIndex 最终 URL 与 schema；
2. TimelineDayState 最终 URL 与 schema；
3. DiarySummaryState 最终 URL 与 schema；
4. revision 通知采用 WebSocket、SSE、ETag 还是短轮询；
5. Backend 写入 URL 和 envelope；
6. P0 fixture 文件位置、loader 命令和数据版本；
7. MiMo 生成任务、缓存和限流策略；
8. CareThread 如何由当前权威事件投影；
9. P0 材料附件是否确认只做 metadata；
10. P0 送达是否确认只做 `mock_delivered`；
11. 公网部署需要的非前端环境变量；
12. 可供 Frontend 联调的分支、提交和测试地址；
13. P1 是否接受“真实历史必须有数据库、来源隔离和删除策略，但不新增账户系统”的边界。
14. 是否接受固定截止点 `1786334400000` 以及 `mock_fixture | hybrid | realtime` 三种来源模式。

Frontend 收到这些回填后，再开始接口接入；不会先在 `lbx-frontend` 中实现另一套 Backend、Relay
或数据库逻辑。
