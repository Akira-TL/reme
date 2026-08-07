# 可解释生物力学姿态分类器 —— 实现规格（SPEC）

- Type: design-spec（实现者照此写代码，不应再做设计决策）
- Date: 2026-08-01
- Owner: D（数据处理），交付物落在 `backend/reme/pose/`，服务 A 任务票 `.scratch/pose-classification-owner-a/issues/03-build-geometric-posture-baseline.md`
- 理论依据：`.scratch/posture-classifier-theory/notes/*.md`（7 篇，已逐篇读完）
- 数据事实：`.scratch/posture-classifier-theory/data-reality.md`
- 验证协议：`.scratch/posture-classifier-theory/validation-protocol.md`
- 接口合同：`.scratch/abc-interface/spec.md`（跨角色字段的唯一正式来源）

---

## 0 阅读顺序与本文的三条硬承诺

实现者按 §1 → §8 → §2 → §3 → §4 → §5–7 → §9–10 的顺序读。§8 是模块清单与函数签名，§2 是判据本体。

本规格自我约束三条，任何违反都视为缺陷：

1. **凡单目 2D 拿不到的量，命名里必须带 `_proxy` / `_norm` / `_like`，且在输出的 `not_observable` 里逐条列名。** 禁止出现裸的 `com` / `cop` / `zmp` / `mos` / `grf` / `velocity_mps`。
2. **每个阈值必须携带 `provenance ∈ {literature, derived, measured, pending_calibration, assumed}` 与 `source` 文本。** 没有 provenance 的数字不允许出现在判据里（CI 守卫见 §10.6）。
3. **证据不足即 `unknown`。** `unknown` 是一等标签，不是兜底；它有自己的原因码、自己的驻留时间、自己的评测指标。

---

## 1 接受什么数据（输入契约）

### 1.1 主输入：A 的 FrameLandmarks

唯一合法 `schema_version` = `"movenet-17/v0-experiment"`（`backend/reme/pose/scene_bundle.py:15`）。record 9 字段、keypoint 4 字段，定义见 `backend/reme/pose/movenet.py:43-51` 与 `camera.py:234-244`。

本分类器**同时接受两种记录形状**（`data-reality.md` §5 已实测存在分歧）：

| 字段 | 当前形状（camera/video_dataset 写出） | legacy 形状（`.scratch/.../data/movenet17-real-2370.jsonl`） | 本分类器的处置 |
|---|---|---|---|
| schema 键 | `schema_version` | `schema` | 两者都读；都缺 → `InputContractError` |
| 检出标志 | `person_detected` | `torso_detected` | 两者都读；都缺 → `InputContractError` |
| `scene_id` | 有 | 无 | 缺失时由调用方显式传入，**不得**默认成常量字符串 |
| `landmark_quality` | 有 | 无 | 缺失时按 `CORE_KEYPOINT_NAMES` 8 点自行推导（`scene_bundle.py:346-363` 同款逻辑），**不得**默认 `usable` |
| `coordinate_space` | 恒 `normalized_image_top_left` | 无 | 不等于该常量 → `InputContractError`；缺失时按该常量处理并记 `assumed` |
| `smoothed` | 恒 `false` | 无 | `true` 且未携带滤波带宽 → **时序头拒判**（静态头放行），见 §2.5.7 |
| `keypoints` | 17 项，含 `name` | 17 项，含 `name` | 顺序必须严格等于 `MOVENET_KEYPOINT_NAMES`，否则 `InputContractError` |

未知的额外键一律忽略（前向兼容；`context.py` 对 posture payload 已是这个先例）。

### 1.2 第二输入：ImageGeometry（**必须显式提供，不得猜**）

`FrameLandmarks` 不携带图像宽高，而 `x_norm` 按宽归一化、`y_norm` 按高归一化，因此**直接在归一化坐标上算角度是静默的系统性错误**：16:9 下真实 45° 会算成 29.4°，4:3 下最大畸变 8.21°、16:9 下 16.26°（`clinical-posture.md` §3.1；`monocular-geometry.md` §4.0；`skeleton-posture-sota.md` §4.0）。

**本设计不把这件事当阻塞项，因为宽高在两条构造路径上都已经可得**：

| 路径 | 宽高来源 | `size_provenance` |
|---|---|---|
| 预录 bundle | `manifest.media.width` / `manifest.media.height`（`scene_bundle.py:394-395`，`_validate_manifest_media` 已强制为正整数） | `"measured"` |
| 实时摄像头 | `CameraConfig.width/height`（`camera.py:29-30`）或 `LiveMoveNetStream` 的 `CAP_PROP_FRAME_WIDTH/HEIGHT`（`camera.py:133-134`） | `"measured"` |
| 裸 JSONL 无上下文 | 调用方显式传入 | `"assumed"` |

**硬规则**：`size_provenance == "assumed"` 时，所有角度类判据降级——只允许**同轴比值型**判据参与释放标签（`com_height_norm`、`leg_extension`、`vertical_order_margin`、`stance_width_norm`），角度类量照常计算但只写进 `evidence.quantities` 且标 `support="inconclusive"`。理由：同轴比值对各向异性缩放免疫（`balance-robotics.md` §3.0-P3）。

仍然**建议**（非阻塞）请 A 在 `FrameLandmarks` 增补 `image_width_px` / `image_height_px`，让裸 JSONL 自描述。

### 1.3 第三输入：SceneCalibration（每 `scene_id` 一份）

```
gravity: (gx, gy) 单位向量 + provenance    # 图像 y 轴不是重力（monocular-geometry §2.2 论断 D/G）
thresholds: dict[str, Threshold]           # §2.3 的全部决策边界
tau_kp: float                              # 关键点 score 门限
tau_cov: float                             # mass_coverage 门限
fingerprint: SceneFingerprint              # 漂移监控，§2.5.8
```

**未标定的 scene 不得复用别的 scene 的阈值。** 未提供 SceneCalibration 时使用 `DEFAULT_CALIBRATION`，其中每个阈值的 provenance 都是 `pending_calibration`，并且 `released_classes` 只含 `{"standing"}`（`data-reality.md`：本项目只有 standing 的真实人体素材）。

### 1.4 容错矩阵（逐种异常的确定性行为）

| 异常 | 判定 | 行为 | 出处 |
|---|---|---|---|
| `person_detected=false` | 硬门 G0 | `unknown`，`abstain_reason="no_person_detected"`，冻结 dwell 计时与滤波缓冲 | `temporal-estimation.md` §4.5 Layer 0 |
| `landmark_quality="unavailable"` | 硬门 G0 | 同上，`abstain_reason="landmark_quality_unavailable"` | 同上 |
| 关键点 `x_norm`/`y_norm` 为 `None` | 输入契约缺口 | 该点 `usable=False`；**不得** `float(None)`（`posture.py:192-198` 现有 bug 的规避）；若核心 4 点有 None → `unknown` | `scene_bundle.py:482-498` 允许 None |
| `score > 0` 且坐标恰为 `(0,0)` | 上游 bug | 整帧 `landmark_quality→unavailable`，`abstain_reason="upstream_zero_coordinate"` | `monocular-geometry.md` §4.8 C6 |
| 低置信点（`score < tau_kp`） | 掩码传播 | 该点不参与任何几何量；**不得**填 0、不得取最近邻、不得用上一帧 | `monocular-geometry.md` §2.6 论断 R |
| 缺点导致某量无法计算 | 局部不可用 | 该 `Quantity` 返回 `None` → 依赖它的 `Criterion.support = "inconclusive"`，并进 `unavailable_features` | `posture_criteria.py:157-167` 已实现 |
| `mass_coverage < tau_cov` | 硬门 G2 | `unknown`，`abstain_reason="mass_coverage_below_threshold"` | `com-anthropometry.md` §4.4 |
| 时间戳**倒退** | 时间轴异常 | 单帧回退 ≤ `REWIND_TOLERANCE_MS`（3000.0，对齐 `guardrails.py:36`）→ 丢弃该帧并记 `dropped_out_of_order`；超过 → 整个时序状态机 `reset()`，不生成 TransitionEvent | `time_semantics` R5；`state_machine.py:251-252` |
| 时间戳**重复**（同一 `timestamp_ms`） | 重复帧 | 保留首条，后续丢弃并计数；不得两次推进 dwell | `stream.py:184-190` 非降序约定 |
| `frame_index` 跳跃但时间戳连续 | 正常（离线抽帧按 `sample_every` 跳） | 忽略 `frame_index` 的连续性，**一切时序运算只用 `timestamp_ms`** | `input_contract`：两处 `frame_index` 语义不一致 |
| 时间跳变（gap ≥ `N_GAP` 帧 ≈ 167 ms） | gap | gap 期间输出 `unknown`；滤波缓冲**冻结不推进**，dwell **暂停** | `temporal-estimation.md` §4.7 |
| gap 时长 < `T_RESET`（1.0 s） | 短 gap | 恢复状态机，但该次切换强制标 `uncertain_transition` | 同上 |
| gap 时长 ≥ `T_RESET` | 长 gap | **完全重置**滤波器与状态机；重置后第一个静态标签**不产生 TransitionEvent** | 同上（防止捏造一次不存在的转移） |
| 帧率异常（Δt 落在 [20, 60] ms 之外） | 采样异常 | 时序头拒判该窗口；静态头放行 | `temporal-estimation.md` §4.3 阶段 0 |
| 任一关键点贴图像边界（`≤ε` 或 `≥1-ε`，ε=0.005） | 出画 | 该点 `usable=False`；核心点出画 → `unknown` | `balance-robotics.md` §4.4 第 5 条 |

---

## 2 判断当前姿态（分层设计）

```
FrameLandmarks(dict)
   │
   ├─ L0  SceneContext：ImageGeometry / GravityCalibration / ScaleTracker / SceneFingerprint
   │        └─ 输出：像素空间坐标 + 每点 σ_px + 参考尺度 S_ref + 重力单位向量 g
   │
   ├─ L1  Biomechanics：18 个具名物理量，每个带 σ、单位、provenance、失效条件
   │        （backend/reme/pose/biomech.py）
   │
   ├─ L2  Criteria：每类的物理判据集，判据 = 不确定度感知的 (量, 比较, 阈值) 三元组
   │        （backend/reme/pose/posture_criteria.py）
   │
   ├─ L3  Fusion & Abstention：exactly-one-class + 冲突处理 + 8 道门 + 影子模式
   │        （backend/reme/pose/posture_criteria.py）
   │
   └─ L4  Temporal：重采样 → 中值 → SG → 受约束 Viterbi → 滞回/驻留 → 转变分类
            （backend/reme/pose/posture_temporal.py）
```

**内部一律以输入帧率（30 Hz）计算特征与状态机，只把决策降采样到 5–10 Hz 输出。绝不先降采样再算特征。** 依据：跌倒下降相 583 ± 255 ms，30 FPS 下 17.5 帧、10 Hz 下 5.8 帧、5 Hz 下 2.9 帧（`clinical-posture.md` §4.5；`balance-robotics.md` §3.5 推论 3）。现有 `RealtimePostureTracker` 的节流（`posture_runtime.py:97-102`）会**跳过非 emit 帧不调用 predictor**——这对静态头无害，但会摧毁时序头，因此 §2.5 的时序管线**必须由分类器自己维护 30 Hz 缓冲**，见 §8.4 的 `ingest_frame()` / `emit_if_due()` 双方法设计。

### 2.1 L0 场景层：三个必须先定下来的东西

#### 2.1.1 像素空间还原（等比）

```
u_i = x_norm_i * W_px
v_i = y_norm_i * H_px      # v 轴向下
```
即直接乘回像素。这与 `biomech.py:272-273` 现有实现一致，也等价于 `u = x_norm·(W/H), v = y_norm`（差一个全局缩放，不影响角度与比值）。**单元测试必须包含：合成一条已知 45° 的线，断言算出 45° ± 1°**（`skeleton-posture-sota.md` §6.3）。

#### 2.1.2 重力方向 `g`（每 scene 常数，不是图像 y 轴）

- 默认 `g = (0, 1)`，`gravity_provenance = "assumed"`。
- 标定方式（按优先级）：(a) 装机时人工确认一条铅垂线；(b) 该 scene 下大量**已确认直立**帧的躯干主轴方向的圆中位数；(c) 不标定 → 保持 `assumed`，并在所有角度阈值上加 `roll_tol` 保护带（默认 5°）。
- **禁止**：用"站立人群躯干方向众数"作为独立标定（循环论证，`monocular-geometry.md` §2.2 落地建议第 2 条）——它只能作**一致性监控**：长期众数偏离假定竖直超 `roll_tol` → 报 `scene_drift`。

#### 2.1.3 参考尺度 `S_ref`（上包络，不是中位数）

几何事实：弱透视下投影**只会缩短不会拉长**，故观测尺度的**上分位数**才是真实体尺的无偏估计（`measurement-error.md` §4.2(b)；`balance-robotics.md` §3.4）。

```python
class ScaleTracker:
    """Rolling upper-envelope estimate of the person's projected body scale."""

    def __init__(self, *, window_ms: float = 8000.0, quantile: float = 0.9,
                 min_samples: int = 30) -> None: ...
    def update(self, timestamp_ms: float, frame: FrameGeometry) -> None: ...
    @property
    def s_ref_px(self) -> float | None: ...           # None ⇒ 不可信 ⇒ 该帧 unknown
    @property
    def provenance(self) -> Provenance: ...           # "measured" | "pending_calibration"
    def fingerprint(self) -> SceneFingerprint: ...
```

- 单帧尺度 `S_frame = 2·sqrt(Σ_k w_k‖p_k − c‖² / Σ_k w_k)`，k 取 `{5,6,11,12}` 中 usable 的点（≥3 个），`w_k = 1/σ_COCO(k)²`。正面站立时理论值 ≈ 0.366·H（`measurement-error.md` §4.2(a)）。
- `S_ref = Q90(S_frame over window_ms)`，窗口内样本 < `min_samples` → `s_ref_px = None`。
- **失效条件**：整个窗口内人都在躺/深蹲 ⇒ 上分位数严重低估 ⇒ 所有归一化量爆表。处置：`s_ref_px is None` → `unknown`，**不要猜**（`balance-robotics.md` §3.4）。
- `window_ms` 与 `quantile` 是**待校准参数**（建议起点 3–10 s / 0.9）。

### 2.2 L1 几何层：18 个物理量

每个量都是一个 `Quantity(name, value, sigma, unit, provenance, note)`（`biomech.py:110-146` 已定义）。表中"性质"列：**O** = 可观测；**P** = 投影代理量（带系统偏差，偏差方向随机位与人体朝向变化）；**O\*** = 在标定的 `g` 与 `S_ref` 下可观测。

