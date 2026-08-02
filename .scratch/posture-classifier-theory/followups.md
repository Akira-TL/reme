# 对抗复审遗留项（按优先级）

- 日期：2026-08-01
- 来源：12-agent 工作流的两路对抗复审（物理严谨性 / 工程可行性），两路结论均为 `needs_revision`
- 已修：主轴混用、竖直序关系 roll 容差（commit `8d91075`）；σ 系统偏差项（见下方 F2）
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

### F2 σ 仍只含随机抖动，缺系统项 — **已修**

当前 `sigma_px` 只来自实测二阶差分 MAD（≈0.0041·H）。`data-reality.md` §6.2 自己写明
该估计**捕捉不到系统性偏差**。`notes/measurement-error.md` §4.3 把总误差定义为
`κ·σ_COCO·S_ref + σ_abs + b(i)`，其中 `b(i)`（髋/膝 30–50 mm ≈ 0.02·H）不随时间平均衰减、
滤波无效——**比当前采用的 σ 还大约 5 倍**。

已实现 `UncertaintyModel`（`backend/reme/pose/biomech.py`）：

```
σ(i)² = random(i)² + absolute² + bias(i)²
```

- `random`：本项目实测抖动（0.0041·H），可滤、随时间平均衰减；
- `absolute`：热图栅格下限。MoveNet Lightning 解码 48×48 热图，但整图坐标下的值
  取决于生产者是否做了 tracking crop，而 FrameLandmarks 不报告这一点——
  **保持为 0 而不是编一个数**，待接口缺口补上；
- `bias(i)`：Needham et al. 2021（Sci Rep 11:20673, doi:10.1038/s41598-021-00212-x）
  实测髋/膝 30–50 mm（≈0.02·H）、踝 1–15 mm，归因于训练集里髋关节中心的大规模误标。
  髋膝踝直接用文献值锚定，其余关节按 COCO OKS σ 相对比例外推（已在代码注释标明是外推）。

**为什么这一项必须加**：本项目实测抖动把髋排为核心关节里最"稳"的（0.83–1.12 px），
而 COCO 标注 σ 把髋排为最差（.107）、Needham 又实测髋的系统偏差最大。
三者并不矛盾——**一个被稳定地放错位置的髋，在时间差分下恰恰是安静的**，
所以二阶差分估计器对最大的那一项误差在结构上是盲的。

实测影响（真实 2370 帧）：

| | 髋 σ | standing | unknown |
|---|---|---|---|
| 仅抖动 | 1.19 px | 98.7% | 30 |
| 抖动+系统偏差 | **5.94 px** | **94.2%** | **137** |

多出来的 107 帧拒判，正是此前"未曾挣得"的置信度。

顺带修复一个同源缺陷：体尺度原按**竖直**跨度估计，坐/躺时跨度变小 → σ 变小 →
**人一躺下反而更自信**。改为核心骨架的最大点对距离（姿态不变、且排除手臂伸展的影响）。

保守取舍：把不同关键点的 bias 当作独立项在平方和里相加。若偏差是整具骨架的共模位移，
它在任何两点之差中会抵消，因此当前做法**高估**而非低估不确定度——对关怀系统是安全方向。
待验证集可用时应改为标定共模/差模分量。

仍待补：`σ_projection(ψ̂)`（出平面前缩引入的角度偏差，需先做 F3 的每人标定）。

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

### F6 时序层若引入 Viterbi，必须让证据覆盖发出的标签 — **已建（走确定性方案）**

复审指出：若在 L2/L3 之上再加受约束 Viterbi，则**发出的标签不再是判据产生的**，
而 evidence 只记录 L2/L3，这正是本设计声称要避免的事后合理化换了一层。
两条路选一：只保留 dwell/滞回这类对离散输出的确定性去抖（可回放、可解释），
或显式定义 `log_obs = f(criteria margins)` 并把转移惩罚与
`temporal_override: {frame_verdict, emitted_state, reason}` 写进 evidence。
**已选 (a) 确定性方案**，实现于 `backend/reme/pose/posture_temporal.py`：

- 只做两件读者可手工复算的事：让变更**等待**（最小驻留 + 滞回），以及**拒绝**
  身体做不到的变更（standing↔lying 无单帧直达路径）；
- 不引入 Viterbi。理由有二：(1) 全序列 argmax 会让发出的标签不再由判据产生，
  而 evidence 只记 L2/L3，读者按证据复算会得到与实际发出不同的答案——正是本设计
  拒绝的事后合理化换层；(2) Viterbi 需要逐类观测对数似然，而判据层产出的是带
  不确定度的裕度、明确不是概率，没有标定数据可据以诚实构造 log_obs。
- **证据覆盖发出的标签**：每条 `TemporalVerdict` 同时记录 `posture`（发出）、
  `frame_posture`（本帧判据结论）、`overridden` 与 `override_reason`（哪条规则导致差异），
  payload 内嵌完整 `frame_evidence`。

实测（真实 2370 帧，默认驻留 167 ms = 30 FPS 下 5 帧）：

| 驻留 | 标签翻转 | standing | unknown |
|---|---|---|---|
| 0 ms（等价直通） | 120 | 2233 | 137 |
| 100 ms | 21 | 2226 | 144 |
| **167 ms（默认）** | **5** | **2335** | **35** |
| 333 ms | 1 | 2360 | 10 |

`dwell=0` 与原始序列**逐帧完全一致**，证明该层除驻留参数外不改变任何东西。

设计要点与边界：
- 驻留以**感知时间毫秒**计，不以帧数计——输入 30 Hz 而输出 5–10 Hz，实时与回放帧率不同；
- 姿态**时长从候选首次出现起算**，驻留不计入该姿态自身时长；
- 时钟回退与超过 `max_gap_ms` 的断流触发状态重置，重置后先 `unknown` 再重新建立；
- 冷启动先 `unknown`，直到姿态真正持住一个驻留；
- standing↔lying 的禁令**只禁直接释放，不永久拒绝**：中间强制插入 `unknown`
  （实测约 233 ms），持续证据最终仍会胜出——否则人真的倒地时会被永远否认；
- 驻留只编码**顺序约束与时间下界**，不编码"时长即语义"：受控转移与跌倒下降相时长重叠
  （1.1–1.5 s vs 583±255 ms，+1.6σ 已达 1.0 s），区分二者需速度峰形，属尚未建立的更上层。

**仍需预算的代价**：167 ms 驻留给每次姿态变更增加最多 167 ms 延迟。它落在合同的
500 ms 姿态标签 P95 预算内，但必须计入；且它延迟的是安全相关信号，与 ADR-0005 的
确定性升级时钟相互作用，接线时需专门核对而非默认继承。

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
