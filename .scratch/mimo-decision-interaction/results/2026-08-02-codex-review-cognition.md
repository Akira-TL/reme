# Codex 异构对抗复审 · 认知增强批次处置记录

- 复审范围：9624bdf..6e12ea0（S10 骨架→四泳道→收口接线→实验），Codex session `019fbe61-bbcc-7bb2-8b60-273b24686864`
- 结论：4 P1 / 16 P2 → **15 项已修，5 项文档化接受**
- 修复提交：`54851f7`（新增回归测试 12 个，套件全绿 + mypy strict + ruff 清）

## 已修（本轮提交）

| Finding | 修法 |
|---|---|
| P1 记忆持久化在决策路径/服务锁内做文件 IO（慢盘拖住跌倒决策与全场景升级） | `BehaviorMemoryStore(persist_async=True)`：变更同步只改内存，落盘交给单一有序守护写线程（合并到最新快照）；生产构造启用，测试保持同步语义 |
| P1 home provider 抛异常打断确定性升级；cognition off 仍查询 | `_home_context` 硬错误边界（任何异常→默认上下文+stderr，决策不可被上下文失败打断）；cognition off 不查询；**response 路径彻底脱钩**（超时升级只消费不可调制的 timeout 字段，直接用基线配置） |
| P1 evidence 巨整数 `float()` OverflowError 炸掉合法问候 | `_finite_number` 捕获 OverflowError/ValueError 按缺失处理 |
| P1 记忆文件坏 UTF-8 绕过损坏处理炸构造 | `_load_state` 捕 `UnicodeError` 与 OSError 同路归"从空启动" |
| P2 STILL↔LOW 抖动计入躁动（纯静息窗可到 1.0） | motion flip 改按低/活动/未知**带**翻转计数（`_motion_band`） |
| P2 携入 posture_duration 超窗（20s 窗报 999s 静止） | 片段时长夹到 `window_ms` |
| P2 全未检出窗口以"零活动"入基线 | `dominant_posture is None`（⟺无检出观察）时跳过 observe |
| P2 基线载入收 NaN/Infinity/布尔时刻/小数样本数 | 严格类型（非布尔整数）+ isfinite + 非负校验，违者按损坏从空启动；事件 recorded_at_s 同样拒非有限 |
| P2 home 时间线 NaN/inf from_ms 穿过校验（NaN 段可全时段命中） | `_parse_from_ms` 与 provider 构造均加 `math.isfinite` |
| P2 `--home-script` 与 `--memory-file` 同路径（记忆落盘覆写脚本） | resolve 后相等即 `ServerConfigError` |
| P2 `--no-cognition` 仍构造记忆库/加载脚本（一键回退可被坏文件卡死） | cognition off 时完全不触碰认知文件，provider/store 均为 None |
| P2 记忆/环境文本可携带换行+【标签】注入提示词结构 | `_sanitize_section`：空白折叠 + 300 字封顶（标题与内容都过） |
| P2 实验台 v2 不走生产 `context_aware`/注入顺序 | `_system_prompt_for`/`_user_content_for` 改走生产 `build_system_prompt(context_aware=…)` + `build_user_prompt(context_sections=…)`；**v2 全格已用生产路径重跑**（见 2026-08-02-experiment-v2rerun/） |
| P2 传输失败 0ms 与真实测量按数值区分（真 0ms 被丢弃） | 传输失败标 `latency_ms=NaN`（无测量），分位按 isfinite 选取 |
| P2 重复 `--variant` 翻倍成本且报表掩盖 | 选择去重（保序取首现） |

## 文档化接受

| Finding | 接受理由 |
|---|---|
| P2 窗口边界前驱不参与相邻计数（边界坐→站丢一次计数） | 窗口自含语义是刻意设计；5-10Hz 采样下单对边界样本影响可忽略 |
| P2 observe 先于 deviation 折叠（1.6× 被压到 ~1.36×） | 偏差方向是**少提**而非误报，与"宁缺毋滥"同向；演示尺度接受 |
| P2 observe 跨线程乱序折叠 EWMA | 节流预留正确，乱序仅影响 EWMA 收敛路径；单人演示场景不可现 |
| P2 provider 在阈值调制与提示词组装间被查询两次 | 我方两个 provider 均为时间戳纯函数（static/scripted），快照一致性由确定性保证；约定 provider 必须按时间戳确定 |
| P2 appellation 分母排除 elder_message 缺失样本 | 生产侧骨架模板兜底保证有话可说；实验指标只测"说了的话是否合规"，缺话率另行观察 |
