# 测量误差与不确定度传播：单目 2D COCO-17 关键点下的可用量与误差预算

> 调研范围：姿态估计关键点的噪声特性 → 角度 / 速度 / 判据的误差传播 → 可编码的误差预算。
> 输入前提（唯一）：A 角色输出的 `movenet-17/v0-experiment` JSONL，MoveNet SinglePose Lightning，COCO-17，
> 归一化图像坐标 `x,y ∈ [0,1]`（原点左上，y 向下），单人、室内固定机位、30 FPS、输出 5–10 Hz。
> **无深度、无内外参、无米制尺度、无力板、无 IMU、无 3D。**
>
> 引用规范：本文所有论断带 URL / DOI。凡未能读到原文的，逐条标注「未读原文」。
> 已按项目约定排除 MDPI 与 Frontiers 来源。
> 本文出现的所有传播公式均已用 Monte-Carlo（N=2×10⁵–4×10⁵）实测校验，脚本见文末「附录 A 复现方式」。

---

## 1 结论摘要（5 条）

1. **置信度分数不是误差估计，且在本项目条件下不可直接标定。**
   MoveNet 的 score 是 CenterNet 式热图峰值，官方模型卡只承诺"出画的关键点会给低分"，从未承诺分数与像素误差的对应关系。
   ICML 2024 的 *On the Calibration of Human Pose Estimation* 证明：热图类方法的置信度存在系统性 **scaling gap**——
   它等价于一个 **与实例尺度 s 无关的常数** `l̃²/(σ²+l̃²)`，而真实的 OKS 目标 `l²/(σ²+l²)` 中 `l` 随实例大小和关键点类型变化。
   **推论：同一个 score=0.6，在近处大人和远处小人身上代表完全不同的绝对像素误差。score 只能当作"分尺度分关键点"的排序量，禁止当概率用。**

2. **误差从关键点传到角度的放大倍数只由"段长/噪声比"决定，且有闭式解并已实测校验。**
   两点段方位角：`σ_θ ≈ σ_p·√2 / L`；三点关节角（顶点 B，边长 Lu、Lw，夹角 θ）：
   `σ_θ ≈ σ_p·√(2/Lu² + 2/Lw² − 2cosθ/(Lu·Lw))`。
   在 `σ_p/L ≤ 0.1` 时该线性化与 MC 实测误差 <1%；`σ_p/L = 0.33` 时低估 12%（见 §4.3 有效性门）。
   在 `σ_p = 0.02·H`（H = 人体在画面中的高度，属 MoveNet Lightning 的现实量级）下：
   躯干倾角 σ≈5.6°，膝角 σ≈11.4°，**肘角 σ≈17.2°**。**肘/腕/前臂类角度在本项目任何尺度下都不可用。**

3. **最可靠的角度不是躯干两点向量，而是可靠关键点云的加权主轴。**
   主轴角的精度是 `σ_axis = σ_p / √(Σ_k (t_k − t̄)²)`（t_k 为点在主轴上的投影坐标），MC 实测吻合到 0.3%。
   9 个核心点（鼻+双肩+双髋+双膝+双踝）在站立构型下 `Σ(t−t̄)² = 0.906·H²`，
   于 σ_p=0.01H 时给出 **σ_axis ≈ 0.60°**，而两点躯干向量只有 2.81°——**精度差 4.7 倍**。
   代价：主轴会被四肢构型系统性带偏（那是信号不是噪声），必须限定核心点子集 + 逆方差加权。

4. **差分必须先滤后导，且噪声放大量级是可以预算出来的。**
   白噪声经中心差分放大 `fs/√2 = 21.2 /s`（30 FPS）：σ_p=0.02H → σ_v = 0.42 H/s 的纯噪声，
   而"跌倒式下降"参考量级仅 ~1.0 H/s，SNR≈2.4，**不可用**。
   换 Savitzky–Golay（w=9, p=2）导数核，噪声增益从 0.707 降到 0.129（**5.5 倍**），σ_v=0.077 H/s，SNR≈12.9，才勉强可用。
   二阶导（加速度）在任何配置下都不可用：σ_p=0.02H 时 σ_a = 44 H/s²，而重力在 1.7 m 人体上只有 5.8 H/s²——**噪声是信号的 7.6 倍。禁止在本项目使用二阶导数特征。**

5. **拒判（unknown）必须是多门联合的硬约束，且门限只能由验证集风险-覆盖曲线定，不得硬编码。**
   可落地的门有五道：尺度门（S_body 下界）、覆盖门（分关键点的 score 阈值）、
   **单边**骨长门（投影只会缩短不会拉长，所以只有"观测长度超出解剖上界"是有效证据）、
   时间连续门（位移/骨长变化率上界）、**传播不确定度门**（把 §4 的 σ_θ 直接算出来跟阈值比）。
   其中第五道是本设计能诚实给置信度的关键：**它把"这一帧的几何量到底有多准"变成一个可计算的数，而不是一个猜的常数。**

---

## 2 理论与一手文献（论断 → 出处 → 原始条件）

### 2.1 关键点定位误差的量级与分布

#### 2.1.1 标注方差下界：COCO OKS 的 σ_i（本项目最硬的定量锚点）

**论断**：COCO 官方给出的每类关键点标准差 σ_i 是**人类标注者之间**的离散度，是任何模型误差的**下界**；
且它在关键点之间差异极大——**髋是最差的（σ=0.107），是鼻子（0.026）的 4.1 倍**。

**出处（已读原文）**：COCO Keypoint Evaluation 官方页
<https://cocodataset.org/#keypoints-eval>（正文取自官方仓库源文件
<https://raw.githubusercontent.com/cocodataset/cocodataset.github.io/master/dataset/keypoints-eval.htm>）

官方定义逐字：

```
OKS = Σ_i [ exp(−d_i² / (2 s² κ_i²)) · δ(v_i>0) ] / Σ_i [ δ(v_i>0) ]
d_i : ground truth 与检测关键点之间的欧氏距离
s   : object segment area 的平方根（实例尺度）
κ_i = 2σ_i
σ_i² = E[ d_i² / s² ]，用 val 中 5000 张冗余标注图像测得
```

官方 σ 值（人体）：

| 部位 | nose | eyes | ears | shoulders | elbows | wrists | hips | knees | ankles |
|---|---|---|---|---|---|---|---|---|---|
| σ_i | .026 | .025 | .035 | .079 | .072 | .062 | **.107** | .087 | .089 |
| 相对权重 σ_i/σ_nose | 1.00 | 0.96 | 1.35 | 3.04 | 2.77 | 2.38 | **4.12** | 3.35 | 3.42 |

**原始条件**：COCO 2017 val 的 5000 张图，人工冗余标注，`s` = 分割掩码面积的平方根。
**这是"标注者对同一张图的分歧"，不含任何模型误差、不含时序抖动、不含域外分布。**

**对 Reme 的直接后果（关键）**：
- 髋关节点（COCO-17 的 11/12）是全身最不确定的关键点。而 Reme 判 standing / sitting / lying / bending 的核心几何量——躯干轴——**两端之一正是髋**。这个矛盾必须在设计里正面处理（见 §4.2 用主轴替代两点躯干）。
- 腕（.062）居然比肩（.079）和肘（.072）更准，因为腕是视觉上有明确边界的表面标志，而肩/髋的"关节中心"藏在身体内部、只能靠标注者猜。**这提醒我们：score 高 ≠ 定位准，两者的物理来源不同。**
- σ_i 是**相对**量（已被 s 归一），因此可以在不知道 Reme 场景里 s 是多少的情况下，直接把 σ_i 当作**分关键点的相对噪声权重**使用；只需在验证集上标定一个全局标量 κ（见 §5.2）。

由 OKS 反解距离（本文计算，公式来自上引官方定义 `d = s·κ_i·√(2 ln(1/OKS))`）：

| 部位 | d(OKS=0.9) | d(OKS=0.5) |
|---|---|---|
| nose | 0.024·s | 0.061·s |
| shoulder | 0.073·s | 0.186·s |
| hip | **0.098·s** | **0.252·s** |
| knee | 0.080·s | 0.205·s |
| ankle | 0.082·s | 0.210·s |

**读法**：一个 OKS=0.9（在 COCO 语境下算"很准"）的髋关键点，仍可以偏离真值 0.098·s。
按 s ≈ 0.35·H 的粗略换算（站立人的掩码面积开方 vs 身高，本文估计，**非文献值，必须用验证集覆盖**），
这相当于 **0.034·H** 的髋定位误差——已经超过 §4.3 表里"σ_p/H = 0.03"那一列。

#### 2.1.2 MoveNet SinglePose Lightning 官方模型卡（已读全文）

**出处**：MoveNet.SinglePose Model Card（Google 官方 PDF，Beletti / Chen / Oerlemans / Votel）
<https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf>

逐字要点：

- 架构：`MobileNetV2 image feature extractor with Feature Pyramid Network decoder (to stride of 4) followed by CenterNet prediction heads with custom post-processing logic.` Lightning 深度乘子 1.0。
- 输入：Lightning `192x192x3`（int32，RGB，[0,255]）。**FPN 解到 stride 4 ⇒ 热图网格 48×48。**
- 输出：`[1,1,17,3]`，前两通道是 **yx**（注意是 y 在前）归一化到 [0,1]，第三通道是 `prediction confidence scores`。
- 关于 score 的**唯一**官方语义：
  `The model predicts 17 human keypoints of the full body even when they are occluded. For the keypoints which are outside of the image frame, the model will emit low confidence scores. A confidence threshold (recommended default: 0.3) can be used to filter out unconfident predictions.`
- 使用条件：`Most suitable for detecting the pose of a single person who is 3ft ~ 6ft away from a device's webcam`。
- 评测：COCO val2017 单人子集（919 张）与自建 Active 集（1161 张 YouTube fitness/yoga/dance）。
- 训练数据：COCO train2017 过滤到 ≤2 人（28k）+ Active 训练集（23.5k YouTube 健身/拉伸/舞蹈）。
- Out-of-scope（官方明写）：`Any form of surveillance or identity recognition is explicitly out of scope and not enabled by this technology.`