| # | 名称 | 公式（COCO-17 索引，像素空间） | 单位 | 性质 | 理论出处 | 失效条件 |
|---|---|---|---|---|---|---|
| Q1 | `trunk_axis_from_gravity` | 9 核心点 `{0,5,6,11,12,13,14,15,16}` 的 `1/σ_COCO²` 加权 + IRLS 稳健 PCA 主轴与 `g` 的夹角 | deg | P | `measurement-error.md` §4.3 表 C：σ=0.60° @σ_p=0.01H，比两点躯干向量（2.81°）精 4.7 倍 | 四肢构型带偏主轴（已用核心点子集缓解）；沿光轴躺时主轴方向由噪声主导 |
| Q2 | `body_elongation` | 同一加权点云的 `sqrt(λ1/λ2)` | ratio | O | `monocular-geometry.md` §4.7 | 躺向光轴时反而变小 → 必须与 Q13 联合 |
| Q3 | `trunk_segment_from_gravity` | `MIDS=(p5+p6)/2` → `MIDH=(p11+p12)/2` 与 `g` 夹角 | deg | P | ISO 11226 trunk inclination 的投影（`clinical-posture.md` §2.3 C1） | 前缩到 0；**不是腰椎屈曲角**，文档必须区分 |
| Q4 | `thigh_from_gravity` | `hip_i → knee_i` 与 `g` 夹角，左右取 σ 更小的一侧 | deg | P | activPAL/Acti4 区分 sit/stand 的核心量（`clinical-posture.md` §2.1 A1–A3） | 投影把双峰抹平（§2.3 阈值表已注明） |
| Q5 | `shank_from_gravity` | `knee_i → ankle_i` 与 `g` 夹角 | deg | P | `balance-robotics.md` §4.2：sitting 小腿近竖直 vs crouching 小腿也屈 | 同 Q4 |
| Q6 | `knee_flexion` | `180° − joint_angle(hip_i, knee_i, ankle_i)` | deg | P | bending（knee>150°）vs crouching（knee<80°）的核心几何差异（`clinical-posture.md` §4.2） | σ=11.4° @σ_p=0.02H；本项目实测 σ_p=0.0041H ⇒ σ≈2.3°（`data-reality.md` §6.6）。**坐姿下膝常被桌子遮挡，上线前必须先实测可用率** |
| Q7 | `hip_flexion` | `180° − joint_angle(MIDS, hip_i, knee_i)` | deg | P | 同上 | 同上 |
| Q8 | `com_proxy_2d` | `Σ_j a_j·p_j`，14 项定常线性组合（见下表），代码内 `a /= a.sum()` | px（2 维点） | P | de Leva 1996 Table 4 + Dempster 1955 Table 14（`com-anthropometry.md` §4.3） | 体表标注 ≠ 关节中心；躯干单刚体假设在 bending 类最弱 |
| Q9 | `mass_coverage` | `Σ_{j: score_j ≥ τ_kp} a_j ∈ [0,1]` | ratio | O | `com-anthropometry.md` §4.4 | 无（这是 score 唯一有物理意义的用法） |
| Q10 | `com_height_norm` | `((mean(v15,v16) − com_proxy_2d)·g) / S_ref` | ratio | P | K&G 2011 CoM-height 判据的 2D 移植（`balance-robotics.md` §3.1 X） | 踝点被遮挡/编造；相机 pitch |
| Q11 | `d_hip_norm` | `‖com_proxy_2d − MIDH‖ / ‖MIDS − MIDH‖` | ratio | P | 模型算术：standing 0.044 → bending 0.162（`com-anthropometry.md` §4.5） | 躯干前缩 |
| Q12 | `leg_extension` | `((p_ankle − p_hip)·g) / (‖thigh‖+‖shank‖)`，左右取 σ 更小一侧 | ratio | O | `biomech.py:507-538` 已实现 | 大腿或小腿前缩 |
| Q13 | `sagittal_observability` | `sqrt(1 − clamp(r/R0,0,1)²)`，`r = ‖p5−p6‖/‖MIDS−MIDH‖`，`R0 = 0.85`（正面期望） | ratio | P | 前缩比（`monocular-geometry.md` §4.5）；`data-reality.md` §4 实测本项目素材 r≈0.12（接近侧向） | 混淆 `ψ_torso` 与 `ψ_sh`；`r > 1.25·R0` 时模型自相矛盾 → 返回 0（已实现于 `biomech.py:486-494`） |
| Q14 | `compactness` | `max_pairwise_dist(usable points) / S_ref` | ratio | O\* | `clinical-posture.md` §4.4：**最重要的护栏量**，沿光轴躺时塌到 0.4–0.5 以下 | `S_ref` 不可信时不可用 |
| Q15 | `vertical_order_margin_*` | `(p_lower − p_upper)·g`，三对：`shoulder_above_hip` / `hip_above_knee` / `knee_above_ankle` | px（带 σ） | O | 符号型量在单调透视下保持（`monocular-geometry.md` §4.6；`skeleton-posture-sota.md` §4.2 F8） | roll ≠ 0；真实高度差小于噪声 margin 时符号翻转 → 用 σ 做符号检验 |
| Q16 | `stance_width_norm` | `\|u15 − u16\| / \|u5 − u6\|` | ratio | P | `balance-robotics.md` §4.2 | 人体偏航时与真实站距脱钩 → 必须携带 `available` 标志 |
| Q17 | `bbox_elongation` | `h/(h+w)`，取 usable 点的轴对齐包围盒 | ratio | O | `skeleton-posture-sota.md` §4.2 F3（有界等价量，避免除零） | 沿光轴跌倒时结构性失效 |
| Q18 | `bone_over_length_flags` | `‖p_a−p_b‖ > (1+eps)·λ_bone·(S_ref/0.366)` | bool 集 | O | `measurement-error.md` §4.5：**只有"超长"方向有效** | **禁止**实现"过短报警"（与前缩完全混淆）与"左右骨长应相等"（左右出平面角不同，2D 投影天然不等） |

#### Q8 的 14 项系数（唯一允许硬编码的人体测量常量）

来源 **de Leva (1996) Table 4，性别平均**，`com-anthropometry.md` §4.3。**禁止与 Winter/Dempster 混表**（分割面不同，混用破坏质量守恒）。**禁止按性别切换**（骨架不可反推性别；男女系数差异仅造成 4.2–5.0 mm 位移，远小于换表 14.9–19.1 mm 与髋中点误差 71–283 mm）。

```python
COM_PROXY_WEIGHTS: dict[int, float] = {
    3: 0.0341, 4: 0.0341,      # ears  —— 头颈整块质量锚在耳屏（Dempster 1955 T14）
    5: 0.1392, 6: 0.1392,      # shoulders
    7: 0.0233, 8: 0.0233,      # elbows
    9: 0.0127, 10: 0.0127,     # wrists —— 手部质量就近归并
    11: 0.1760, 12: 0.1760,    # hips
    13: 0.0815, 14: 0.0815,    # knees
    15: 0.0333, 16: 0.0333,    # ankles —— 足部质量就近归并
}   # nose/eyes 权重恒为 0；取整后 Σ=1.0002，代码内必须 a /= a.sum()
```

三条由此立即得到、必须写进单元测试的性质：
1. **左右互换不变性**：`a_left_X ≡ a_right_X` ⇒ 交换任意一对同名左右关键点，`com_proxy_2d` 不变（对 MoveNet 侧视时的 L/R 标签互换免疫）。
2. **噪声增益** `sqrt(Σa²) = 0.346`，比"髋中点"估计量（0.707）低 2.04 倍。
3. **影响力排序**：hip 0.176 > shoulder 0.139 > knee 0.0815 > ear 0.0341 ≈ ankle 0.0333 > elbow 0.0233 > wrist 0.0127；髋+肩合计 63.0%。

`mass_coverage` 参考值：双耳丢失 0.932 / 双肩丢失 0.722 / 单侧整条腿丢失 0.709 / 双髋丢失 0.648。

**降级序列**（必须在输出标记 `degraded_path`）：全 14 项 → 去耳（0.932）→ 去腕肘（0.891）→ **停止**。**严禁**降级到"髋中点代替 CoM"（从 5 mm 残差跳到 71–283 mm，且误差方向随姿态类别翻转）。

#### 不确定度传播（闭式，已 MC 校验）

```python
sigma_segment_angle = hypot(sigma_a, sigma_b) / L                       # rad
sigma_joint_angle   = sqrt((sa/Lu)**2 + (sc/Lw)**2
                           + sv**2*(1/Lu**2 + 1/Lw**2 - 2*cos(th)/(Lu*Lw)))
sigma_axis          = sigma_p / sqrt(sum((t_k - t_bar)**2))
```
`biomech.py:329-458` 已实现三者。**线性化有效性门**（硬约束，`measurement-error.md` §4.3）：
```
sigma_p / min(Lu, Lw) > 0.25  →  该角度 unavailable
sigma_p / min(Lu, Lw) > 0.10  →  该角度 degraded（σ 乘 1.05 保守修正）
```

`sigma_p` 的默认值：`MEASURED_SIGMA_PER_BODY_HEIGHT × 观测体像素高`（`biomech.py:305-326`，来自本项目实测 σ=1.31 px @ H=318.9 px ⇒ σ_p ≈ 0.0041·H）。**禁止把 `score` 换算成 σ**：实测 `corr(score, 抖动) = −0.31`，且 ICML 2024 证明热图置信度存在与实例尺度无关的 scaling gap（`measurement-error.md` §2.2）。

### 2.3 L2 判据层：每类的物理判据与阈值来源

判据 = `Criterion(name, quantity, comparison, threshold, rationale)`。`support` 的定义（`posture_criteria.py:153-167` 已实现）：

```
comparison="below": value + 1.96σ ≤ threshold → "supports"
                    value − 1.96σ ≥ threshold → "opposes"
                    否则                        → "inconclusive"
```
**整个 95% 覆盖区间越过阈值才算满足。区间跨越阈值时是 `inconclusive`，绝不四舍五入成决定。**

#### 2.3.1 standing

物理理由：站立是**整条运动链竖直伸展**的构型——躯干、大腿、小腿三段都接近重力方向，髋在膝上、膝在踝上，质心代理位于踝线之上较高位置。

| 判据 | 量 | 比较 | 阈值符号 | provenance | 来源 |
|---|---|---|---|---|---|
| `trunk_upright` | Q1 `trunk_axis_from_gravity` | below | `standing_trunk_max_deg` | `pending_calibration` | 起点 25°；本项目实测站立 p99 = 10.8°（`data-reality.md` §2） |
| `thigh_near_vertical` | Q4 `thigh_from_gravity` | below | `standing_thigh_max_deg` | `pending_calibration` | 起点 30°；实测站立最大离竖直 16.3° |
| `knee_extended` | Q6 `knee_flexion` | below | `standing_knee_flex_max_deg` | `pending_calibration` | 起点 35° |
| `leg_vertically_extended` | Q12 `leg_extension` | above | `standing_leg_ext_min` | `pending_calibration` | 起点 0.75 |
| `hip_above_knee` | Q15 | above | `0.0`（符号检验） | `derived` | 序关系，本项目实测 100% 成立 |
| `knee_above_ankle` | Q15 | above | `0.0` | `derived` | 同上 |
| `com_high` | Q10 `com_height_norm` | above | `standing_com_height_min` | `pending_calibration` | K&G 2011 两级高度结构（**结构可搬，数值不可搬**——0.81/0.56 是那台 ASIMO-like 仿真机器人的） |

前置条件：`mass_coverage ≥ τ_cov`；双踝或单踝 usable（否则 `leg_vertically_extended` 与 `knee_above_ankle` 变 `inconclusive`，standing 自然不成立 → `unknown`）。

#### 2.3.2 sitting

物理理由（临床黄金判据）：**坐姿在解剖上强制髋关节屈曲接近 90°，把大腿从近竖直转到近水平，同时小腿保持近竖直**。这是 activPAL / Acti4 / ActiGraph 三套独立实现共同依赖的量——但那是"大腿相对**重力**的倾角"，由绑在大腿上的传感器直接测得，**不是投影角**（`clinical-posture.md` §2.1）。

**"大腿近水平 + 小腿近竖直"这一对必须联合。** 单一大腿倾角**无法**区分 sitting 与 lying（两者大腿都可能近水平），这是 Lyden 2016 用大腿绕长轴 ±65° 旋转作为第二自由度才解决的问题（sens 96.7% / spec 92.9%，7 天自由生活）。我们没有绕长轴旋转，因此改用**小腿竖直度**作为那个正交自由度。

| 判据 | 量 | 比较 | 阈值符号 | provenance | 来源 |
|---|---|---|---|---|---|
| `thigh_towards_horizontal` | Q4 | above | `sitting_thigh_min_deg` | `literature`（**必须校准后覆盖**） | Skotte 2014 Acti4：离竖直 > 45° 且 SD < 100 mg → sedentary；activPAL 离水平 40°/10° 滞回；ActiGraph 50–60°。**这三个值全部是相对重力、由大腿传感器测得，且与"加速度标准差"条件耦合；投影会抹平使该阈值有效的双峰结构。只作"存在一个拐点且位于离竖直 40–60°"的结构性先验。** |
| `shank_near_vertical` | Q5 `shank_from_gravity` | below | `sitting_shank_max_deg` | `pending_calibration` | 起点 35°；正交自由度，Lyden 2016 的方法论移植 |
| `knee_flexed` | Q6 | above | `sitting_knee_flex_min_deg` | `pending_calibration` | 起点 50°；三维参考量级 knee ≈ 85–100° ⇒ flexion 80–95°，2D 投影只会压缩 |
| `trunk_still_upright` | Q1 | below | `sitting_trunk_max_deg` | `pending_calibration` | 起点 40°；把 sitting 与 lying 分开 |
| `shoulder_above_hip` | Q15 | above | `0.0` | `derived` | 序关系 |

前置条件：`sagittal_observability ≥ Θ_sag_min`（坐姿几何是矢状面的）；膝、踝 usable。

**已知失效模式（必须写进 Model Card）**：伸直腿坐 —— activPAL 在这种情形下 70% 误判为 standing（`clinical-posture.md` §2.1 A3）。我们的 `shank_near_vertical` 会同时满足，因此靠 `thigh_towards_horizontal` 单独承担；一旦它落进死区就是 `unknown`——这是正确行为。

#### 2.3.3 lying

物理理由：**躺卧是身体长轴接近垂直于重力**。关键设计决定：**lying 必须靠身体主轴方向判定，而不是 CoM 高度**——模型算术显示躺姿下 `com_proxy_2d` 与髋中点的垂直分量仅差 0.0005 H，高度类特征在该类几乎无判别力（`com-anthropometry.md` §6.2）。

| 判据 | 量 | 比较 | 阈值符号 | provenance | 来源 |
|---|---|---|---|---|---|
| `long_axis_horizontal` | Q1 | above | `lying_axis_min_deg` | `pending_calibration` | 起点 65° |
| `body_elongated` | Q2 `body_elongation` | above | `lying_elong_min` | `pending_calibration` | 起点 2.0；**护栏**：防止把前缩成一团的投影当成"主轴水平" |
| `com_low` | Q10 | below | `lying_com_height_max` | `pending_calibration` | 佐证，非主判据（见上文） |

前置条件（**比其它类更严**）：
- `compactness ≥ C_MIN`（否则 `unknown`，**不得输出 lying**）——沿光轴躺是本系统最危险的失效模式：θ=90° 时投影长度按 cos φ 收缩，φ→90° 时段长趋 0、角度完全由噪声决定，可能被判成 standing（`clinical-posture.md` §6.2 风险 1）。
- `S_ref` 可信。

**能力缺口声明（必须进产品文案）**：单目无标定下**无法区分"躺在地上"与"躺在床/沙发上"**（无地面平面、无单应）。系统只输出"保持 lying 达 X 秒"这一可观测事实，**不输出"摔在地上"**。同理**不输出仰/侧/俯子类**。

