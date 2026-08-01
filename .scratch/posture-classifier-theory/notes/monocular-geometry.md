# 单目归一化 2D 关键点的可辨识性边界与视角不变量

> 面向 Reme B 角色（静态姿态分类 + 时序转换分类）的前置理论调研。
> 唯一输入前提：A 角色产出的 `movenet-17/v0-experiment` JSONL；COCO-17 关键点；
> `coordinate_space = "normalized_image_top_left"`，x,y ∈ [0,1]，y 轴向下；
> **无深度、无内参外参、无米制尺度、无 IMU、无力板、无 3D**。单人、室内固定机位、30 FPS、输出 5–10 Hz。
>
> 全文严格区分三层：
> **(a)** 该理论在完整 3D 动捕 / 测力台条件下的原始形式；
> **(b)** 在单目 2D 归一化关键点下只能拿到的**投影代理量**；
> **(c)** 根本**不可观测**的量。
>
> 文中引用的论文准确率/误差数字**仅用于确定误差量级**，**不是本项目的指标**，不得对外复述为 Reme 的性能。
> 已按项目既有约定排除 MDPI 与 Frontiers 来源。

---

## 1 结论摘要

1. **归一化坐标里的"角度"不是角度。** 如果 `x_norm = x_px/W`、`y_norm = y_px/H`，那么像素空间到归一化空间是各向异性缩放 `diag(1/W, 1/H)`，角度被系统性剪切。4:3 画面下"与竖直方向夹角"的最大畸变是 **8.21°**（真值 49.11° → 观测 40.89°）；16:9 下是 **16.26°**（53.13° → 36.87°）。这已经超过任何合理的 standing/bending 判据边界。所有几何量必须先还原到等比空间。这是**阻塞级**前提，不是可选优化。VideoPose3D 官方代码 `X/w*2 - [1, h/w]`（x 和 y 都除以同一个 `w`）就是这个做法的一手背书。

2. **图像 y 轴不是重力方向；图像里的"躯干倾角"是投影代理量，不是 3D 倾角。** 透视投影不保角；深度方向的前缩（foreshortening）使沿光轴方向倒下的人躯干投影长度趋近 0，倾角估计方差爆炸。生物力学侧的一手证据一致：2D 视频测角在矢状面对准时可用，额状面/横断面**不可靠**（Leporace 2023；Oyama 2016）。**推论：`lying` 的召回在视角上是各向异性的，产品文档必须明说。**

3. **绝对尺度不可观测，比例可观测。** 按画幅宽高归一化会把"人离相机的远近 + 人在画面里的位置"编码进特征（离画面中心越远，仿射近似误差越大，误差 ∝ ΔZ/Z × 像半径）。必须用人体自身尺度做二次归一化，且尺度候选（躯干长 / 肩宽 / 髋宽）互相之间的**矛盾程度本身**就是最好的拒判信号。

4. **深度歧义是原理性的，不是模型不够好。** 2D→3D lifting 是 ill-posed；单假设回归器在**理论上必然**产生骨长不守恒的姿态（ManiPose Prop. 4.2）。实测：VideoPose3D 分段长度时间标准差 7.8 mm、MixSTE 9.9 mm（Human3.6M）；换到 MPI-INF-3DHP，VideoPose3D 涨到 27.5 mm。即使给完美 GT 2D，实验室同分布下 MPJPE 仍在 17–37 mm。**结论：本项目不引入 lifting**——它给不了绝对尺度，还会污染我们赖以拒判的骨长一致性检验。

5. **几何自检可以做，成本极低，且比 softmax 置信度可靠。** MoveNet 官方明确："即使关键点被遮挡也会预测全部 17 点"、"出画的点给低分"、"推荐阈值 0.3"。所以低分点是**带位置的猜测**，必须掩码传播；**绝不能用 (0,0) 冒充**（OpenPose 的 `0,0,0` 约定之所以安全是因为第三位同时为 0）。本文 §4 给出 6 组可运行时计算的一致性检验（骨长比区间 / 左右对称 / 序关系自洽 / 可见性 / 尺度时序稳定 / 坐标合法性）来触发 `unknown`。

---

## 2 理论与一手文献

每小节格式：**论断 → 出处 → 原始条件（该结论在什么实验/假设下成立）**。

### 2.1 透视投影不保角；仿射/弱透视近似何时失效

**论断 A：射影变换保持共线性与交比，不保长度、长度比、角度、平行性。**
- 出处：R. Hartley, A. Zisserman, *Multiple View Geometry in Computer Vision*, 2nd ed., Cambridge University Press, 2004, ISBN 0521540518 — 官方书页 <https://www.robots.ox.ac.uk/~vgg/hzbook/>（含目录与部分样章 PDF）。第 2 章（射影几何与 2D 变换）、第 6 章（相机模型）、第 8 章（单视图几何）。
- 原始条件：理想针孔相机、无畸变。**这是数学事实，不是经验结论——它对我们无条件成立。**