官方 Keypoint mAP（Lightning）：

| 切片 | COCO val2017 单人 | Active 单人 |
|---|---|---|
| Male / Female | 67.4 / 65.4 | 90.2 / 87.8 |
| Young / Middle / Old | 65.6 / 68.0 / 72.1 | 89.1 / 89.3 / 85.7 |
| Skin tone Darker / Medium / Lighter | **60.5 / 61.2 / 74.4** | 89.1 / 92.2 / 92.9 |

**必须写进风险清单的三条**：

1. **"即使被遮挡也会预测全部 17 个点"**——MoveNet 在遮挡下会**编造**关键点位置，而模型卡只承诺"出画会低分"，
   **没有**承诺"画面内被遮挡会低分"。老人坐在沙发上下肢被茶几挡住、躺在床上被被子盖住，都是"画面内遮挡"。
   → **不能把 score 当遮挡检测器用。必须另外用几何一致性（§4.5）来抓这类编造。**
2. **域外分布**：训练/评测数据是 COCO 在野图 + YouTube 健身/瑜伽/舞蹈。**没有**卧床/跌倒/老年居家场景。
   COCO val 上 Lightning 只有 65–74 mAP，Active 上才 88–93——**跨域掉 20+ 点是官方自己的数据。**
   Reme 的目标域（室内固定机位、老人、lying）与两个评测集都不同，**任何借用这些数字的准确率声明都是编造。**
3. **公平性缺口**：COCO val 上 darker 60.5 vs lighter 74.4，**差 13.9 mAP**。这是官方自报的。
   产品红线相关：分类器阈值若在单一肤色/体型的验证集上标定，会把这个缺口直接转成分组假阴性。

#### 2.1.3 tfjs 运行时的隐藏滤波（已读源码，直接影响 JSONL 的 `smoothed` 字段解释）

**出处（已读原文）**：`tensorflow/tfjs-models` 官方源码
<https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts>
与 <https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/README.md>

官方常量逐字：

```
KEYPOINT_FILTER_CONFIG = { frequency: 30, minCutOff: 2.5, beta: 300.0,
                           derivateCutOff: 2.5, thresholdCutOff: 0.5,
                           thresholdBeta: 5.0, disableValueScaling: true }
DEFAULT_MIN_POSE_SCORE  = 0.25
MIN_CROP_KEYPOINT_SCORE = 0.2
CROP_FILTER_ALPHA       = 0.9
MOVENET_SINGLEPOSE_LIGHTNING_RESOLUTION = 192
```

README：`enableSmoothing` — `a boolean indicating whether to use temporal filter to smooth the predicted keypoints. Defaults to True.`