#### 2.3.4 bending_or_crouching（两条独立证据链，任一成立即释放同一标签）

物理理由：弯腰与下蹲在躯干倾角上不可分，**唯一稳定的几何差异在膝**——髋铰链式弯腰 hip ≈ 70–110° 但 **knee 仍 > 150°**；深蹲 knee < 80°（`clinical-posture.md` §4.2，三维参考量级，**不得作 2D 阈值**）。

**链 A（bending）**：躯干前屈但膝仍伸直，腿仍承载高度。

| 判据 | 量 | 比较 | 阈值符号 | provenance |
|---|---|---|---|---|
| `trunk_flexed` | Q1 | above | `bending_trunk_min_deg` | `pending_calibration`（起点 35°，与 standing 的 25° 之间留 25–35° 灰区） |
| `knee_still_extended` | Q6 | below | `standing_knee_flex_max_deg` | `pending_calibration` |
| `hip_above_knee` | Q15 | above | `0.0` | `derived` |
| `com_shifted_from_hip` | Q11 `d_hip_norm` | above | `bending_d_hip_min` | `pending_calibration`（起点 0.10；standing 0.044 vs bending 0.162） |

**链 B（crouching）**：髋膝踝同时屈曲，整条链缩短。

| 判据 | 量 | 比较 | 阈值符号 | provenance |
|---|---|---|---|---|
| `knee_deeply_flexed` | Q6 | above | `crouch_knee_flex_min_deg` | `pending_calibration`（起点 100°，即 knee < 80°） |
| `shank_flexed` | Q5 | above | `crouch_shank_min_deg` | `pending_calibration`（起点 25°；这是与 sitting 的关键分野——sitting 小腿近竖直） |
| `leg_folded` | Q12 | below | `crouch_leg_ext_max` | `pending_calibration`（起点 0.55） |
| `com_lowered` | Q10 | below | `crouch_com_height_max` | `pending_calibration` |

前置条件：`sagittal_observability ≥ Θ_sag_min`（躯干屈曲是矢状面运动）；膝、踝 usable。

**必须先实测再决定是否依赖 Q6**：坐姿/桌下遮挡时膝的可用率可能很低。若验证集上 `knee_flexion` 在目标场景的可用率不足，整个链 A/B 降级为 `unknown`，**不猜**。

#### 2.3.5 阈值来源汇总（`THRESHOLDS` 字典的完整规格）

```python
@dataclass(frozen=True, slots=True)
class Threshold:
    value: float
    provenance: Provenance     # literature | derived | measured | pending_calibration | assumed
    source: str                # 必须能让人回溯到具体文献条目或校准运行 id
```

分三档，实现者必须逐条照抄 provenance：

| 档 | 阈值 | 说明 |
|---|---|---|
| `literature`（可硬编码，须注明出处） | `sitting_thigh_min_deg = 45.0` | Skotte 2014 / Radtke 2021 的**结构性**先验，**必须在校准后被 `measured` 覆盖** |
| | `TAU_KP_DEFAULT = 0.3` | MoveNet Model Card 官方推荐默认值（与相机几何无关），仍须验证集确认 |
| | `COM_PROXY_WEIGHTS`（14 项） | de Leva 1996 Table 4 性别平均 |
| | `SIGMA_COCO`（17 项） | COCO keypoints-eval 官方 σ 表，用于 PCA 加权与容差缩放 |
| | `OMEGA0 = 3.0 /s` | Hof 2005 §2.2 换算（成人 2.8–3.2，±6%）。**仅用于选窗口长度与时间常数，不作分类判据**；儿童失效（+25%） |
| `derived`（由本项目噪声分析推出） | `angle_budget_deg = 10.0` | 由 `σ_θ = √2σ/L` 反解最小可用段长；实测 σ=1.31 px ⇒ 5° 需 ≥21 px、10° 需 ≥11 px（`data-reality.md` §6.3） |
| | `sigma_theta_max` | 由"类别间可分辨间距 Δ"倒推，要求 `σ_θ ≤ Δ/3`（3σ 分离） |
| | 一切 `0.0` 符号检验阈值 | 序关系判据 |
| `pending_calibration`（起点，**禁止对外引用为工作边界**） | 其余全部 | 见 §2.3.1–2.3.4 各表 |

**禁止硬编码清单**（进 code review checklist，CI 守卫见 §10.6）：

1. 任何 `9.8` / `9.81` / `GRAVITY` / `sqrt(2gh)` / `m/s` / `m/s²` / `g`（重力加速度）标识符。
2. 任何米、厘米、千克单位的阈值。
3. 任何跨 `scene_id` 共用的绝对 `y_norm` 阈值。
4. 把 `score` 乘进 `COM_PROXY_WEIGHTS`（会破坏 Σa=1，制造与遮挡强相关的伪特征）。
5. 混用 Dempster/Winter 与 de Leva 的行。
6. "丢弃缺失环节 + 重归一化"（偏差随姿态翻符号：standing −0.0134 H vs bending +0.0096 H）。
7. 任何二阶导数（加速度/冲击/jerk）特征——即便用本项目**实测**的乐观 σ，σ_a = 9.0 H/s² 仍大于重力尺度 5.8 H/s²（`data-reality.md` §6.6 结论 2）。
8. 未做等比还原就 `atan2`。
9. `posture_before == standing and posture_after == lying → 跌倒` 的硬规则（Robinovitch 2013：12% 的跌倒发生在"正在坐下"、13% 在静止站立）。
10. 任何文献准确率进入 README / 演示话术 / 本项目指标声明。

### 2.4 L3 融合与拒判层

#### 2.4.1 融合规则：exactly-one-class，**没有 argmax**

```
matched = {c : ClassEvidence(c).met}          # met = 全部 criteria supports 且无 inconclusive
len(matched) == 1  → 释放该类（若在 released_classes 内）
len(matched) == 0  → unknown, abstain_reason = "no_class_criteria_fully_met"
len(matched) >= 2  → unknown, abstain_reason = "criteria_for_{...}_met_simultaneously"
```

**为什么不用加权求和/argmax**：Bagalà 2012 在 29 例真实老人跌倒上重测 13 个已发表算法，明确指出"算法越复杂、需同时满足的阈值假设越多，越不容易检出"，同时 Sierra 2026 证明学习型分类器 99.24% → 74.06%（未见人物）。加权求和会把"两条互相矛盾的证据"平均成一个看起来自信的数；exactly-one 让矛盾直接暴露成拒判。这也是 Rudin 2019 / Ghassemi 2021 主张的"本质可解释"而非"事后归因"。

**已知天然共存对**（不是 bug，是几何事实，必须在 `abstain_reason` 里具名）：
- `sitting` ∧ `bending_or_crouching`：正对相机时两者都表现为 `v_MH ≈ v_knee`，区分依赖髋膝踝相对**深度**（不可观测）。
- `sitting` ∧ `lying`：俯视机位下沙发上"坐"与"躺"的 2D 骨架可近乎相同（Auvinet 2011 用 ≥4 台相机重建 3D 才达 99.7%，其混淆事件正是 crouching / sitting / lying-on-sofa）。

#### 2.4.2 冲突处理：`counter_evidence` 必须被记录

即使某类被释放，其它类中 `support == "opposes"` 的判据也要进 `evidence.counter_evidence`。理由：评审需要看到"我们知道哪条证据在反对"，这正是 EU AI Act Art.86 要求的"决定的主要要素"。

#### 2.4.3 拒判门（8 道，按顺序，短路）

| 门 | 条件 | `abstain_reason` | 出处 |
|---|---|---|---|
| G0 上游门 | `person_detected=false` 或 `landmark_quality="unavailable"` | `no_person_detected` / `landmark_quality_unavailable` | `temporal-estimation.md` §4.5 Layer 0 |
| G1 输入合法门 | 坐标 None / `(0,0)` 且 score>0 / 顺序错 / 出画 | `upstream_contract_violation` | `monocular-geometry.md` §4.8 C6 |
| G2 质量覆盖门 | `mass_coverage < τ_cov` | `mass_coverage_below_threshold` | `com-anthropometry.md` §4.4 |
| G3 尺度门 | `S_ref is None` 或 `compactness < C_MIN` | `scale_reference_unreliable` / `body_projection_collapsed` | `balance-robotics.md` §3.4；`clinical-posture.md` §4.4 |
| G4 角分辨率门 | `σ_θ > sigma_theta_max`（传播不确定度） | `angular_uncertainty_exceeds_budget` | `measurement-error.md` §4.6 G5 |
| G5 几何一致性门 | `bone_over_length_flags` 任一为真；`max_keypoint_step > MAX_STEP` | `geometry_inconsistent` | `measurement-error.md` §4.5 |
| G6 可观测性门 | `sagittal_observability < Θ_sag_min` ⇒ 依赖矢状面的类标 `unavailable_reason` | （不直接拒判，逐类致 unavailable） | `monocular-geometry.md` §4.5 |
| G7 融合门 | `len(matched) != 1` | 见 §2.4.1 | — |
| G8 发布门 | `winner not in released_classes` | `{winner}_not_validated_on_project_data` + `shadow_candidates=[winner]` | `data-reality.md` §1 |

**G8 影子模式是本设计的诚实性核心**：本项目只有 `standing` 的真实人体素材（79 秒 2370 帧），其余三类的阈值来自"用重力参考传感器测得"的文献先验，**从未在本项目数据上验证过**。默认 `released_classes = {"standing"}`，其余三类计算并记录为 `shadow_candidates`，但对外释放 `unknown`。开启它们必须是一次**显式的、被记录的决定**（写进 `SceneCalibration.released_classes` 并带 `calibrated_at`）。

#### 2.4.4 置信度语义（**不是概率**）

```python
def _evidence_strength(winning: ClassEvidence, *, sagittal_value: float) -> float:
    """Smallest normalised margin among winning criteria, discounted by observability."""
    margins = [min(1.0, abs(q.value - c.threshold.value) / (3.92 * max(q.sigma, 1e-6)))
               for c in winning.criteria if (q := c.quantity) is not None]
    weakest = min(margins) if margins else 0.0
    return round(min(0.95, weakest * (0.5 + 0.5 * min(1.0, max(0.0, sagittal_value)))), 6)
```

- 上限 0.95，**结构上不可能到 1.0**。
- 语义写进 payload：`"confidence_semantics": "evidence_strength_not_probability"`。
- `unknown` 时的 `posture_confidence`：硬门（G0–G5）失败 → `1.0`（我们**确信**无法判定，并保持与 `StaticPostureModel`（`posture.py:125-128`）现有语义一致，避免改变 C 侧 UI 行为）；软门（G7 近平局）失败 → 实际的低 margin 值。两者由 `posture_evidence.abstain_kind ∈ {"hard_gate","soft_tie","not_released"}` 区分，C 侧据此渲染文案。

### 2.5 L4 时序层

#### 2.5.1 滤波管线（顺序不可换）

```
阶段 0  按 timestamp_ms 重采样到均匀 33.33 ms 网格；缺帧 ≤ N_HOLD(3) 线性插值，> N_HOLD 标 gap
阶段 1  逐关键点 score 门控（τ_kp）
阶段 2  几何量中值滤波 W_MED = 5 帧（≈167 ms）—— 去飞点、保阶跃
阶段 3  因果 Savitzky-Golay：W_SG = 9 帧（300 ms），polyorder = 2；同一套系数给 0 阶与 1 阶
阶段 4  只在体尺度归一化后的量上比阈值
```

- **禁用 `filtfilt`（非因果）于实时链路**；离线复核链路可用零相位 Butterworth（fc 5 Hz 位置 / 10 Hz 速度）。两条独立代码路径。
- **所有平滑窗口必须 < 0.15 s（≪ 1/ω₀ ≈ 0.33 s）**，否则会把跌倒抹平成缓慢坐下（`balance-robotics.md` §3.5 推论 1）。W_MED=5（167 ms）已经在边界上——实现时把它作为待校准参数，并在校准报告里给出"关掉中值滤波后 over-segmentation 变化"的消融结果。
- **先聚合、后微分**：对 `trunk_axis_from_gravity`、`com_height_norm` 这类**聚合量**求导，不要对单个关键点求导后再聚合。噪声增益从中心差分的 0.707 降到 SG(9,2) 的 0.129（5.5 倍改善），SNR 从 2.4 提到 12.9（`measurement-error.md` §4.4 表 E）。

#### 2.5.2 允许转移图（唯一的硬生理约束）

```
        ST ←──→ SI            ST↔LY：受控通道【禁止】直达
         ↕       ↕            任意 ↔ UK：允许
        BC ←──→ LY
```

`ST ↔ LY` 的 `−∞` 是**唯一**可以硬编码的生理不可能性：即使自由落体从 h ≈ 0.9 m 也需 ≈ 0.43 s；实测下降相 583 ± 255 ms 且速度低于倒立摆模型预测；起身/躺下的自然策略必经中间位形（Klima 2016：90.6% 老年被试用 rolling + asymmetrical squat）。它的含义是"**受控通道里不存在单步 ST↔LY 路径**"，而不是"人不能从站变躺"——后者通过 `ST → BC → LY` 或 §2.5.5 的 fall 快通道表达。

转移对数分数（Viterbi 用，**λ 全部待校准**）：

| from \ to | ST | SI | BC | LY | UK |
|---|---|---|---|---|---|
| **ST** | 0 | −λ₁ | −λ₁ | **−∞** | −λ_u |
| **SI** | −λ₁ | 0 | −λ₁ | −λ₁ | −λ_u |
| **BC** | −λ₁ | −λ₁ | 0 | −λ₁ | −λ_u |
| **LY** | **−∞** | −λ₂ | −λ₁ | 0 | −λ_u |
| **UK** | −λ_r | −λ_r | −λ_r | −λ_r | 0 |

- `λ₂ > λ₁`：LY→SI（自己坐起来）比 SI→LY（躺下）更费力，先验上更少见。
- **`λ_r`（UK 出弧）必须小。** 若这里惩罚太大，一次遮挡会让状态机卡在旧标签上——**这是最危险的失效模式：人在遮挡后倒地而系统仍报 standing。**
- 固定滞后 Viterbi，lag L = 15 帧 = 500 ms。

#### 2.5.3 滞回与最小驻留

- 滞回：所有几何判据用双阈值（进 `θ_in` / 出 `θ_out`，`θ_out < θ_in`）。activPAL 的坐→站 40° / 站→坐 10° 滞回带是这一做法的实证先例。
- 最小驻留 `T_dwell`（**全部待校准**，此处只给量级依据）：

| 状态 | 初值 | 依据 |
|---|---|---|
| ST | 500 ms | 稳定态 |
| SI | 700 ms | 坐下后短时再起身较少见 |
| **BC** | **250 ms** | **必须最短**——BC 本质是过渡位形；dwell 太长会把 `ST→BC→LY` 整条路径吞掉，导致 fall 被误报为 normal |
| LY | 700 ms | 躺下后稳定 |
| UK | 200 ms | 要能快速进出，不能卡住 |