**论断 B：仿射相机（含正交、弱透视、准透视）是全透视的零阶/一阶近似，仅当"物体深度变化远小于相机到物体的距离"时有效；其像误差有闭式界。**
- 出处：G. Wang, Q. M. J. Wu, *Guide to Three Dimensional Structure and Motion Factorization*, Advances in Pattern Recognition, Springer, 2011, Ch. 2 "Simplified Camera Projection Models", DOI [10.1007/978-0-85729-046-5_2](https://doi.org/10.1007/978-0-85729-046-5_2)。
  - 原文："Affine camera is a zero-order (for weak-perspective) or a first-order (for paraperspective) approximation of full perspective projection. It is valid when the depth variation of the object is small compared to the distance from camera to the object."
  - 定量（式 2.34）：仿射近似的像点误差
    `e_a = | r₃ᵀ X̄ / t_z | · | m̄ |`
    即 **误差 ≈ (该点相对物体质心的深度偏离 / 相机距离) × (该点距主点的像半径)**。
  - 该书还指出（结论 1）：**绕光轴的旋转角 γ（即 camera roll）不影响 `m̄`、`m̄_q`、`m̄_a`**——roll 是像平面内的旋转，它不产生投影畸变，但它**整体旋转了"图像竖直方向"**。这两件事必须分开：roll 不破坏角度之间的关系，但破坏了"图像 y 轴 = 重力"这个锚点。
- 原始条件：已知内参、图像已用 `K⁻¹x → x` 归一化。**我们没有 K，所以这个公式只能定性使用**：用来判断"何时不可信"，不能拿来算误差数值。
- 代入 Reme 场景做量级判断（**推断，非文献值**）：
  - 站姿、MoveNet 官方推荐工作距离 3 ft ~ 6 ft（0.9–1.8 m），人体矢状面厚度 ΔZ ≈ 0.2–0.3 m → ΔZ/Z ≈ 0.11–0.33。弱透视勉强可用。
  - 躺姿且身体沿光轴方向铺开，人体深度跨度可达 1.6–1.8 m；相机 2–3 m → ΔZ/Z ≈ 0.5–0.9。**弱透视彻底失效**，此时任何"投影长度比"和"投影角度"都不再是 3D 量的代理。

**论断 C（实证侧）：2D 视频测角在矢状面可用，额状面/横断面不可靠；且 2D 角"未必解剖学正确"。**
- 出处 1：G. Leporace et al., "Validity and reliability of two-dimensional video-based assessment to measure joint angles during running: A systematic review and meta-analysis," *Journal of Biomechanics* 157:111747, 2023. DOI [10.1016/j.jbiomech.2023.111747](https://doi.org/10.1016/j.jbiomech.2023.111747)（据 PubMed，PMID 37541054）。
  - 结论原文：效度"ranged from poor to excellent, with most of the parameters assessed presenting poor or moderate validity"；"caution should be taken when applying 2DVAS, particularly for **frontal and transverse plane angles**"。信度（同评分者/跨评分者/跨场次）反而普遍 good–excellent。
  - **这个"信度高但效度低"的组合极其重要**：2D 角度是**可重复的**（所以看起来很稳、很像一个好特征），但**系统性偏离真实解剖角**。深度学习分类器会愉快地学到这个稳定偏差，然后在换机位时崩掉。
- 出处 2：S. Oyama et al., "Reliability and Validity of Quantitative Video Analysis of Baseball Pitching Motion," *Journal of Applied Biomechanics* 33(1):64–68, 2016. DOI [10.1123/jab.2016-0011](https://doi.org/10.1123/jab.2016-0011)（据 PubMed，PMID 27705057）。
  - 原文："Two-dimensional angles at the shoulder, elbow, and trunk could be measured with high reliability. However, **the angles are not necessarily anatomically correct**, and thus use of quantitative video analysis should be limited to angles that can be measured with good validity."
  - 只有 `trunk contralateral flexion at maximum external rotation` 一个变量拿到 high validity；其余 moderate 或更差。
- 原始条件：受试者已知、相机**专门对准运动平面**、人工数字化、动作是标准化的跑步/投球。**Reme 的条件严格更差**：固定机位、人体朝向任意、自动关键点、动作非标准化。所以这些文献给的是**乐观上界**。

**关键推论（本节最重要的产出）**
- 图像里"肩中点 → 髋中点"向量与图像 y 轴的夹角 `θ_img`，只在 (i) 人体冠状面近似平行于像平面、(ii) 人在画面中心附近、(iii) roll 已知 三个条件同时成立时，才是真 3D 躯干倾角的可用代理。
- **灾难情形（朝深度方向躺下）**：躯干在像平面上的投影长度 → 0，`θ_img` 由关键点噪声主导；同时以躯干长为分母的所有归一化量爆炸。**必须直接触发 `unknown`，而不是输出 `lying`。**
- **最好情形（侧向躺下）**：躯干平行像平面，`θ_img ≈ 90°`，前缩最小。
- 因此"包围盒纵横比 / 椭圆主轴倾角"这类经典跌倒特征在沿光轴方向跌倒时结构性失效。这也解释了为什么严肃的跌倒检测工作要么上多相机、要么上深度/惯性传感器（见 §6 风险 1 的引文）。

### 2.2 相机 roll 未知时，图像 y 轴 ≠ 重力方向；文献里怎么估重力

**论断 D：重力方向在图像中的投影是"逐像素"的，不是一个全局常向量。即使 roll = 0，画面不同位置的"竖直方向"在像平面上也不同。**
- 出处：L. Jin, J. Zhang, Y. Hold-Geoffroy, O. Wang, K. Matzen, M. Sticha, D. F. Fouhey, "Perspective Fields for Single Image Camera Calibration," CVPR 2023 (Highlight). arXiv:[2212.03239](https://arxiv.org/abs/2212.03239)；项目页 <https://jinlinyi.github.io/PerspectiveFields/>；代码 <https://github.com/jinlinyi/PerspectiveFields>。
  - **Up-vector** 定义为重力方向 `g` 在该像素处投影的极限方向：
    `u_x = lim_{c→0} [ P(X − c·g) − P(X) ] / ‖P(X − c·g) − P(X)‖₂`
  - **Latitude** 定义为入射光线与水平面的夹角：`φ_x = arcsin( R·g / ‖R‖₂ )`；**horizon 处 φ = 0**，上方为正、下方为负。
  - 报告误差（Google Street View，主点非中心）：roll 中位误差 **1.37°**、pitch **2.60°**、FoV **3.75°**；Up-vector 平均误差 2.18°（Stanford2D3D）/ 3.47°（TartanAir）。
  - 原始条件：**需要 RGB 图像**。我们只有关键点，所以这条路径要求 A 角色额外透出一帧图像做一次性标定（可接受：固定机位只需装机时做一次）。
- 补充出处：W. Xian, Z. Li, M. Fisher, J. Eisenmann, E. Shechtman, N. Snavely, "UprightNet: Geometry-Aware Camera Orientation Estimation from Single Images," ICCV 2019. arXiv:[1908.07070](https://arxiv.org/abs/1908.07070)；代码 <https://github.com/zhengqili/UprightNet>。从**单张室内 RGB** 估 2DoF 相机朝向（即重力在相机系中的方向），用局部/全局几何表征对齐 + 可微最小二乘求旋转。原始条件：室内场景、训练域为合成 + 真实室内数据集。

**论断 E：地平线（水平面的消失线）可从单图估计；室内场景的竖直方向可从 Manhattan 结构的消失点得到。**
- 出处 1：S. Workman, M. Zhai, N. Jacobs, "Horizon Lines in the Wild," BMVC 2016. arXiv:[1604.02129](https://arxiv.org/abs/1604.02129)；官方 PDF <https://www.bmva-archive.org.uk/bmvc/2016/papers/paper020/paper020.pdf>；数据集 <https://mvrl.cse.wustl.edu/datasets/hlw/>；代码 <https://github.com/scottworkman/deephorizon>。HLW 数据集含 100,553 张带 horizon 标注的图像。
- 出处 2：J. M. Coughlan, A. L. Yuille, "Manhattan World: Compass Direction from a Single Image by Bayesian Inference," ICCV 1999. 官方 PDF <https://www.ski.org/wp-content/uploads/2024/12/manhattan_iccv99_compressed.pdf>。论断：绝大多数室内与城市场景建立在三维正交网格上；由此可用贝叶斯推断从**单张图、无需边缘检测/Hough 预处理**直接估相机相对该网格的朝向，其中一个方向就是竖直方向。
- 原始条件：室内需存在足够的直线结构（门框、墙角、柜边、地砖缝）。Reme 的室内固定机位场景通常满足。

**论断 F：只要有参考平面的消失线 + 一个不平行于该平面方向的消失点，单视图就能算出"平行于参考平面的平面之间的距离（差一个公共尺度）"、"平行平面上的面积/长度比"、以及相机位置——不需要内参也不需要外参。**
- 出处：A. Criminisi, I. D. Reid, A. Zisserman, "Single View Metrology," *International Journal of Computer Vision* 40(2):123–148, 2000. DOI [10.1023/A:1026598000963](https://doi.org/10.1023/A:1026598000963)；官方页 <https://www.robots.ox.ac.uk/ActiveVision/Publications/criminisi_etal_ijcv2000/criminisi_etal_ijcv2000.html>。
  - 摘要原文："We describe how 3D affine measurements may be computed from a single perspective view of a scene given only minimal geometric information determined from the image. This minimal information is typically the vanishing line of a reference plane, and a vanishing point for a direction not parallel to the plane."
- **对 Reme 的意义（本节最高性价比的一条）**：固定机位下标一次地面消失线 + 竖直消失点，就能把"髋是否高于膝"从**图像 y 轴上的序关系**升级为**真实重力方向上的序关系**，并得到"离地高度之比"这个仿射可观测量。代价只是装机流程多一步，比换模型、加数据都便宜。
- 原始条件：需要地面可见；需要标注两组以上平行线（或自动检测）；结果是**仿射量（比值）**，**不是米制**。

**论断 G：人对 roll 误差比对 FoV/pitch 误差敏感得多。**
- 出处：Y. Hold-Geoffroy, K. Sunkavalli, J. Eisenmann, M. Fisher, E. Gambaretto, S. Hadap, J.-F. Lalonde, "A Perceptual Measure for Deep Single Image Camera Calibration," CVPR 2018. arXiv:[1712.01259](https://arxiv.org/abs/1712.01259)；Adobe Research 页 <https://research.adobe.com/publication/a-perceptual-measure-for-deep-single-image-camera-calibration/>；项目页 <https://lvsn.github.io/deepcalib/>。
  - 大规模人类感知实验后构建的感知度量按观测到的容忍度对各参数缩放：**pitch 1:0.2（图像单位）、roll 1:12（角度）、FoV 1:15（角度）**。roll 与 FoV 的角度缩放差一个数量级级别的敏感度分配。
  - 对我们的意义：几度的 roll 误差**线性地**污染"躯干与竖直夹角"，且是不可自愈的系统偏差。

**"固定机位下假设 roll ≈ 0"的可检验性 —— 落地建议**
1. **可检验**：固定机位下 roll 是常数，一次装机标定即可。三条独立路径：
   - (a) **场景结构**：Manhattan 假设下取竖直消失点 `v_z`；若 `v_z` 落在图像上/下方极远处，则接近正交投影，roll ≈ 画面中竖直边的平均倾斜角。
   - (b) **学习式**：Perspective Fields / UprightNet 直接回归 roll（前者报告 roll 中位误差 1.37°）。
   - (c) **人工**：装机时拍一张带铅垂线/门框的照片，人工确认。
2. **不可作为独立标定**：用"站立人群躯干向量方向的众数"反推重力，是**循环论证**（我们正是要用重力方向来判定站立）。它只能当**一致性监控**：若长期众数与假定竖直方向偏离超过阈值，报警要求重新标定。
3. **工程约束**：把 `roll` 做成显式配置项而非隐含假设；所有涉及"与竖直方向夹角"的阈值必须留 `±roll_tol` 保护带。

### 2.3 尺度归一化：按什么归一，为什么不能按画幅

**论断 H：正规做法是保持像素纵横比——x 和 y 除以同一个数。**
- 出处（一手代码）：facebookresearch/VideoPose3D, `common/camera.py`
  <https://github.com/facebookresearch/VideoPose3D/blob/main/common/camera.py>
  ```python
  def normalize_screen_coordinates(X, w, h):
      assert X.shape[-1] == 2
      return X/w*2 - [1, h/w]
  ```
  **x 和 y 都除以 `w`**；y 的值域变成 `[-1, h/w]`，纵横比被保留。
- 原始条件：Human3.6M / HumanEva-I 的固定标定相机。但保持纵横比这件事本身是无条件正确的。

**论断 I：按 W、H 各自归一化有三重危害。**
1. **各向异性剪切**（可量化，见 §1 结论 1 与 §4 的公式）。
2. **距离编码**：包围盒尺寸、关键点绝对坐标都直接编码"人在画面里占多大" = "人离相机多远 + 相机装多高"。换房间、换镜头、换安装高度即崩。
3. **位置编码**：仿射近似误差 `e_a ∝ |m̄|`（Wang & Wu 2011 式 2.34），离画面中心越远畸变越大。把绝对像位置喂进分类器等于让它去记住这个机位的畸变场。

**三种人体自身尺度的优劣**

| 尺度 | 优点 | 致命弱点 | 失效时机 |
|---|---|---|---|
| 躯干长 `‖MS − MH‖` | 解剖上最稳（ANSUR II CV ≈ 4–5%）；与姿态标签的耦合最弱 | 前缩到 0 | 人朝/背对相机躺下——**正是最需要它的时候** |
| 肩宽 `‖P5 − P6‖` | 与躯干长**互补**：人正/背对时最大 | 前缩到 0 | 人完全侧身 |
| 髋宽 `‖P11 − P12‖` | 同肩宽，第二冗余 | 前缩到 0；且 COCO hip 标注一致性最差（OKS σ=1.07，17 点中最大） | 侧身 |
| 包围盒对角线 | 永不为 0，最鲁棒 | **把姿态本身编码进尺度**（站立/躺下由身高主导，蹲下急剧缩小）→ 与标签泄漏；对单个离群关键点极敏感 | 任何时候都有偏 |

**建议**：`s = max(L_torso, k_sh·L_sh, k_hip·L_hip)`（`k_*` 由验证集校准，ANSUR 先验见 §5）。
更重要的是：**把"尺度候选之间是否互相矛盾"本身当成拒判信号**——躯干长和肩宽同时很小，只可能是人整体远离相机（表观尺度小，可从时序判断）或关键点崩了。

**论断 J：COCO 官方评测本身就是按实例尺度归一化误差，并给出了每个关键点的可靠性权重。**
- 出处：COCO keypoint evaluation，官方页 <https://cocodataset.org/#keypoints-eval>。
  OKS 定义 `OKS = Σᵢ exp(−dᵢ²/(2s²kᵢ²))·δ(vᵢ>0) / Σᵢ δ(vᵢ>0)`，其中 `dᵢ` 是检测点与 GT 的欧氏距离，`s` 是实例尺度（√分割面积），`kᵢ = 2σᵢ` 为每关键点常数。
  COCO 17 点的 `σ`：`[.26, .25, .25, .35, .35, .79, .79, .72, .72, .62, .62, 1.07, 1.07, .87, .87, .89, .89] / 10`
  顺序即 `nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles`。
- **对我们的两个直接用途**：
  1. **hips 的 σ = 1.07 是全部 17 点里最大**（是 nose 的 4 倍）。任何以髋中点为原点或分母的量都必须打折，容差按 σ 缩放。
  2. `δ(vᵢ>0)`：COCO 评测**显式区分"没有标注"和"标注了但看不见"**（v=0 未标注 / v=1 标注但不可见 / v=2 标注且可见）。这是"score 不能坍缩进坐标"的制度性证据。

### 2.4 视角不变 vs 弱视角依赖：哪些是真不变量

**论断 K：射影变换下的严格不变量是交比（cross-ratio）——共线四点，或共面五点的两个独立不变量。**
- 出处：Hartley & Zisserman 2004 第 2 章；Criminisi et al. 2000 正是用竖直方向上四个点的交比做高度测量。
- **在 COCO-17 上基本不可用**：需要共线四点。髋–膝–踝只有三点，且只在腿完全伸直时才近似共线。**必须说清楚：本项目拿不到严格视角不变量。**

**论断 L：人体动作识别的视角不变量需要额外假设——共面点集，或已知的人体测量比例。**
- 出处：V. Parameswaran, R. Chellappa, "View Invariance for Human Action Recognition," *International Journal of Computer Vision* 66(1):83–101, 2006. DOI [10.1007/s11263-005-3671-4](https://doi.org/10.1007/s11263-005-3671-4)。
  （注：Springer 页面在本次环境下无法直连抓取，DOI/卷期/页码经多个索引源交叉确认；**未读全文，摘要级引用**。）
- 原始条件：需要人体上一组近似共面的点或已知的比例先验。

**实际可用量的三级分类**

| 量 | 不变性级别 | 成立条件 |
|---|---|---|
| 交比 | 射影不变（真不变量） | 需共线四点 → **本项目不可用** |
| 骨长比（同帧两骨投影长度之比） | **图像相似变换不变**，非 3D 视角不变 | 两骨近似共面且该面平行像平面 |
| 关节角（肩-肘-腕、髋-膝-踝） | **图像相似变换不变**，非 3D 视角不变 | 该环节所在平面平行像平面（矢状面对准） |
| 相邻环节夹角 | 同上 | 同上 |
| 躯干与图像竖直方向夹角 | 图像**平移 + 均匀缩放**不变，**对 roll 敏感** | roll 已知 |
| 竖直序关系（髋在膝上方等） | 最鲁棒的一类：只依赖投影后的**符号**而非幅值 | roll 已知；两点真实高度差需大于噪声 margin |
| 左右对称性（左右骨长差） | 反射对称性检验 | 用作**检验**而非特征时无额外条件 |

**本节的核心区分（工程上最常被混淆的一点）**：
"骨长比"和"关节角"是**图像平面内的相似变换不变量**——平移、旋转、均匀缩放图像不改变它们。这**不等于视角不变**。改变相机视角会改变每根骨的出平面角，从而改变每根骨的前缩率，从而改变投影骨长比和投影关节角。很多工程实践把二者混为一谈，得到"我做了尺度归一化所以视角无关了"的错误结论。

### 2.5 单目 2D→3D lifting 的固有深度歧义与误差量级

**论断 M：2D→3D lifting 本质 ill-posed——多个 3D 姿态对应同一个 2D 投影。**
- 出处：C. Rommel, V. Letzelter, N. Samet, R. Marlet, M. Cord, P. Pérez, E. Valle, "ManiPose: Manifold-Constrained Multi-Hypothesis 3D Human Pose Estimation," NeurIPS 2024. arXiv:[2312.06386](https://arxiv.org/abs/2312.06386)；官方 proceedings PDF <https://proceedings.neurips.cc/paper_files/paper/2024/file/c223aaf2c89379cbde179858d3af1b0d-Paper-Conference.pdf>；代码 <https://github.com/cedricrommel/manipose>。
  - 原文："Due to depth ambiguity and occlusions, 2D-to-3D lifting is intrinsically ill-posed: multiple 3D poses correspond to the same projection observed in 2D."

**论断 N（定理级）：刚体骨架下，最小化 MSE 的单假设回归器，其预测姿态必然落在人体姿态流形之外，即预测骨长必然收缩。**
- 出处：同上，**Proposition 4.2 (Inconsistency of MSE minimizer)**。
  - 证明梗概：最优模型是条件期望 `f*(x) = E[p|x]`；由 Jensen 不等式与刚体假设，对任意关节 `j` 有 `ℓ²_j(f*(x)) < s²_j`（`s_j` 为真实骨长）。
  - 三条推论（论文原文列举）：(1) 传统无约束单假设方法**必然**给出骨长变动的运动；(2) 单假设下受流形约束的模型在 MPJPE 上**必然**输给无约束模型；(3) 同时达到最优 MPJPE 与一致性的**唯一**途径是多假设。
- 原始条件：刚体骨架 + 训练分布的温和假设。**这不是经验发现，是数学结论。**

**误差量级（Human3.6M，实验室、固定 4 机位、训练/测试同分布）**

| 模型 | 输入 | MPJPE (P1) | 备注 |
|---|---|---|---|
| VideoPose3D (CVPR 2019) | 检测 2D (CPN) | **46.8 mm** | P-MPJPE 36.5 mm；感受野 243 帧 |
| VideoPose3D | **GT 2D** | **37.2 mm** | 论文 Table 3 |
| MotionBERT (ICCV 2023) scratch | 检测 2D (SH) | 39.2 mm | |
| MotionBERT finetune | 检测 2D (SH) | **37.5 mm** | 论文摘要与 Table 1 (top) |
| MotionBERT scratch | **GT 2D** | 17.8 mm | Table 1 (middle) |
| MotionBERT finetune | **GT 2D** | **16.9 mm** | |

- 出处：D. Pavllo, C. Feichtenhofer, D. Grangier, M. Auli, "3D human pose estimation in video with temporal convolutions and semi-supervised training," CVPR 2019. arXiv:[1811.11742](https://arxiv.org/abs/1811.11742)；代码 <https://github.com/facebookresearch/VideoPose3D>。
- 出处：W. Zhu, X. Ma, Z. Liu, L. Liu, W. Wu, Y. Wang, "MotionBERT: A Unified Perspective on Learning Human Motion Representations," ICCV 2023. arXiv:[2210.06551](https://arxiv.org/abs/2210.06551)；代码 <https://github.com/Walter0807/MotionBERT>；项目页 <https://motionbert.github.io/>。

**骨长不守恒的实测量级（ManiPose Table 2/3；MPSCE = 分段长度的时间标准差均值，MPSSE = 左右分段长度差均值，单位 mm）**

| 模型 | 数据集 | MPJPE | MPSSE | MPSCE |
|---|---|---|---|---|
| VideoPose3D | H3.6M (检测 2D) | 46.8 | 6.5 | 7.8 |
| PoseFormer | H3.6M | 44.3 | 4.3 | 7.2 |
| MixSTE | H3.6M | 40.9 | 8.8 | 9.9 |
| GFPose (200 hyp.) | H3.6M | 35.6 | 13.1 | 16.5 |
| ManiPose | H3.6M | 39.1 (oracle) | 0.3 | 0.5 |
| VideoPose3D | **MPI-INF-3DHP (GT 2D)** | 84.8 | 10.4 | **27.5** |
| MixSTE | MPI-INF-3DHP (GT 2D) | 54.9 | 17.3 | 21.6 |

- 注意 MPI-INF-3DHP（含户外、更接近真实场景）上 VideoPose3D 的 MPSCE 飙到 27.5 mm——**离开实验室分布，骨长一致性直接崩掉。**
- ManiPose Fig. 5 的分坐标分析：MixSTE 的**深度（z）坐标误差约为其他坐标的两倍**；误差最大的两段是 `KNEE–FOOT` 与 `ELBOW–WRIST`（末端环节最受深度歧义影响）。

**原始条件与不可外推声明（务必写进 SPEC）**
- 上述所有数字都来自实验室数据集，训练与测试**同分布**、受试者少（H3.6M 训练 S1/5/6/7/8、测试 S9/S11）、动作是日常动作脚本、相机是标定过的固定 4 机位。
- **不能外推到**"室内固定机位、老年人、躺在地板上、自遮挡严重"的场景。
- **不是 Reme 的指标**。引用它们的唯一目的是确定量级：即使做 lifting，深度不确定度也在**厘米到十几厘米**；而 `sitting` / `lying` / `bending_or_crouching` 的区分尺度是**几十厘米**。信噪比不足以支撑靠 lifting 来"补深度"。

**决策：本项目不引入 2D→3D lifting。** 理由汇总：
1. 原理 ill-posed（论断 M）；
2. 单假设回归**必然**破坏骨长一致性（论断 N）——而骨长一致性正是我们赖以拒判的核心检验，引入 lifting 等于自毁地基；
3. lifting 输出是 root-relative 且尺度归一的，**给不了绝对尺度**，也给不了"离地高度"——我们真正需要的量它给不出；
4. 增加延迟、模型依赖与运维面，与 5–10 Hz、边缘部署的约束冲突。

### 2.6 自遮挡、关键点置信度，以及"低置信度点不得用 (0,0) 冒充"

**论断 O：MoveNet 对被遮挡的关键点仍然输出位置，只是给低分。**
- 出处（一手）：MoveNet.SinglePose Model Card，官方托管
  <https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf>
  - 输出："A float32 tensor of shape [1, 1, 17, 3]. The first two channels of the last dimension represents the **yx** coordinates (normalized to image frame, i.e. range in [0.0, 1.0]) of the 17 keypoints... The third channel of the last dimension represents the prediction confidence scores of each keypoint, also in the range [0.0, 1.0]."
    ⚠️ **注意通道顺序是 (y, x) 不是 (x, y)**——这是常见接线 bug。
  - 遮挡行为原文：**"The model predicts 17 human keypoints of the full body even when they are occluded. For the keypoints which are outside of the image frame, the model will emit low confidence scores. A confidence threshold (recommended default: 0.3) can be used to filter out unconfident predictions."**
  - 工作距离原文："Most suitable for detecting the pose of a single person who is **3ft ~ 6ft** away from a device's webcam."
  - 输入："192x192x3 (Lightning)" —— **正方形**。
  - 训练/评测域：COCO Keypoint 单人子集（train 28k / val 919 张）+ Active Dataset（YouTube fitness、yoga、dance；train 23.5k / eval 1161 张）。Lightning 在 COCO val 单人集上 keypoint mAP 按肤色分层为 60.5（Darker）/ 61.2（Medium）/ 74.4（Lighter）；在 Active 集上 89.1 / 92.2 / 92.9。
  - **Out-of-scope Use Cases 原文**："This model is not intended for detecting poses of multiple people in the image. **Any form of surveillance or identity recognition is explicitly out of scope and not enabled by this technology.**"
- **对 Reme 的四条直接后果**：
  1. 低分关键点是**带位置的猜测**，不是缺失。它会构造出貌似合理的骨长与角度。必须掩码传播。
  2. 训练域里**没有"躺在地板上的老年人"**。model card 的 mAP 数字不能外推到我们的场景。
  3. 官方工作距离 3–6 ft，室内固定机位监护往往超出。
  4. "surveillance out of scope" 是**产品/法务红线**的一手依据，需要留档确认。

**论断 P：tfjs 官方实现对 SinglePose 走正方形 crop，最终返回像素坐标。**
- 出处（一手代码）：tensorflow/tfjs-models, `pose-detection/src/movenet/detector.ts`
  <https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/detector.ts>
  - SinglePose 路径用 `initCropRegion()` / `determineNextCropRegion()` 算一个**正方形** crop region，经 `tf.image.cropAndResize()` 送入模型；
  - 模型的 [0,1] 归一化输出先映回 crop：`pose.keypoints[i].y = this.cropRegion.yMin + pose.keypoints[i].y * this.cropRegion.height`；
  - 再映回原图像素：`keypoints[k].y *= imageSize.height; keypoints[k].x *= imageSize.width`。
  - （MultiPose 路径才做保纵横比的 resize + padding。）
- **推论**：如果 A 角色走 tfjs 路径拿到像素坐标后再除以 (W, H)，得到的 `x_norm, y_norm` 就是**各向异性**的；如果直接透出 TFLite 模型的原始 [0,1] 输出，则它是相对**正方形 crop** 的、**等比**的。**两者语义完全不同，必须实测确认，不能猜。**（见 §6 阻塞项）

**论断 Q：关键点定位误差有明确的类型学，其中"左右反转"是独立的一类，且可见点数与失败率强相关。**
- 出处：M. R. Ronchi, P. Perona, "Benchmarking and Error Diagnosis in Multi-Instance Pose Estimation," ICCV 2017. arXiv:[1707.05388](https://arxiv.org/abs/1707.05388)。
  - **Jitter**：`0.5 ≤ ks < 0.85`，落在人类标注者变异范围内的小误差。
  - **Miss**：`ks < 0.5` 对所有 GT 位置，即"不在任何身体部位附近"。
  - **Inversion**：与**同一个人**的语义相似部位混淆（典型即左右互换）。
  - **Swap**：与**另一个人**的部位混淆。
  - 定量：Miss 造成约 **15%** AP 损失；Inversion 约 **4%**；Jitter 虽最常见（约 25% 关键点）但影响最小。
  - 遮挡相关：**可见关键点少于 5 个时，超过 30% 的实例被漏检**；Miss 与 Jitter 在低可见度下占主导。
- **对我们的两条用途**：
  1. 左右 Inversion 是**真实存在**的失效模式。因此"左右对称性检验"既是有用的自检，也可能被 Inversion 触发——两者都应导向降级/拒判，这是可接受的（保守方向正确）。
  2. "可见关键点数"是一个有一手证据支撑的独立拒判维度。

**论断 R：`(0,0,0)` 是 OpenPose 表示缺失的历史约定；它之所以安全，是因为第三位同时为 0。**
- 出处（一手）：CMU-Perceptual-Computing-Lab/openpose, `doc/02_output.md`
  <https://github.com/CMU-Perceptual-Computing-Lab/openpose/blob/master/doc/02_output.md>
  - 格式 `x0,y0,c0,x1,y1,c1,...`，`c` 为 `[0,1]` 的 detection confidence；未检出的关键点在 JSON 中出现为 `0,0,0`。
- **危害**：下游若只取 `(x, y)` 而忽略 `c`，缺失点会被吸到画面左上角原点，制造出虚假的"人蜷缩在左上角"的骨架，进而制造虚假骨长、虚假角度、虚假包围盒。这些虚假值在数值上完全合法，静默污染训练与推理。
- **本项目的正确做法**：schema 已带 `score`。保留原始 `(x_norm, y_norm, score)`；用显式 mask 传播；**任何以缺失点为端点的几何量标为 `undefined`，而不是 0、不是插值**（除非做了显式的时间插值并同时置 `smoothed=true`，且插值跨度有上限）。
- **额外校验**：若出现 `score > 0` 但 `(x_norm, y_norm) == (0, 0)` 的组合，视为上游 bug，整帧标 `unavailable`。

---

## 3 在单目 2D COCO-17 下可观测 / 代理 / 不可观测的逐项判定

**这是本次调研的最重要产出。** 三级判定：
- ✅ **可放心使用**：在本项目条件下近似成立，误差可控且方向已知。
- ⚠️ **需打折使用**：只在明确的前置条件成立时可信，必须配一个"前置条件是否成立"的检验，且不得单独决策。
- ⛔ **必须拒判 / 不可观测**：在单目 2D 归一化关键点下不存在或严重有偏，**不得以任何形式假装拥有**。

| # | 量 | 判定 | 理由 / 前置条件 |
|---|---|---|---|
| 1 | 绝对身高、绝对骨长（米制） | ⛔ 不可观测 | 单视图无内参、无参考物。Criminisi 2000 也只能给**比值**，且需消失线 + 竖直消失点 |
| 2 | 人到相机的距离 / 关节深度 Z | ⛔ 不可观测 | 只有"表观尺度" = f·真实尺寸/Z，其中 f 与真实尺寸都未知，二者不可解耦 |
| 3 | 3D 躯干与重力方向的夹角 | ⛔ 不可观测；`θ_img` 是**投影代理量** | §2.1；需要 3D 或至少多视角 |
| 4 | 世界竖直方向（重力在图像中的场） | ⛔ v0 不可观测（假设 roll≈0）；**标定后可升级为 ⚠️** | §2.2；Perspective Fields 的 Up-vector 是逐像素的 |
| 5 | 关节离地高度（米制） | ⛔ 不可观测 | — |
| 6 | 同一条竖直线上两点的离地高度**之比** | ⚠️ 标定后可观测（仿射意义） | Criminisi 2000：需地面消失线 + 竖直消失点 |
| 7 | 人体重心（COM）位置 | ⛔ 不可观测 | 需人体测量学质量惯性参数 + 3D 姿态 |
| 8 | 地面反力（GRF）、压力中心（COP） | ⛔ 不可观测 | 需力板 / 测力鞋垫 |
| 9 | 3D 关节角、3D 角速度、角动量 | ⛔ 不可观测 | 需 3D 动捕 |
| 10 | 图像内骨长**比**（同帧两骨） | ⚠️ 打折 | 只在两骨近似共面且平行像平面时 ≈ 3D 比。**更适合当"检验"而非"特征"** |
| 11 | 图像内关节角（肩-肘-腕、髋-膝-踝） | ⚠️ 打折 | 矢状面对准可用；额状/横断面不可信（Leporace 2023）。信度高但效度低——**这是陷阱** |
| 12 | 左右对称性（左右同名骨投影长度差） | ✅ 作为**检验**可放心用 | 对称破缺 → 出平面旋转 ∨ Inversion ∨ 遮挡；三者都应导向降级。作为**特征**则 ⚠️ |
| 13 | 竖直序关系（`v_MS < v_MH < v_knee < v_ankle`） | ✅ 可用，但需 margin + roll 假设 | 符号量比幅值量鲁棒；真实高度差小时符号会被噪声翻转，必须加 margin |
| 14 | 身体主轴方向（高置信点的加权 PCA） | ⚠️ 打折 | 与 `θ_img` 同源受限，但比单一躯干向量稳健（多点平均） |
| 15 | 各向异性 / 铺展度 `√(λ1/λ2)` | ⚠️ 打折 | 受前缩调制；躺向光轴时反而变小 |
| 16 | 包围盒纵横比 | ⚠️ 打折，**不得单独决策** | 经典跌倒特征，沿光轴方向跌倒时结构性失效（§2.1 推论） |
| 17 | 表观尺度（`s`）的时间变化率 | ⚠️ 打折 | 是"靠近/远离相机" ∨ "倒下" ∨ "关键点崩" 的混杂信号 |
| 18 | 关键点速度/加速度 | ⚠️ 打折 | 必须除以人体自身尺度 `s` 才有跨帧/跨人可比性；30 FPS 下差分噪声大，须先平滑 |
| 19 | 前缩比 `L_torso / L_sh` | ✅ 可放心用作**几何门** | 见 §4 公式 F1——它同时是"弱透视假设是否成立"的检验 |
| 20 | 可见关键点数 `n_vis` / 核心四点 `n_core` | ✅ 可放心用作拒判维度 | Ronchi & Perona：可见点 <5 时 >30% 实例被漏检 |
| 21 | `sitting` vs `lying` 的区分 | ⛔ **部分视角下几何不可分** | 俯视机位下沙发上"坐"与"躺"的 2D 骨架可近乎相同。需场景先验或拒判（§6 风险 2） |
| 22 | `bending_or_crouching` vs `sitting` 的区分 | ⛔ 正对相机时几何不可分 | 两者都表现为 `v_MH ≈ v_knee`；区分依赖髋膝踝的相对**深度**（不可观测）。建议靠时序或合并/拒判 |

---

## 4 可直接编码的量与公式（COCO-17 索引）

COCO-17 索引：
`0 nose, 1 Leye, 2 Reye, 3 Lear, 4 Rear, 5 Lsh, 6 Rsh, 7 Lel, 8 Rel, 9 Lwr, 10 Rwr, 11 Lhip, 12 Rhip, 13 Lkn, 14 Rkn, 15 Lank, 16 Rank`

### 4.0 第 0 步（强制）：等比还原

设帧宽高比 `a = W / H`。**`a` 必须由 A 角色写进 schema**（新增 `frame_width`/`frame_height` 或 `aspect_ratio`），否则整条链路带一个未知的系统偏差。

```
u_i = x_norm_i
v_i = y_norm_i / a        # 把 y 换算到"以画面宽为单位"，恢复等比；v 轴仍向下
```

**若 A 角色透出的是 TFLite 模型相对正方形 crop 的原始 [0,1] 输出，则 `a = 1`，u,v 已等比**。
两种情况的语义完全不同，**必须实测确认**（例如：让一个人在画面中沿已知 45° 方向站位，比对两种解释下算出的角度）。

各向异性剪切的量化（自验，可写单测）：
```
tan(θ_norm) = tan(θ_true) / a          # θ 为与竖直方向的夹角
最大畸变出现在 tan(θ_true) = √a：
  a = 4/3  (640×480)  → 49.11° 被读成 40.89°，最大误差 8.21°
  a = 3/2               → 50.77° 被读成 39.23°，最大误差 11.54°
  a = 16/9 (1280×720) → 53.13° 被读成 36.87°，最大误差 16.26°
```

### 4.1 掩码与派生点

```
τ_kp = 0.3                                  # MoveNet 官方推荐默认值，需验证集校准
m_i  = 1 if score_i >= τ_kp else 0

MS = (P5 + P6) / 2      requires m5 & m6    # mid-shoulder
MH = (P11 + P12) / 2    requires m11 & m12  # mid-hip
```

**铁律**：任何用到 `m_i = 0` 的点的量 → `undefined`。不是 0，不是最近邻，不是上一帧的值（除非做了显式时间插值、跨度 ≤ N 帧、并置 `smoothed=true`）。

### 4.2 长度量（全部在 (u,v) 空间）

```
L_torso   = ‖MS − MH‖
L_sh      = ‖P5  − P6‖
L_hip     = ‖P11 − P12‖
L_thighL  = ‖P11 − P13‖ ;  L_thighR = ‖P12 − P14‖
L_shankL  = ‖P13 − P15‖ ;  L_shankR = ‖P14 − P16‖
L_uarmL   = ‖P5  − P7‖  ;  L_uarmR  = ‖P6  − P8‖
L_farmL   = ‖P7  − P9‖  ;  L_farmR  = ‖P8  − P10‖
```

### 4.3 鲁棒尺度

```
s = max( L_torso , k_sh · L_sh , k_hip · L_hip )
```
`k_sh`、`k_hip` 为把肩宽/髋宽折算到躯干长量纲的系数。ANSUR II 均值推得的中心值：
`k_sh = L_torso/L_sh ≈ 1.34（女）/ 1.30（男）`，取 **1.32**；
`k_hip = L_torso/L_hip ≈ 1.79（女）/ 1.96（男）`，取 **1.88**（注意男女差异达 9%，髋宽的性别二态性明显，比肩宽更不稳）。
**区间必须验证集校准**；固定机位单住户场景优先用个人基线自校准。

固定机位 + 单住户场景下**强烈建议做个人基线自校准**：在几何门通过的高置信站立帧上在线估计该个体自己的 `L_torso/L_sh`、`L_thigh/L_torso` 等，之后用**相对个人基线的偏离**而非群体常数做判据。这比任何人群统计都准，且完全免费。

### 4.4 躯干倾角（投影代理量，必须配可信度门）

```
d = MS − MH                          # 从髋指向肩
θ_img = atan2( |d.u| , −d.v )        # 与"图像向上"方向夹角 ∈ [0°, 180°]
                                     # v 轴向下，所以"向上"是 −v
                                     # θ_img = 0  躯干在图像中竖直向上
                                     # θ_img = 90 躯干在图像中水平
```
若已标定 roll，则 `θ_grav = θ_img − roll`；否则记录 `θ_img` 并在阈值上留 `±roll_tol`。

### 4.5 前缩比与出平面角估计（**F1，本文最有用的一个派生量**）

```
F1:  fore_ratio = L_torso / max(L_sh, ε)
```

弱透视下，长度为 `L` 的 3D 线段若与像平面成出平面角 `ψ`，其投影长度 ≈ `(f/Z)·L·cos ψ`。若肩线近似平行像平面（`ψ_sh ≈ 0`），则

```
fore_ratio ≈ R₀ · cos ψ_torso        其中 R₀ = 该个体真实的 躯干长/肩宽
ψ_torso ≈ arccos( clamp(fore_ratio / R₀, 0, 1) )
```

以 ANSUR II 均值推得的群体中心 `R₀ ≈ 1.32`（女 1.341 / 男 1.299）：

| 观测 `fore_ratio` | 推得 `ψ_torso` | 解读 |
|---|---|---|
| 1.30 | ~10° | 躯干基本平行像平面，`θ_img` 可信 |
| 1.10 | ~34° | 中度前缩，`θ_img` 打折 |
| 0.90 | ~47° | 显著前缩 |
| 0.65 | ~60° | 严重前缩，`θ_img` 不可信 |
| 0.40 | ~72° | 躯干近乎沿光轴，**必须 `unknown`** |

**这是一个可以在运行时算出的"我现在有多可信"的自估量**，而且它把 §2.1 那个"沿光轴躺下会灾难"的定性论断变成了可执行的门。
⚠️ 局限（必须写进代码注释）：
- 它混淆了 `ψ_torso` 与 `ψ_sh`（人侧身时肩线也前缩，`fore_ratio` 会偏大，此时该量反而给出"很可信"的错误结论）→ 必须与 `L_sh/s` 的绝对水平联合判断；
- 它假设个体的 `R₀` 等于群体中心 → 用个人基线自校准（§4.3）可消除这一项；
- 它是弱透视下的一阶推理，不适用于 `ΔZ/Z` 很大的近距离大俯仰机位。

### 4.6 竖直序关系（带 margin）

```
above(A, B) := ( v_B − v_A ) > margin · s        # A 在 B 上方（v 向下）
```
站立的完整序：`above(MS, MH) ∧ above(MH, knee) ∧ above(knee, ankle)`
坐姿典型破坏 `above(MH, knee)`；躺姿典型破坏 `above(MS, MH)`。
`margin` 必须验证集校准，建议起点 `0.05–0.10 · s`。

### 4.7 主轴与铺展度

对所有 `m_i = 1` 的点（可按 `1/σ_i²` 加权，σ 取 §2.3 的 COCO 值）做加权 PCA：
```
λ1 ≥ λ2 = 协方差特征值
elong = √(λ1 / λ2)
φ     = 主轴方向与 −v 的夹角
```
`lying` 的典型模式是 `elong` 大 且 `φ → 90°`。但 `φ` 与 `θ_img` 同源受限，且 `elong` 在躺向光轴时**反而变小**——必须与 F1 联合。

### 4.8 几何一致性检验（触发 `unknown` 的核心，C1–C6）

**C1 骨长比区间**
```
r1 = L_thigh / L_torso    ∈ [lo1, hi1]
r2 = L_shank / L_thigh    ∈ [lo2, hi2]
r3 = L_sh    / L_torso    ∈ [lo3, hi3]
r4 = L_farm  / L_uarm     ∈ [lo4, hi4]
```
**这些是投影长度比。出平面旋转只会让分子或分母变小（前缩），永远不会变大。所以违反区间的方向携带信息**：
- 比值偏小 → 分子那根骨出平面；
- 比值偏大 → 分母那根骨出平面。

**关键机制**：只有当**所有**比值都在区间内，才说明整个骨架近似平行像平面，此时 §4.4/§4.6 的角度类量才可信。
**C1 同时是"弱透视假设是否成立"的运行时检验。** 这是本判据表的核心设计。

**C2 左右对称**
```
asym_X = | L_XL − L_XR | / max(L_XL, L_XR)      X ∈ {thigh, shank, uarm, farm}
```
- 全部 `asym_X < τ_sym` → 人近似正对/背对相机，且无 Inversion → 角度量最可信；
- 单侧显著更短 → 该侧出平面（正常侧身）∨ 遮挡 ∨ Inversion → **降级为 `degraded`**，不必立刻 `unknown`；
- 多处不对称 + 低置信 → `unknown`。

**C3 序关系自洽**
序关系集合互相矛盾时（如 `¬above(MH,knee) ∧ ¬above(knee,ankle) ∧ elong 小 ∧ fore_ratio 正常`）→ `unknown`。

**C4 可见性**
```
n_vis  = Σ m_i
n_core = m5 + m6 + m11 + m12
```
要求 `n_core == 4` 才允许输出 `standing/sitting/lying/bending_or_crouching`，否则 `unknown`。
`n_vis` 下限由验证集校准；Ronchi & Perona 的"可见点 <5 时 >30% 实例被漏检"支持设一个下限。

**C5 尺度时序稳定性（2D 版 MPSCE，本文自定义）**
```
MPSCE_2D = mean_over_bones( std_t( L_bone(t) / s(t) ) )      # 滑窗内
```
> **明确声明**：这是**借用** ManiPose 的一致性度量思想在 2D 投影长度上的类比，**不是** ManiPose 定义的 3D 指标本身，也不与其数值可比。
同一个人在几百毫秒内，归一化骨长不该乱跳。`MPSCE_2D` 超阈值 → 关键点不稳 → 降级。

**C6 坐标合法性**
- `x_norm, y_norm ∈ [0,1]`；
- `score > 0` 且 `(x_norm, y_norm) == (0,0)` → 上游 bug，整帧 `unavailable`；
- 全部 17 点 `score` 均 < τ_kp → `unavailable`（区别于 `unknown`：前者是感知失败，后者是判据不足）。

### 4.9 时序与滞回

30 FPS 输入、5–10 Hz 输出 ⇒ 每个输出对应 3–6 帧。
- 窗口内按 `score` 与几何门等级加权投票；
- 对 `unknown` 使用**非对称滞回**（进入 `unknown` 容易、退出难），避免边界抖动；
- `fall_like_transition` 的时序特征应建在**归一化后**的量上（`Δθ_img/Δt`、`Δ(v_MH)/(s·Δt)`），且必须携带该窗口内的几何门等级——**几何门在跌倒瞬间恰恰最容易失效**（运动模糊 + 前缩 + 遮挡同时发生），所以时序分类器必须能输出 `uncertain_transition`。

---

## 5 阈值与参数：文献先验 / 必须校准 / 禁止硬编码

### 5.1 有文献先验（可作初值，仍需校准）

**关键点阈值**
- `τ_kp = 0.3` —— MoveNet 官方 model card 推荐默认值。**但那是针对 COCO/fitness 域的**；躺地、遮挡、低光域必须重标。

**关键点可靠性权重**
- COCO OKS 的 `σ`（§2.3）。用途：PCA 加权、一致性检验容差按 `σ` 缩放。
- 记住 `hips σ = 1.07`（17 点最大），`eyes σ = 0.25`（最小）。**以髋中点为原点或分母的量一律打折。**

**人体测量学先验（ANSUR II）**
- 出处：C. C. Gordon et al., *2012 Anthropometric Survey of U.S. Army Personnel: Methods and Summary Statistics*, Technical Report Natick/TR-15/007, U.S. Army Natick Soldier RD&E Center, 2014. DTIC AD-A611869，官方 PDF <https://apps.dtic.mil/sti/pdfs/ADA611869.pdf>。样本：男 n=4082、女 n=1986。以下数值直接从该报告的 summary statistics 表提取（单位 cm）。

| 维度 | 女 mean ± SD | 男 mean ± SD |
|---|---|---|
| Stature | 162.85 ± 6.42 | 175.62 ± 6.86 |
| Acromial height | 133.51 ± 5.81 | 144.07 ± 6.33 |
| Trochanterion height | 84.54 ± 4.47 | 90.09 ± 4.92 |
| Lateral femoral epicondyle height | 46.59 ± 2.71 | 49.17 ± 2.66 |
| Lateral malleolus height | 6.27 ± 0.51 | 7.29 ± 0.57 |
| Biacromial breadth | 36.53 ± 1.83 | 41.57 ± 1.92 |
| Bicristal breadth | 27.33 ± 2.23 | 27.54 ± 1.75 |
| Acromion-radiale length（上臂） | 31.12 ± 1.72 | 33.52 ± 1.75 |
| Radiale-stylion length（前臂） | 24.13 ± 1.52 | 26.79 ± 1.54 |

由均值推导的骨段长与比值（**均值之比，非比值之均值**）：

| 派生量 | 女 | 男 |
|---|---|---|
| 躯干 = acromial − trochanterion | 48.97 | 53.98 |
| 大腿 = trochanterion − lat. fem. epicondyle | 37.95 | 40.92 |
| 小腿 = lat. fem. epicondyle − lat. malleolus | 40.32 | 41.88 |
| `L_sh / L_torso` | 0.746 | 0.770 |
| `L_torso / L_sh`（即 §4.5 的 `R₀`） | **1.341** | **1.299** |
| `L_thigh / L_torso` | 0.775 | 0.758 |
| `L_shank / L_thigh` | 1.062 | 1.023 |
| `L_farm / L_uarm` | 0.775 | 0.799 |
| `L_hip / L_torso`（bicristal） | 0.558 | 0.510 |
| `L_torso / stature` | 0.301 | 0.307 |

**四条必须写进代码注释的警告**：
1. **这是"均值之比"，不是"比值的均值"。** ANSUR 汇总表不给联合分布，各维度间是正相关的，所以我用它**只能定中心值，区间宽度必须由验证集的经验分布确定**。
2. **人群不匹配。** ANSUR 是美军现役军人：年轻、经体能筛选。Reme 若面向老年用户，体型分布系统性不同（脊柱后凸会显著缩短表观躯干长）。ANSUR 只能定"量级"，不能定"人群"。
3. **landmark 不等价。** COCO 的 shoulder/hip 关键点是 2D 标注约定，不是解剖 landmark。把 ANSUR 的 acromion / trochanterion 等同于 COCO 的 shoulder / hip 是一个近似，误差未知。
4. **它们是 3D 长度，我们观测的是 2D 投影长度。** 所有比值都只是"若骨段平行像平面时的上界"。

### 5.2 必须由验证集校准（禁止拍脑袋）

| 参数 | 说明 |
|---|---|
| `[lo1..hi4]` | C1 四组骨长比区间的上下界 |
| `τ_sym` | C2 左右对称阈值 |
| `margin` | C6/§4.6 序关系余量（建议起点 0.05–0.10·s） |
| `fore_ratio` 下限 | §4.5 触发 `unknown` 的前缩阈值 |
| `k_sh`, `k_hip` | §4.3 尺度折算系数（ANSUR 先验 1.32 / 1.87 仅为中心值） |
| `R₀` | §4.5 参考比；**优先用个人基线在线自校准** |
| `θ_img`、`elong` 的类别决策边界 | standing / sitting / lying / bending 的分界 |
| `n_vis` 下限 | C4 |
| `MPSCE_2D` 阈值、滑窗长度 | C5 |
| 时序窗口长度、滞回参数 | §4.9 |
| **拒判率工作点** | 这是**产品参数**不是技术参数：`unknown` 太多没用、太少不安全，需与产品共同定 |
| `τ_kp` | 官方 0.3 只是起点 |
| `roll_tol` | 由装机标定的 roll 不确定度决定 |

### 5.3 禁止硬编码

- ⛔ 任何以像素或归一化单位表达的**绝对长度**（必须除以 `s`）。
- ⛔ 任何隐含"人一定在画面中央 / 一定占画面某比例"的量。
- ⛔ 任何隐含相机高度、俯仰角、焦距的常数。
- ⛔ 任何"人体身高 = X cm"或"1 归一化单位 = X cm"的换算。
- ⛔ 直接把 `y_norm` 当作"离地高度"。
- ⛔ 把 `roll = 0` 写死在公式里而不暴露 `roll` / `roll_tol` 参数。
- ⛔ 把 `a = W/H` 写死（不同摄像头不同）。
- ⛔ 任何直接用 `x_norm, y_norm` 算角度而未先做 §4.0 等比还原的代码路径。

---

## 6 对 Reme 的取舍建议与风险

### 6.1 阻塞项（必须先解决，否则后续全错）

**B-1：确认 `normalized_image_top_left` 的确切语义。**
两种可能：
- (i) MoveNet TFLite 原始输出，相对 **192×192 正方形 crop**，则已等比，`a = 1`；
- (ii) tfjs 返回的原图像素坐标再除以 `(W, H)`，则**各向异性**，`a = W/H`。

后果差异是 4:3 下最大 8.21°、16:9 下最大 16.26° 的角度系统偏差（§4.0）。
**行动**：读 A 角色的实现代码确认；同时在 schema 中补 `frame_width` / `frame_height`（或 `aspect_ratio`）与 `keypoint_space` 枚举，让下游可以自证。一手背书：VideoPose3D 官方 `normalize_screen_coordinates` 用同一个 `w` 归一 x 和 y。

**B-2：确认关键点通道顺序。** MoveNet TFLite 原始输出是 **(y, x, score)**，不是 (x, y, score)。若 A 角色做过转换，需在文档中固定该约定并加单测（例如：让人举右手，检查 `P10`（right_wrist）的 `y_norm` 是否变小）。

### 6.2 建议的分类器结构：两级"门 + 判"

```
FrameLandmarks
    │
    ├─▶ [Geometric Gate]  C1..C6 + F1
    │       ├─ pass          → usable
    │       ├─ partial fail  → degraded
    │       └─ hard fail     → reject
    │
    ├─ usable   → 完整分类器 {standing, sitting, lying, bending_or_crouching}
    ├─ degraded → 保守子分类器，只允许 {standing, unknown} 或 {lying, unknown}
    └─ reject   → unknown
```

**为什么门要独立于分类器**：
- 几何门是**可解释、可单测、可离线回放验证**的确定性逻辑；
- 分类器的 softmax 置信度**未校准**——MoveNet model card 与 tfjs 文档都明说 confidence 不跨模型校准，且我们的分类器也不会天然校准。用未校准的 softmax 做拒判是把"证据不足必须拒判"这条产品红线建在流沙上。
- 门的每一条失败都可以映射到一条**人类可读的原因**（"躯干严重前缩"/"左右不对称"/"核心关键点缺失"），这对运维和用户沟通至关重要。

### 6.3 建议进入分类器的特征（全部尺度无关、已等比还原）

见本次任务的结构化输出 `proposed_features`。核心原则：
- 所有长度量除以 `s`；
- 所有角度量在 (u,v) 等比空间计算，并减去标定的 `roll`；
- 每个特征伴随一个 `valid` 位（由其依赖的关键点 mask 决定），缺失时用**掩码而非填零**送入模型；
- 把 `fore_ratio`、`asym_*`、`n_vis` 这些"元特征"也喂给分类器——让它自己学会"我什么时候不该自信"。

### 6.4 风险清单

**风险 1：`lying` 的召回是视角各向异性的 —— 这是安全侧的漏报。**
沿光轴方向倒下 → 躯干前缩 → 我们的门会判 `unknown` 而非 `lying`。这在几何上是**正确**的（我们确实没有证据），在安全上是**漏报**。
- **必须在产品文档里明说，不得声称"能检测跌倒"。**
- 若这个方向的漏报不可接受，唯一的正解是**加传感器**，不是在单目 2D 上调参。一手证据：
  - E. Auvinet, F. Multon, A. Saint-Arnaud, J. Rousseau, J. Meunier, "Fall detection with multiple cameras: an occlusion-resistant method based on 3-D silhouette vertical distribution," *IEEE Trans. Inf. Technol. Biomed.* 15(2):290–300, 2011. DOI [10.1109/TITB.2010.2087385](https://doi.org/10.1109/TITB.2010.2087385)（据 PubMed，PMID 20952341）。他们用**多相机重建 3D 形状**、分析**沿竖直轴的体积分布**，用 **≥4 台相机**才达到 99.7% sensitivity/specificity；混淆事件里明确包含 crouching(11)、sitting(9)、lying on a sofa(4)——**与我们的标签集高度重合**。注意"沿竖直轴的体积分布"这个量本身就要求已知重力方向与 3D 重建，两样我们都没有。
  - B. Kwolek, M. Kepski, "Human fall detection on embedded platform using depth maps and wireless accelerometer," *Computer Methods and Programs in Biomedicine* 117(3):489–501, 2014. DOI [10.1016/j.cmpb.2014.09.005](https://doi.org/10.1016/j.cmpb.2014.09.005)（据 PubMed，PMID 25308505）。用**深度图 + 三轴加速度计**双模态，且明确指出纯惯性方案误报太多导致老人不接受。数据集 <https://fenix.ur.edu.pl/~mkepski/ds/uf.html>。

**风险 2：`sitting` vs `lying` 在部分视角下几何不可分。**
俯视机位下，沙发上"坐"与"躺"的 2D 骨架可以几乎相同。
- 低成本升级路径：固定机位下引入**场景语义区域先验**（这块是沙发/床/地板）。思路见 H. Nait-Charif, S. J. McKenna, "Activity Summarisation and Fall Detection in a Supportive Home Environment," ICPR 2004 — 原文："A person lying on a sofa, as she often does, is probably only resting. In contrast, a person lying on the floor where she has not previously lain may have fallen and require assistance." 即**同样的姿态，语义完全取决于位置**。代价是引入人工区域配置。
- 该区分本身就是被专门研究的难题：即使用**大腿佩戴的加速度计**，sitting 与 lying 的区分也需要专门方法（K. Lyden, D. John, P. Dall, M. H. Granat, "Differentiating Sitting and Lying Using a Thigh-Worn Accelerometer," *Medicine & Science in Sports & Exercise*, DOI [10.1249/MSS.0000000000000804](https://doi.org/10.1249/MSS.0000000000000804)）。这说明难度来自问题本身，不是我们的实现。

**风险 3：`bending_or_crouching` 与 `sitting` 在正对相机时几何不可分。**
两者都表现为 `v_MH ≈ v_knee`；区分依赖髋膝踝的相对**深度**（不可观测，见 §3 第 2、22 行）。
- 建议：这两类的边界靠**时序**（进入方式：屈髋屈膝下蹲 vs 后移落座）而非静态几何；或在 v0 直接合并/拒判。

**风险 4：域外风险与许可风险。**
- MoveNet 的训练与评测域是 COCO 单人 + fitness/yoga/dance 视频；"躺在地板上的老年人"不在其中。model card 的 mAP 数字（60.5–74.4 on COCO val 单人集，按肤色分层）不能外推。
- **model card 明确把 surveillance 列为 out-of-scope use case**（原文见 §2.6 论断 O）。Reme 的室内固定机位监护是否落入该定义，需要产品/法务确认并留档。这不是技术问题但会阻断上线。

**风险 5：明确"不做"的事。**
- ⛔ 不引入 2D→3D lifting（理由见 §2.5）。
- ⛔ 不报告任何未在本项目自有验证集上测得的准确率。本文引用的所有论文数字仅为误差量级参考。
- ⛔ 不做医疗声明。"检测到疑似跌倒事件"是事件描述；"跌倒风险评估""平衡能力评估"是医疗判断，不做。
- ⛔ 不用未校准的 softmax 作为拒判依据。

### 6.5 最高性价比的一次性升级：装机时做场景标定

固定机位下标一次**地面消失线 + 竖直消失点**（Criminisi et al., IJCV 2000），收益：
1. `roll` 得到独立验证（不再是未检验的假设）；
2. "髋是否高于膝"从**图像 y 轴序关系**升级为**真实重力方向序关系**；
3. 得到"离地高度之比"这一仿射可观测量 —— 这直接给出 `lying`（身体主要部分贴近地面）最接近本质的判据，且是 Auvinet 2011 用 4 台相机去求的那个量的单目仿射版本；
4. 可选叠加：用 Perspective Fields / UprightNet 从装机时的一张 RGB 自动初始化，人工确认。

代价：装机流程多一步（拍一张照 + 确认几条线）。**比换模型、加数据、加算力都便宜。**
限制：结果是仿射量（比值），不是米制；需要地面在画面中可见；需要场景有足够的直线结构（Manhattan 假设，见 Coughlan & Yuille 1999）。

---

## 附：本文引用的一手来源清单

**几何 / 相机模型**
- Hartley & Zisserman, *Multiple View Geometry in Computer Vision*, 2nd ed., CUP 2004, ISBN 0521540518 — <https://www.robots.ox.ac.uk/~vgg/hzbook/>
- Wang & Wu, *Guide to Three Dimensional Structure and Motion Factorization*, Springer 2011, Ch. 2 — DOI [10.1007/978-0-85729-046-5_2](https://doi.org/10.1007/978-0-85729-046-5_2)
- Criminisi, Reid, Zisserman, "Single View Metrology," IJCV 40(2):123–148, 2000 — DOI [10.1023/A:1026598000963](https://doi.org/10.1023/A:1026598000963)
- Coughlan & Yuille, "Manhattan World," ICCV 1999 — <https://www.ski.org/wp-content/uploads/2024/12/manhattan_iccv99_compressed.pdf>

**重力 / 相机朝向估计**
- Jin et al., "Perspective Fields for Single Image Camera Calibration," CVPR 2023 — arXiv:[2212.03239](https://arxiv.org/abs/2212.03239)
- Xian et al., "UprightNet," ICCV 2019 — arXiv:[1908.07070](https://arxiv.org/abs/1908.07070)
- Workman, Zhai, Jacobs, "Horizon Lines in the Wild," BMVC 2016 — arXiv:[1604.02129](https://arxiv.org/abs/1604.02129)
- Hold-Geoffroy et al., "A Perceptual Measure for Deep Single Image Camera Calibration," CVPR 2018 — arXiv:[1712.01259](https://arxiv.org/abs/1712.01259)

**2D→3D lifting 与深度歧义**
- Pavllo et al., VideoPose3D, CVPR 2019 — arXiv:[1811.11742](https://arxiv.org/abs/1811.11742) / <https://github.com/facebookresearch/VideoPose3D>
- Zhu et al., MotionBERT, ICCV 2023 — arXiv:[2210.06551](https://arxiv.org/abs/2210.06551) / <https://github.com/Walter0807/MotionBERT>
- Rommel et al., ManiPose, NeurIPS 2024 — arXiv:[2312.06386](https://arxiv.org/abs/2312.06386) / <https://proceedings.neurips.cc/paper_files/paper/2024/file/c223aaf2c89379cbde179858d3af1b0d-Paper-Conference.pdf>

**关键点检测器与误差学**
- MoveNet.SinglePose Model Card — <https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf>
- tfjs-models pose-detection `movenet/detector.ts` — <https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/src/movenet/detector.ts>
- COCO keypoint evaluation (OKS, σ 值) — <https://cocodataset.org/#keypoints-eval>
- Ronchi & Perona, "Benchmarking and Error Diagnosis in Multi-Instance Pose Estimation," ICCV 2017 — arXiv:[1707.05388](https://arxiv.org/abs/1707.05388)
- OpenPose 输出格式文档 — <https://github.com/CMU-Perceptual-Computing-Lab/openpose/blob/master/doc/02_output.md>

**生物力学 / 人体测量学（据 PubMed 检索与 DTIC）**
- Leporace et al., *J Biomech* 157:111747, 2023 — DOI [10.1016/j.jbiomech.2023.111747](https://doi.org/10.1016/j.jbiomech.2023.111747)
- Oyama et al., *J Appl Biomech* 33(1):64–68, 2016 — DOI [10.1123/jab.2016-0011](https://doi.org/10.1123/jab.2016-0011)
- Gordon et al., ANSUR II, Natick/TR-15/007, 2014 — <https://apps.dtic.mil/sti/pdfs/ADA611869.pdf>
- Auvinet et al., *IEEE TITB* 15(2):290–300, 2011 — DOI [10.1109/TITB.2010.2087385](https://doi.org/10.1109/TITB.2010.2087385)
- Kwolek & Kepski, *Comput Methods Programs Biomed* 117(3):489–501, 2014 — DOI [10.1016/j.cmpb.2014.09.005](https://doi.org/10.1016/j.cmpb.2014.09.005)
- Lyden et al., *Med Sci Sports Exerc* — DOI [10.1249/MSS.0000000000000804](https://doi.org/10.1249/MSS.0000000000000804)

**视角不变量（未读全文，摘要级引用）**
- Parameswaran & Chellappa, "View Invariance for Human Action Recognition," IJCV 66(1):83–101, 2006 — DOI [10.1007/s11263-005-3671-4](https://doi.org/10.1007/s11263-005-3671-4)。Springer 页面在本次环境下无法直连抓取，卷期页码经多个索引源交叉确认，**未读原文**。

**引用规范说明**：本文中 Leporace、Oyama、Auvinet、Kwolek、Lyden 五条的书目信息来自 PubMed 检索（According to PubMed），DOI 链接已随文给出。
