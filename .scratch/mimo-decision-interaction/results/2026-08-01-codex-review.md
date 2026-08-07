# Codex 异构对抗复审 · 处置记录

- 复审范围：b-decision 分支前 7 提交（3d8fd37..a5b87cf），Codex session `019fbda6-1ed0-7d93-bec8-e83d0fc1ffec`
- 结论：0 P0 / 7 P1 / 6 P2；本记录对应修复提交见 git log（复审后一并修复）
- 复审确认无误的关键点：超时升级不调 MiMo、规则升级后迟到结果被丢弃、MimoProposal 无 action/state 白名单、degraded 不覆盖已提交告警、授权前置、澄清一次上限

## 处置表

| # | Finding | 处置 |
|---|---|---|
| P1-1 | 非 MONITORING 阶段新跌倒被吞 | ✅ 修复：`_fall_preempts` 抢占检查置于 phase 短路之前；可抢占集合 = MONITORING/CONCERN 询问/授权等待/RESOLVED（重开新事件）；`handled_fall_event_id` 防同事件重触发；家属告警态不降级不抢占 |
| P1-2 | response×source 交叉白名单缺口（timeout 可伪造授权、family_input 可代答） | ✅ 修复：records 层全交叉白名单——timeout 只能 none、family_input 只能 card_confirmed、老人应答（含 consent）只能 user_input/script |
| P1-3 | reset 后 generation ABA | ✅ 修复：runtime 增加 epoch，reset 递增；CAS 快照为 (epoch, session) |
| P1-4 | 无发射 tick 不失效在途 MiMo + high-water 回写 | ✅ 修复：CAS 改为会话对象值比较（任何真实变迁都使在途失效）；幂等复用 tick 不再写会话（轮询不误杀在途调用，专测锁定） |
| P1-5 | 无 single-flight，并发重复 MiMo | ⚠️ 接受：会话值比较 CAS 已把并发结果收敛为一致（后到者返回 pending），代价仅为偶发一次多余 API 调用；48h 单人演示不做合并机制 |
| P1-6 | record/audit 同步写失败阻断已提交决策 | ✅ 修复：两处写盘 OSError 捕获降级为 stderr 警告，不阻断 CareDecision 返回 |
| P1-7 | 行动卡引语可被 MiMo 伪造 + 无主诉进授权流 | ✅ 修复：`_bind_elder_quote` 服务端强制以 session 内老人原话覆写 elder_quote（缓存与出站两处）；need_help 无 text 先澄清一次、再无主诉走通用家属提醒，不再让 MiMo 凭空造卡 |
| P2-1 | degraded 写入录制流卡死回放 | ✅ 修复：record 捕获跳过 degraded |
| P2-2 | 转移表漏格（授权 unclear / urgent need_help） | ✅ 修复：授权 unclear 复问一次后保守关闭；urgent need_help 维持 urgent 返回当前决策 |
| P2-3 | record 回放忽略 decision_id | ✅ 修复：回放推进前校验 decision_id，错配 409 stale_decision |
| P2-4 | urllib 超时语义 + 4xx 盲重试 | ✅ 修复：单调总截止预算（timeout×attempts），每次尝试用剩余额度；仅 429/5xx/网络类重试，其余 4xx 立即失败 |
| P2-5 | schema 失败不消耗重试 | ✅ 修复：HTTP 成功但 proposal 非法时整次重问一次再降级（B spec §8.4） |
| P2-6 | VisualContext 矛盾数据 + 审计缺视觉元数据 | ✅/⚠️ 部分：records 校验补 sample_count must-be-null；审计仍为布尔 + note（完整视觉元数据字段化留待联调期，audit 是 artifacts 内部件不影响合同） |

## 修复后的验证

全套件 148 测试绿（新增 17 个针对上述 finding 的回归测试）、mypy strict、ruff 全清。抢占/ABA/轮询三条并发路径均有专测锁定。