- `D_enter = 3` 个输出周期（@7.5 Hz ≈ 400 ms）。
- **`T_dwell(BC)` 与 §2.5.4 的 `Θ_bc_max` 必须是两个独立参数，不得复用同一个数**（前者是标签稳定参数，后者是 transition 判据）。
- 健康指标：滑动 10 s 内切换次数 > `N_MAX` → 报 `degraded` 并降级到 UK。

#### 2.5.4 转变分类（normal / fall_like / uncertain）

给定一次状态切换区间 `[t0, t1]`：

```
descent_dur_ms   = t1 - t0
v_peak_bl_s      = max v_y(t)                          # body-lengths/s，正 = 向下
v_peak_width_ms  = |{t : v_y(t) > 0.5·v_peak}| · Δt    # 速度峰半高宽
delta_trunk_deg  = trunk_axis(t1) - trunk_axis(t0)
bc_dwell_ms      = 区间内 BC 的累计驻留
still_frac_after = 结束后 T_still 窗口内 motion < eps_still 的帧占比
quality_min      = 区间内最低 frame quality
```

```
fall_like_transition  ⟺  v_peak_bl_s     ≥ Θ_fall_v
                       ∧ descent_dur_ms  ≤ Θ_fall_dur
                       ∧ bc_dwell_ms     ≤ Θ_bc_max        # 跌倒几乎不在中间位形驻留
                       ∧ v_peak_width_ms ≤ Θ_peak_w        # 跌倒是单尖峰；受控下降是恒速平台
                       ∧ SG 窗内全部 9 帧 quality == "usable"

normal_transition     ⟺  起止两端都是高置信静态标签
                       ∧ 路径在允许转移图内
                       ∧ v_peak_bl_s     <  Θ_fall_v
                       ∧ descent_dur_ms  ≥  Θ_ctrl_min
                       ∧ 质量门通过

uncertain_transition  ⟺  其余全部（含质量降级、遮挡、路径非法、灰带、gap 后恢复）
```

三条关键设计决定：

1. **`fall_like_transition` 不绑定 `posture_before=standing`**（Robinovitch 2013：12% 的跌倒发生在"正在坐下"、13% 在静止站立）。`posture_before` 降为 `evidence` 字段。
2. **"落地后静止"只加分、不设为必要条件**。Bagalà 2012 记录真实跌倒中大量受试者跌坐在臀部、跪倒、倚在家具上，**从未进入躺姿**；以 lying 为确认条件的算法因此漏检。`still_frac_after` 只写进 evidence。
3. **总时长不能单独分离受控与跌倒**（分布重叠：受控半周期 1.1–1.5 s vs 跌倒 583 + 1.6σ ≈ 1.0 s）。真正可分的是**形状**——`v_peak_width_ms` 与 `bc_dwell_ms`。`descent_dur_ms` 只作粗筛。

`Θ_fall_dur` 有文献先验（Choi 2015 的 583 ± 255 ms，取 +1.6σ~+2.4σ ⇒ 起点 1.0–1.2 s）；`Θ_ctrl_min` 有文献先验（Bohannon 2006 反推 1.1–1.5 s 的下沿 ⇒ 起点 1.0 s）。`Θ_fall_v` / `Θ_peak_w` / `Θ_bc_max` **无任何文献可依，必须验证集校准**。

**`TransitionEvent.evidence` 必须删除的伪字段**：任何加速度峰值 / 冲击强度 / 撞击力 / GRF。依据：30 FPS 单目视频姿态估计的髋**加速度**误差 26.3 ± 19.4%，且对 >3.0 g 的冲击系统性低估 21.4%；本项目实测 σ 下 σ_a = 9.0 H/s² 仍大于重力尺度 5.8 H/s²。

#### 2.5.5 双延迟通道

| 通道 | 环节 | 延迟 |
|---|---|---|
| 静态标签 | 中值 67 ms + SG 133 ms + Viterbi 500 ms + debounce 400 ms | **≈ 1.1 s** |
| fall 快通道（旁路 Viterbi/debounce） | 中值 + 快滤波 | **≈ 70–150 ms** + 下降窗口（≈0.6 s） ⇒ 端到端 ≈ 0.8 s |

**这张表必须进代码注释与对外文档，且必须在校准后用实测值替换估算值。声称"实时"而不给延迟数字是不诚实的。**

#### 2.5.6 gap 与重置

见 §1.4 容错矩阵最后四行。核心失效场景是"人在沙发后面倒地"：gap 后直接接上旧状态会报告一次不存在的平滑转移；gap 后凭空生成 transition 会报告一次虚构的 fall。两者都不可接受。

#### 2.5.7 `smoothed=true` 的处置

JSONL 有 `smoothed: bool` 但**没有记录滤波器类型与截止频率**。若上游用了未知带宽的时序平滑，本层的速度类特征全部不可解释（一个 0.5 s 滑动平均会把跌倒抹平成缓慢坐下）。处置：`smoothed == true` 且缺 `smoothing` 元数据 → **时序头拒判**（`uncertain_transition`），静态头放行。同时向 A 提 schema 需求：`smoothing: {type, window_ms | cutoff_hz}`。

#### 2.5.8 场景指纹与漂移监控

```python
@dataclass(frozen=True, slots=True)
class SceneFingerprint:
    s_ref_p50_px: float
    s_ref_p90_px: float
    standing_trunk_axis_p50_deg: float
    standing_trunk_axis_p95_deg: float
    ankle_line_v_p50_px: float
    sample_count: int
```
运行时偏离超限（任一分位数漂移 > 校准时记录值的 `DRIFT_TOL`）⇒ 判定"机位已变"⇒ **全局降级到 `unknown` 并报 `degraded`**，而不是继续用失效阈值输出。

---

## 3 为什么（证据结构 / evidence schema）

设计依据（`skeleton-posture-sota.md` §2.9）：Anchors 的 precision/coverage、Concept Bottleneck 的可介入性、EU AI Act Art.86 的"决定的主要要素"、FDA 透明度原则的"局限与逻辑"、Chow 1970 / Geifman & El-Yaniv 2017 的选择性预测。

**核心性质：解释不是对黑箱打分的事后合理化——判据就是产生结论的东西，读者可以只凭 evidence payload 重算出这个结论。**

### 3.1 字段规格

```jsonc
{
  "schema_version": "reme-posture-evidence/v0-experiment",
  "rule_id": "R-SIT-1",                    // 具名规则，CORELS 风格
  "posture": "sitting",
  "abstain_reason": null,
  "abstain_kind": null,                    // "hard_gate" | "soft_tie" | "not_released" | null
  "confidence_semantics": "evidence_strength_not_probability",
  "evidence_strength": 0.71,               // = posture_confidence，见 §2.4.4
  "degraded_path": null,                   // "com_proxy_no_ears" | "com_proxy_no_arms" | null

  "quantities": {                          // L1 全部可算量，每个带 σ 与出处
    "thigh_from_gravity": {"value": 78.0, "sigma": 2.1, "unit": "deg",
                           "provenance": "derived",
                           "note": "projected segment length 96.3 px"},
    "shank_from_gravity": {"value": 8.0, "sigma": 2.3, "unit": "deg", "provenance": "derived"},
    "trunk_axis_from_gravity": {"value": 14.2, "sigma": 0.9, "unit": "deg",
                                "provenance": "derived", "note": "9 core points"},
    "knee_flexion": {"value": 84.0, "sigma": 2.4, "unit": "deg", "provenance": "derived"},
    "com_height_norm": {"value": 0.41, "sigma": 0.02, "unit": "ratio", "provenance": "derived"},
    "mass_coverage": {"value": 0.97, "sigma": 0.0, "unit": "ratio", "provenance": "derived"},
    "sagittal_observability": {"value": 0.62, "sigma": 0.0, "unit": "ratio",
                               "provenance": "derived",
                               "note": "shoulder/trunk 0.67 vs frontal expectation 0.85"}
  },

  "class_evidence": [                      // 每一类都记录，不只是胜者
    {
      "posture": "sitting",
      "met": true,
      "unavailable_reason": null,
      "criteria": [
        {"name": "thigh_towards_horizontal", "support": "supports", "comparison": "above",
         "measured": {"value": 78.0, "sigma": 2.1, "unit": "deg"},
         "threshold": {"value": 45.0, "provenance": "literature",
                       "source": "Skotte 2014 Acti4: thigh inclination > 45 deg FROM GRAVITY, coupled with an acceleration-variance condition; activPAL/ActiGraph place the inflection at 40-60 deg. Measured by a thigh-mounted sensor against gravity, NOT a projected camera angle. Carried as a prior that an inflection exists."},
         "rationale": "seated support forces roughly 90 deg of hip flexion, rotating the femur from near-vertical towards horizontal",
         "support_keypoints": [11, 13], "min_score": 0.64},
        {"name": "shank_near_vertical", "support": "supports", "comparison": "below",
         "measured": {"value": 8.0, "sigma": 2.3, "unit": "deg"},
         "threshold": {"value": 35.0, "provenance": "pending_calibration",
                       "source": "orthogonal DOF replacing Lyden 2016 thigh long-axis rotation; starting point, not yet calibrated"},
         "rationale": "a single thigh inclination cannot separate sitting from lying; the shank supplies the orthogonal degree of freedom",
         "support_keypoints": [13, 15], "min_score": 0.58}
      ]
    }
  ],

  "counter_evidence": [                    // 反对票，必须记录
    {"posture": "bending_or_crouching", "name": "knee_still_extended", "support": "opposes",
     "measured": {"value": 84.0, "sigma": 2.4, "unit": "deg"},
     "threshold": {"value": 35.0, "provenance": "pending_calibration"},
     "note": "knee flexion far exceeds the bending bound, so bending is ruled out"}
  ],

  "gates": [                               // 8 道门的逐条结果
    {"name": "person_detected", "passed": true, "detail": "producer reported a person"},
    {"name": "mass_coverage", "passed": true, "detail": "0.97 covered, needs 0.80"},
    {"name": "scale_reference", "passed": true, "detail": "S_ref 312.4 px from 240 samples (P90)"},
    {"name": "angular_resolution", "passed": true,
     "detail": "sigma 1.31 px needs segments >= 11.0 px for a 10 deg budget"},
    {"name": "sagittal_observability", "passed": true, "detail": "0.62 >= 0.50"}
  ],

  "unavailable_features": [
    {"feature": "stance_width_norm", "reason": "kp16 score 0.11 < tau_kp 0.30"}
  ],

  "not_observable": [                      // 固定清单，永远输出
    "metric_scale", "depth", "gravity_direction_absolute", "floor_plane",
    "center_of_pressure", "zero_moment_point", "ground_reaction_force",
    "true_3d_joint_angles", "intent", "injury_state"
  ],

  "shadow_candidates": [],                 // 计算出但未释放的类
  "rule_stats": {"precision_val": null, "coverage_val": null, "n_val": 0},
  "calibration": {"scene_id": "living-room-1", "profile_id": "cal-2026-08-01-a",
                  "s_ref_px": 312.4, "pixel_aspect": 1.7778,
                  "size_provenance": "measured", "gravity_provenance": "assumed",
                  "released_classes": ["standing"], "calibrated_at": null}
}
```

### 3.2 每条证据的 support / against / confidence 贡献

| 字段 | 含义 | 对结论的贡献 |
|---|---|---|
| `support = "supports"` | 95% 覆盖区间整体越过阈值，方向与该类一致 | 计入 `met` 的合取；其归一化 margin 参与 `evidence_strength = min(margins)` |
| `support = "opposes"` | 区间整体在阈值另一侧 | 该类 `met = false`；同时写进胜者的 `counter_evidence` |
| `support = "inconclusive"` | 区间跨越阈值，**或**该量不可算 | 该类 `met = false`（**不四舍五入**）；量不可算时另写 `unavailable_features` |
| `unavailable_reason`（类级） | 该类所需证据在当前视角下不可观测（如 G6 矢状面门） | 该类不参与融合，且**不算作"反对"**——它是"我看不见"，不是"不是它" |

**`evidence_strength = min(margins)` 而不是均值**：一条弱证据不应被其它强证据掩盖。这直接对应 Bagalà 的观察"合取项越多越漏检"的反面——我们承认合取，但把最弱的一环暴露出来。

### 3.3 人类可读的一句话（由 payload 机械生成，不是 LLM 写的）

```python
def explain(verdict: PostureVerdict) -> str:
    """Render the verdict as one checkable sentence. Pure string assembly."""
```
输出形如：

> 判 `sitting`（证据强度 0.71，非概率）：大腿与重力夹角 78.0°±2.1°（阈值 >45°，来源 Skotte 2014 Acti4 结构性先验，**尚未在本项目数据校准**）；小腿与重力夹角 8.0°±2.3°（阈值 <35°，待校准）；膝屈曲 84.0°±2.4°（阈值 >50°，待校准）；躯干主轴 14.2°±0.9°（阈值 <40°，待校准）；肩在髋之上（符号检验，margin 41.2±1.9 px）。反对证据：`bending_or_crouching.knee_still_extended` —— 膝屈曲远超弯腰上界。不可观测量：米制尺度、深度、绝对重力方向、地面平面、压力中心、意图。

---

## 4 输出什么（与 ABC 合同兼容的扩展）

### 4.1 决定性约束：`schema_version` 不变

`backend/reme/decision/context.py:108-112` 对 `schema_version` 做**精确相等**校验；`tests/test_decision_stream.py:180-192` 证明**缺字段**会被拒（`IngestError(code="bad_event")`）。因此：

- **`PostureObservation.schema_version` 保持 `"reme-posture/v0-experiment"` 不变。**
- **现有 11 个字段一个不动。**
- **新增内容一律作为纯新增的可选键。** 先例：A 从 `posture_runtime.py:128` 一直在发 `visible_keypoint_ratio`，B 一直静默忽略且不报错（`context.py` 内 0 处 `_reject_unknown_fields`）。

### 4.2 扩展方式：一个新键 `posture_evidence`

```
PostureObservation payload
├── 11 个既有字段（不动）
└── "posture_evidence": { ... }      # 新增，可选
        ├── 常驻 digest（≤ 320 B，见 §4.3）
        └── "evidence_ref": {"stream": "posture_evidence", "timestamp_ms": ..., "frame_index": ...}
```

**完整 evidence（§3.1 那份，约 5 kB）不进 PostureObservation**，而是写进独立的 `posture_evidence.jsonl`，由 `evidence_ref` 指过去。理由：
1. B 的 `_parse_posture_observation` 每条都要跑，不能被 5 kB 拖累；
2. `stream.py:112-113` 的内存缓冲是 `deque(maxlen=2000)` per scene，塞 5 kB × 2000 = 10 MB/scene 不可接受；
3. D 侧路演需要的是"能当场打开逐格看"的完整链，那是文件级的需求，不是事件级的。

### 4.3 digest 的字段（常驻，随每条 PostureObservation 走）

```jsonc
"posture_evidence": {
  "schema_version": "reme-posture-evidence/v0-experiment",
  "rule_id": "R-STAND-1",
  "abstain_reason": null,
  "abstain_kind": null,
  "confidence_semantics": "evidence_strength_not_probability",
  "mass_coverage": 0.97,
  "sagittal_observability": 0.62,
  "scale_provenance": "measured",
  "size_provenance": "measured",
  "gravity_provenance": "assumed",
  "released_classes": ["standing"],
  "shadow_candidates": [],
  "criteria_met": 6,
  "criteria_total": 7,
  "criteria_inconclusive": 1,
  "evidence_ref": {"stream": "posture_evidence", "timestamp_ms": 12345.678, "frame_index": 370}
}
```

