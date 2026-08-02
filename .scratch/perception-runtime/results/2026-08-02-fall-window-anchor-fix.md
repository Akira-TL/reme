# 2026-08-02 · 跌倒规则候选的运动锚定复评——修复长前奏漏报（发现 2 闭环）

- 背景：`2026-08-02-a-to-b-local-link.md` 发现 2。`TransitionDetector` 的 `short_window` 信号用**整个缓冲区跨度**（`evidence.duration_ms`）与 `fall_max_duration_ms=1400` 比较，而滑窗按 `window_ms=3200` 修剪、从场景开始/上一事件清空后累积。连续运行时缓冲常驻 ~3.2s，`short_window` 恒不成立：站几秒再摔的真实跌倒五信号只剩四个，落到 `uncertain_transition`（姿态上下文被长窗稀释时）或 `normal_transition`（姿态干净时）。
- 修复：`backend/reme/pose/transitions.py` 增加**运动锚定复评**（motion-anchored rescue）。第一遍全窗分类逐比特不变；当结果非 `fall_like_transition` 时，把评估窗口重新锚定在 settle 打破处再判一次跌倒假设。
- 结论：站立前奏 0.6s/2s/4s 的同一跌倒序列现在都产出 `fall_like_transition`，置信度**逐位相同**（0.808335）；慢速躺下不受影响。阈值与置信度公式零改动，B 侧 `fall_confidence_min` 锚定按构造保持。

## 机理与方案

`_motion_anchored_window()`（纯函数，确定性）：

1. 对缓冲内相邻样本对算 `_pair_speed`，以 `min_motion_speed * 0.5 = 0.09` 为静默阈值——与 `_is_settled` 的 unknown-motion 回退判据同源，无新配置项；
2. 从尾部反向扫：跳过尾部静默段（躺定确认帧），聚合最近一段运动突发（内部静默 < `settle_ms=200` 不打断），直到遇到时长 ≥ `settle_ms` 的静默段——其末样本即 **settle 打破处（锚点）**；
3. 子窗 = [锚点前 ≤ `settle_ms` 的静默上下文 … 最新样本]，保证 start 段仍描述动作前状态（posture_before/start_center）；
4. `motion_duration_ms` = 突发本身跨度（首个运动对起点 → 末个运动对终点），**不含**上下文和落定尾巴——尾巴长短是姿态流节奏噪声（5Hz 更新 + settle 确认），不是转变时长。

`_rescue_fall()` 在子窗证据上用与第一遍**完全相同**的五信号判据（`_fall_signals`，单一来源抽取）与置信度公式（`_fall_confidence`），仅 `short_window` 改用 `motion_duration_ms`。五信号全成立才改判 fall_like；事件 `start_ms/end_ms` 取子窗边界，`evidence.reasons` 追加 `motion_anchored_window` 标记、`evidence.motion_duration_ms` 记录突发时长（B 的 `context.py` 对 evidence 是自由字典，安全）。

误报防线不变：慢速转变即使被锚定，子窗内 `rapid_center_drop ≥0.20` + `high_keypoint_speed ≥0.65` 也不可能同时成立（慢动作把位移摊薄在长时间上）；全窗几何未变时子窗峰速 ≤ 全窗峰速 < 0.18，rescue 结构上不可能触发。

## 实测证据

单元回归（`tests/test_pose_transitions.py` 新增，先红后绿）：

- `test_fall_after_long_standing_prelude_is_fall_like`：站 2s→摔 0.4s→躺。修复前实跑 `normal_transition`（四信号成立唯缺 short_window），修复后 `fall_like_transition`，事件锚定 `start_ms=1700`（settle 打破 1900ms 减一个 settle_ms 上下文）、`motion_duration_ms=400`；
- `test_slow_lying_down_after_long_prelude_is_not_fall`：站 2s→慢躺 2.5s，rescue 不误报（运动跨度 2600ms > 1400 被自身时长否决）。