这是 **One Euro Filter**（Casiez / Roussel / Vogel, CHI 2012, DOI [10.1145/2207676.2208639](https://dl.acm.org/doi/10.1145/2207676.2208639)，
官方算法页已读 <https://gery.casiez.net/1euro/>），其自适应截止频率为：

```
f_c = f_cmin + β·|x̂'|        α = 1 / (2π f_c T + 1)
官方调参指南：decreasing fcmin reduces jitter but increases lag;
             if high speed lag is a problem, increase beta.
```

**对 Reme 的致命推论（必须在 A/B 接口上确认）**：

- 若 A 角色的 `smoothed=true` 来自 tfjs 默认路径，则关键点**已经**过了一层 One Euro：
  静止时 `f_c ≈ minCutOff = 2.5 Hz`（强平滑），高速运动时 `β·|x̂'|` 项爆炸、`f_c` 冲到几十 Hz（几乎不滤）。
- **这正好和 fall detection 的需求相反**：跌倒是高速事件，恰恰落在"几乎不滤"的区间，
  即**跌倒瞬间拿到的是噪声最大的原始关键点**，而"静止误判"区间反而被过度平滑。
- 且滤波后噪声**不再是白噪声**（帧间强相关），所以 §4.4 里所有"白噪声 → √N 衰减"的预算在 `smoothed=true` 时是**乐观的**；
  再叠一层自建滤波会**复合延迟**而不会复合降噪。

**行动项**：JSONL 的 `smoothed` 必须区分"未滤 / One-Euro 已滤"两种语义，且 B 侧的滤波器设计必须按这两种情况分叉。
建议向 A 角色要求：**输出未平滑的原始关键点**（`enableSmoothing:false`），把滤波完全放到 B 侧可控。

#### 2.1.4 BlazePose：visibility 的真实语义 + 人类标注上限（已读全文）

**出处**：Bazarevsky et al., *BlazePose: On-device Real-time Body Pose tracking*, arXiv:2006.10204
<https://arxiv.org/abs/2006.10204>

逐字：`we simulate occlusions (random rectangles filled with various colors) during training and introduce
a per-point visibility classifier that indicates whether a particular point is occluded and if the position
prediction is deemed inaccurate.`

**推论**：BlazePose 的 visibility 是一个**训练出来的二元遮挡分类头**，语义是"被遮挡/位置不准"的混合标签，
**不是**定位误差的方差估计。MoveNet 的 score 是热图峰值，语义又不一样。**两者都不是标定过的不确定度。**

BlazePose 的评测数字（原始条件：自建 1000 张 in-house 数据，PCK@0.2 以躯干尺寸归一）：

| 方法 | AR Dataset PCK@0.2 | Yoga Dataset PCK@0.2 |
|---|---|---|
| **人类标注者复标（上限）** | **97.2** | — |
| OpenPose (body only) | 87.8 | 83.4 |
| BlazePose Full | 84.1 | 84.5 |
| BlazePose Lite | 79.6 | 77.6 |

**这张表是本调研最重要的分布形状证据**：
- 连**人**都有 2.8% 的点误差超过躯干尺寸的 20%；
- 轻量模型有 **16–22%** 的点误差超过 0.2·torso ≈ 0.058·H（按 torso≈0.29H 换算）。
- **即误差分布是重尾的**：不能只用一个 σ 描述，必须假设有 10–20% 的点是"离群"（gross error），
  这直接决定了 §4 的稳健估计必须用中位数/加权最小二乘而不是普通均值。

#### 2.1.5 独立验证：2D 单目关键点 → 关节角，误差到底多少度

**(a) Stenum / Rossi / Roemmich 2021（已读原文，与 Reme 条件最接近）**
*Two-dimensional video-based analysis of human gait using pose estimation*,
PLOS Computational Biology 17(4):e1008935, DOI [10.1371/journal.pcbi.1008935](https://doi.org/10.1371/journal.pcbi.1008935)

- 原始条件：**单目矢状面 2D 视频，25 Hz，960×540**，OpenPose，实验室内步行，同步 3D 光学动捕作真值。
- 关键点轨迹先过 **零相位 4 阶 Butterworth 低通，截止 5 Hz**；≤0.12 s 的缺口线性插值。
- 矢状面关节角 MAE：**髋 4.0°，膝 5.6°，踝 7.4°**。
- 时间参数 MAE 0.02 s；步长 MAE 0.049 m。
- 作者明说踝角精度不足以检测组间小变化；且步长有**随人在画面中位置变化的系统误差**（画面中心最小）。

**(b) Washabaugh et al. 2022（已读 PubMed 完整摘要，PMID 35988434）**
*Comparing the accuracy of open-source pose estimation methods for measuring gait kinematics*,
Gait & Posture 97:188–195, DOI [10.1016/j.gaitpost.2022.08.008](https://doi.org/10.1016/j.gaitpost.2022.08.008)

- 原始条件：32 名健康成人，矢状面视频，对比 OpenPose / **MoveNet Lightning** / **MoveNet Thunder** / DeepLabCut vs 标记点动捕。
- 髋运动学全步态周期平均误差：OpenPose **3.7 ± 1.3°**，**MoveNet Thunder 4.6 ± 1.8°**。
- 膝：OpenPose **5.1 ± 2.5°** 最优。
- 结论原文：OpenPose 显著优于其他平台。**MoveNet Lightning 未进入"最准"之列——Reme 用的正是 Lightning。**

**(c) Needham et al. 2021（已读 PMC 全文要点）**
*The accuracy of several pose estimation methods for 3D joint centre localisation*,
Scientific Reports 11:20673, DOI [10.1038/s41598-021-00212-x](https://doi.org/10.1038/s41598-021-00212-x)

- 原始条件：**多机位 200 Hz** 高速图像 + 标记点动捕，OpenPose/AlphaPose/DeepLabCut，2D 检测后三角化到 3D。
- **髋与膝有 ~30–50 mm 的系统性偏差**，踝 1–15 mm。
- 作者归因：`likely a result of large-scale mislabeling of hip joint centre locations in the datasets used to train each deep learning model.`

**这条对 Reme 的意义极大**：髋的误差主体是**系统性偏差（bias）**，不是随机抖动。
系统偏差**不会**被任何时域滤波或多帧平均消掉。
→ **模型误差必须拆成两部分预算**：`ε = b（系统偏差，不随时间平均衰减）+ n（帧间抖动，可滤）`。
→ 任何"多帧平均就能提精度"的假设都只对 n 成立。

**(d) 域外：lying pose**
Liu, Huang, Fu, Li, Su, Ostadabbas, *Simultaneously-Collected Multimodal Lying Pose Dataset:
Enabling In-Bed Human Pose Monitoring*, IEEE TPAMI 2023, DOI [10.1109/TPAMI.2022.3155712](https://doi.org/10.1109/TPAMI.2022.3155712)；
预印本 arXiv:2008.08735 <https://arxiv.org/abs/2008.08735>（**未读全文，仅读官方摘要**）。
摘要要点：卧姿估计"被忽视"，其特有困难（光照条件不同、**姿态分布不同**）显著削弱通用姿态估计模型的有效性；
需专门的 SLP 数据（109 名受试）训练才能到 PCKh@0.5 ≈ 95%。

**推论**：Reme 的 `lying` 类别正处在 MoveNet 训练分布之外。**这是本项目最大的单点风险，且无法用 B 侧算法弥补，只能靠拒判和验证集实测暴露。**

### 2.2 置信度是否可标定

**论断 A（一般性）**：现代深度网络的置信度系统性过自信。
Guo, Pleiss, Sun, Weinberger, *On Calibration of Modern Neural Networks*, ICML 2017, PMLR v70:1321–1330
<https://proceedings.mlr.press/v70/guo17a.html>（**未读全文，读官方页摘要 + arXiv:1706.04599 摘要**）。
核心：现代网络（ResNet 类）比早期网络（LeNet）**校准更差**；temperature scaling 这类单参数后处理常常够用。

**论断 B（姿态估计专属，本节最关键）**：
Gu, Chen, Yao, *On the Calibration of Human Pose Estimation*, **ICML 2024**（dblp 已确认会议；预印本 arXiv:2311.17105
<https://arxiv.org/abs/2311.17105>，已读 HTML 全文）。

逐条（含论文方程编号）：

- **理想置信度**（Eq.12）：`s_OKS = l²/(σ² + l²) = 1 − σ²/(σ² + l²)`，其中 `l` 是与**实例尺度相关**的 OKS 缩放，`σ` 是标注不确定度。
- **热图类的 scaling gap**（Eq.17）：实际输出 `ŝ_det = l̃²/(σ² + l̃²)`，
  论文原话：`This difference comes from that l̃ is a constant value whereas l changes according to
  different instance sizes and keypoints.`
- **回归（RLE）类的 form gap**（Eq.19）：`ŝ_reg = 1 − σ̂`，是 σ̂ 的**线性**形式，
  `only models annotation variation but ignores instance size`，与 OKS 的指数包络形状不匹配。
- 影响量级：把置信度换成常数，SimpleBaseline 的 mAP 从 72.4 掉到 67.5（说明 score 在排序上确实携带信息，但形状是错的）。
- 他们的校准方案 CCNet 需要**网络倒数第二层特征**作为输入，用 **per-keypoint OKS** 作监督（Eq.20 `L_conf = Σ(ŝ_k − s_k)²`）。
  校准后 OKS 与置信度的 Pearson 相关从 0.643 升到 0.718。

**对 Reme 的三条硬结论**：

1. **MoveNet 是 CenterNet 热图头（模型卡自证），因此 scaling gap 直接适用。**
   `score` 缺少实例尺度这一维 ⇒ **score 单独不能反解像素误差**。
2. **即使做了校准，OKS 与置信度的相关也只有 0.718**——共享方差约 52%。
   也就是说，**最好情况下 score 也只解释了一半的误差变异。** 任何"score 高就当准"的设计都在赌另一半。
3. **CCNet 路线在 Reme 不可用**：它要网络内部特征，而 A/B 接口只给 (x, y, score)。
   → 本项目**唯一**可行的标定路线是：在自己的验证集上，按 `(关键点类别 × 尺度分箱 × score 分箱)` 三维统计经验误差分位数，
   把 score 当**分箱索引**而不是概率。这必须写进 §5.2 的标定清单。

### 2.3 关键点噪声 → 关节角的传播

**(a) 生物力学侧的一手依据（原始条件：完整 3D 动捕 + 标记点）**
Fonseca, Armand, Dumas, *An analytical model to quantify the impact of the propagation of uncertainty
in knee joint angle computation*, International Biomechanics 9(1):10–18, 2022,
DOI [10.1080/23335432.2022.2108898](https://doi.org/10.1080/23335432.2022.2108898)（已读 PMC 版
<https://pmc.ncbi.nlm.nih.gov/articles/PMC9397457/>）。
方法：标准 GUM 一阶不确定度传播 `u²_y = Σ_j (∂y/∂x_j)² u²_{x_j}`（论文 Eq.9 是其在关节坐标系分式形式下的展开）。
其原始条件是**3D 关节坐标系 + 旋转轴姿态向量**，与 2D 图像角度不同构，**不能照搬公式**；
可照搬的是**方法论**：一阶偏导传播 + 逐输入不确定度。

**(b) 本项目自行推导并已 MC 校验的 2D 形式**（这是本文的原创贡献部分，推导过程与校验见 §4.3 / 附录 A）

设点噪声各向同性、逐轴标准差 σ_p、点间独立：

- **两点段方位角**（A→B，段长 L）：
  `δφ = (n̂ · (δB − δA)) / L`，n̂ ⟂ 段方向 ⇒ `Var(φ) = 2σ_p²/L²`
  ⇒ **`σ_φ = √2 · σ_p / L`（弧度）**
- **三点关节角**（顶点 B，u = A−B 长 Lu，w = C−B 长 Lw，夹角 θ）：
  `δθ = n̂_w·δC/Lw − n̂_u·δA/Lu − (n̂_w/Lw − n̂_u/Lu)·δB`，且 `n̂_u·n̂_w = cos θ`
  ⇒ **`σ_θ = σ_p·√( 2/Lu² + 2/Lw² − 2cosθ/(Lu·Lw) )`（弧度）**

MC 校验（N=4×10⁵，圆统计标准差）：

| Lu | Lw | θ | σ_p | σ_p/L_min | 预测(°) | MC(°) | 比值 |
|---|---|---|---|---|---|---|---|
| 0.20 | 0.20 | 180° | 0.010 | 0.050 | 7.02 | 7.01 | 0.999 |
| 0.20 | 0.20 | 90° | 0.010 | 0.050 | 5.73 | 5.73 | 1.000 |
| 0.25 | 0.20 | 150° | 0.008 | 0.040 | 4.95 | 4.96 | 1.001 |
| 0.10 | 0.08 | 120° | 0.010 | 0.125 | 14.47 | 14.64 | 1.012 |
| 0.05 | 0.05 | 170° | 0.010 | 0.200 | 28.00 | 28.85 | 1.030 |
| 0.03 | 0.03 | 170° | 0.010 | 0.333 | 46.66 | 52.29 | **1.121** |

**线性化的有效边界（可直接编码成门）**：`σ_p / L_min ≤ 0.10` 时误差 <1%；
`≤ 0.20` 时 <3%（可接受，偏乐观）；**`> 0.25` 时公式系统性低估 >6%，此时该角度应直接判 unavailable。**

**(c) 结构性结论**：因为 L 在分母，**短段角度对像素噪声的敏感度按 1/L 发散**。
在 COCO-17 里段长排序（占身高比例，见 §4.1）：躯干 0.288 > 小腿/大腿 ≈0.245 > 上臂 0.186 > 前臂 0.146。
**⇒ 前臂/肘角的噪声放大是躯干的 ~2 倍，是本项目最先应当放弃的量。**

### 2.4 差分求速度的噪声放大：为什么必须先滤后导

**(a) 一手依据（生物力学侧）**
Winter, Sidwall, Hobson, *Measurement and reduction of noise in kinematics of locomotion*,
Journal of Biomechanics 7(2):157–159, 1974,
DOI [10.1016/0021-9290(74)90056-6](https://doi.org/10.1016/0021-9290(74)90056-6)
（**未读原文**：ScienceDirect 403；DOI/卷/页经 Crossref API 核实）。
经检索到的摘要要点：所有运动学系统都会给空间信号加噪；这些噪声**在空间轨迹上肉眼不可见**，
但在求速度和加速度时会造成大误差。**这正是本项目的核心命题的原始出处。**

Winter, *Biomechanics and Motor Control of Human Movement*, Wiley,
DOI [10.1002/9780470549148](https://doi.org/10.1002/9780470549148)
（**未读官方全文**，Wiley 付费墙；书目元数据经 Crossref 核实）。
Ch.3 的 **residual analysis** 选截止频率法与 Ch.4 的人体测量学表是本项目引用的两处。

**residual analysis 方法（通行表述，未读官方原文，标注为二手转述）**：
以一系列截止频率 f_c 分别做零相位 Butterworth 低通，计算残差
`R(f_c) = √( (1/N) Σ_n (x_n − x̂_n(f_c))² )`；
在高 f_c 区间 R(f_c) 近似线性（此时只滤掉白噪声），把该线性段外推到 f_c=0 得截距 a
（= 噪声 RMS 的估计）；令 `R(f_c*) = a` 的 f_c* 即为最优截止频率。
该方法的前提假设是**加性零均值高斯白噪声**。

**对照的一手来源（可读到摘要）**：Challis, *A Procedure for the Automatic Determination of Filter Cutoff
Frequency for the Processing of Biomechanical Data*, Journal of Applied Biomechanics 15(3):303–317, 1999,
DOI [10.1123/jab.15.3.303](https://doi.org/10.1123/jab.15.3.303)
（**未读全文**，Human Kinetics 403；摘要经检索）。
其做法：系统性变化 Butterworth 截止频率，直到"滤波前后之差"在**自相关函数**意义上最接近白噪声。
**这条对 Reme 特别重要**：它给出了一个**可直接编码的自检**——
如果 `(原始 − 滤波)` 的残差序列自相关在 lag≥1 上显著非零，说明截止频率取得太低、把信号也滤掉了。

**(b) 噪声增益的闭式解 + 实测**（本文推导并 MC 校验，白噪声、σ=1、Δt=1 帧）

| 差分算子 | 噪声增益 g（= ‖核‖₂） | MC 实测 |
|---|---|---|
| 前向差分 `x[n]−x[n−1]` | √2 = 1.4142 | 1.4147 |
| 中心差分 `(x[n+1]−x[n−1])/2` | 1/√2 = 0.7071 | 0.7077 |
| 二阶中心差分 `x[n+1]−2x[n]+x[n−1]` | √6 = 2.4495 | 2.4499 |

带上采样率：`σ_v = g · f_s · σ_p`，`σ_a = g · f_s² · σ_p`。30 FPS 下 `f_s=30`，`f_s²=900`——**这是二阶导不可用的根本原因。**

频域上的等价说法：微分算子的频响是 `|H(ω)| = ω`，**对高频噪声的放大与频率成正比**。
白噪声在整个 Nyquist 带内均匀分布，微分后能量集中到带顶，所以"先滤后导"不是优化而是必要条件。

**(c) Savitzky–Golay 导数核（推荐方案）**
Savitzky & Golay, *Smoothing and Differentiation of Data by Simplified Least Squares Procedures*,
Analytical Chemistry 36(8):1627–1639, 1964,
DOI [10.1021/ac60214a047](https://doi.org/10.1021/ac60214a047)
（**未读原文**；DOI/卷/页经 Crossref 核实。SmoothNet 论文亦引用其作为滤波基线。）

本文用 `scipy.signal.savgol_coeffs(w, p, deriv=1)` 实测的噪声增益（Δt=1 帧）：

| 核 | 噪声增益 g | 相对中心差分的降噪 | 窗口时长 @30FPS | 单边延迟 |
|---|---|---|---|---|
| 中心差分 | 0.7071 | 1.0× | 0.10 s | 33 ms |
| SG w=5 p=2 | 0.3162 | 2.2× | 0.17 s | 67 ms |
| SG w=7 p=2 | 0.1890 | 3.7× | 0.23 s | 100 ms |
| **SG w=9 p=2** | **0.1291** | **5.5×** | **0.30 s** | **133 ms** |
| SG w=11 p=2 | 0.0953 | 7.4× | 0.37 s | 167 ms |
| SG w=15 p=2 | 0.0598 | 11.8× | 0.50 s | 233 ms |
| SG w=9 p=3 | 0.3381 | 2.1× | 0.30 s | 133 ms |
| SG w=15 p=3 | 0.1518 | 4.7× | 0.50 s | 233 ms |

**注意 p=3 比 p=2 差 2.5 倍**——高阶多项式保留了更多高频、降噪能力大跌。
本项目的运动带宽低（见 §5.1），**p=2 是正确选择，禁止无依据地上 p=3。**

**(d) 抖动是真实存在且量级已知的（一手实测）**
Zeng et al., *SmoothNet: A Plug-and-Play Network for Refining Human Poses in Videos*, ECCV 2022,
DOI [10.1007/978-3-031-20065-6_36](https://doi.org/10.1007/978-3-031-20065-6_36)，
官方 PDF 已读 <https://www.ecva.net/papers/eccv_2022/papers_ECCV/papers/136650615.pdf>。

- 官方定义：per-frame 精度用 MPJPE；平滑度/抖动用 **mean per joint acceleration error (Accel)**，
  `2D 姿态单位为 pixel/frame²`。
- Human3.6M 上的 2D 结果（Table 2）：

| Backbone | Accel (px/frame²) | MPJPE (px) | Accel-1%（最差 1%） |
|---|---|---|---|
| Hourglass | 1.54 | 9.42 | 2.71 |
| CPN | 2.91 | 6.67 | 4.17 |
| HRNet | 1.01 | 4.59 | 3.55 |
| RLE | 0.90 | 5.14 | 2.28 |
| + SmoothNet | **0.13–0.15** | 略降 | 0.19–0.26 |

- 论文原话：`the jitter problem is caused by pose estimation errors, which can be divided into two parts:
  the jitter error J between adjacent frames and the biased error S between the ground truth and smoothed poses.`
- 关于滤波器：`it inevitably faces the trade-off between jitters and lags, resulting in significant errors under long-term jitters.`

**两条可用推论**：
1. **抖动误差和偏置误差必须分开预算**（与 §2.1.5(c) 的 Needham 结论一致）。
   反解（本文计算）：Accel 是 2D 模长，`Accel = √6 · σ_iid · E[|·|]/σ`，取 2D 高斯 `E[|d|]=σ√(π/2)`
   ⇒ HRNet 的逐轴白噪声 `σ_iid ≈ 1.01/1.253/2.449 ≈ 0.33 px`；
   同法由 MPJPE 4.59 px 反解逐轴位置误差 `≈ 3.66 px`。
   ⇒ **位置误差里只有约 1/10 的幅度（约 1% 的方差）是帧间独立的白噪声，其余是帧间相关的偏置。**
   → **多帧平均能把角度抖动压下去，但压不掉系统性偏差。诚实的置信度必须包含一个不可消除的 bias 项。**
2. 滤波器路线固有 jitter–lag 折中，且对"长时抖动"（连续多帧整体偏离，如遮挡期间）无能为力
   ⇒ **长时抖动只能靠拒判处理，不能靠滤波处理。**

### 2.5 何时该直接判 unknown：拒判的理论依据

**(a) 选择性分类（reject option）的一手来源**
Geifman & El-Yaniv, *Selective Classification for Deep Neural Networks*, NeurIPS 2017, pp.4878–4887；
预印本 arXiv:1705.08500 <https://arxiv.org/abs/1705.08500>（**未读全文，读官方摘要**）。
核心：给定已训练网络，构造一个选择性分类器，**让用户设定目标风险水平**，
测试时按需拒判，从而以**高概率保证**该风险；实证在 CIFAR/ImageNet 上，
"top-5 误差 ≤2% 且置信度 99.9%"可在约 60% 覆盖率下达成。

**对 Reme 的直接映射**：
- unknown / uncertain_transition **不是失败模式，是产品的一等输出**。
- 门限**不应**由直觉设定，而应由验证集上的 **risk–coverage 曲线**给出：
  固定"可接受的选择性风险"（例如：在被判 lying 的帧里，错判率 ≤ X%），反解覆盖率对应的阈值。
- 这与产品红线（"不得编造准确率，证据不足必须拒判"）是同一件事的两种表述。

**(b) 各类判据在文献中的做法与其在 2D 下的有效性**

| 判据 | 文献中的常见做法 | 在单目 2D 归一化坐标下是否成立 |
|---|---|---|
| 可见点比例 | 按 score 阈值统计有效点数 | ✅ 成立，但阈值必须**分关键点**（COCO σ 差 4 倍，score 分布也不同） |
| 置信度阈值 | MoveNet 官方推荐 0.3；tfjs 内部 `MIN_CROP_KEYPOINT_SCORE=0.2` / `DEFAULT_MIN_POSE_SCORE=0.25`；文献中亦见 0.6 | ⚠️ 成立但**不可跨尺度迁移**（scaling gap，§2.2） |
| 骨长一致性 | 3D 里做双向约束（太长/太短都报警） | ⚠️ **在 2D 只有单边有效**：透视投影只会缩短不会拉长，"太短"与"前后缩短(foreshortening)"不可分辨。**只有"观测长度超出解剖上界"是有效证据** |
| 时间连续性 | 位移/速度上界、Kalman 门（Needham 用 bi-directional Kalman） | ✅ 成立，且是 2D 下最强的一道门 |
| 左右对称性 | 左右同名骨长应相等 | ❌ **在 2D 不成立**：左右肢体的出平面角不同，投影长度天然不等。只能做很宽的一致性检查 |

---

## 3 在单目 2D COCO-17 下的可观测 / 代理 / 不可观测逐项判定

> 记号：`K_i` = COCO-17 索引；`MS`=(K5+K6)/2 中肩；`MH`=(K11+K12)/2 中髋。
> 分类：**[O] 可观测**（存在无偏或已知有偏的估计）；**[P] 投影代理量**（能算，但与物理量之间隔着一个未知的出平面角）；
> **[X] 不可观测**（在给定输入下无法辨识，装作有就是编造）。

| # | 量 | 判定 | 理由（一手依据 / 几何论证） |
|---|---|---|---|
| 1 | 关键点在**图像平面**的位置 | **[O]** | 直接输出。误差量级见 §2.1 |
| 2 | 关键点的**真实 3D 位置** | **[X]** | 无深度、无内参。单目 2D 存在整条视线上的深度歧义 |
| 3 | **米制尺度**（身高 cm、位移 m、速度 m/s） | **[X]** | 无内参、无已知尺寸参照物。任何 "m/s" 输出都是编造。**必须全程用无量纲的 H 或 S_body 单位** |
| 4 | **躯干在图像平面的倾角** | **[O]** | 两点向量角，公式 §4.2。但精度受髋（COCO σ 最差）拖累 |
| 5 | **躯干相对重力的真实倾角** | **[P]** | 仅当躯干近似平行于像平面时二者才接近。人朝/背向相机弯腰时投影长度趋 0，倾角完全失真 |
| 6 | 关键点云的**主轴方向** | **[O]** | 精度最高的角度量（§4.2、§2.3）。有四肢构型偏置 |
| 7 | **膝角 / 髋角**（图像平面内） | **[P]** | 只有当大腿-小腿平面平行像平面时才≈真实关节角。侧向站立时膝角投影严重压缩 |
| 8 | **肘角 / 腕相关角** | **[X]（工程上）** | 段长最短（前臂 0.146H），σ_θ 在 σ_p=0.02H 时 17°，超过类别间的可分辨间距 |
| 9 | **肩宽 / 髋宽的投影长度** | **[P]** | 是"朝向"的代理量：正面最大、侧面趋 0。但与"人变远了"混淆，必须先归一化到 S_body |
| 10 | **人体朝向（面向相机 / 侧身 / 背对）** | **[P]** | 可由 (肩宽投影/S_ref) + 鼻/耳可见性联合推断，**只能给粗分档，不能给角度** |
| 11 | **关键点包围盒长宽比** | **[O]** | 纯 2D 量，本身就在图像平面定义。是 lying 最强的单一特征 |
| 12 | **图像平面速度** `dp/dt` | **[O]**（单位 H/s） | 需先滤后导，§2.4 |
| 13 | **真实三维速度 / 重心下降速度** | **[X]** | 深度分量不可观测；正对相机的下落在像平面上几乎不动 |
| 14 | **加速度 / 冲击（impact）** | **[X]（工程上）** | σ_a = √6·f_s²·σ_p，30 FPS 下噪声是重力的 3.8–11.5 倍（§4.4 表 F） |
| 15 | **地面反力 / 力矩 / 关节力矩** | **[X]** | 需力板或完整惯性参数 + 3D 运动学。Reme 无任何一项。**这也是医疗声明红线所在** |
| 16 | **重心（COM）** | **[P]** | 用 Winter 惯性参数需要 3D 段位姿与米制尺度。2D 只能算"关键点加权质心"，是一个**代理量，不是 COM**，必须换名字 |
| 17 | **人到相机的距离 / 深度变化** | **[X]** | 仅能得到"表观尺度变化"，与真实身高、体型、镜头畸变纠缠 |
| 18 | **骨长是否合理（超长）** | **[O]** | 单边判据，见 §4.5 |
| 19 | **骨长是否合理（过短）** | **[X]** | 与 foreshortening 完全混淆，不可辨识 |
| 20 | **遮挡状态** | **[X]（由 score 判）** | MoveNet 只承诺"出画低分"，未承诺"画内遮挡低分"，且模型卡明说会给被遮挡点输出坐标 |
| 21 | **每个关键点的定位误差（像素）** | **[X]（由 score 直接得）** / **[P]（分箱标定后）** | scaling gap，§2.2。**只有在"关键点类别 × 尺度分箱 × score 分箱"上做经验分位数标定后，才变成代理量** |
| 22 | **步态时空参数（步长/步频）** | **[P]** | Stenum 2021 在矢状面下可做，但需要人走过画面且有明确矢状视角；Reme 是固定机位任意朝向，不成立 |
| 23 | **是否发生了跌倒（物理事件）** | **[P]** | 只能观测"像平面上的快速姿态变化"。正对/背对相机的跌倒在像平面上是低速事件。**这是 fall_like_transition 必须承认的结构性盲区** |

**最需要写进设计文档的三条"不可假装拥有"**：

- **没有米制尺度** ⇒ 所有阈值必须以 `S_body` 或 `H` 为单位；任何 `0.5 m/s`、`2 g` 之类的阈值都是编造。
- **没有深度** ⇒ 朝向相机的运动（弯腰、下蹲、正面跌倒）在像平面上的位移被压缩到接近 0。
  `bending_or_crouching` 与 `fall_like_transition` 在这个方向上是**结构性不可观测**，只能拒判，不能靠算法补。
- **没有力/惯性信息** ⇒ 禁止任何涉及"冲击力""关节负荷""跌倒伤害风险"的表述（产品红线：不得做医疗声明）。

---

## 4 可直接编码的量与公式（COCO-17 索引写全）

### 4.0 索引与符号

```
0 nose      1 l_eye     2 r_eye     3 l_ear     4 r_ear
5 l_shoulder  6 r_shoulder  7 l_elbow  8 r_elbow  9 l_wrist  10 r_wrist
11 l_hip     12 r_hip     13 l_knee   14 r_knee   15 l_ankle 16 r_ankle

p_i  = (x_norm[i], y_norm[i])       # 注意 y 轴向下
s_i  = score[i]
MS   = (p_5 + p_6)/2                # mid-shoulder
MH   = (p_11 + p_12)/2              # mid-hip
û    = (0, -1)                      # 图像"上"方向（y 向下，故为 -1）
```

### 4.1 人体测量学先验（**只作 sanity check，不得作硬编码常数**）

来源：Drillis & Contini, *Body segment parameters*, TR-1166-03, NYU School of Engineering & Science, 1966；
经 Winter, *Biomechanics and Motor Control of Human Movement*（DOI [10.1002/9780470549148](https://doi.org/10.1002/9780470549148)）Fig.4.1 转述。
**未读原文**（TR-1166-03 无公开电子版；Winter 官方全文付费墙）——**数值为通行转述，项目内必须用验证集实测的 λ 覆盖。**
另注：检索到有文献指出 Drillis & Contini 的比例"来自一个从未被验证的人群，且未给出各比例所预测的人体尺寸的正式定义"，
**这进一步说明这些常数只能当先验，不能当真值。**

| 量 | 占身高 H 的比例 λ | COCO-17 实现 |
|---|---|---|
| 躯干（肩-髋） | 0.288 | ‖MS − MH‖ |
| 肩宽 | 0.259 | ‖p_5 − p_6‖ |
| 髋宽 | 0.191 | ‖p_11 − p_12‖ |
| 大腿 | 0.245 | ‖p_11 − p_13‖ / ‖p_12 − p_14‖ |
| 小腿 | 0.246 | ‖p_13 − p_15‖ / ‖p_14 − p_16‖ |
| 上臂 | 0.186 | ‖p_5 − p_7‖ / ‖p_6 − p_8‖ |
| 前臂 | 0.146 | ‖p_7 − p_9‖ / ‖p_8 − p_10‖ |
| 头-颈（鼻到中肩） | ~0.182 | ‖p_0 − MS‖ |

站立时各点的**离地高度**（同源）：鼻 0.936H、肩 0.818H、髋 0.530H、膝 0.285H、踝 0.039H。

### 4.2 尺度与朝向：三个层级的估计器

**(a) 帧内尺度 `S_frame`（旋转不变，卧姿也能用）**

```
core = {5,6,11,12} 中 score ≥ τ_kp 的点            # 至少 3 个
c    = weighted_mean(core, w = 1/σ_COCO_i²)
S_frame = 2 · sqrt( Σ_k w_k ‖p_k − c‖² / Σ_k w_k )   # 2 × 加权 RMS 半径
```
正面站立时理论值 `S_frame ≈ 0.366·H`（由 λ_肩宽/λ_髋宽/λ_躯干 推得，本文计算）。

**(b) 参考尺度 `S_ref`（推荐：所有阈值都用它，而不是 S_frame）**

固定机位 + 单人 ⇒ 真实体尺在秒级内不变，但 `S_frame` 会因 foreshortening 剧烈波动。
因此：
```
S_ref ← 对通过质量门的帧的 S_frame 取长窗（≥5 s）的高分位数（如 P75 或 P90），并做慢速跟踪
```
理由：投影**只会缩短**（§2.5(b)），因此 `S_frame` 的**上包络**才是真实尺度的无偏估计，中位数是有偏的。
**这一条是把"投影只会缩短"这个几何事实变成算法的关键。**

**(c) 表观身高 `H_hat`**（用于把 §4.3 的表读成度数）
```
H_hat = S_ref / 0.366        # 先验换算，只用于人类可读的诊断，不进入判据
```

### 4.3 角度量与其不确定度（**误差预算表，可直接编码**）

**噪声模型（三项，逐关键点）**

```
σ_p(i) = sqrt( ( κ · σ_COCO(i) · S_ref )²        # 相对项：随人体尺度缩放
              + σ_abs²                            # 绝对项：热图栅格 / 编码精度下限
              + b(i)²                             # 系统偏差项：不随时间平均衰减
             )
```

- `σ_COCO(i)`：§2.1.1 官方表，**这是唯一有一手文献支撑的部分**。
- `κ`：单个标量，表示"模型误差是标注误差的多少倍"。**必须验证集标定**，先验区间 2–4（由 §2.1.5 的 MAE 反推）。
- `σ_abs`：MoveNet Lightning 192×192 输入 + stride-4 FPN ⇒ 48×48 热图；一格 = 输入的 1/48 ≈ 0.021。
  有 offset 回归可做亚格精度，故 `σ_abs` 在**裁剪框坐标**下约 0.005–0.02。
  换算到整图坐标需乘裁剪框比例——**而 JSONL 未告知是否做了 intelligent cropping，这是必须向 A 角色确认的接口空白。**
- `b(i)`：髋/膝的系统偏差（Needham 2021 报 30–50 mm，约 0.02·H），**滤波无效**。

**角度传播主公式（已 MC 校验，§2.3）**

```python
# 两点段方位角（弧度）
sigma_phi = math.hypot(sig_A, sig_B) / L          # 独立时 = sqrt(sA²+sB²)/L

# 三点关节角（弧度），顶点 B
sigma_theta = math.sqrt( (sig_A/Lu)**2 + (sig_C/Lw)**2
                       + sig_B**2*(1/Lu**2 + 1/Lw**2 - 2*math.cos(th)/(Lu*Lw)) )
# 各点同 sigma 时退化为: sig * sqrt(2/Lu² + 2/Lw² − 2cosθ/(Lu·Lw))

# 主轴角（N 点最小二乘 / PCA），t_k = 点在主轴上的投影坐标
sigma_axis = sig / math.sqrt(sum((t_k - t_bar)**2 for t_k in T))
```
主轴公式 MC 校验：预测 0.602° vs MC 0.601°（9 点站立构型）；1.543 vs 1.547（5 点）；1.989 vs 1.997（4 点）——**吻合 <0.5%**。

**表 A：两点段方位角 σ_φ（度），按 σ_p/H**

| 量 | λ = L/H | σ_p/H=0.005 | 0.010 | 0.020 | 0.030 |
|---|---|---|---|---|---|
| **躯干 MS–MH** | 0.288 | **1.4** | **2.8** | **5.6** | **8.4** |
| 肩线 5–6 | 0.259 | 1.6 | 3.1 | 6.3 | 9.4 |
| 髋线 11–12 | 0.191 | 2.1 | 4.2 | 8.5 | 12.7 |
| 大腿 11–13 | 0.245 | 1.7 | 3.3 | 6.6 | 9.9 |
| 小腿 13–15 | 0.246 | 1.6 | 3.3 | 6.6 | 9.9 |
| 上臂 5–7 | 0.186 | 2.2 | 4.4 | 8.7 | 13.1 |
| **前臂 7–9** | 0.146 | 2.8 | 5.5 | **11.1** | **16.6** |
| 头-颈 0–MS | 0.182 | 2.2 | 4.5 | 8.9 | 13.4 |

**表 B：三点关节角 σ_θ（度）**

| 关节 | Lu/H | Lw/H | σ_p/H=0.005 | 0.010 | 0.020 | 0.030 |
|---|---|---|---|---|---|---|
| 膝 11-13-15 @170°（伸直） | 0.245 | 0.246 | 2.9 | 5.7 | **11.4** | 17.1 |
| 膝 @90°（屈曲） | 0.245 | 0.246 | 2.3 | 4.7 | 9.3 | 14.0 |
| 髋 MS-MH-13 @175° | 0.288 | 0.245 | 2.7 | 5.3 | 10.6 | 15.9 |
| 髋 @90° | 0.288 | 0.245 | 2.2 | 4.3 | 8.7 | 13.0 |
| **肘 5-7-9 @170°** | 0.186 | 0.146 | 4.3 | 8.6 | **17.2** | **25.7** |
| 肘 @90° | 0.186 | 0.146 | 3.5 | 7.1 | 14.1 | 21.2 |

**注意关节角在伸直（θ→180°）时最差**：`−2cosθ/(Lu·Lw)` 项在 θ=180° 变为 `+2/(Lu·Lw)`，
顶点噪声的两路贡献同向叠加而非抵消。**"腿是不是伸直的"恰恰是最难测准的构型。**

**表 C：最佳可用角度——加权主轴 vs 两点躯干（σ_p=0.01H）**

| 估计器 | Σ(t−t̄)²（H² 单位，站立构型） | σ_axis |
|---|---|---|
| **9 核心点**（0,5,6,11,12,13,14,15,16） | 0.906 | **0.60°** |
| 5 点（0,5,6,11,12） | 0.138 | 1.54° |
| 4 点（5,6,11,12） | 0.083 | 1.99° |
| 2 点 MS–MH（λ=0.288） | — | 2.81° |
| 2 点 MS–中踝（λ=0.779） | — | 1.04° |

**⇒ 设计建议：`standing / lying` 的主判据应当是 9 核心点的加权主轴角，不是两点躯干向量。精度差 4.7 倍。**
**代价与必须做的补偿**：主轴会被四肢构型带偏（举手、伸腿）。补偿方式：
(i) 只用核心点子集；(ii) 用 `1/σ_COCO(i)²` 加权；(iii) 做一次 IRLS 稳健重加权剔除离群点（BlazePose 数据显示 16–22% 的点是离群，§2.1.4）。

**表 D：最小可用尺度（σ_abs 主导时，σ_θ ∝ 1/H）**

| σ_abs（整图归一化单位） | 目标 σ | 躯干倾角所需最小 H | 膝角(170°)所需最小 H |
|---|---|---|---|
| 0.002 | 5° | 0.11 | 0.23 |
| 0.002 | 10° | 0.06 | 0.11 |
| 0.004 | 5° | 0.23 | 0.46 |
| 0.004 | 10° | 0.11 | 0.23 |
| 0.008 | 5° | 0.45 | 0.91 |
| 0.008 | 10° | 0.23 | 0.46 |

读法：若实测 `σ_abs = 0.004`（整图归一化），则要让**膝角**的 σ ≤ 10°，人必须占据画面高度的 23% 以上；
要 σ ≤ 5°，需占 46% 以上——**在客厅广角机位下几乎不可能。这就是"膝角在 Reme 不可用"的定量依据。**

**线性化有效性门（硬约束）**
```
if sigma_p / min(Lu, Lw) > 0.25:  该角度 → unavailable（公式已系统性低估 >6%，且分布重尾）
if sigma_p / min(Lu, Lw) > 0.10:  该角度 → degraded（σ 需乘 1.05 保守修正）
```

### 4.4 速度/微分（表 E、F）

**表 E：跌倒式下降的 SNR（参考量级：中髋在 0.5 s 内下降 0.5·H ⇒ 峰值 1.0 H/s）**

| σ_p | 中心差分 σ_v | SNR | SG w=9 p=2 σ_v | SNR | SG w=15 p=2 σ_v | SNR |
|---|---|---|---|---|---|---|
| 0.01H | 0.212 H/s | 4.7 | 0.039 H/s | **25.8** | 0.018 H/s | 55.7 |
| 0.02H | 0.424 H/s | **2.4** | 0.077 H/s | 12.9 | 0.036 H/s | 27.9 |
| 0.03H | 0.636 H/s | **1.6** | 0.116 H/s | 8.6 | 0.054 H/s | 18.6 |

**表 F：加速度（二阶中心差分，30 FPS）**

| σ_p | σ_a | 参考：重力在 1.7 m 人体上 |
|---|---|---|
| 0.01H | 22.0 H/s² | 5.77 H/s² |
| 0.02H | 44.1 H/s² | 5.77 H/s² |
| 0.03H | 66.1 H/s² | 5.77 H/s² |

**⇒ 硬结论：本项目禁止使用任何二阶导数（加速度、冲击、jerk）特征。噪声是重力的 3.8–11.5 倍。**
（对照：Bourke, O'Brien, Lyons 2007, Gait & Posture 26(2):194–199,
DOI [10.1016/j.gaitpost.2006.09.012](https://doi.org/10.1016/j.gaitpost.2006.09.012)，**未读全文、读摘要**——
该文的加速度阈值法建立在**躯干佩戴的三轴加速度计**上，Reme 没有这个传感器，**不能借用其阈值或其结论**。）

**推荐的速度管线（可直接编码）**
```
1) 逐关键点做质量门（§4.6），失败的点做限长插值（≤4 帧 ≈ 0.13 s，参照 Stenum 2021 的 0.12 s 上限）
2) 先在"几何量"层面聚合（如主轴角、中髋位置），再对聚合量求导 —— 不要对单个关键点求导后再聚合
   （聚合先做，等于先做了一次空间平均，把独立噪声压掉 √N）
3) 对聚合量用 SG(w=9, p=2, deriv=1) 求导，Δt = 1/30 s，噪声增益 0.129
4) 输出侧降采样到 5–10 Hz —— 注意这是"抽取"，SG 已做了抗混叠低通
5) 自检（Challis 1999 的思路）：残差 (raw − filtered) 的自相关在 lag≥1 应接近 0；
   若显著为正 ⇒ 窗口过长、信号被削；若为负 ⇒ 过短
```
**滞后预算**：SG w=9 居中 ⇒ 零相位，但需要 4 个未来帧 = **133 ms 端到端延迟**。
在 5–10 Hz 输出（100–200 ms 周期）下这是可接受的；w=15（233 ms）需产品确认。

### 4.5 骨长一致性：**只有单边判据成立**

几何事实：透视投影下 `L_obs = L_true · cos(φ_out-of-plane) · (焦距/深度)`，`cos ≤ 1`。
在 `S_ref` 归一化后（已吸收深度尺度），**投影只能让骨看起来更短，不能更长**。

```python
# ✅ 有效：超长检测（唯一可靠的骨长判据）
def bone_too_long(p_a, p_b, lam_prior, S_ref, eps=0.25):
    return dist(p_a, p_b) > (1 + eps) * lam_prior * (S_ref / 0.366)

# ❌ 无效：不要写"太短就报警"。太短 = 前后缩短，是完全合法的真实姿态
# ❌ 无效：不要写"左右同名骨长应相等"。左右出平面角不同，2D 投影天然不等
```
`eps` 必须由验证集标定（吸收 λ 先验的人群变异 + S_ref 估计误差），先验区间 0.2–0.35。

**时间连续性上界（可编码）**
```python
# 1) 关键点位移上界：人体末端最大线速度量级 ~ 5 H/s（保守），30 FPS ⇒ 每帧 0.17·H
MAX_STEP = 0.17 * H_hat
# 2) 骨长变化率上界：d(L_obs)/dt = −L·sin(φ)·dφ/dt，肢体角速度上界 ~10 rad/s
#    ⇒ 每帧 |ΔL_obs| ≤ L · 10 / 30 ≈ 0.33·L   （宽松但能抓住瞬时跳变）
```
两条都是**必要非充分**条件：违反 ⇒ 该点不可信；不违反 ⇒ 不能推出可信。

### 4.6 判据组合与拒判逻辑（可编码骨架）

```python
def frame_quality(rec, S_ref, cal):
    # G0 上游门
    if not rec["person_detected"]:                     return "unavailable"
    if rec["landmark_quality"] == "unavailable":       return "unavailable"

    # G1 尺度门 —— 阈值来自 §4.3 表 D，用实测 sigma_abs 反解
    if S_ref < cal.S_min:                              return "unavailable"

    # G2 覆盖门 —— 逐关键点阈值（不是全局单一阈值）
    ok = {i for i in CORE if rec.kp[i].score >= cal.tau[i]}
    if len(ok & TORSO) < 3:                            return "unavailable"
    if len(ok) < cal.min_core_points:                  return "degraded"

    # G3 骨长单边门（只查超长）
    if any(bone_too_long(...) for bone in BONES_with_both_ends_in(ok)):
                                                       return "degraded"

    # G4 时间连续门
    if any(step(i) > cal.max_step for i in ok):        return "degraded"

    return "usable"


def axis_angle_with_uncertainty(rec, S_ref, cal):
    pts, w = weighted_core_points(rec, cal)            # w_i = 1/(sigma_COCO_i)^2
    theta  = principal_axis_angle(pts, w)              # 已做 IRLS 稳健重加权
    sig_p  = per_kp_sigma(rec, S_ref, cal)             # §4.3 三项模型
    Sxx    = sum(w_i*(t_i - t_bar)**2 for ...)
    sig_th = weighted_sigma_p / sqrt(Sxx)              # §4.3 主公式
    return theta, sig_th


def classify(rec, ...):
    q = frame_quality(...)
    if q == "unavailable":                             return "unknown", 0.0
    theta, sig_th = axis_angle_with_uncertainty(...)

    # G5 传播不确定度门 —— 本设计诚实性的核心
    if sig_th > cal.sigma_theta_max:                   return "unknown", 0.0

    label, margin = static_classifier(theta, aspect_ratio, ...)

    # G6 选择性分类门（Geifman & El-Yaniv 2017 的 risk–coverage 标定）
    if margin < cal.margin_threshold:                  return "unknown", ...
    return label, calibrated_confidence(margin, S_ref_bin, q)
```

**时序标签的额外门**：
`fall_like_transition` 需要速度 ⇒ 需要 SG 窗内**全部 9 帧**都是 `usable`。
```python
if sum(1 for f in window if f.quality == "usable") < 9:
    return "uncertain_transition"
```
且必须承认结构性盲区（§3 #23）：**正对/背对相机的跌倒在像平面上是低速事件**，
本系统对这一方向的跌倒**必须输出 uncertain_transition，而不是 normal_transition**。
（否则就是把"没看见"报告成"没发生"——这是本产品最危险的失效模式。）

---

## 5 阈值与参数：哪些有文献先验、哪些必须验证集校准、哪些禁止硬编码

### 5.1 有一手文献先验的（可作初值，仍需验证）

| 参数 | 先验值 | 一手出处 | 原始条件与迁移风险 |
|---|---|---|---|
| 关键点相对噪声权重 `σ_COCO(i)` | nose .026 … hip .107 | [COCO keypoints-eval](https://cocodataset.org/#keypoints-eval) | 标注者方差，**是下界**。相对比例可迁移，绝对值不可 |
| MoveNet score 阈值初值 | 0.3 | [MoveNet Model Card](https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf) | 官方仅针对"出画"场景推荐。**不覆盖画内遮挡** |
| tfjs 内部阈值 | `MIN_CROP_KEYPOINT_SCORE=0.2`, `DEFAULT_MIN_POSE_SCORE=0.25` | [constants.ts](https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/constants.ts) | 为"裁剪稳定性"设计，非为分类设计 |
| 关键点轨迹低通截止 | **5 Hz** 零相位 4 阶 Butterworth | [Stenum 2021](https://doi.org/10.1371/journal.pcbi.1008935) | 25 Hz 步行视频。**跌倒带宽更高，5 Hz 可能削掉事件**——必须对 fall 段单独验证 |
| 缺口插值上限 | 0.12 s（≈4 帧 @30FPS） | 同上 | 同上 |
| 段长比例 λ | §4.1 表 | Drillis & Contini 1966 / [Winter](https://doi.org/10.1002/9780470549148) | **未读原文**，且原始人群未经验证。仅作 sanity check |
| 关节角可达精度参考 | 髋 3.7–4.6°、膝 5.1–5.6°、踝 7.4° | [Washabaugh 2022](https://doi.org/10.1016/j.gaitpost.2022.08.008)、[Stenum 2021](https://doi.org/10.1371/journal.pcbi.1008935) | **实验室、健康成人、矢状面、OpenPose/Thunder**。Reme 用 Lightning + 任意朝向，**只能当乐观上界** |
| 关键点误差重尾比例 | 16–22% 点误差 > 0.2·torso | [BlazePose](https://arxiv.org/abs/2006.10204) Table 1 | 自建数据集。用于论证"必须用稳健估计"，不用于定阈值 |
| 微分噪声增益 | 中心差分 0.707；SG(9,2) 0.129 | 本文推导 + MC 实测（见附录 A） | 白噪声假设。`smoothed=true` 时不成立 |

### 5.2 **必须**在 Reme 自己的验证集上标定的（不标定就不能上线）

1. **`κ`（模型/标注误差比）** — 用留出集上人工标注的关键点与 MoveNet 输出比对，
   按 `σ_p(i) = κ·σ_COCO(i)·S_ref` 拟合。先验 2–4。
2. **`σ_abs`（绝对误差下限）** — 让受试者在不同距离静止站立，测同一关键点在 N 帧内的位置离散度，
   拟合 `σ_p(S_ref)` 曲线的截距。**这是表 D 的唯一输入。**
3. **`b(i)`（系统偏差）** — 长时静止段的时间平均与人工真值之差。**这一项决定置信度的天花板。**
4. **`τ[i]`（逐关键点 score 阈值）** — 在 `(关键点类别 × S_ref 分箱 × score 分箱)` 上统计经验误差分位数，
   取"P90 误差 ≤ 目标"的最小 score。**这是绕过 scaling gap 的唯一可行办法（§2.2 结论 3）。**
5. **`S_min`（最小可用尺度）** — 由 (2) 的 σ_abs 代入表 D 反解，再在验证集上确认。
6. **`sigma_theta_max`** — 由"类别间可分辨间距"倒推：
   若 standing 与 bending 的主轴角判据分界在 Δ 度，则要求 `σ_θ ≤ Δ/3`（3σ 分离）。
7. **`eps`（骨长超长容差）** — 覆盖 λ 的人群变异 + S_ref 误差。先验 0.2–0.35。
8. **SG 窗长 w** — 在验证集的 fall 段上做 jitter–lag 折中曲线；
   同时跑 §4.4 步骤 5 的自相关自检确认没削掉信号。
9. **`margin_threshold`** — **必须**由 risk–coverage 曲线给出（[Geifman & El-Yaniv 2017](https://arxiv.org/abs/1705.08500)），
   固定目标选择性风险后反解，而不是拍脑袋。
10. **分组标定** — 至少按肤色/体型/衣着分层复核阈值，因为模型卡自报 COCO val 上肤色间 mAP 差 13.9 点（§2.1.2）。

### 5.3 **禁止**硬编码的（写死即为编造）

- **任何米制阈值**（`m`、`m/s`、`m/s²`、`g`）——无内参无尺度，不可观测（§3 #3）。
- **任何加速度/冲击阈值**——噪声是重力的 3.8–11.5 倍（表 F）。
- **单一全局 score 阈值**——scaling gap 使其不可跨尺度、跨关键点迁移（§2.2）。
- **"骨长过短"报警**与**"左右骨长必须相等"**——在 2D 投影下不可辨识（§4.5）。
- **借用文献准确率**——Stenum/Washabaugh/BlazePose 的数字都是别的条件下的，
  **写进 Reme 的任何指标声明都违反产品红线。**
- **把 score 直接当概率**——最好情况下它与 OKS 的相关只有 0.718（§2.2）。
- **`bending_or_crouching` 的绝对角度阈值**——弯腰方向决定投影，正对相机时该角度不可观测，
  阈值必须与"朝向代理量"（§3 #10）联合，且在朝向不可判时直接拒判。

---

## 6 对 Reme 的取舍建议与风险

### 6.1 应当采纳（按优先级）

1. **主判据换成加权稳健主轴角，弃用两点躯干向量。** 精度差 4.7 倍（表 C），实现成本几乎相同。
   实现要点：核心点子集 + `1/σ_COCO²` 加权 + IRLS 稳健重加权（应对 16–22% 的离群点）。
2. **把"传播不确定度"做成一等输出。** 每帧输出 `(label, σ_θ, quality_reason)`，
   `σ_θ` 由 §4.3 公式实时算出。这是本设计能诚实给置信度的唯一路径——
   它把"这一帧有多准"从常数变成可计算量。
3. **尺度估计与姿态测量解耦**：`S_ref` 用长窗上包络（§4.2b），`S_frame` 只作诊断。
   理由：投影只会缩短，所以上包络才无偏。
4. **先聚合后微分 + SG(9,2)**：噪声增益从 0.707 降到 0.129，延迟 133 ms 可接受（表 D/E）。
5. **向 A 角色索要未平滑关键点**（`enableSmoothing:false`），并让 `smoothed` 字段携带滤波器身份。
   否则 §4.4 的整套噪声预算在 One-Euro 已滤的数据上不成立（§2.1.3）。
6. **必须向 A 角色确认是否做了 intelligent cropping**，因为 `σ_abs` 在整图坐标下的值完全取决于此（§4.3）。

### 6.2 应当放弃（越早越好）

| 放弃项 | 定量理由 |
|---|---|
| 肘角、腕相关角、任何前臂参与的角 | σ_p=0.02H 时 σ_θ=17.2°（表 B），超过类别间可分辨间距 |
| 膝角作为主判据 | σ=11.4°；且要 σ≤10° 需人占画面 23%+（表 D），客厅广角机位达不到 |
| 一切加速度/冲击/jerk 特征 | 噪声/信号 = 3.8–11.5（表 F） |
| "重心（COM）"这个词 | 2D 下只有"关键点加权质心"，是代理量。用 COM 命名 = 隐含医疗/生物力学声明 |
| 左右对称性判据 | 2D 投影下左右出平面角不同，天然不等 |
| 骨长"过短"报警 | 与 foreshortening 完全混淆 |
| 任何 m/s 或 g 单位的输出 | 不可观测 |

### 6.3 风险清单（必须写进 SPEC 的 known limitations）

| # | 风险 | 严重度 | 现状 | 缓解 |
|---|---|---|---|---|
| R1 | **lying 在 MoveNet 训练分布之外**（TPAMI 2023 SLP 明证） | 🔴 高 | 无法用 B 侧算法弥补 | 验证集必须**大量**覆盖卧姿；实测 PCK 掉多少就诚实报多少；掉太多就把 lying 的判据收紧到只在高置信几何构型下给出，其余拒判 |
| R2 | **正对/背对相机的跌倒在像平面上是低速事件** | 🔴 高 | 结构性不可观测 | 强制输出 `uncertain_transition`；**禁止**把"没看见"报告成 `normal_transition`；产品文案必须说明存在方向盲区 |
| R3 | **正对相机弯腰时躯干投影长度趋 0** | 🔴 高 | `bending_or_crouching` 的核心判据在此方向失效 | 用 `S_frame/S_ref` 的骤降作为"朝向恶化"信号 → 触发拒判 |
| R4 | **MoveNet 对遮挡点仍输出坐标且不保证低分**（模型卡自证） | 🟠 中高 | score 不能当遮挡检测器 | 靠 §4.5 骨长单边门 + 时间连续门抓；抓不到的必须承认 |
| R5 | **score 不可跨尺度标定**（ICML 2024 scaling gap） | 🟠 中高 | CCNet 路线因接口不给内部特征而不可用 | 只能做 `(kp × scale_bin × score_bin)` 三维经验分位数标定（§5.2 第 4 条） |
| R6 | **髋是 COCO σ 最差的关键点（0.107）且有 30–50 mm 系统偏差** | 🟠 中高 | 恰是躯干判据的端点 | 换主轴（R1 缓解项 1）；把 `b(hip)` 显式放进 σ_p 模型 |
| R7 | **系统偏差不随时间平均衰减**（SmoothNet 反解：位置误差里 <10% 是可滤白噪声） | 🟠 中高 | 多帧平均的收益被高估 | σ_p 三项模型里保留 `b(i)`；置信度上限由 b 决定，不由窗口长度决定 |
| R8 | **模型卡自报肤色间 mAP 差 13.9 点** | 🟠 中高 | 阈值若单一人群标定会转成分组假阴性 | 分层验证集 + 分组报告；不能只报总体指标 |
| R9 | **`smoothed` 语义未定义**，若为 One-Euro 则跌倒瞬间几乎不滤 | 🟡 中 | 接口空白 | §6.1 第 5 条 |
| R10 | **未知是否做了 intelligent cropping**，直接决定 σ_abs | 🟡 中 | 接口空白 | §6.1 第 6 条 |
| R11 | **Stenum 的 5 Hz 截止是步行数据得来，跌倒带宽更高** | 🟡 中 | 可能削掉事件 | 对 fall 段单独跑 Challis 自相关自检；必要时对静态/时序两条链路用不同截止 |
| R12 | **λ 先验来自未经验证的人群**（Drillis & Contini） | 🟡 中 | 老年人体型比例与年轻男性样本不同 | λ 只作 sanity check；`eps` 放宽并验证集标定 |
| R13 | **MoveNet 官方明写"surveillance is explicitly out of scope"** | 🟡 中（合规） | Reme 是居家看护场景 | 产品定位与合规文案需正面处理；这是模型作者的明示边界，不是技术问题 |

### 6.4 一句话总结

**在单目 2D COCO-17 下，唯一精度足够、且误差可闭式预算的角度量是"可靠关键点云的加权稳健主轴角"（σ≈0.6° @ σ_p=0.01H）；
速度只能在"先聚合、再 SG(9,2) 求导"之后使用（SNR 从 2.4 提到 12.9）；加速度、米制量、深度方向的一切运动都不可观测。
凡是不可观测的，必须拒判，不得由模型补齐——这是本设计诚实性的全部内容。**

---

## 附录 A 复现方式

本文所有传播公式的 MC 校验脚本位于
`/Users/maniforld/Documents/reme/.scratch/posture-classifier-theory/notes/verify/`
（依赖 `numpy` + `scipy`，直接 `python verify.py` 等即可复跑）：

| 脚本 | 校验内容 | 结果 |
|---|---|---|
| `verify.py` | 段方位角、三点关节角、前向/中心/二阶差分增益、SG 增益 | 差分增益与闭式解吻合 <0.1% |
| `verify2.py` | 用圆统计重做角度校验；线性化有效边界扫描；中点平均的相关性影响 | σ_p/L ≤ 0.1 时误差 <1%；ρ=0.9 时中点平均**几乎无降噪**（0.974σ vs 理想 0.707σ） |
| `pca2.py` | 主轴角公式 `σ = σ_p/√Σ(t−t̄)²` | 预测 0.602° vs MC 0.601°（<0.5%） |
| `budget.py` | 生成 §4 表 A–H | — |

**`verify2.py` 的一个额外发现（重要）**：`MH=(p11+p12)/2` 这类中点平均，
只有在左右误差**独立**时才有 `σ/√2` 的降噪；实测在相关系数 ρ=0.9 时降噪几乎为 0（0.974σ）。
同一模型、同一帧、同一裁剪框下的左右同名关键点误差**高度相关**，
所以**中点平均带来的降噪应保守地按 0（即 σ_mid = σ_p）计入预算**，不要按 σ_p/√2。

---

## 附录 B 一手来源清单与阅读状态

| # | 来源 | URL / DOI | 阅读状态 |
|---|---|---|---|
| 1 | MoveNet.SinglePose Model Card (Google) | <https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf> | ✅ 全文（PDF 提取 5 页） |
| 2 | COCO Keypoint Evaluation（官方） | <https://cocodataset.org/#keypoints-eval> | ✅ 全文（官方仓库源文件） |
| 3 | tfjs-models MoveNet `constants.ts` / README | <https://github.com/tensorflow/tfjs-models/tree/master/pose-detection/src/movenet> | ✅ 常量与 README |
| 4 | BlazePose (Bazarevsky et al.) | arXiv:[2006.10204](https://arxiv.org/abs/2006.10204) | ✅ 全文（PDF 提取 4 页） |
| 5 | On the Calibration of Human Pose Estimation (Gu, Chen, Yao) | ICML 2024；arXiv:[2311.17105](https://arxiv.org/abs/2311.17105) | ✅ HTML 全文（含 Eq.12/17/19/20） |
| 6 | SmoothNet (Zeng et al.) | ECCV 2022, DOI [10.1007/978-3-031-20065-6_36](https://doi.org/10.1007/978-3-031-20065-6_36)；[ECVA PDF](https://www.ecva.net/papers/eccv_2022/papers_ECCV/papers/136650615.pdf) | ✅ 全文（含 Table 2） |
| 7 | Stenum, Rossi, Roemmich | PLOS Comput Biol 17(4):e1008935, DOI [10.1371/journal.pcbi.1008935](https://doi.org/10.1371/journal.pcbi.1008935) | ✅ 全文要点 |
| 8 | Needham et al. | Sci Rep 11:20673, DOI [10.1038/s41598-021-00212-x](https://doi.org/10.1038/s41598-021-00212-x) | ✅ PMC 全文要点 |
| 9 | Washabaugh et al. | Gait & Posture 97:188–195, DOI [10.1016/j.gaitpost.2022.08.008](https://doi.org/10.1016/j.gaitpost.2022.08.008) | ✅ PubMed 完整摘要（正文 403） |
| 10 | 1€ Filter (Casiez, Roussel, Vogel) | CHI 2012, DOI [10.1145/2207676.2208639](https://dl.acm.org/doi/10.1145/2207676.2208639)；[官方算法页](https://gery.casiez.net/1euro/) | ✅ 官方算法页（含公式与调参指南） |
| 11 | Fonseca, Armand, Dumas | Int Biomech 9(1):10–18, DOI [10.1080/23335432.2022.2108898](https://doi.org/10.1080/23335432.2022.2108898) | ✅ PMC 全文要点 |
| 12 | Liu et al. SLP | TPAMI 2023, DOI [10.1109/TPAMI.2022.3155712](https://doi.org/10.1109/TPAMI.2022.3155712)；arXiv:[2008.08735](https://arxiv.org/abs/2008.08735) | ⚠️ **仅官方摘要** |
| 13 | Cao et al. OpenPose | TPAMI, DOI [10.1109/TPAMI.2019.2929257](https://doi.org/10.1109/TPAMI.2019.2929257) | ⚠️ **仅摘要/元数据** |
| 14 | Guo et al. Calibration of Modern NN | ICML 2017, [PMLR v70:1321](https://proceedings.mlr.press/v70/guo17a.html) | ⚠️ **仅官方页摘要** |
| 15 | Geifman & El-Yaniv Selective Classification | NeurIPS 2017；arXiv:[1705.08500](https://arxiv.org/abs/1705.08500) | ⚠️ **仅摘要** |
| 16 | Winter, Sidwall, Hobson | J Biomech 7(2):157–159, DOI [10.1016/0021-9290(74)90056-6](https://doi.org/10.1016/0021-9290(74)90056-6) | ❌ **未读原文**（ScienceDirect 403）；DOI/卷/页经 Crossref 核实 |
| 17 | Winter, *Biomechanics and Motor Control of Human Movement* | Wiley, DOI [10.1002/9780470549148](https://doi.org/10.1002/9780470549148) | ❌ **未读官方全文**（付费墙）；residual analysis 与 λ 表为**二手转述** |
| 18 | Challis | J Appl Biomech 15(3):303–317, DOI [10.1123/jab.15.3.303](https://doi.org/10.1123/jab.15.3.303) | ❌ **未读全文**（403）；方法要点见检索摘要 |
| 19 | Savitzky & Golay | Anal Chem 36(8):1627–1639, DOI [10.1021/ac60214a047](https://doi.org/10.1021/ac60214a047) | ❌ **未读原文**；DOI/卷/页经 Crossref 核实；实现以 SciPy 为准并自测 |
| 20 | Bourke, O'Brien, Lyons | Gait & Posture 26(2):194–199, DOI [10.1016/j.gaitpost.2006.09.012](https://doi.org/10.1016/j.gaitpost.2006.09.012) | ❌ **未读全文**，读摘要；**其加速度阈值不适用于本项目** |
| 21 | Drillis & Contini | TR-1166-03, NYU School of Engineering & Science, 1966 | ❌ **未读原文**（无公开电子版）；λ 数值经 Winter Fig.4.1 二手转述 |

**排除来源**：按项目既有约定，本文未引用任何 MDPI 或 Frontiers 出版物。
检索过程中出现的 MDPI *Sensors*「Filtering Biomechanical Signals in Movement Analysis」等条目已主动排除。