### 4.4 完整 JSON 示例（一条实际写盘/上线的 PostureObservation）

```json
{"schema_version":"reme-posture/v0-experiment","scene_id":"living-room-1","timestamp_ms":12345.678,"frame_index":370,"person_detected":true,"posture":"standing","posture_confidence":0.812345,"posture_duration_ms":4200.0,"motion_level":"low","visible_keypoint_ratio":0.941176,"landmark_quality":"usable","posture_evidence":{"schema_version":"reme-posture-evidence/v0-experiment","rule_id":"R-STAND-1","abstain_reason":null,"abstain_kind":null,"confidence_semantics":"evidence_strength_not_probability","mass_coverage":0.9723,"sagittal_observability":0.6182,"scale_provenance":"measured","size_provenance":"measured","gravity_provenance":"assumed","released_classes":["standing"],"shadow_candidates":[],"criteria_met":7,"criteria_total":7,"criteria_inconclusive":0,"evidence_ref":{"stream":"posture_evidence","timestamp_ms":12345.678,"frame_index":370}}}
```

一条拒判的例子：

```json
{"schema_version":"reme-posture/v0-experiment","scene_id":"living-room-1","timestamp_ms":18933.0,"frame_index":568,"person_detected":true,"posture":"unknown","posture_confidence":1.0,"posture_duration_ms":800.0,"motion_level":"low","visible_keypoint_ratio":0.647059,"landmark_quality":"degraded","posture_evidence":{"schema_version":"reme-posture-evidence/v0-experiment","rule_id":null,"abstain_reason":"body_projection_collapsed","abstain_kind":"hard_gate","confidence_semantics":"evidence_strength_not_probability","mass_coverage":0.7089,"sagittal_observability":0.1104,"scale_provenance":"measured","size_provenance":"measured","gravity_provenance":"assumed","released_classes":["standing"],"shadow_candidates":["lying"],"criteria_met":0,"criteria_total":7,"criteria_inconclusive":5,"evidence_ref":{"stream":"posture_evidence","timestamp_ms":18933.0,"frame_index":568}}}
```

> 注意这一条：`shadow_candidates:["lying"]` 但 `posture:"unknown"` —— 系统看到了像躺的构型，但 `compactness` 塌陷说明身体长轴指向光轴、方向由噪声主导，因此拒绝输出 `lying`。**这在几何上是正确的（我们确实没有证据），在安全上是漏报**，必须写进产品说明。

### 4.5 TransitionEvent 的 evidence（B 侧已有开放挂载点）

`context.py:103` 的 `TransitionEvent.evidence: dict[str, Any]` 只要求是 dict（`context.py:153-155`），是仓库内既有的"结构化证据挂载点"范式，直接照抄形状：

```json
{"schema_version":"reme-transition/v0-experiment","scene_id":"living-room-1","start_ms":21100.0,"end_ms":21780.0,"transition":"fall_like_transition","transition_confidence":0.64,"landmark_quality":"usable","evidence":{"posture_before":"standing","posture_after":"lying","center_height_change":-0.38,"peak_descent_speed_bl_per_s":1.42,"descent_duration_ms":680.0,"trunk_angle_change_deg":57.3,"intermediate_dwell_ms":90.0,"still_frac_after":0.86,"quality_min":"usable","v_peak_width_ms":210.0,"rule_id":"R-FALLLIKE-1","not_observable":["impact_acceleration","ground_reaction_force","metric_descent_speed","intent"],"evidence_ref":{"stream":"posture_evidence","timestamp_ms":21780.0}}}
```

**`evidence` 中永久禁止出现**：`impact_g`、`peak_acceleration`、`impact_force`、任何 `*_mps`、任何 `*_g`。

### 4.6 到 MiMo 的最短路径（一行改动）

`backend/reme/decision/policy.py:814-823` 的 `_perception_summary` 只序列化 5 个键，送进 MiMo prompt。加一个键即可让"为什么"落到 CareDecision 的措辞上：

```python
"posture_reason": observation.posture_evidence_digest,   # rule_id + abstain_reason + 两条最强判据
```

**边界（ADR-0006 §安全不变量 2）**：证据只进提示词与阈值调制，**不进状态机转移条件**——升级台阶仍由规则独占。

### 4.7 与 `PosturePredictor` Protocol 的对接

`posture_runtime.py:24-27` 的 Protocol 只有一个方法，且是结构化 Protocol（非 nominal）：

```python
class PosturePredictor(Protocol):
    def predict_record(self, record: dict[str, Any]) -> PosturePrediction: ...
```

但 `PosturePrediction`（`posture.py:32-39`）只有 4 个字段，且 tracker 只消费 `posture` / `confidence` / `visible_keypoint_ratio`，**`probabilities` 被完全丢弃**（`posture_runtime.py:105,128,157-159`）。因此 evidence **不能**塞进 `probabilities`。

**解法**（不改 Protocol、不改 `PosturePrediction`、不破坏任何现有测试）：

```python
class BiomechPosturePredictor:
    """Satisfies PosturePredictor structurally; also exposes the last verdict."""

    def predict_record(self, record: dict[str, Any]) -> PosturePrediction: ...
    @property
    def last_verdict(self) -> PostureVerdict | None: ...
    def digest_for(self, frame_index: int) -> dict[str, Any] | None: ...
```

`RealtimePostureTracker` 保持不变即可跑通（向后兼容）。要让 evidence 进入 payload，新增一个**可选**的 tracker 装饰器：

```python
def attach_posture_evidence(
    event: RuntimeEvent, predictor: BiomechPosturePredictor
) -> RuntimeEvent:
    """Return a copy of a POSTURE_OBSERVATION event with `posture_evidence` added."""
```

调用方（`camera.py:347-370`、`live_preview.py:177-208`）各加一行。**不改 `posture_runtime.py`。**

---

## 5 存储

### 5.1 隐私合规（先说这个，因为它约束一切）

| 条款 | 出处 | 对本设计的判定 |
|---|---|---|
| "允许保存关键点、姿态、事件、决策和性能日志" | `.scratch/abc-interface/spec.md` §16 L561 | **绿灯**：姿态/证据/时间线都在授权范围内 |
| 实时摄像头默认原始帧不落盘 | 同 §16 L558-560 | 本设计**不写任何图像**。骨架**坐标**不是图像 |
| 原始帧与片段请求后不留存，除非显式调试模式 | ADR-0003 L15；`CONTEXT.md` L31 | 本设计不产生任何帧文件 |
| 跨会话累积 / 对外导出的证据留存 | ADR-0001 L22（Status 虽为 Superseded，但 ADR-0003 L6 只取代了"发送原始帧"这一条；ADR-0003 L17 反而重申长期留存仍在 MVP 之外） | **需要新 ADR**。本设计的落盘默认**限定在单 scene / 单 session 内**、落 git-ignored 的 `artifacts/`、不跨天聚合。若要跨会话留存或导出，走 **ADR-0007**（**不要占 0004** —— 0004 已被预留给 `adr-0003-keypoint-frame-record` 的改号，见 `.scratch/handoff/2026-08-01-spec-crosscheck.md` §4 L37） |
| 写失败不得阻断决策路径 | `audit.py:50-55` | 全部落盘走 `try/except OSError` + warning，绝不抛 |

### 5.2 文件布局

**预录 bundle（有 manifest）**：

```
<bundle>/
  manifest.json
  keypoints_2d.jsonl                      # A 产出（既有）
  posture_observations.jsonl              # ★ 填满 manifest 里恒为 None 的现成槽位
  transition_events.jsonl                 # ★ 同上
  derived/
    posture_evidence.jsonl                # 完整 evidence，按需写
    posture_evidence.index.json           # 稀疏偏移索引，§6
    posture_timeline.jsonl                # 姿态区间，§7
    posture_timeline.index.json
    posture_calibration.json              # SceneCalibration 快照
```

**manifest 登记方式（关键：不要动 `streams`）**：

- `posture_observations` / `transition_events` 直接填进 `manifest.streams` 的**现有槽位**（`scene_bundle.py:177-178` 目前恒为 `None`）。这是零风险的——`_validate_manifest_streams`（`scene_bundle.py:442-458`）做的是**集合精确相等**校验，往里加键会当场炸，但**填充已有键的值**完全合法。
- 新增的三个 derived 产物走**顶层兄弟节**，与 `diagnostics` / `extraction`（`scene_bundle.py:181-195`）同款惯例；`load_scene_manifest`（`scene_bundle.py:84-105`）对未知顶层键零校验：

```json
"evidence": {
  "posture_evidence": "derived/posture_evidence.jsonl",
  "posture_timeline": "derived/posture_timeline.jsonl",
  "posture_calibration": "derived/posture_calibration.json"
}
```

**实时会话（无 manifest —— 合同 §7 L261 明写 SceneManifest 只用于 `recorded_video`）**：

```
artifacts/posture-timeline/<session_id>/
  posture_observations.jsonl
  posture_evidence.jsonl
  posture_evidence.index.json
  posture_timeline.jsonl
  posture_timeline.index.json
  session_index.json        # session_id → scene_id、墙钟锚点、首末感知时间
```

`artifacts/` 已在 `.gitignore:25`。目录约定对齐 `config.py:24` 的 `audit_path` 先例。

> ⚠️ **已知缺口（不在本设计范围内解决，但必须记录）**：live 会话产出的时间线文件**当前没有任何对 C 暴露的读取路径**——`api-for-c.md` L43-45 的 `GET /scenes/<scene_id>/<相对路径>` 只服务 bundle。需要新端点或新约定。

### 5.3 追加写与原子性

仓库既有三种做法，本设计取 **`AuditLog` 范式**（`audit.py:18-55`）：`threading.Lock` + `open("a")` + 构造时 `mkdir(parents=True, exist_ok=True)` + 写失败只 print warning 绝不抛。

```python
class JsonlAppender:
    """Thread-safe append-only JSONL writer that never blocks the caller."""

    def __init__(self, path: Path | str, *, fsync_every: int = 0) -> None: ...
    def append(self, record: dict[str, Any]) -> int | None:
        """Return the byte offset of the written line, or None when the write failed."""
    def close(self) -> None: ...
```

原子性保证与其局限，逐条写清：

| 保证 | 机制 | 局限 |
|---|---|---|
| 单条记录不撕裂 | 一次 `write()` 写入完整 `line + "\n"`（< PIPE_BUF/页大小时，POSIX 追加模式下单次 write 不会与其它 write 交错） | 记录 > 4 KB 时理论上仍可能被信号打断；因此**完整 evidence 记录必须 < 4 KB**，超出部分截断并置 `truncated: true` |
| 进程崩溃后可恢复 | 读回时逐行 `json.loads`，**最后一行解析失败即丢弃**（视为半写） | 需要读取器容忍尾部半行——这是本设计对既有 `_read_jsonl`（`context.py:172-188`）的**必要增强** |
| 索引与数据不一致 | 索引是**可重建**的派生物；启动时若 `index.count != 实际行数` 则整体重建 | 重建是 O(n) 全扫，10 万条约 0.3 s，可接受 |
| 跨进程并发写 | **不支持。** 每个 session/scene 由单一 writer 持有 | 必须在文档里写明；违反时后果是记录交错 |

`fsync_every = 0`（默认不 fsync，对齐 `records.py:530-535` 的既有做法）；给出 `fsync_every = N` 选项供演示前落盘用。

### 5.4 序列化风格

跟随 `records.py:531`：`json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"`。
非 jsonl 的 JSON artifact 跟随 `posture.py:487`：`json.dumps(..., ensure_ascii=False, indent=2) + "\n"`。

### 5.5 schema 版本

| 文件 | schema_version | 备注 |
|---|---|---|
| `posture_observations.jsonl` | `reme-posture/v0-experiment` | **不变**（跨角色合同不能自己升版） |
| `transition_events.jsonl` | `reme-transition/v0-experiment` | 不变 |
| `posture_evidence.jsonl` | `reme-posture-evidence/v0-experiment` | 新增（D 域内部，不属于 A/B/C 合同） |
| `posture_timeline.jsonl` | `reme-posture-timeline/v0-experiment` | 新增 |
| `posture_calibration.json` | `reme-posture-calibration/v0-experiment` | 新增 |
| L1 特征 schema | `reme-biomech/v0-experiment` | 已在 `biomech.py:37` |

命名遵循仓库惯例 `<owner>-<domain>/v<N>-<stage>`；校验一律 `payload.get("schema_version") != CONST → raise`，不做兼容匹配。

### 5.6 大小估算（7.5 Hz）

实测字节数（`separators=(",",":")`，UTF-8）：

| 记录 | 大小 | 频率 | 每小时 | 每 24 h |
|---|---|---|---|---|
| PostureObservation（11 字段，无 evidence） | 310 B | 7.5 Hz = 27 000/h | 8.4 MB | 201 MB |
| PostureObservation + digest | 630 B | 27 000/h | **17.0 MB** | **408 MB** |
| 完整 evidence 记录 | ≈ 3.6 kB（上限 4 kB） | 仅标签变化 / 拒判起始 / 转变边界 / 每 10 s 心跳 ⇒ 实测量级 ≤ 0.5 Hz = 1 800/h | **6.5 MB** | 156 MB |
| TransitionEvent | 640 B | 事件驱动，典型 < 100/h | < 0.1 MB | < 2 MB |
| PostureInterval（时间线区间） | 470 B | 典型 60–300/h | < 0.15 MB | < 3.4 MB |
| **合计** | | | **≈ 23.7 MB/h** | **≈ 570 MB/day** |

79 秒演示片段（`data-reality.md` 的真实素材）：约 **0.52 MB**。

控制手段（全部 stdlib）：
- `evidence_detail ∈ {"full", "digest", "off"}`（默认 `"full"`，演示/长跑可降）；
- `gzip` 归档轮转：`posture_evidence.jsonl` 满 `ROTATE_BYTES`（默认 64 MB）后 `gzip` 压缩为 `.jsonl.gz`（实测姿态 JSONL 压缩比约 8–12×），索引记录 `gz` 标志与内部偏移；
- 保留期 `retention_hours`（默认 24），超期文件删除前**必须列出实际文件清单**（用户规则：删除类不可逆操作必须先列清单）。

---

## 6 查找（查询与索引）

### 6.1 需要支持的查询（来自 C 与 D 的实际需求）

| # | 查询 | 出处 | 复杂度目标 |
|---|---|---|---|
| Q-A | `latest_at(scene_id, t_ms)` —— 不晚于 t 的最后一条观察 | 合同 §9 L351「C 使用最新有效观察」；B 侧 `context.py:301-333` 同语义 | O(log n) |
| Q-B | `range(scene_id, t0_ms, t1_ms)` —— 时间窗内全部观察 | `software-demo/spec.md` §9 L216「按视频时间同步记录流」 | O(log n + k) |
| Q-C | `intervals(scene_id, t0_ms, t1_ms)` —— 与窗口相交的姿态区间 | §7；合同里**没有 owner**，这是本设计填的空缺 | O(log m + k) |
| Q-D | `evidence_at(scene_id, t_ms)` —— 该时刻的完整 evidence | D 路演「为什么这一刻要问她」；`product-roadshow-owner-d/spec.md` §4.6 L173-180 要求结构化日志 | O(log m) + 1 次 seek |
| Q-E | `reload_after_seek(scene_id, t_ms)` —— seek/reset 后整段重建 | `api-for-c.md` L24/L39：seek 前必须 reset，reset 会清空 B 的会话状态 | O(log n + k) |
| Q-F | `behavior_window(scene_id, t_ms, window_ms=120000)` —— ADR-0006 L1 行为语义层的 2 分钟回看 | `behavior.py:19` `DEFAULT_WINDOW_MS = 120000.0` | O(log n + k) |