进程内实况重放（真 `LandmarkFrameEngine`：GeometricPostureModel + RealtimePostureTracker + TransitionDetector，与 runtime_server 同序，10fps，e2e 同款骨架）：

| 场景 | 修复前（发现 2 实测） | 修复后 |
|---|---|---|
| 前奏 0.6s + 摔 0.4s | fall_like 0.808 | fall_like **0.808335**（原路径，reasons 无锚定标记——第一遍行为逐比特保持） |
| 前奏 2.0s + 摔 0.4s | uncertain 0.35 | fall_like **0.808335**（rescue，span 1700→2800，motion 400ms） |
| 前奏 4.0s + 摔 0.4s | （推论漏报） | fall_like **0.808335**（rescue——对前奏长度不变） |
| 前奏 2s + 慢躺 3s | normal | normal 0.77（rescue 未触发） |

全量验证：pytest 560 项全通过（含 `tests/test_danger_link_e2e.py` 六跳链路）；改动文件 ruff/`ruff format`/mypy strict 全净。

## B 侧联动评估（fall_confidence_min 锚定）

`guardrails.py::FALL_LIKE_CONFIDENCE_FLOOR = 0.55` 钉在 A 置信度公式的解析下界。本修复：

- 公式常数（0.55/0.12/0.12/0.08）与门限（`fall_center_drop`/`fall_peak_speed`/`fall_torso_change_deg`/`fall_max_duration_ms`/`min_visible_keypoint_ratio`）**零改动**——rescue 复用同一 `_fall_confidence`，输出仍恒在 [0.55, 0.87]，下界锚定按构造保持，B 无需重标定；
- 经验上 rescue 事件与年轻缓冲事件置信度逐位一致（同一跌倒 0.808335），产出分布不漂移；
- `transitions.py::_fall_confidence` 已加注释指回 guardrails 的锚定，防止未来改公式时漏联动。
- 顺带发现：`docs/references/cognition-evidence.md:292` 仍写 0.59 下界（假设 r ≥ 0.5），guardrails.py 已依 Codex 的 r=0 反例修正为 0.55——文档滞后，需单独同步（不属本 diff）。

## MIL 时序模型定位（fall-transition-training）

规则修复与 MIL 不是二选一：规则仍是实时链路唯一的候选生成器（MIL v3 当前定位是"保守候选确认器"，尚未接入实时）。本修复消除的是**结构性时序盲区**（漏报窗口），MIL 要补的是**语义辨别力**（真摔 vs 快速主动躺倒/坐倒——规则五信号对"扑到床上"这类快速受控动作本就无法区分，年轻缓冲下同样会报 fall_like，这不是本修复引入的新误报面）。MIL 接入时机不受影响。

## 演示编排注意

- `examples/integration/ab_live_debug.py` 新增 `--fall-prelude`（默认 0.6 与 e2e 同节奏）；`--fall-prelude 2.0` 即长前奏回归复现，不必再改代码；
- 编排上不再需要"动作起点紧贴场景开始"；`scene_signal`（switch）重置缓冲仍可作为演示兜底手段保留；
- 残余边界（均为原规则语义内的限制，不是回归）：① 运动突发本身 >1400ms 的慢速跌倒仍不判 fall（`fall_max_duration_ms` 语义如此，现在量的是真转变时长，比旧行为只宽不严）；② 摔后持续躁动（pair 速度 ≥0.09 超过 1.4s 才落定）会把突发拉长而漏判；③ 前一事件 `cooldown_ms=1600` 内的跌倒仍被冷却抑制。这三类交给 MIL/人工复核路径。

## 复现

```bash
# 单元回归
uv run --extra dev python -m pytest tests/test_pose_transitions.py tests/test_danger_link_e2e.py -q

# 实链路（A/B 起服后）：长前奏跌倒应产出 fall_like 且 B 走危险链路
.venv/bin/python examples/integration/ab_live_debug.py --fall-prelude 2.0
```
