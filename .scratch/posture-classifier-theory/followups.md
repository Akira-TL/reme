# 对抗复审遗留项（按优先级）

- 日期：2026-08-01
- 来源：12-agent 工作流的两路对抗复审（物理严谨性 / 工程可行性），两路结论均为 `needs_revision`
- 已修：主轴混用、竖直序关系 roll 容差（见 commit `8d91075`）
- 本文件记录**尚未修**的项

## P0 — 接线前必须处理

### F1 影子模式会让 B 的关怀触发器整条失效

`released_classes={"standing"}` 时，B 侧依赖**取值**而非字段的判断全部失效：

- `backend/reme/decision/guardrails.py:31-33` `concern_postures = frozenset({Posture.SITTING})`
  → sitting 永不释放，`detect_concern_trigger`（`guardrails.py:70`）永不成立；
- `backend/reme/decision/home.py:209-215` 在 bathroom 场景加的是 `Posture.LYING`，同理失效；
- 结果：B 被钉死在 OBSERVE。

**结论：现在不要把本分类器接进 live 链路。** live 保持 `StaticPostureModel`，
本分类器只做离线/回放对比，直到补拍数据让其余类别可以释放。
接线前需在 `.scratch/abc-interface/spec.md` 增补"取值层兼容性"一节，
逐条列出 B 对 `posture` 取值的依赖点。

### F2 σ 仍只含随机抖动，缺系统项

当前 `sigma_px` 只来自实测二阶差分 MAD（≈0.0041·H）。`data-reality.md` §6.2 自己写明
该估计**捕捉不到系统性偏差**。`notes/measurement-error.md` §4.3 把总误差定义为
`κ·σ_COCO·S_ref + σ_abs + b(i)`，其中 `b(i)`（髋/膝 30–50 mm ≈ 0.02·H）不随时间平均衰减、
滤波无效——**比当前采用的 σ 还大约 5 倍**。

应改为 `σ_total² = σ_random² + b(i)² + σ_projection(ψ̂)² + σ_gravity(roll_tol)²`，
其中 roll 项已在 `vertical_order_margin` 落地，其余三项待补。
在补齐前，所有 `1.96σ` 判据都比它应有的更自信。

## P1 — 释放其余类别前必须处理

### F3 用 |Δy|/(k·L_ref) 代替投影角，消除方位依赖

`notes/balance-robotics.md` 指出：单目下真正物理正确的倾角估计是
`cosθ = |Δy_img| / (k·L)`——**竖直分量在绕重力轴旋转下不变**，因此该式不依赖方位角，
而当前实现的 `arccos(|v·ĝ|/|v|)` 用的是投影长度，随方位角系统性偏小。
代价是需要每人的 `L_ref`（直立标定段的段长中位数），与 Codex 的
`q_b = L_b(t)/(a_t·L_b,ref)` 前缩门控共用同一套标定量。
这是把"透视会扭曲角度"从"降权"升级为"直接修正"的关键一步。

### F4 lying 的 compactness 门未定义数值

`notes/clinical-posture.md` 的告警值 0.4–0.5 对应的定义是
`max_pairwise_dist / rolling_p90(max_pairwise_dist)`（正常 ≈1.0）。
当前实现的 `*_elongation` 是 `sqrt(major/minor)`，量纲与正常值都不同（直立骨架实测 ≈6.9），
阈值 2.0 是独立猜测，**不能引用来源的 0.4–0.5**。
需补一个沿光轴躺下的合成用例，断言确实触发拒判并给出 `shadow_candidates=["lying"]`。

### F5 尺度参考随深度移动污染

若引入 `S_ref` 类的滚动尺度量，必须绑定"窗口内存在 ≥N 帧独立通过直立性检查"的锚点，
并携带 `s_ref_anchor_age_ms`；人朝相机走近/走远会同向污染所有归一化量。

## P2 — 时序层与外发

### F6 时序层若引入 Viterbi，必须让证据覆盖发出的标签

复审指出：若在 L2/L3 之上再加受约束 Viterbi，则**发出的标签不再是判据产生的**，
而 evidence 只记录 L2/L3，这正是本设计声称要避免的事后合理化换了一层。
两条路选一：只保留 dwell/滞回这类对离散输出的确定性去抖（可回放、可解释），
或显式定义 `log_obs = f(criteria margins)` 并把转移惩罚与
`temporal_override: {frame_verdict, emitted_state, reason}` 写进 evidence。
当前实现**没有时序层**，因此暂不违规；加之前先决定。

### F7 evidence 到 B 的通路会在边界被丢弃

`backend/reme/decision/context.py` 的 `_parse_posture_observation` 不读任何 evidence 键，
`PostureObservation` 只有 8 个字段。要让 B 看到证据，需在该 dataclass 末尾加
`posture_evidence: dict[str, Any] | None = None`（带默认值以免破坏位置构造）并在解析处读取。

### F8 TransitionEvent 的 evidence 键名已被 B 冻结

`backend/reme/decision/behavior.py:35-37` 冻结了
`descent_duration_ms` / `com_drop_ratio` / `post_impact_motion`，
且后两者必须是 [0,1] 比值。将来产出转变事件时必须用这三个名字，
不要新造 `center_height_change` 之类的键。

### F9 posture_runtime 的节流早于 predict

`backend/reme/pose/posture_runtime.py:98-102` 在 `predict_record` **之前**短路返回，
因此 predictor 只能看到 `output_hz`（默认 7.5）的帧。
任何需要逐帧（30 Hz）输入的时序特征都无法在现有 tracker 下满足，
需把节流移到 predict 之后，或加 `ingest_every_frame` 开关。

## 记录：复审对设计稿的一处误报

工程复审核实：设计稿 §8.3/§11.1 声称
`posture_criteria.py:536` 存在 `THRESHOLDS["sitting_thigh_max_deg"]` 的 KeyError——
该键在仓库中的唯一出现就是设计稿自己，实际代码为 `standing_leg_extension_min`。
这条"必须修的第一步"是虚构的。留作提醒：**设计稿对代码的断言同样需要复核**。