**Q-E 是本设计存在的最实的技术理由**：`state_machine.py:251-252` 的 `REJECT_TIMELINE_REWIND` + `session.py:156` / `stream.py:169-174` 的 `_session_sequences.clear()` 意味着 **seek 会重置 B 的运行时状态**。时间线若要在 seek 后仍显示"之前发生过什么"，**不能靠 B 的运行时状态重建，必须靠一份独立的已落盘记录**。

### 6.2 索引结构（纯 stdlib + numpy）

现状：仓库内**没有任何索引**——时间查找唯一实现是 `context.py:310-321` 的 O(n) 线性扫描 + `break`，没有 bisect、没有二分。本设计补上。

```jsonc
// posture_evidence.index.json
{
  "schema_version": "reme-posture-timeline/v0-experiment",
  "kind": "offset_index",
  "scene_id": "living-room-1",
  "target": "posture_evidence.jsonl",
  "target_bytes": 6815744,
  "count": 1893,
  "t0_ms": 0.0,
  "t1_ms": 78966.0,
  "compressed": false,
  "entries": [[0.0, 0, 3412], [133.0, 3412, 3388], ...]   // [timestamp_ms, offset, length]
}
```

- **稀疏化**：`entries` 每 `INDEX_STRIDE`（默认 1）条记一项；证据流条数少，全索引即可。观察流条数多（27 000/h），用 `INDEX_STRIDE = 32` 稀疏索引 + 组内线性扫描，索引体积降 32×，查询仍是 O(log(n/32) + 32)。
- **增量维护**：`JsonlAppender.append()` 返回写入偏移，索引器直接累加，**不需要重扫**。
- **一致性自愈**：加载时 `target_bytes != path.stat().st_size` → 全量重建（O(n)）。

内存侧结构：

```python
@dataclass(frozen=True, slots=True)
class TimestampIndex:
    """Sorted perception timestamps with byte offsets, backed by numpy arrays."""

    scene_id: str
    timestamps_ms: np.ndarray      # float64, 严格非降序
    offsets: np.ndarray            # int64
    lengths: np.ndarray            # int64

    def latest_at(self, t_ms: float) -> int | None:
        """Index of the last record at or before t_ms. np.searchsorted, O(log n)."""
    def range(self, t0_ms: float, t1_ms: float) -> tuple[int, int]:
        """Half-open [lo, hi) slice bounds. Two searchsorted calls, O(log n)."""
```

用 `np.searchsorted(a, v, side="right") - 1` 实现 `latest_at`；numpy 已是仓库唯一无条件运行时依赖（`pyproject.toml:14-16`），不引入新依赖。**不引入 sqlite**——虽然是 stdlib，但会引入一个需要迁移管理的二进制状态，与"append-only JSONL + 可重建索引"的既有惯例不一致。

### 6.3 复杂度汇总

| 操作 | 复杂度 | 备注 |
|---|---|---|
| 追加一条观察 | O(1) 摊还 | 写 + 索引累加 |
| 冷启动加载索引 | O(m)（m = 索引项数） | 27 000/h × stride 32 ⇒ 844 项/h |
| 索引缺失时重建 | O(n) 全扫 | 10 万条约 0.3 s |
| `latest_at` / `range` | O(log m + stride) | stride=32 ⇒ 常数项 32 |
| `evidence_at` | O(log m) + 1 seek + 1 readline | 不把整个 evidence 流读进内存 |
| `intervals` | O(log k + 命中数) | 区间数量级 < 300/h，可全载内存 |

---

## 7 时间线（逐帧观察 → 姿态区间）

### 7.1 为什么需要它

合同里 `PostureObservation` 是**点采样**（5–10 Hz），只有 `posture_duration_ms` 表示"当前姿态已持续多久"。**把点流合并成 `[start_ms, end_ms, posture]` 区间这件事，合同里没有 owner**（`TransitionEvent` 与 `CareDecision.visual_context` 自带 start/end，静态姿态没有）。A 的标注 CSV 用区间格式，但那是训练标注不是运行时交付物。这是本设计填的第二个空缺。

### 7.2 聚合算法：run-length + 最小区间合并 + 拒判段独立成段

```python
@dataclass(frozen=True, slots=True)
class PostureInterval:
    scene_id: str
    start_ms: float
    end_ms: float
    posture: str                      # 含 "unknown"
    sample_count: int
    confidence_p50: float
    confidence_min: float
    abstain_ratio: float              # 区间内 unknown 样本占比（posture=="unknown" 时为 1.0）
    dominant_abstain_reason: str | None
    quality_min: str                  # usable | degraded | unavailable
    mass_coverage_p05: float
    evidence_digest: dict[str, Any]   # 该区间最具代表性的一条 digest（取 confidence 中位数那条）
    evidence_ref: dict[str, Any] | None
```

```python
class TimelineAggregator:
    """Fold a PostureObservation stream into contiguous posture intervals."""

    def __init__(self, *, min_interval_ms: float = 400.0,
                 merge_gap_ms: float = 200.0) -> None: ...
    def push(self, observation: dict[str, Any]) -> PostureInterval | None:
        """Feed one observation; return a closed interval when one is finalised."""
    def flush(self) -> PostureInterval | None:
        """Close the open interval at stream end / session end."""
    def reset(self) -> None:
        """Drop all state (call on gap >= T_RESET or on scene reset)."""
```

规则：
1. `posture` 变化即开新区间。
2. 新区间时长 < `min_interval_ms` 且其前后两个区间同标签 ⇒ **回填合并**（消除 over-segmentation）。`min_interval_ms` 默认 400 ms（= `D_enter` 的量级），**待校准**。
3. `unknown` 段**永不被合并掉**——拒判是要展示的信息，不是噪声。
4. 时间戳倒退超过 `REWIND_TOLERANCE_MS` ⇒ `reset()`，并在新区间打 `after_reset: true`。
5. 区间的 `start_ms` / `end_ms` **一律是感知时间**（合同 §5 L199）；`end_ms` 取该区间最后一条观察的 `timestamp_ms`（不外推）。

### 7.3 支持 C 的 seek 与回放

| C 的动作 | 时间线侧的行为 |
|---|---|
| `POST /api/scene/reset` 然后 seek 到 `t` | 时间线**不重置**（它是落盘的历史，不是运行时状态）；C 调 `intervals(scene_id, 0, t)` 拿到 t 之前的完整历史 |
| 播放中按视频时间同步 | C 按 `range(scene_id, t-Δ, t+Δ)` 拉观察点 + `intervals` 拉区间条 |
| 大幅回退（>3 s）未 reset | B 会 409 `timeline_rewind`；时间线读取**不受影响**（只读，无会话状态） |
| 暂停 / 结束 | 感知时间冻结；`response_timeout_ms` 走**交互时间轴**，与时间线**不是同一根轴**，渲染时必须分开（合同 §5 L202-203） |
| `demo_time_scale` | **只用于叙事显示，不改变真实感知时间**（合同 §7 L293）；存储层永远存真实毫秒 |

### 7.4 与 RuntimeEvent 的 session 隔离配合

合同 §4 L156：**持久化数据记录不写死运行时 `session_id`**；`session_id` 属于传输信封。因此：

- `posture_observations.jsonl` / `posture_timeline.jsonl` 的每条记录带 `scene_id`，**不带 `session_id`**。
- 一份独立的 `session_index.json` 做映射，且它是**运维层**产物（可含墙钟，对齐 `audit.py:5-7` 的明文授权）：

```json
{
  "schema_version": "reme-posture-timeline/v0-experiment",
  "kind": "session_index",
  "sessions": [
    {"session_id": "sess-2026-08-01-1", "scene_id": "living-room-1",
     "wall_clock_anchor": 1785628800.123,
     "first_perception_ms": 0.0, "last_perception_ms": 78966.0,
     "observation_count": 592, "interval_count": 7, "reset_count": 0}
  ]
}
```

三条规则（对齐 `time_semantics` R1–R4）：
- **R1** 感知时间戳（`timestamp_ms` / `start_ms` / `end_ms`）与墙钟锚点（`wall_clock_anchor`）是**两个不同字段名**，不得混用。
- **R2** 感知时间戳必须与 `scene_id`（recorded）或 session 索引条目（live）一起才有意义——0 点随 session/视频而变。
- **R3** 落盘记录不写运行时 `session_id`；映射只存在于 session 索引。
- **R4** `demo_time_scale` 不进存储层。

`RuntimeEvent` 侧的会话校验（`event.require_session()`，`runtime.py:207-215`）保持不动：旧会话事件在进入时间线之前就被 tracker 拒了。

---

## 8 模块清单与函数签名

### 8.1 现状：两个未纳入 git 的模块已存在

`backend/reme/pose/biomech.py`（596 行）与 `backend/reme/pose/posture_criteria.py`（609 行）当前是**未跟踪文件**（`git status: ?? `），已实现 L1 的一部分与 L2/L3 的骨架，且 `ruff check` 通过。本规格以它们为基线，**不重写，只增补与修复**。

### 8.2 `backend/reme/pose/biomech.py` —— L1 几何层（增补）

已实现且保留：`Quantity` / `ImageGeometry` / `FrameGeometry` / `parse_frame_record` / `segment_angle_from_gravity` / `joint_angle` / `trunk_axis_angle` / `sagittal_observability` / `leg_extension_ratio` / `vertical_order_margin` / `min_segment_length_for_angle_budget`。

**必须新增**：

```python
COM_PROXY_WEIGHTS: dict[int, float]            # §2.2 表，模块级常量
SIGMA_COCO: tuple[float, ...]                  # 17 项 COCO OKS sigma
BONE_LENGTH_RATIOS: dict[str, float]           # λ 先验，只作 sanity check

def com_proxy_2d(frame: FrameGeometry) -> tuple[np.ndarray, Quantity] | None:
    """Return the 14-term de Leva weighted centroid and its mass coverage.

    The returned point is an image-plane proxy for the projection of the body
    centre of mass, never the centre of mass itself: it inherits surface-marker
    offsets, a single-rigid-body trunk assumption, and has no depth component.
    Returns None when mass coverage is too low to define it at all.
    """

def mass_coverage(frame: FrameGeometry) -> Quantity:
    """Return the fraction of body mass carried by usable keypoints, in [0, 1]."""

def com_height_norm(frame: FrameGeometry, com: np.ndarray, s_ref_px: float) -> Quantity | None:
    """Return the gravity-aligned height of the CoM proxy above the ankle line,
    normalised by the tracked body scale. 2D port of the K&G 2011 CoM-height
    criterion; the two-level threshold structure transfers, the numbers do not."""

def com_hip_offset_norm(frame: FrameGeometry, com: np.ndarray) -> Quantity | None:
    """Return |com_proxy - mid_hip| / trunk length."""

def body_compactness(frame: FrameGeometry, s_ref_px: float) -> Quantity | None:
    """Return max pairwise distance over usable points divided by the reference
    scale. The primary guard against a body axis pointing down the optical axis,
    where segment lengths collapse and angles become noise."""

def bbox_elongation(frame: FrameGeometry) -> Quantity | None:
    """Return h / (h + w) of the usable-keypoint bounding box."""

def stance_width_norm(frame: FrameGeometry) -> Quantity | None:
    """Return ankle separation over shoulder separation (same-axis ratio)."""

def bone_over_length_flags(
    frame: FrameGeometry, s_ref_px: float, *, eps: float = 0.25
) -> dict[str, bool]:
    """Return per-bone 'projected length exceeds the anatomical upper bound' flags.

    Only the over-length direction is a valid criterion: projection can shorten a
    bone but never lengthen it. Do not add an under-length check (it is
    indistinguishable from foreshortening) or a left-right equality check (the
    two sides have different out-of-plane angles)."""

def max_keypoint_step(
    frame: FrameGeometry, previous: FrameGeometry, s_ref_px: float
) -> Quantity | None:
    """Return the largest per-keypoint displacement since the previous frame,
    normalised by body scale. A necessary-not-sufficient continuity check."""
```

**必须修改**：
- `trunk_axis_angle` 增加 `1/σ_COCO²` 加权与 IRLS 稳健重加权（当前是等权 PCA），并把 `sigma_axis` 改用**加权** `Σ w_k (t_k − t̄)²`（当前 `biomech.py:437` 用 `frame.sigma_px[indices[0]]` 单点 σ，等权时可接受，加权后必须改）。
- `parse_frame_record` 增加：`(0,0)` + `score>0` 的上游 bug 检测、边界 ε 检测、`coordinate_space` 校验、`smoothed` 透传。

### 8.3 `backend/reme/pose/posture_criteria.py` —— L2/L3（增补 + 修 bug）

**必须修复的缺陷（当前代码会在运行时抛 KeyError）**：

```
posture_criteria.py:536  THRESHOLDS["sitting_thigh_max_deg"]   ← 该键不存在
posture_criteria.py:110  THRESHOLDS 定义的是 "sitting_thigh_min_deg"
```
且比较方向也错：坐姿是"大腿**偏离**竖直**大于**阈值"，应为 `comparison="above"` + `sitting_thigh_min_deg`，而现有代码写的是 `comparison="below"`。**这一条会让 sitting 判据在真实运行时崩溃或反向。** 必须在实现第一步修掉，并加针对性测试。

**必须新增**：
- `sitting` 增加 `shank_near_vertical`（Q5）与 `trunk_still_upright`（Q1）判据（§2.3.2）。
- `lying` 增加 `compactness` 前置门（§2.3.3），并把 `com_height_norm` 降为佐证。
- `bending_or_crouching` 拆成链 A / 链 B 两套 `ClassEvidence`，任一 `met` 即释放同一标签（§2.3.4）。
- `standing` 增加 `com_high`（Q10）。
- `Criterion` 增加 `support_keypoints: tuple[int, ...]` 与 `min_score: float`（证据可核查性，§3.1）。
- `PostureVerdict` 增加 `counter_evidence` / `unavailable_features` / `not_observable` / `abstain_kind` / `degraded_path` / `rule_id` / `calibration`。
- `classify_frame` 签名扩展：

```python
def classify_frame(
    frame: FrameGeometry,
    *,
    calibration: SceneCalibration,
    s_ref_px: float | None,
    previous: FrameGeometry | None = None,
) -> PostureVerdict:
    """Classify one frame from named physical criteria, abstaining when unsure."""
```

### 8.4 `backend/reme/pose/posture_scale.py` —— L0（新建）

```python
@dataclass(frozen=True, slots=True)
class SceneFingerprint: ...        # §2.5.8

class ScaleTracker: ...            # §2.1.3

@dataclass(frozen=True, slots=True)
class GravityCalibration:
    gx: float
    gy: float
    provenance: Provenance
    roll_tol_deg: float = 5.0

def estimate_gravity_from_standing(
    frames: Sequence[FrameGeometry],
) -> GravityCalibration:
    """Circular-median trunk axis over confirmed-standing frames.

    CONSISTENCY MONITOR ONLY. Using this as the primary gravity calibration is
    circular reasoning: standing is defined by its relation to gravity. Feed it
    frames whose standing label came from an independent source (manual
    confirmation at install time), or use it only to detect drift."""
```

### 8.5 `backend/reme/pose/posture_temporal.py` —— L4（新建）

```python
POSTURE_TEMPORAL_STATES = ("standing", "sitting", "bending_or_crouching", "lying", "unknown")

@dataclass(frozen=True, slots=True)
class TemporalConfig:
    input_hz: float = 30.0
    median_window: int = 5
    savgol_window: int = 9
    savgol_order: int = 2
    viterbi_lag_frames: int = 15
    dwell_ms: dict[str, float] = ...        # §2.5.3
    enter_periods: int = 3
    gap_frames: int = 5
    reset_gap_ms: float = 1000.0
    rewind_tolerance_ms: float = 3000.0
    max_switches_per_10s: int = 8

@dataclass(frozen=True, slots=True)
class TemporalOutput:
    posture: str
    confidence: float
    transition: TransitionCandidate | None
    degraded: bool
    reason: str | None

class PostureTemporalTracker:
    """30 Hz internal state machine; decisions are downsampled by the caller."""

    def __init__(self, *, config: TemporalConfig, calibration: SceneCalibration) -> None: ...
    def ingest_frame(self, timestamp_ms: float, verdict: PostureVerdict) -> None:
        """Feed every input frame (30 Hz). Never skip frames here."""
    def emit_if_due(self, timestamp_ms: float, *, output_hz: float) -> TemporalOutput | None:
        """Return a decision at the output cadence, or None."""
    def reset(self) -> None: ...

def savgol_coefficients(window: int, order: int, deriv: int) -> np.ndarray:
    """Return Savitzky-Golay FIR coefficients. Pure numpy least squares.

    Noise gain ||h||_2 for deriv=1: forward diff 1.4142, central 0.7071,
    SG(5,2) 0.3162, SG(7,2) 0.1890, SG(9,2) 0.1291, SG(11,2) 0.0953.
    SG(9,3) is 0.3381 — 2.6x worse than order 2. Do not raise the order without
    evidence. (measurement-error.md section 4.4)"""

def median_filter(values: Sequence[float], window: int) -> list[float]:
    """Odd-window running median. Removes impulses of width <= window//2 while
    preserving steps — the signal model that matches posture quantities plus
    MoveNet outliers."""

def constrained_viterbi(
    log_obs: np.ndarray, log_trans: np.ndarray, *, lag: int
) -> list[int]:
    """Fixed-lag Viterbi over the constrained transition graph.

    log_trans[standing][lying] and log_trans[lying][standing] must be -inf: the
    only hard physiological constraint we are entitled to encode. It means there
    is no single-step controlled path, not that a person cannot go from standing
    to lying — that path runs through bending_or_crouching or the fall fast
    channel."""

def classify_transition(
    window: Sequence[TemporalSample], *, calibration: SceneCalibration
) -> TransitionCandidate:
    """Return normal / fall_like / uncertain with its evidence. Section 2.5.4."""
```

**`scipy` 不可引入**（`pyproject.toml:14-16`：numpy 是唯一无条件运行时依赖）。SG 系数用 numpy 最小二乘手算（`np.linalg.pinv(np.vander(...))`），约 8 行；中值滤波用 `np.median` 滑窗；Viterbi 是纯 numpy 循环。**无降级路径需要——这三样都不需要 scipy。**

### 8.6 `backend/reme/pose/posture_evidence.py` —— 输出适配（新建）

```python
EVIDENCE_SCHEMA_VERSION = "reme-posture-evidence/v0-experiment"

class BiomechPosturePredictor:
    """Structural implementation of reme.pose.posture_runtime.PosturePredictor."""

    def __init__(self, *, image: ImageGeometry, calibration: SceneCalibration,
                 scale: ScaleTracker | None = None) -> None: ...
    def predict_record(self, record: dict[str, Any]) -> PosturePrediction: ...
    @property
    def last_verdict(self) -> PostureVerdict | None: ...

def build_evidence_digest(verdict: PostureVerdict) -> dict[str, Any]:
    """Return the <=320 byte digest carried inside every PostureObservation."""

def build_evidence_record(
    verdict: PostureVerdict, *, scene_id: str, timestamp_ms: float, frame_index: int
) -> dict[str, Any]:
    """Return the full evidence record for the sidecar stream (< 4 KB)."""

def attach_posture_evidence(
    event: RuntimeEvent, predictor: BiomechPosturePredictor
) -> RuntimeEvent:
    """Return a copy of a POSTURE_OBSERVATION event with `posture_evidence` added."""

def explain(verdict: PostureVerdict) -> str:
    """Render the verdict as one human-checkable sentence. Pure assembly."""
```

### 8.7 `backend/reme/pose/posture_timeline.py` —— 存储/查询/时间线（新建）

```python
TIMELINE_SCHEMA_VERSION = "reme-posture-timeline/v0-experiment"

class JsonlAppender: ...                # §5.3
class TimestampIndex: ...               # §6.2
class OffsetIndexBuilder: ...           # 增量维护 + 一致性自愈
class TimelineAggregator: ...           # §7.2

@dataclass(frozen=True, slots=True)
class PostureInterval: ...              # §7.2

class PostureTimelineStore:
    """Append-only posture/evidence/timeline store with O(log n) time lookup."""

    def __init__(self, root: Path | str, *, scene_id: str,
                 evidence_detail: str = "full") -> None: ...

    # write
    def append_observation(self, observation: dict[str, Any]) -> None: ...
    def append_evidence(self, record: dict[str, Any]) -> None: ...
    def append_transition(self, event: dict[str, Any]) -> None: ...
    def flush(self) -> None: ...

    # read
    def latest_at(self, t_ms: float) -> dict[str, Any] | None: ...
    def range(self, t0_ms: float, t1_ms: float) -> tuple[dict[str, Any], ...]: ...
    def intervals(self, t0_ms: float, t1_ms: float) -> tuple[PostureInterval, ...]: ...
    def evidence_at(self, t_ms: float) -> dict[str, Any] | None: ...
    def behavior_window(self, t_ms: float, window_ms: float = 120000.0
                        ) -> tuple[dict[str, Any], ...]: ...

def register_in_manifest(manifest_path: Path, *, evidence_paths: dict[str, str]) -> None:
    """Fill the existing posture_observations / transition_events stream slots and
    add a top-level `evidence` sibling node.

    NEVER add a key to manifest.streams: _validate_manifest_streams does a set
    equality check (scene_bundle.py:442-458) and any extra key raises."""
```

### 8.8 `backend/reme/pose/posture_calibration.py` —— 校准（新建）

```python
CALIBRATION_SCHEMA_VERSION = "reme-posture-calibration/v0-experiment"

@dataclass(frozen=True, slots=True)
class SceneCalibration:
    scene_id: str
    profile_id: str
    thresholds: dict[str, Threshold]
    tau_kp: float
    tau_cov: float
    gravity: GravityCalibration
    released_classes: frozenset[str]
    fingerprint: SceneFingerprint | None
    calibrated_at: str | None                 # None ⇒ 全部 pending_calibration

DEFAULT_CALIBRATION: SceneCalibration          # released_classes = {"standing"}

def load_calibration(path: Path | str) -> SceneCalibration: ...
def save_calibration(path: Path | str, calibration: SceneCalibration) -> None: ...

def fit_thresholds(
    index_path: Path | str, *, target_abstain_rate: float
) -> tuple[SceneCalibration, dict[str, Any]]:
    """Grid-search thresholds on a labelled validation set, grouped by clip.

    Follows the repository's existing tuning idiom (numpy grid search plus
    percentiles, posture.py:540-574) rather than sklearn. Splits MUST be grouped
    by scene_id / contiguous clip: putting frames from one video into both the
    fitting and the evaluation half systematically inflates every number."""

def check_drift(
    calibration: SceneCalibration, observed: SceneFingerprint
) -> tuple[bool, str]: ...
```

### 8.9 CLI（可选，遵循仓库范式）

`backend/reme/pose/posture_criteria.py` 增加 `_build_parser()` + `main(argv: Sequence[str] | None = None) -> int`，错误路径 `print(f"error: {exc}")` + `return 2`，对齐 `posture.py:743-807` / `scene_bundle.py:501-566`。子命令：`classify`（跑一份 JSONL 出观察 + 证据 + 时间线）、`calibrate`、`explain`。若要暴露成命令需加到 `pyproject.toml:18-22` 的 `[project.scripts]`。

---

## 9 校准计划

### 9.1 硬前提：本项目当前**没有**多类别真实数据

- 唯一真实人体素材 79 秒 2370 帧，**全程只有 `standing`**；躯干角 max 13.7°、大腿离水平最小 73.7°、髋<膝<踝 100% 成立。
- 覆盖 5 类的 `downloads6-animation-bootstrap-v2` 是**动画参考素材 + 文件名推断标签 + 媒体不在本机**，`lying` 的 test 只有 1 个片段。**不能作为训练真值或验收依据**（人体测量学失配、目标人群失配、标签强度不足）。

因此**默认 `released_classes = {"standing"}`**，其余三类跑影子模式。这不是保守，是"证据不足必须拒判"的直接落实。

### 9.2 四层验证（对应 `validation-protocol.md`）

| 层 | 验证对象 | 手段 | 能得出的结论 | **不能**得出的结论 |
|---|---|---|---|---|
| V1 几何正确性 | 特征计算 == 数学定义 | 解析构造关键点 + 闭式期望，误差 < 1e-9 | 代码实现无误 | 判据是否适合真人 |
| V2 判据行为 | 判据在受控姿态上的响应 | 2D 正向运动学合成骨架，逐度扫描 | 边界位置、单调性、拒判带宽度 | 真实场景准确率 |
| V3 噪声鲁棒性 | 实测噪声下的稳定性 | V2 骨架 + σ=1.31 px 高斯扰动 × 1000 | 置信度是否诚实（可靠性曲线） | 真实遮挡/异常姿态表现 |
| V4 真实素材 | 唯一真实片段 | 2370 帧 | **仅** `standing` 的稳定性/抖动/拒判率/耗时 | 其余任何类别 |

**V2 的合成骨架是由判据所使用的同一套几何假设生成的，因此它不能证明判据适合真人。把 V2 结果表述成"准确率"是错误的。**

V4 的**预期张力**：本项目素材受试者接近侧向（肩宽/躯干 = 0.12，正面期望 0.85），`sagittal_observability` ≈ 0.99（侧向对矢状面判据反而**有利**），但 `stance_width_norm` 与左右对称类量必须降权。**禁止**为了让这段视频"好看"而放松前缩门控——阈值必须先由理论与噪声分析定下，再看视频结果。

### 9.3 阈值拟合协议

1. **切分单位是 `scene_id` / 连续片段，绝不按帧随机切。** 相邻帧强相关，按帧切会系统性高估一切指标。
2. 每个阈值报告**在不同机位子集上的漂移量**；漂移超过其死区宽度的量**不得单独使用**。
3. 任何样本量 < 30 的类别**只能用于报告失败案例，不得用于设阈**。
4. 拒判边界按 **risk–coverage 曲线**取点（Chow 1970 / Geifman & El-Yaniv 2017），**并把覆盖率一并报告**。拒判率是要公布的指标，不是耻辱。
5. 时序阈值按 **FPR vs Lead Time 双目标曲线**取点（K&G 2011），**不报单一准确率**——原文明确指出"整体预测准确率不必然带来更低 FPR 与更高 lead time"。
6. 死区宽度建议起点 ±15°（由实测角度噪声 ≈ 1.0–2.3° + 投影失真共同决定）。
7. 校准记录必须落盘到 `posture_calibration.json` 的 `calibration` 字段，含 `profile_id` 与 `calibrated_at`；**未校准的 scene 一律降级到 `unknown`**。

### 9.4 验证集必须覆盖的场景（否则校准出的阈值不可辩护）

- 多个机位高度与俯仰角；
- 人相对相机至少 0° / 45° / 90° 三档方位；
- 全部已知失效场景：伸直腿坐、**沿光轴躺（头朝/脚朝相机）**、下蹲、坐在地上、俯身捡物、坐在低矮沙发上；
- `bending_or_crouching` 与 `sitting` 在正对相机时的混淆样本；
- 至少一段刻意的正常躺下与一段受控的跌倒式转变（安全前提下用软垫，或明确标注为脚本触发）；
- 分层记录肤色/体型/衣着，分组报告各门触发率与 σ_axis 分布（MoveNet 官方自报 COCO val 上肤色间 mAP 差 13.9 点）。

### 9.5 解除限制所需的最小补拍

每个目标类别 ≥ 3 个不同人物、≥ 2 个机位角度的连续片段；每段包含进入该姿态的完整过程与稳定保持段；按人物划分 train/val/test；拍摄时同步记录机位高度、俯仰角与人物朝向。**在补拍完成前，任何四类指标都不应出现在 PPT、答辩材料或对外文档中。**

### 9.6 报告模板（逐字，防止过度声明）

```text
已验证：
- 几何实现正确性（V1）：<结果>
- 判据边界与拒判带（V2，合成）：<结果>
- 噪声下的置信度校准（V3，蒙特卡洛，σ=1.31 px 实测）：<结果>
- 真实素材上的 standing 稳定性（V4，2370 帧）：<结果>

未验证（当前无数据）：
- sitting / lying / bending_or_crouching 在真实人体上的 precision / recall / F1
- 跨人物、跨机位、跨光照泛化
- 老年人体态（脊柱后凸、身高丢失）下的适用性
- 任何跌倒式转变的检测能力

阈值来源：
- <逐条列出：literature / derived / measured / pending_calibration>
```

---

## 10 测试计划

遵循仓库既有约定：**无 `conftest.py`**（每个文件自带私有 helper）、绝对导入 `from reme.xxx import ...`、纯 `assert`、**无 `@pytest.mark.parametrize`**（全仓 0 处）、**无 `unittest.mock`**（全仓 0 处，打桩就手写 12 行类）、`pytest.raises(XxxError, match="...")`、函数名是完整句子。

### 10.1 `tests/test_pose_biomech.py`

| 测试 | 断言 |
|---|---|
| `test_com_proxy_weights_sum_to_one_after_normalisation` | `abs(sum(a) - 1) < 1e-9`（归一后） |
| `test_com_proxy_is_invariant_to_left_right_label_swap` | 交换 5↔6、11↔12、13↔14、15↔16 后 `com_proxy_2d` 逐元素相等 |
| `test_com_proxy_noise_gain_matches_closed_form` | `sqrt(sum(a**2))` ≈ 0.346 ± 1e-3 |
| `test_mass_coverage_matches_published_failure_cases` | 双耳失效 0.932、双肩 0.722、单腿 0.709、双髋 0.648，各 ±1e-3 |
| `test_synthetic_forty_five_degree_segment_reads_as_forty_five_degrees` | 在 16:9 与 4:3 两种 `ImageGeometry` 下都得 45° ± 1°（各向异性还原的回归测试） |
| `test_segment_angle_sigma_matches_closed_form` | `σ = hypot(σa,σb)/L`，与 1000 次 MC 吻合 < 5% |
| `test_axis_angle_is_more_precise_than_two_point_trunk_vector` | 同一构型下 `σ_axis < σ_trunk_segment`（站立构型下应差 ~4.7 倍） |
| `test_bone_over_length_flags_only_fire_on_over_length` | 人为压缩骨长 50% 不触发；拉长 60% 触发 |
| `test_parse_rejects_zero_coordinate_with_positive_score` | `pytest.raises(BiomechError, match="upstream")` |
| `test_parse_accepts_legacy_torso_detected_shape` | legacy 形状不抛 |
| `test_parse_derives_landmark_quality_when_absent` | 缺 `landmark_quality` 时不默认 `usable` |

### 10.2 `tests/test_pose_posture_criteria.py`

| 测试 | 断言 |
|---|---|
| `test_sitting_criteria_do_not_raise_on_a_seated_skeleton` | **§8.3 KeyError 的回归测试**——当前代码在此崩溃 |
| `test_sitting_requires_thigh_away_from_vertical_not_towards_it` | 比较方向的回归测试 |
| `test_exactly_one_class_is_required_to_release_a_label` | 造一个 sitting/bending 同时成立的骨架 → `unknown` + reason 含两类名 |
| `test_inconclusive_criterion_never_rounds_into_a_decision` | 令 `value` 恰在阈值上、σ 较大 → `support == "inconclusive"` 且该类 `met is False` |
| `test_lying_is_refused_when_the_body_projection_collapses` | `compactness < C_MIN` 时 `posture == "unknown"` 且 `shadow_candidates == ("lying",)` |
| `test_non_released_class_is_reported_as_shadow_candidate` | 默认 `released_classes={"standing"}` 下 sitting 骨架 → `unknown` + `abstain_kind == "not_released"` |
| `test_every_threshold_carries_a_provenance_and_source` | 遍历 `THRESHOLDS`，断言 `provenance` 在枚举内且 `source` 非空 |
| `test_evidence_payload_round_trips_through_json` | `json.loads(json.dumps(verdict.to_payload()))` 无损 |
| `test_counter_evidence_records_the_opposing_criterion` | 胜者 payload 里能找到被否决的那条 |
| `test_confidence_never_reaches_one_for_a_released_label` | ≤ 0.95 |

### 10.3 `tests/test_pose_posture_temporal.py`

| 测试 | 断言 |
|---|---|
| `test_savgol_derivative_noise_gain_matches_published_values` | SG(9,2,deriv=1) 的 `‖h‖₂` ≈ 0.1291 ± 1e-4；中心差分 0.7071 |
| `test_median_filter_removes_short_impulses_and_preserves_steps` | 宽度 2 的脉冲被去除，阶跃保留 |
| `test_standing_to_lying_has_no_single_step_path` | 受约束 Viterbi 在只有 ST/LY 观测的序列上必须插入 BC 或输出 UK |
| `test_unknown_exit_penalty_does_not_lock_the_state_machine` | 遮挡 2 s 后人变成 lying，状态机必须能出 UK 到 LY，不得仍报 standing |
| `test_gap_longer_than_reset_threshold_emits_no_transition_event` | gap ≥ 1.0 s 后第一个静态标签不产生 TransitionEvent |
| `test_short_gap_marks_the_transition_uncertain` | gap < 1.0 s → `uncertain_transition` |
| `test_timestamp_rewind_within_tolerance_drops_the_frame` | 计数 +1，状态不变 |
| `test_timestamp_rewind_beyond_tolerance_resets_the_tracker` | `reset()` 被触发 |
| `test_duplicate_timestamp_does_not_advance_dwell` | dwell 不变 |
| `test_transition_evidence_contains_no_acceleration_field` | 遍历 evidence 键，断言无 `accel` / `impact` / `_g` / `_mps` 子串 |
| `test_bending_dwell_does_not_swallow_a_fall_path` | `T_dwell(BC)=250 ms` 下 ST→BC→LY 在 680 ms 内完成仍能判 fall_like |

### 10.4 `tests/test_pose_posture_timeline.py`

| 测试 | 断言 |
|---|---|
| `test_latest_at_returns_the_last_record_at_or_before_the_timestamp` | 含边界相等的情形 |
| `test_range_returns_a_half_open_window` | |
| `test_index_is_rebuilt_when_the_target_file_size_changes` | 手动截断文件后加载 → 自动重建 |
| `test_reader_tolerates_a_truncated_final_line` | 半写行被丢弃且不抛 |
| `test_unknown_intervals_are_never_merged_away` | 300 ms 的 unknown 段仍独立成区间 |
| `test_short_same_label_interval_is_merged_back` | 消除 over-segmentation |
| `test_persisted_records_do_not_contain_a_session_id` | 合同 §4 L156 的回归测试 |
| `test_manifest_registration_does_not_add_a_streams_key` | 注册后 `set(manifest["streams"])` 仍等于那 5 个名字 |
| `test_append_failure_does_not_raise` | 用只读目录触发 OSError，断言只 warning |

### 10.5 `tests/test_pose_posture_evidence.py`

| 测试 | 断言 |
|---|---|
| `test_predictor_satisfies_the_runtime_protocol` | 直接注入 `RealtimePostureTracker`，跑通一段并产出事件 |
| `test_posture_observation_keeps_the_frozen_schema_version` | payload 的 `schema_version == "reme-posture/v0-experiment"` |
| `test_posture_observation_keeps_all_eleven_contract_fields` | 逐个断言 |
| `test_decision_side_parses_the_extended_observation` | 直接调 `reme.decision.context._parse_posture_observation`，断言不抛且 8 个字段正确（跨包耦合的回归测试） |
| `test_evidence_digest_stays_within_the_size_budget` | `len(json.dumps(digest, separators=(",",":"))) <= 320` |
| `test_full_evidence_record_stays_under_four_kilobytes` | `<= 4096` |
| `test_explain_mentions_every_winning_criterion_and_its_source` | 字符串包含每条判据名与其 `provenance` |

### 10.6 CI 守卫（`tests/test_pose_posture_guardrails.py`）

这不是常规单测，是**把设计红线变成可执行断言**：

```python
FORBIDDEN_IN_FEATURE_MODULES = ("9.81", "9.8 ", "GRAVITY", "sqrt(2*g", "m_per_s",
                                "meters", "_mps", "_kg", "cop", "zmp", "ground_reaction")
```

| 测试 | 断言 |
|---|---|
| `test_feature_modules_contain_no_metric_scale_identifiers` | 对 `biomech.py` / `posture_criteria.py` / `posture_temporal.py` 做源码文本扫描 |
| `test_no_module_multiplies_score_into_the_com_weights` | 源码中 `COM_PROXY_WEIGHTS` 附近不得出现 `score` |
| `test_no_second_derivative_feature_exists` | 扫描 `deriv=2` / `accel` |
| `test_every_literature_threshold_names_its_source` | `THRESHOLDS` 中 `provenance == "literature"` 的项，`source` 必须 ≥ 40 字符且含年份 |
| `test_no_cross_scene_absolute_y_threshold` | 扫描裸 `y_norm >` / `y_norm <` 比较 |

### 10.7 门禁

- `.venv/bin/python -m pytest -q` —— 新增测试全绿，且现有 249 个测试**一个不许挂**（尤其 `tests/test_decision_*.py` 那 5 处局部 posture dict，虽然无白名单校验但必须跑一遍确认）。
- `.venv/bin/python -m mypy` —— `packages=["reme"]` 意味着新模块必须 strict 通过：每个函数（含私有 helper）完整注解、显式 `-> None`；numpy 出参用 `float(...)` / `int(...)` / `cast(np.ndarray, ...)` 收窄（`warn_return_any`）；不留任何 `# type: ignore`；`dict[str, Any]` 合法（`disallow_any_explicit` 未启用）；裸 `np.ndarray` 可用（numpy 2.x 有 PEP 696 默认类型参数）。
- `.venv/bin/python -m ruff check` —— **新文件必须 0 error**（全仓当前有 4 处既有欠债，非本次引入）。`line-length = 100`、`select = ["E","F","I","UP","B","SIM"]`；用 `X | Y` 而非 `Optional`、`isinstance(x, int | float)`、`collections.abc` 而非 `typing`。**不得**用整文件 `# ruff: noqa`（`review.py:1` 是唯一先例，不该效仿）。
- 每个模块首行 `"""..."""` docstring + `from __future__ import annotations`；公共 dataclass 一律 `@dataclass(frozen=True, slots=True)`；每个模块自定义一个继承 `ValueError` 的错误类，不抛裸 `ValueError`。

---

## 11 未决风险与必须先修的缺陷

### 11.1 必须在实现第一步修掉的缺陷

1. **`posture_criteria.py:536` 的 `KeyError`**：引用 `THRESHOLDS["sitting_thigh_max_deg"]`，而字典里定义的是 `"sitting_thigh_min_deg"`（`posture_criteria.py:109-118`）。`sitting` 判据一旦被评估就会崩。**且比较方向也错**（应为 `above`）。
2. **`biomech.py:437` 的 σ_axis 用了单点 σ**（`frame.sigma_px[indices[0]]`），等权 PCA 下可接受，改成 `1/σ_COCO²` 加权后必须同步改为加权形式。
3. **`biomech.py` 的 `com2d` 只在 docstring 里出现，没有实现**（§8.2 已列为必须新增）。

### 11.2 风险清单

| # | 风险 | 严重度 | 缓解 | 残留 |
|---|---|---|---|---|
| R1 | **沿光轴躺 → 被判 standing 或 unknown** | 🔴 高，结构性 | `compactness` + `body_elongation` 硬护栏 → `unknown` | 无法根除。几何上正确（我们确实没有证据），安全上是**漏报**。必须写进产品说明，且机位安装建议避免让床/沙发长轴对准光轴 |
| R2 | **正对/背对相机的跌倒在像平面上是低速事件** | 🔴 高，结构性 | 强制 `uncertain_transition`；`sagittal_observability` 门 | **禁止**把"没看见"报成 `normal_transition`——这是本产品最危险的失效模式 |
| R3 | **lying 在 MoveNet 训练分布之外** | 🔴 高 | 验证集必须**大量**覆盖卧姿并实测 PCK；掉太多就把 lying 收紧到只在高置信构型下给出 | 无法用 B 侧算法弥补（TPAMI 2023 SLP 明证） |
| R4 | **本项目无 sitting/lying/bending 的真实人体数据** | 🔴 高 | 影子模式（G8）+ 四层验证协议 | 在补拍前，这三类**永远不能**报 precision/recall |
| R5 | **COCO hip 标注 ≠ 髋关节中心，且承载 35.2% 的 CoM 权重** | 🟠 中高 | 只用相对量、不用 CoM 绝对位置；主判据换成 9 点加权主轴 | 系统性偏移，方向未知，无文献常数可修正 |
| R6 | **躯干单刚体假设在 `bending_or_crouching` 上最弱** | 🟠 中高 | 该类额外引入不依赖躯干质心的 Q5/Q6/Q7 | 恰好压在关键判别边界上；该类拒判率会更高 |
| R7 | **膝角在坐姿/桌下遮挡时可用率可能极低** | 🟠 中高 | 上线前**必须先实测可用率**；不足则整链降级 `unknown` | 若不可用，bending vs crouching 的唯一稳定几何差异就没了 |
| R8 | **相机 roll / pitch 未知** | 🟠 中高 | 每 scene 标定 `g`；未标定加 `roll_tol` 保护带 | pitch ≠ 0 时"体段相对重力的三维倾角"恢复退化，`lying` 尤其敏感 |
| R9 | **`smoothed=true` 时滤波带宽未知** | 🟡 中 | §2.5.7 时序头拒判 | 需要 A 补 `smoothing` 元数据；这是 schema 空白 |
| R10 | **是否做了 intelligent cropping 未知** | 🟡 中 | `σ_abs` 在整图坐标下的值完全取决于此 | 需向 A 书面确认 |
| R11 | **老年人体型与两套人体测量表的总体都不匹配** | 🟡 中 | 只用尺度不变的相对特征 + 在目标人群上校准 | 跨总体迁移带来 ~12% 环节参数偏差。**绝不可声称对老年人准确** |
| R12 | **MoveNet Model Card 明写 "surveillance is explicitly out of scope"** | 🟡 中（合规） | 产品定位为"知情同意下的居家动作事实提取"，不表述为监控 | 这是模型作者的明示边界，不是技术问题，需产品/法务留档 |
| R13 | **`RealtimePostureTracker` 的节流会跳过非 emit 帧** | 🟡 中（工程） | §8.5 的 `ingest_frame` / `emit_if_due` 双方法，由分类器自己维护 30 Hz 缓冲 | 若实现者图省事直接在 `predict_record` 里做时序，会得到 7.5 Hz 采样的时序特征 —— 跌倒下降相只有 4.4 个样本 |
| R14 | **合同与实现已漂移**（CareDecision 已有 `consent_required` / `action_card` 等，合同 §11 L464 说本版不含） | 🟡 中（文档） | 本设计不碰 CareDecision；若时间线要记录决策，按**实现**的字段集来，并在文档里标注"超出 abc-interface v0 合同" | crosscheck P0-4 仍开放，是当前最大开放项 |
| R15 | **live 会话的时间线文件对 C 没有读取路径** | 🟡 中（缺口） | 本设计只负责落盘与本地查询 API | 需要新端点或新约定；`api-for-c.md` L43-45 只服务 bundle |
| R16 | **ADR 编号撞号** | 🟡 中（流程） | 本设计若需新 ADR，取 **0007**；**不要占 0004**（已预留给 `adr-0003-keypoint-frame-record` 的改号） | 那份未合入的 ADR 还含一句与已 Accepted 的 ADR-0003 冲突的隐私口径，改号时必须一并改 |
| R17 | **ADR-0006 的 L1/L2/L3 认知模块全是 `NotImplementedError`** | 🟡 中 | 本设计不依赖 `BehaviorFeatures` / `BehaviorMemoryStore` | 反过来，本设计的时间线存储可以成为那三层缺的持久化底座（`behavior.py:19` 的 120 s 窗口正对 §6.1 Q-F） |
| R18 | **团队在压力下引用文献准确率** | 🟠 中高（红线） | §10.6 CI 守卫 + §9.6 报告模板 | Bagalà 2012 是最好的反例教材：13 个算法自报 76–97%，真实跌倒上掉到 57.0% ± 27.3%，每天最多 85 次误报 |

### 11.3 一句话总结

> 用 de Leva (1996) 的 14 项定常线性组合作 CoM 代理、用 9 点加权稳健主轴作朝向主判据、用"大腿近水平 + 小腿近竖直"分开坐与躺、用膝角分开弯腰与下蹲、用 `compactness` 与 `mass_coverage` 把"我看不见"变成可执行的门；每个判据自带 σ、阈值自带 provenance、拒判自带原因码；时序在 30 Hz 内部跑、只把决策降到 5–10 Hz；证据落成独立的 append-only 流并配可重建的偏移索引，让 seek 之后历史仍在。**凡是单目 2D 拿不到的，一律拒判，不由模型补齐——这是本设计诚实性的全部内容。**
