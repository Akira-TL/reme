# 骨架姿态分类与跌倒判据：被验证过的特征工程、失效证据，以及在单目 2D COCO-17 下的可观测性判定

- 日期：2026-08-01
- 面向：Reme 姿态分类器（A 角色 JSONL → 静态标签 standing/sitting/lying/bending_or_crouching/unknown；时序标签 normal_transition/fall_like_transition/uncertain_transition）
- 前置：`.scratch/feasibility/17-keypoint-posture-classification-literature.md`（本文不重复其模型选型结论，只补强"特征与判据的物理基础 + 失效证据 + 可观测性"）
- 检索约束：一手来源优先（期刊/会议官方页、DOI、官方框架文档、监管机构官网）；**排除 MDPI 与 Frontiers**
- 阅读深度标注：文中每条来源都标了 `[读全文]` / `[读摘要]` / `[未读原文]`，未读的一律不作为定量依据

---

## 1 结论摘要

1. **经典跌倒判据的"四件套"（包围盒宽高比突变、CoM/头部竖直速度、躯干倾角变化率、落地后静止时长）在文献中被反复独立使用，但它们的**原始形式全部依赖 Reme 不具备的量**：米制尺度、重力方向、深度、或多相机/深度相机重建。在单目归一化 2D 下它们只能退化为**投影代理量（projected proxy）**，不是同一个物理量。
2. **"阈值在实验室有效"这件事已经被一手实验证伪过至少两次**：Bagalà 等在 29 例真实老人跌倒上重测 13 个已发表算法，平均灵敏度 57.0%±27.3%（原文献多为 90–100%），最差配置每天 22–85 次误报（[PLoS ONE 2012](https://doi.org/10.1371/journal.pone.0037062)，`[读全文]`）；Sierra 等的 XGBoost 姿态分类训练 99.24% → 未见人物 74.06%（[arXiv:2605.00890](https://arxiv.org/abs/2605.00890)，`[读全文]`）。**因此任何论文准确率都不得移植为 Reme 指标。**
3. **"落地后长时间静止"是被部分证伪的判据，不能当必要条件**：Bagalà 明确记录真实跌倒中大量受试者最终坐在臀部、跪着或靠在家具上，从未进入"躺"状态，导致以 lying 为确认条件的算法漏检。它只能作为提升 precision 的**佐证（confirmatory evidence）**。
4. **单目 2D 下最稳健的信息是"骨架内部的无量纲比例与序关系"，最脆弱的是"沿光轴方向的姿态变化"**。Sierra 的几何法在同一套阈值下 standing still 98.15%、fall backward 仅 60.02%——后者正是沿相机光轴的运动，投影几乎不变。这是 Reme 必须在产品层面公开承认的系统性盲区，而不是靠调阈值能修的。
5. **一个立刻要修的工程坑（非文献问题，是本项目的实现问题）**：`x_norm` 以图像**宽**归一化、`y_norm` 以图像**高**归一化（TensorFlow 官方 MoveNet 教程的可视化代码即 `width*x, height*y`）。因此**直接用 (x_norm, y_norm) 算的任何角度和长度都被 W/H 各向异性拉伸**。16:9 画面下一条真实 45° 的躯干线会算成 60.6°。当前 `FrameLandmarks` schema 没有 `image_width/image_height` 字段，**必须先补，否则所有角度特征系统性错误且不可察觉**。

---

## 2 理论与一手文献

### 2.1 跌倒的阶段划分与"判据必须是复合的"

- **论断**：跌倒不是一个瞬时事件，而是"失衡 → 下落 → 冲击 → 冲击后姿态 → 冲击后不动"的序列；任何单一信号都不足以判定，主流做法是"冲击 + 姿态 + 静止"三条件合取。
- **出处**：Noury N., Fleury A., Rumeau P., Bourke A., Ó Laighin G., Rialle V., Lundy J., *Fall detection — Principles and Methods*, IEEE EMBC 2007, DOI [10.1109/IEMBS.2007.4352627](https://doi.org/10.1109/IEMBS.2007.4352627)（`[读摘要]`，PubMed 18002293）。该文自述是对系统/算法/传感器的综述，并指出**缺乏共同评价框架导致各系统性能无法比较**，同时提出评价流程建议。
- **原始条件**：面向可穿戴与环境传感器（加速度计、地板振动、红外），不是视觉。
- **对 Reme 的直接含义**："冲击（impact）"这一相在 Reme 完全不可观测（无加速度计、无力板）。Reme 只剩"姿态"和"静止"两相，判据强度天然弱于文献里的三相方案 —— 这是把标签命名为 `fall_like_transition`（运动学上像跌倒的转变）而不是 `fall` 的技术理由，应写进产品文案。

### 2.2 包围盒/椭圆宽高比（aspect ratio）

- **论断**：人从直立变为躺卧时，前景轮廓的"高/宽"比会从远大于 1 跌到接近或小于 1；该比值是视觉跌倒检测中被使用次数最多的单一特征。
- **出处（原始与反复使用）**：
  - Vishwakarma V., Mandal C., Sural S., *Automatic Detection of Human Fall in Video*, PReMI 2007, LNCS 4815, DOI [10.1007/978-3-540-77046-6_76](https://doi.org/10.1007/978-3-540-77046-6_76)（`[未读原文]`，仅见出版商页与二手描述：自适应背景减除 + 最小包围盒 + 两状态有限状态机）。
  - Rougier C., Meunier J., St-Arnaud A., Rousseau J., *Robust Video Surveillance for Fall Detection Based on Human Shape Deformation*, IEEE TCSVT 21(5):611–622, 2011, DOI [10.1109/TCSVT.2011.2129370](https://doi.org/10.1109/TCSVT.2011.2129370)（`[未读原文]`，仅确认了书目与 DOI）。
  - Yu M., Rhuma A., Naqvi S. M., Wang L., Chambers J., *A Posture Recognition-Based Fall Detection System for Monitoring an Elderly Person in a Smart Home Environment*, IEEE Trans. Inf. Technol. Biomed. 16(6):1274–1286, 2012, DOI [10.1109/TITB.2012.2214786](https://doi.org/10.1109/TITB.2012.2214786)（`[读全文]`，读的是 [nlpr.ia.ac.cn 镜像 PDF](https://nlpr.ia.ac.cn/2012papers/gjkw/gk21.pdf)，非 IEEE 官方 PDF）。该文用**椭圆拟合**替代矩形拟合，全局特征只有两个：椭圆主轴与水平轴夹角 Θ，以及长短半轴比 a/b；并明确说椭圆拟合在分割噪声（脚下多出一条线）下比矩形更稳。
  - Kwolek B., Kępski M., *Human fall detection on embedded platform using depth maps and wireless accelerometer*, Computer Methods and Programs in Biomedicine 117(3):489–501, 2014, DOI [10.1016/j.cmpb.2014.09.005](https://doi.org/10.1016/j.cmpb.2014.09.005)。其 [UR Fall Detection 官方数据集页](https://fenix.ur.edu.pl/mkepski/ds/uf.html)（`[读全文]`）列出的特征即：H/W 包围盒比、blob 长短轴比、包围盒占用率、像素相对质心的标准差（X/Z）、当前身高与站立身高之比、实际身高（mm）、人体中心到地面的距离、40 cm 立方体内的地面占用率。
- **原始条件**：全部基于**前景轮廓/剪影或深度图**，不是骨架关键点；Kwolek 用的是 Kinect 深度图，因此"实际身高（mm）"和"到地面平面的距离"是**真实米制量**。
- **脆弱点（一手证据）**：
  - Yu 等在构建姿态数据集时明确要求 15 名受试者"在不同方向上模拟姿态，使分类器对视角鲁棒"——这等于承认**特征本身不是视角不变的**，鲁棒性靠训练数据覆盖买来。
  - Auvinet E., Multon F., Saint-Arnaud A., Rousseau J., Meunier J., *Fall Detection With Multiple Cameras: An Occlusion-Resistant Method Based on 3-D Silhouette Vertical Distribution*, IEEE Trans. Inf. Technol. Biomed. 15(2):290–300, 2011, DOI [10.1109/TITB.2010.2087385](https://doi.org/10.1109/TITB.2010.2087385)（`[未读原文]`）。整篇工作的动机就是单视角形状特征在遮挡与视角变化下不可靠，改用多相机 shape-from-silhouette 重建体积，并取"40 cm 以下体积 / 总体积"作指标（VVDR）。**多相机不是为了提精度，是为了拿回单视角丢掉的信息。**
- **Reme 判定**：可用，但（a）必须先做 W/H 各向异性纠正；（b）文献阈值（例如"比值 <1 即为躺"）**绝对不可移植**，因为归一化坐标下该比值被常数因子 H/W 缩放；（c）必须按 `scene_id`（机位）校准。

### 2.3 CoM / 头部竖直速度

- **论断**：跌倒时人体质心（或头部）的竖直速度显著大于日常活动；这是"下落相"最直接的信号。
- **出处**：
  - Rougier C., Meunier J., St-Arnaud A., Rousseau J., *Monocular 3D Head Tracking to Detect Falls of Elderly People*, IEEE EMBC 2006, pp. 6384–6387, DOI [10.1109/IEMBS.2006.260829](https://doi.org/10.1109/IEMBS.2006.260829)（`[读摘要]`，PubMed 17947190）。摘要原文即"基于头部的 3D 轨迹……用 3D 速度区分跌倒与正常活动"。**关键点：作者是从单目视频里重建 3D 头部轨迹，即引入了头部的 3D 模型/尺寸先验与相机标定，才把像素速度变回 3D 速度。Reme 没有做这一步。**
  - Bourke 系列算法（经 Bagalà 等复现描述，`[读全文]`）：Bourke3 使用竖直速度阈值 −0.7 m/s、下降沿 600 ms、上升沿 350 ms，冲击后 1–3 s 内 75% 的时间处于 ≥60° 躺姿。
- **物理基础（可引，且与传感器无关）**：自由落体 h = ½gt²。质心下落 1 m 约需 0.45 s，末速约 3 m/s。这个量级只能用来**设计时间窗长度**（Reme 30 FPS → 0.45 s ≈ 14 帧），**不能当判据**。
- **动态稳定性的严格形式**：Hof A. L., Gazendam M. G. J., Sinke W. E., *The condition for dynamic stability*, Journal of Biomechanics 38(1):1–8, 2005, DOI [10.1016/j.jbiomech.2004.03.025](https://doi.org/10.1016/j.jbiomech.2004.03.025)（`[读摘要]`）。判据是：CoM 位置 + CoM 速度 × √(l/g) 必须落在支撑面（base of support）内，该矢量称 XcoM，到支撑面边界的最小距离即 margin of stability。**原始条件：需要 3D CoM 位置、3D CoM 速度、腿长 l（米）、以及支撑面在地面上的几何边界 —— 通常由测力台 + 3D 动捕给出。Reme 四项全无。**
  - 唯一可搬走的东西是**时间常数** √(l/g)：l≈0.9 m → 0.30 s。这为"失衡后到落地"的时间尺度给了一个物理量级，可用于选择时序窗（约 0.3–1.0 s），仅此而已。
- **人体质心的分段估计**：de Leva P., *Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters*, Journal of Biomechanics 29(9):1223–1230, 1996, DOI [10.1016/0021-9290(95)00178-6](https://doi.org/10.1016/0021-9290(95)00178-6)（`[读摘要]`，**未读参数表**）。给出各体段相对质量与质心位置（相对于关节中心），是 CoM 估计的标准来源。**原始条件：3D 体段端点。用 2D 投影关键点加权得到的只是"投影伪质心"，不是 CoM 在图像上的投影（两者在透视 + 自遮挡下不等价）。** 实现时若要用这些系数，必须回读原表，不得凭记忆填数。
- **Reme 判定**：**不可观测 m/s**。只能得到"归一化图像高度/秒"或（更好）"躯干长度/秒"。不得在任何输出、日志、UI 中出现 m/s 或 g。

### 2.4 躯干倾角与其变化率

- **论断**：跌倒伴随躯干（或身体长轴）相对重力方向的大角度快速旋转；姿态角变化 20° 级别常被用作触发条件。
- **出处**：
  - Yu 等 2012（`[读全文]`）：椭圆主轴与水平轴夹角 Θ = ½·arctan(2u₁₁/(u₂₀−u₀₂))，由二值前景的中心矩算出；与 a/b 一起构成仅 2 维的全局特征。作者明确指出全局特征不足以分开 sit 与 sit-like bend，因此又加了沿椭圆长/短轴的投影直方图（各 30 bin，共 60 维），总特征 62 维，用 DAGSVM 分类为 bend/lie/sit/stand。
  - Chen 等的加速度计算法（经 Bagalà 复现，`[读全文]`）：sum vector 冲击检测 + **20° 的朝向变化阈值**。
- **原始条件**：Yu 是 2D 剪影，Θ 是**图像平面内**的角；Chen 是体表加速度计，20° 是**相对重力矢量**的真实倾角变化。两者不是同一个量，不要混用阈值。
- **脆弱点（一手证据）**：Sierra 等 2026（`[读全文]`）的几何法对 8 个姿态的逐类准确率为 standing still 98.15% / fall forward 85.23% / **fall backward 60.02%** / fall left 91.12% / fall right 90.22% / lifting left hand 98.45% / lifting right hand 98.10% / sitting 97.67%。作者自己解释 standing still 高是"因为与标定姿态相似"。**backward 一类塌陷，正对应沿相机光轴的运动在图像平面上投影量最小。**
- **Reme 判定**：可用，但只是"图像平面内的投影倾角"。必须显式记录并在证据里标注：当躯干矢量的图像投影长度显著短于该场景的典型躯干长度时（强前后向倾斜的标志），倾角估计不可信 → 触发 `uncertain_transition` / `unknown`。

### 2.5 落地后静止时长与空间语境

- **论断（被反复使用）**："跌倒后长时间不动"是把"躺在地上"与"躺在沙发上"分开的关键，而且必须结合**位置语境**。
- **出处**：
  - Nait-Charif H., McKenna S. J., *Activity Summarisation and Fall Detection in a Supportive Home Environment*, ICPR 2004（`[读全文]`，作者机构自存 [PDF](http://nccastaff.bournemouth.ac.uk/hncharif/Publications/activitysummarisation.pdf)）。用粗椭圆模型 + 粒子滤波跟踪，状态 eₜ=(xₜ,yₜ,ψₜ,sₜ,eₜ)；**从轨迹中无监督学出"惯常静止区（inactivity zones，椅子/床）"与"出入口区（entry zones）"的高斯混合模型**，把"在惯常静止区之外的静止"作为跌倒线索。原文明确写道：不活动的意义随语境变化，在从未躺过的地方躺下可能意味着摔倒并需要帮助。
  - Yu 等 2012（`[读全文]`）的跌倒规则是三条合取：①姿态为 lie 或 bend；②人体位于**已检测的地面区域**内；③以上两条持续超过时间阈值（**取 30 s**）。作者举例：躺在沙发上被正确排除（不在地面区域）；系鞋带的 bend 被正确排除（不持续）。在 15 人模拟的 240 次跌倒 / 240 次非跌倒上得到 233/240 = 97.08% 检出、2/240 = 0.8% 误报。**注意：这是模拟跌倒 + 留一人交叉验证（"用其他人的姿态样本训练该人的分类器"），不是真实跌倒。**
- **被证伪之处（一手证据，`[读全文]`）**：Bagalà 等 2012 在真实跌倒上发现：
  - 低通滤波后的竖直信号"很少降到被认为是躺姿的 0.5 g 以下"；
  - 摔坐在臀部、跪倒、靠在桌子上的受试者"并没有躺在地板上"；
  - 因此以 lying 为确认条件虽然提升了特异度，但"并非在所有跌倒中都出现"。
  - 作者对失败原因的总结包括：算法在质量、年龄、病史不同的个体上测试，**固定阈值可能不是最优**；阈值通常在模拟跌倒信号上标定，**不适用于真实跌倒信号**；**算法越复杂，需要同时满足的阈值假设越多，越不容易检出跌倒**。
- **Reme 判定**：
  - "落地后静止"只能作为**提高置信度的佐证**，绝不能作为 `fall_like_transition` 的必要条件。
  - "地面区域 / 惯常静止区"在单目 2D 下**没有几何解**（没有地面平面、没有单应），但**有统计解**：按 `scene_id` 学该机位下"人处于低位时 y 的分布"，把它当作**每机位先验**而不是通用常数。这条必须显式标注为"需要每机位校准，未校准时降级到 unknown"。

### 2.6 明确使用几何/可解释特征的骨架姿态分类工作

- **Sierra S. D. M., Sinha M., Múnera M., Cifuentes C. A., *Skeleton-Based Posture Classification to Promote Safer Walker-Assisted Gait in Older Adults*, arXiv:2605.00890（2026 预印本，非同行评审）** — [论文页](https://arxiv.org/abs/2605.00890)，`[读全文]`
  - 输入：MediaPipe Pose Landmarker（lite），**33 个 3D 关键点**，不是 MoveNet 17 点。
  - 特征：预处理为 **48 维"关节间距离与角度"**（原文只写到这一句，**没有列出具体是哪些角、哪些距离**——这是该文可复现性的一个实质缺陷，Reme 不能声称复现了它）。
  - 几何法的真实形态：**先做一次初始姿态标定（initial pose calibration）**，再算每个 landmark 相对标定姿态的欧氏偏差向量，对偏差做加权，与"经验确定的阈值"比较，分出 standing / leaning forward / leaning backward / twisting left / twisting right / lifting hands / sitting 等 8 类；抬手还额外用了助行器把手上的力敏电阻。→ **这是逐人标定的个体化阈值系统，不是跨人物通用几何规则。**
  - 数据：21 名健康成人（21–48 岁），17 人用于训练/测试，**4 人作为未见人物**；几何法的评测只有 3 名健康用户、2 分钟走动、每姿态 15 秒。
  - 结果（关键对照）：XGBoost 姿态分类**训练 99.24% → 未见人物 74.06%**；EDCNN 90.88% → 66.0%；4 层 CNN 90.0% → 76.0%；SVM 79.0% → 66.7%。几何法整体 89.87%，但逐类塌陷到 fall backward 60.02%。
  - 作者自述局限：多类姿态分类明显更差、数据集小、未评估延迟与功耗。
  - **对 Reme 最重要的一条**：这是一份"训练指标不能代表部署指标"的一手证据，且失败结构与 Reme 完全同构（少量受试者、固定机位、多类姿态）。
- **Yu 等 2012（见 §2.2/§2.4，`[读全文]`）** — 62 维手工特征（2 维椭圆全局 + 60 维投影直方图）+ DAGSVM，四类 bend/lie/sit/stand。值得学的两点：(a) 投影直方图按椭圆长短轴长度归一化，作者明确说这是为了让特征**对人到相机的距离不变**——这正是 Reme 需要的"用骨架内部长度做尺度归一化"思想；(b) 作者比较了全局特征、局部特征、二者组合，并在**注入 10% 标签/分割噪声**的数据上重测，DAGSVM 只掉 0.58%。**"在含噪数据上单独报一次指标"是 Reme 应该抄的评测习惯。**
- **Anderson D., Luke R. H., Keller J. M., Skubic M., Rantz M., Aud M., *Linguistic summarization of video for fall detection using voxel person and fuzzy logic*, Computer Vision and Image Understanding 113(1):80–89, 2009, DOI [10.1016/j.cviu.2008.07.006](https://doi.org/10.1016/j.cviu.2008.07.006)（`[读摘要]`，PubMed 20046216）** — 用三个模糊状态 **upright / in-between / on-the-ground** 的隶属度曲线描述人的姿态，再用**分层模糊逻辑**（第一层推瞬时体态，第二层对体态的语言学摘要推活动）。规则可按住户增删修改。**这是本次调研里唯一一个"分类输出天然带人类可读理由"的视觉跌倒工作**，见 §2.8。原始条件是 **voxel person（多相机重建的体素人）**，不是单目。
- **Human posture recognition based on multiple features and rule learning*, Int. J. Machine Learning and Cybernetics（仓库既有调研已列，[Springer 页](https://link.springer.com/article/10.1007/s13042-020-01138-y)，`[未读原文]`）** — 角度 + 距离特征 + 规则学习，本轮未新增证据。

### 2.7 阈值型方法的跨人物/跨机位泛化失败：一手证据汇总

| 证据 | 条件 | 数字 | 一手来源 |
|---|---|---|---|
| 13 个已发表加速度计算法在 **29 例真实老人跌倒**上重测 | 真实跌倒（非模拟） | 平均灵敏度 **57.0% ± 27.3%**（最高 82.8%）；Kangas 系列从原报告 76–97% 掉到 32–53%；Bourke1a 原报告 100%/100% → 真实数据特异度 **19.3%** | Bagalà et al., PLoS ONE 7(5):e37062, 2012, DOI [10.1371/journal.pone.0037062](https://doi.org/10.1371/journal.pone.0037062) `[读全文]` |
| 同上，日常佩戴的误报率 | 3 名跌倒者 24 小时监测 | Bourke1a **每天 22–85 次误报**；Bourke1b 27–84；Bourke2 约 20；Bourke3 约 5 | 同上 |
| 骨架/关键点几何法跨人物 | 21 人采集、4 人未见 | XGBoost 姿态分类 **99.24% → 74.06%** | Sierra et al., arXiv:2605.00890 `[读全文]` |
| 同上，跨姿态方向 | 3 人复现 8 姿态 | standing still 98.15% vs **fall backward 60.02%** | 同上 |
| 视觉跌倒检测阈值的个体依赖 | 综述归纳 | 明确指出个体化阈值是"基于受试者身高确定"的；并指出实验室达到的检出率在真实场景下下降 | Igual R., Medrano C., Plaza I., *Challenges, issues and trends in fall detection systems*, BioMed Eng OnLine 12:66, 2013, DOI [10.1186/1475-925X-12-66](https://doi.org/10.1186/1475-925X-12-66) `[读全文（PMC）]` |
| 同上，真实跌倒数据稀缺 | 综述归纳 | 只有 6 项研究纳入老年受试者，且仅要求其"在数分钟或数小时内完成一组模拟活动"；仅极少数研究报告真实跌倒的加速度数据 | 同上 |
| 视觉算法在真实居家数据上的落差 | 7 户老人住所、数月真实录像 | 作者自述此前算法"几乎全部只在人工环境下的短视频片段、由演员模拟跌倒"上评测；真实数据画质低、跌倒稀少且速度与形态多变 | Debard G. et al., *Camera-based fall detection using real-world versus simulated data: How far are we from the solution?*, J. Ambient Intelligence and Smart Environments 8(2):149–168, 2016, DOI [10.3233/AIS-160369](https://doi.org/10.3233/AIS-160369) `[未读原文，仅见出版商摘要级描述]`；配套数据集论文 Healthcare Technology Letters 2016, DOI [10.1049/htl.2015.0047](https://doi.org/10.1049/htl.2015.0047) `[未读原文，IET 站点 403]` |
| 跨机位在骨架动作识别里被当作独立评测协议 | NTU RGB+D | 官方定义 **Cross-Subject** 与 **Cross-View** 两套协议（C2/C3 训练、C1 测试）——即社区默认"换视角是一个会掉点的独立分布偏移" | Shahroudy A., Liu J., Ng T.-T., Wang G., CVPR 2016, [官方论文页](https://openaccess.thecvf.com/content_cvpr_2016/html/Shahroudy_NTU_RGBD_A_CVPR_2016_paper.html) `[读摘要/协议定义]` |
| 姿态估计器本身在躺姿上的域外问题 | 卧床姿态 | 作者指出缺乏公开的卧床姿态数据集"阻碍了许多成功的姿态估计算法用于该任务"；用 SLP 训练后单模态可达 PCKh@0.5 95% | Liu S., Huang X., Fu N., Li C., Su Z., Ostadabbas S., *Simultaneously-Collected Multimodal Lying Pose Dataset*, IEEE TPAMI 2022, [arXiv:2008.08735](https://arxiv.org/abs/2008.08735) `[读摘要]` |

**归纳出的失败模式（可直接写进 Reme 的风险清单）**
1. **模拟→真实**：在健康年轻人模拟跌倒上标定的阈值，在真实跌倒上灵敏度腰斩。
2. **跨个体**：体型、身高、病史差异使固定阈值非最优（Bagalà 明言）。
3. **跨机位/视角**：形状类特征（宽高比、椭圆角）不是视角不变量；文献靠"多方向采样训练"或"多相机重建"补偿。
4. **沿光轴方向**：前后向跌倒的图像平面投影量最小 → 系统性漏检（Sierra fall backward 60%）。
5. **合取条件越多越漏**：Bagalà 明确指出算法越复杂、需同时满足的阈值假设越多，越不容易检出。
6. **"落地后静止"不总发生**：真实跌倒常止于坐/跪/倚靠。

### 2.8 可解释 AI 在医疗/关怀场景：为什么"事后归因"不够

- **论断 A：事后可解释性（post-hoc explainability）在个体患者层面不可靠，应以严格的内外部验证替代。**
  - 出处：Ghassemi M., Oakden-Rayner L., Beam A. L., *The false hope of current approaches to explainable artificial intelligence in health care*, Lancet Digital Health 3(11):e745–e750, 2021, DOI [10.1016/S2589-7500(21)00208-9](https://doi.org/10.1016/S2589-7500(21)00208-9)（`[读摘要]`，PubMed 34711379）。摘要原文主张当前可解释性方法"不太可能在患者层级决策支持上实现这些目标（建立信任、提供透明度、缓解偏倚）"，并**主张以严格的内部与外部验证作为更直接的手段，并告诫不要把可解释性当作临床部署的硬性要求**。
  - **对 Reme 的翻译**：不要做"给分类结果配一张热力图/一组 SHAP 值"。要做的是"分类结论本身就由可核查的量构成"。
- **论断 B：高风险场景应直接用本质可解释模型，而不是给黑箱套解释。**
  - 出处：Rudin C., *Stop Explaining Black Box Machine Learning Models for High Stakes Decisions and Use Interpretable Models Instead*, Nature Machine Intelligence 1:206–215, 2019；预印本 [arXiv:1811.10154](https://arxiv.org/abs/1811.10154)（`[读摘要]`）。核心论点：试图解释黑箱"可能延续坏实践并造成灾难性伤害"，正确做法是"一开始就设计本质可解释的模型"。
- **论断 C：可解释模型能让人**发现并修掉**数据里的荒谬模式，这是黑箱做不到的。**
  - 出处：Caruana R., Lou Y., Gehrke J., Koch P., Sturm M., Elhadad N., *Intelligible Models for HealthCare: Predicting Pneumonia Risk and Hospital 30-day Readmission*, KDD 2015, DOI [10.1145/2783258.2788613](https://doi.org/10.1145/2783258.2788613)（`[读摘要]`）。摘要明确：可解释的 GA²M 模型"揭示了数据中令人意外的模式，这些模式此前阻止了复杂学习模型在该领域落地"，而可解释性使从业者能够**识别并移除**这些问题模式。
- **论断 D：显著性/归因图可能与模型参数和标签无关（即它根本没在解释模型）。**
  - 出处：Adebayo J., Gilmer J., Muelly M., Goodfellow I., Hardt M., Kim B., *Sanity Checks for Saliency Maps*, NeurIPS 2018（[dblp 记录](https://dblp.org/rec/conf/nips/AdebayoGMGHK18.html)，`[未读原文]`——本次抓取 arXiv 失败，仅确认书目）。**因未读原文，本文不引用其任何定量结论，只作为"归因方法需要经过 sanity check 才能使用"的书目锚点。**
- **论断 E：监管侧对"给出理由"的具体要求。**
  - EU AI Act（Regulation (EU) 2024/1689）**Article 86**（欧盟委员会 AI Act Service Desk 官方条文，`[读全文]`）：受高风险 AI 系统输出所作决定影响、且认为该决定对其健康、安全或基本权利有不利影响的人，"有权从部署者处获得**关于该 AI 系统在决策程序中所起作用以及所作决定的主要要素**的清晰且有意义的解释"。链接：<https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-86>
    - 注意措辞：要求解释的是"系统在决策中的**角色**"和"决定的**主要要素（main elements）**"，**不是**要求给出模型内部权重或热力图。这恰好与"用可核查的证据条目描述结论"对齐。
  - FDA / Health Canada / MHRA, *Transparency for Machine Learning-Enabled Medical Devices: Guiding Principles*, 2024 年 6 月（官方文档 <https://www.fda.gov/media/179269/download>，官方页 <https://www.fda.gov/medical-devices/software-medical-device-samd/transparency-machine-learning-enabled-medical-devices-guiding-principles>；`[读官方页摘要级文本，未逐条读 PDF]`）。其对"透明度"的定义是：**关于该器械的适当信息（包括其预期用途、开发过程、性能，以及在可获得时的逻辑（logic））被清晰传达的程度**。并建立在 2021 年 GMLP 十原则之上，特别是原则 7（关注人机团队的表现）与原则 9（向用户提供清晰、必要的信息）。
  - **Reme 不是医疗器械、不做医疗声明**——但上述两条给出了"给理由"的**内容规格**：预期用途、性能、局限、以及（可得时的）逻辑。这正好可以直接作为 Reme 输出 schema 的字段来源。

### 2.9 分类器输出"为什么"的既有结构化做法（可抄的 schema 范例）

| 做法 | 输出形态 | 一手来源 | 可抄之处 |
|---|---|---|---|
| **Anchors**（规则型局部解释） | IF-THEN 谓词集合 + **precision** + **coverage** 两个统计量 | Ribeiro M. T., Singh S., Guestrin C., AAAI 2018, 32:1527–1535, [AAAI 官方页](https://aaai.org/papers/11491-anchors-high-precision-model-agnostic-explanations/) `[读摘要]` | "证据"必须自带**可核查的统计属性**（这条规则在验证集上的精度与覆盖率），而不是一句自然语言 |
| **Concept Bottleneck Models** | 先预测人可理解的中间概念，再由概念预测标签；**可以直接修改概念值并传播到最终预测** | Koh P. W. et al., ICML 2020, PMLR 119:5338–5348, [PMLR 官方页](https://proceedings.mlr.press/v119/koh20a.html)；[官方代码](https://github.com/yewsiang/ConceptBottleneck) `[读摘要]` | Reme 的几何特征天然就是"概念层"。**可介入性（intervenability）**是最强的可核查性：人可以把 `trunk_angle` 改成正确值看结论是否改变 |
| **GA²M / Explainable Boosting Machine** | 每个特征的形状函数 + 成对交互，可逐特征作图审查 | Caruana et al., KDD 2015（同上）；Nori H., Jenkins S., Koch P., Caruana R., *InterpretML*, [arXiv:1909.09223](https://arxiv.org/abs/1909.09223)，[官方仓库](https://github.com/interpretml/interpret) `[读摘要]` | 若最终要上学习模型而非纯规则，EBM 是能同时给出"每个几何特征贡献了多少"的玻璃箱选项 |
| **Certifiably Optimal Rule Lists (CORELS)** | 带最优性证书的规则列表 | Angelino E., Larus-Stone N., Alabi D., Seltzer M., Rudin C., KDD 2017, DOI [10.1145/3097983.3098047](https://doi.org/10.1145/3097983.3098047)；[官方站点](https://corels.cs.ubc.ca/corels/)、[官方代码](https://github.com/corels/corels) `[读摘要]` | 规则列表本身就是决策依据，无需事后解释；且规则数量可控（适合 5 类姿态） |
| **分层模糊语言学摘要**（视觉跌倒专用） | upright / in-between / on-the-ground 三态隶属度曲线 → 语言学摘要 → 活动 | Anderson et al., CVIU 2009（同 §2.6）`[读摘要]` | 与 Reme 标签体系几乎同构；"隶属度曲线"天然给出软证据与不确定度，规则可按住户定制 |
| **Model Cards** | 结构化的模型文档：预期用途、评测条件、分组性能、局限 | Mitchell M. et al., FAT* 2019, DOI [10.1145/3287560.3287596](https://doi.org/10.1145/3287560.3287596)；[arXiv:1810.03993](https://arxiv.org/abs/1810.03993) `[读摘要]` | 与 FDA 透明度原则要求的内容项高度重合，可直接做 Reme 分类器的随附文档模板 |
| **拒判 / 选择性预测** | 输出 `{predict, abstain}` + 风险-覆盖率曲线 | Chow C. K., *On optimum recognition error and reject tradeoff*, IEEE Trans. Information Theory 16(1):41–46, 1970, DOI [10.1109/TIT.1970.1054406](https://doi.org/10.1109/TIT.1970.1054406) `[读摘要]`；Geifman Y., El-Yaniv R., *Selective Classification for Deep Neural Networks*, NeurIPS 2017, [官方页](https://papers.nips.cc/paper/7073-selective-classification-for-deep-neural-networks) `[读摘要]` | `unknown` / `uncertain_transition` 不是"兜底"，而是**有理论的最优拒判**：先设定可接受风险，再由风险-覆盖率曲线定阈值，并报告覆盖率 |

---

## 3 在单目 2D 归一化 COCO-17 下，逐项可观测性判定

判定口径：
- **可观测（O）**：仅由 `{(x_norm, y_norm, score)}×17 + 时间戳 + 图像宽高比` 即可无偏计算（在弱透视近似下）。
- **投影代理（P）**：能算出一个数，但它是真实物理量的投影/单调代理，带系统偏差，偏差方向与相机位姿和人体朝向有关。
- **不可观测（X）**：没有额外信息（内参、深度、标定、地面平面、传感器）就无解；任何"算出来的值"都是假装。

| 物理/生物力学量 | 判定 | 理由与偏差来源 |
|---|---|---|
| 米制尺度（cm/m） | **X** | 单目投影 u = f·X/Z，尺度与深度耦合，无内参与已知尺寸物体则不可解 |
| 任一关键点深度 Z | **X** | 同上 |
| 重力方向在图像中的方向 | **X**（可作为**每机位常数**估计） | 只有当光轴水平且无 roll 时图像 −y 才≈重力。俯仰安装的相机下 −y 不是重力。可按 `scene_id` 从站立样本估一个"该机位的视觉竖直方向"，但这是**校准结果**不是观测量 |
| CoM 三维位置 | **X** | 需要 3D 体段端点 + 体段质量分数（de Leva 1996） |
| CoM 竖直速度（m/s） | **X** | 无尺度、无深度 |
| 加速度 / 冲击幅值（g） | **X** | 无 IMU、无力板；对像素轨迹二阶差分只是噪声放大 |
| 支撑面（BoS）几何、XcoM、margin of stability | **X** | Hof 2005 的判据需要 CoM 位置+速度+腿长+地面上的支撑多边形 |
| 地面平面 / "人是否在地板上" | **X**（几何解）/ **P**（统计解） | 无单应与内参则无几何解；但可按 `scene_id` 学"低位时 y 的经验分布"作为每机位先验（Nait-Charif 2004 的 inactivity zone 思想的 2D 退化版） |
| 床/沙发 vs 地板 | **X** | Yu 2012 靠地面区域检测解决，Reme 无此信息 → 必须由 `unknown` 承接 |
| 冲击时刻 / 落地事件 | **X** | 无接触传感 |
| 体重、体段质量 | **X** | — |
| 真实关节角（3D） | **X** | — |
| 躯干相对重力的真实倾角 | **P** | 只能得图像平面内投影角；躯干沿光轴倾斜时投影角趋近 0（=看起来仍直立）——Sierra fall backward 60% 的直接机制 |
| 膝/髋屈曲角 | **P** | 同上；肢段与光轴平行时投影角误差无界 |
| 人体"高度" | **P** | 图像内竖直跨度与到相机的距离混淆（透视）。用骨架内部长度归一化后可部分消除 |
| 包围盒宽高比 | **P** | 依赖相机高度/俯仰、跌倒方向相对像平面的取向；且在归一化坐标下被常数 H/W 缩放 |
| 骨架"伪质心"（关键点加权平均） | **P** | 是投影后的加权平均，不等于 CoM 的投影；自遮挡与前后缩影引入偏差 |
| 骨盆（hip mid）高度 | **P** | 同"人体高度" |
| 竖直速度（躯干长度/秒） | **P** | 无量纲化后与米制速度成比例，比例常数依赖 该人躯干长度 与 该机位透视，未知但对同一 scene 近似恒定 |
| 躯干投影角变化率（deg/s） | **P** | 时间是可靠的（时间戳），角度是投影的 |
| 关键点 y 的序关系（nose<shoulder<hip<knee<ankle 等） | **O** | 序关系在单调透视下保持；对尺度与到相机距离不变。**这是本项目最稳的一类特征** |
| 骨架内部长度比（如 竖直跨度/躯干长度、肩宽/髋宽） | **O**（弱透视下） | 同一深度平面内比值消去未知尺度因子；人体前后展开较大时退化为 P |
| 左右对称性 | **O** | 比值型 |
| 关键点置信度、缺失模式、`landmark_quality` | **O** | 直接来自 schema |
| 时间导数（帧间差 / 时间戳差） | **O**（时间部分） | 时间戳可靠；被求导的量的可观测性由该量决定 |
| 姿态**变化**的存在性（有没有发生一次大幅重构） | **O** | 即使角度有偏，"分布发生了显著跃迁"本身是可观测的 |

**必须写进文档、不得回避的三条**
1. **没有 m/s、没有 g、没有 cm。** 任何输出字段、日志、UI 文案里出现米制单位即为 bug。
2. **前后向（沿光轴）的姿态变化是系统性盲区**，这不是精度问题而是可观测性问题；只能靠 `uncertain_transition` 承接，不能靠调阈值消除。
3. **"人躺在地板上" vs "人躺在沙发上"在纯几何上不可判**；只能用每机位统计先验降低不确定度，且必须允许拒判。

---

## 4 可直接编码的量与公式（COCO-17 索引）

约定：`P[i] = (x_i, y_i, s_i)`，`x_i, y_i ∈ [0,1]`，y 轴向下。索引：0 nose, 1/2 eye, 3/4 ear, 5/6 shoulder(L/R), 7/8 elbow, 9/10 wrist, 11/12 hip(L/R), 13/14 knee, 15/16 ankle。

### 4.0 前置：各向异性纠正（**必做，否则以下全部失效**）

TensorFlow 官方 MoveNet 教程的可视化代码把归一化坐标还原为像素时写的是
`kpts_absolute_xy = np.stack([width * kpts_x, height * kpts_y], axis=-1)`
（[官方教程](https://www.tensorflow.org/hub/tutorials/movenet)，`[读全文]`），即 x 以**宽**、y 以**高**归一化。因此定义**统一到"图像高度"单位**的工作坐标：

```
A  = W_px / H_px            # 图像宽高比，必须由 A 角色写入 schema
u_i = x_i * A               # 单位：图像高度
v_i = y_i                   # 单位：图像高度
```

此后所有长度、角度、比例一律在 `(u, v)` 上计算。
**Gate 项：`FrameLandmarks` schema 需新增 `image_width_px` / `image_height_px`（或 `pixel_aspect`），并需要 A 角色确认 `x_norm,y_norm` 到底是相对"原始帧"还是相对"MoveNet 的 resize_with_pad 方形输入"——两者相差一次平移+缩放，会污染 §4.2 起的一切。**

### 4.1 基础派生点与尺度参考

```
S  = ((u5+u6)/2, (v5+v6)/2)      # shoulder mid
H  = ((u11+u12)/2, (v11+v12)/2)  # hip mid
K  = ((u13+u14)/2, (v13+v14)/2)  # knee mid
Ak = ((u15+u16)/2, (v15+v16)/2)  # ankle mid

L_torso   = ||S - H||
L_shoulder= ||P5 - P6||
L_hip     = ||P11 - P12||
```

**尺度参考 L_ref 的选取（关键）**：单帧的 `L_torso` 本身会因前后缩影而变短（人前倾时躯干投影变短）。因此：

```
L_ref(scene, t) = 该 scene_id 下 L_torso 的滑动高分位数（建议 P90，窗口 ≥ 10 s）
```
只有在该分位数可用且样本足够时才启用需要 L_ref 的特征，否则该特征标记 `unavailable`。

### 4.2 静态姿态特征（全部无量纲）

```
# F1 垂直度指数（body verticality）：身体长轴与图像竖直方向的余弦
d      = Ak - S                       # 从肩中点指向踝中点
vert   = d_v / ||d||                  # ∈[-1,1]；站立≈+1，躺≈0，倒立≈-1
# 若踝不可用，退化用 K；再不可用退化用 H（并降级 quality）

# F2 躯干投影倾角（deg），0° = 图像竖直
t      = S - H
theta_trunk = degrees( atan2( |t_u| , max(0, -t_v) ) )   # -t_v>0 表示肩在髋之上
# 若 t_v >= 0（肩不在髋之上）→ theta_trunk 置为 >90°，并置 flag `inverted_torso`

# F3 关键点包围盒宽高比（仅用 score ≥ τ_kp 的点）
w = max(u_i) - min(u_i) ;  h = max(v_i) - min(v_i)
AR = w / max(h, eps)          # 站立 <1，躺 >1（方向随机位而变，必须校准）
# 更稳的等价量（避免除零、值域有界）：
elong = h / (h + w)           # ∈(0,1)，值域有界；站立→显著 >0.5，躺→显著 <0.5

# F4 竖直展开比（身体在图像里"立起来"的程度）
extent_ratio = h / L_ref

# F5 骨盆相对踝的高度（sit/stand 主判别量）
pelvis_rise = (v_Ak - v_H) / L_ref     # 站立最大，坐中等，躺≈0

# F6 膝角（左右各一，投影角）
knee_angle_L = angle(P11 - P13, P15 - P13)   # deg
knee_angle_R = angle(P12 - P14, P16 - P14)

# F7 髋角（躯干-大腿夹角，投影角）
hip_angle_L  = angle(S - P11, P13 - P11)
hip_angle_R  = angle(S - P12, P14 - P12)

# F8 序关系（布尔/序数，最稳健的一族）
ord_head_above_sh   = sign(v_S  - v0)       # nose 在肩之上
ord_sh_above_hip    = sign(v_H  - v_S)
ord_hip_above_knee  = sign(v_K  - v_H)
ord_knee_above_ankle= sign(v_Ak - v_K)
n_ord_satisfied     = 满足"站立式自上而下顺序"的关系数（0..4）

# F9 竖直坍缩度（躺的直接证据）：所有可用点的 v 展布 与 u 展布之比
spread_ratio = std(v_avail) / max(std(u_avail), eps)

# F10 左右不对称（用于识别侧躺/单侧遮挡）
asym = | ||P5-P11|| - ||P6-P12|| | / L_ref

# F11 观测质量
usable_ratio  = #{i : s_i >= τ_kp} / 17
core_usable   = all(s_i >= τ_kp for i in {5,6,11,12})   # 躯干四点
```

**类别语义（作为规则骨架，阈值全部待校准）**
- `standing`：`vert` 高、`n_ord_satisfied` 高、`pelvis_rise` 高、`knee_angle` 接近伸直。
- `sitting`：`vert` 中高、`pelvis_rise` 中、`knee_angle`/`hip_angle` 明显屈曲、`elong` 中。
- `lying`：`vert` 低、`spread_ratio` 低、`elong` 低、`pelvis_rise` ≈ 0。
- `bending_or_crouching`：`theta_trunk` 大但 `pelvis_rise` 仍非零 / `knee_angle` 屈曲且 `n_ord_satisfied` 未完全崩塌。**这是与 lying 最容易混的类**（Yu 2012 也承认 sit 与 sit-like bend 靠全局特征分不开，需要局部特征）。
- `unknown`：`core_usable` 为假，或 `landmark_quality != usable`，或多类得分接近（见 §5 拒判）。

### 4.3 时序特征（窗口建议 0.3–1.0 s；30 FPS → 9–30 帧）

```
dt = (timestamp_ms[t] - timestamp_ms[t-k]) / 1000

# T1 骨盆下降速率（单位：躯干长度/秒；**不是 m/s**）
v_drop = ( v_H[t] - v_H[t-k] ) / L_ref / dt        # 正值 = 向下（y 轴朝下）

# T2 躯干角速率
omega_trunk = ( theta_trunk[t] - theta_trunk[t-k] ) / dt      # deg/s

# T3 垂直度变化率
d_vert = ( vert[t] - vert[t-k] ) / dt

# T4 宽高比跃变
d_elong = ( elong[t] - elong[t-k] ) / dt

# T5 事件后静止度（在候选转变结束后的窗口 [t_end, t_end+T_still]）
motion(t) = max_i ( ||P_i(t) - P_i(t-1)|| ) / L_ref
still_frac = fraction of frames with motion(t) < eps_still
# 佐证用，不作必要条件（Bagalà 2012）

# T6 转变前后的姿态跃迁
transition = (label_before, label_after) 及各自的稳定持续时长

# T7 不可观测性告警：躯干投影长度塌缩 → 强前后向姿态，角度不可信
foreshorten_flag = ( L_torso[t] / L_ref ) < τ_fs
```

**时间尺度的物理先验（仅用于选窗，不做判据）**
- 自由落体 1 m ≈ 0.45 s（t=√(2h/g)）→ 下落相窗口下限约 0.4 s。
- Hof 的 XcoM 时间常数 √(l/g)，l≈0.9 m → **0.30 s**（[Hof et al. 2005](https://doi.org/10.1016/j.jbiomech.2004.03.025)）→ 失衡相的特征时间尺度。
- 输出频率 5–10 Hz → 决策步长 100–200 ms，窗口至少覆盖 3–10 个决策步。

### 4.4 输出"为什么"的 schema 草案（对齐 §2.9）

```jsonc
{
  "schema_version": "reme-posture-evidence/v0",
  "scene_id": "...", "frame_index": 123, "timestamp_ms": 4100,
  "label": "lying",
  "abstained": false,
  "confidence": 0.87,
  "rule_id": "R7",                       // CORELS 风格：结论由具名规则给出
  "evidence": [                          // Anchors 风格：谓词 + 可核查统计量
    {"feature":"vert","value":0.11,"op":"<","threshold":0.35,
     "satisfied":true,"support_keypoints":[5,6,15,16],"min_score":0.62,
     "threshold_source":"val_calib@2026-08-01/scene_A"},
    {"feature":"spread_ratio","value":0.28,"op":"<","threshold":0.50,"satisfied":true,
     "support_keypoints":[0,5,6,11,12,13,14],"min_score":0.41,
     "threshold_source":"val_calib@2026-08-01/scene_A"}
  ],
  "counter_evidence": [
    {"feature":"pelvis_rise","value":0.18,"note":"高于该类典型值，与 bending 部分兼容"}
  ],
  "unavailable_features": [
    {"feature":"knee_angle_L","reason":"kp13 score 0.09 < tau_kp 0.30"}
  ],
  "not_observable": ["metric_scale","depth","gravity_direction","floor_plane"],
  "rule_stats": {"precision_val":0.91,"coverage_val":0.83,"n_val":412},
  "calibration": {"scene_id":"scene_A","L_ref":0.163,"pixel_aspect":1.7778,
                  "calibrated_at":"2026-08-01"}
}
```

设计依据：
- `evidence[].value/threshold/support_keypoints/min_score` → **可核查**（人可以回到那一帧验算），对应 Ghassemi 等主张的"用验证替代事后解释"。
- `rule_stats.precision_val/coverage_val` → Anchors 的 precision/coverage。
- `unavailable_features` + `not_observable` → FDA 透明度原则要求的"局限"，以及 EU AI Act Art. 86 要求的"决定的主要要素"。
- `abstained` + `confidence` → Chow 1970 / Geifman & El-Yaniv 2017 的选择性预测。
- 特征本身即"概念层"，允许人工改写 `evidence[].value` 重跑规则 → Concept Bottleneck 的可介入性。

---

## 5 阈值与参数：文献先验 / 必须校准 / 禁止硬编码

### 5.1 有文献先验，但**只能当量级 sanity check**

| 参数 | 文献值 | 出处 | 为什么不能直接用 |
|---|---|---|---|
| 朝向变化触发 | 20° | Chen 等（经 [Bagalà 2012](https://doi.org/10.1371/journal.pone.0037062) 复现描述） | 原量是相对重力的真实倾角，Reme 只有投影角 |
| 竖直速度触发 | −0.7 m/s | Bourke3（同上） | Reme 无米制速度 |
| 冲击后躺姿确认 | 1–3 s 内 75% 时间 ≥60° | Bourke3（同上） | 依赖体表加速度计的姿态判定 |
| 落地后静止确认 | 30 s | [Yu 等 2012](https://doi.org/10.1109/TITB.2012.2214786) | 该阈值与"地面区域检测"绑定，Reme 无地面区域；且 30 s 对交互式关怀产品过长 |
| "低位"体积占比 | 40 cm 以下体积/总体积 | [Auvinet 等 2011](https://doi.org/10.1109/TITB.2010.2087385)；[UR Fall 数据集](https://fenix.ur.edu.pl/mkepski/ds/uf.html) | 40 cm 是米制量，来自深度/多相机重建 |
| 失衡时间尺度 | √(l/g) ≈ 0.30 s | [Hof 等 2005](https://doi.org/10.1016/j.jbiomech.2004.03.025) | **可用**，但只用于选窗口长度，不作判据 |
| 自由落体 1 m ≈ 0.45 s | 纯物理 | — | **可用**，同上 |

### 5.2 必须由验证集校准（每个 `scene_id` 独立）

- `τ_kp`（关键点置信度门限）、`τ_quality`
- `vert`、`elong`、`AR`、`extent_ratio`、`pelvis_rise`、`spread_ratio` 的所有类别边界
- `knee_angle` / `hip_angle` 的 sit/stand/crouch 边界
- `v_drop`、`omega_trunk`、`d_vert`、`d_elong` 的转变触发阈值
- `eps_still`、`T_still`、`still_frac`
- `τ_fs`（前后缩影告警阈值）
- 拒判阈值：**按 Chow/选择性预测的方式定**——先声明可接受的选择性风险，再从验证集的 risk–coverage 曲线读出阈值，并**把覆盖率一并报告**
- `L_ref` 的分位数与窗口长度

校准记录必须落盘（`calibration` 字段），未校准的 `scene_id` 一律降级到 `unknown` / `uncertain_transition`。

### 5.3 禁止硬编码

- 任何米制量（cm/m/mm）、任何 m/s、任何 g。
- 任何跨 `scene_id` 共享的几何阈值（机位一换即失效；见 §2.7 失败模式 3）。
- 直接抄论文的准确率、灵敏度、特异度作为本项目的预期指标（Bagalà 与 Sierra 双重反例）。
- 在 `image_width_px/image_height_px` 缺失时仍计算角度类特征（会静默产生 10–20° 级系统误差）。
- 把 "落地后静止" 设为 `fall_like_transition` 的必要条件。

---

## 6 对 Reme 的取舍建议与风险

### 6.1 特征对照表：反复验证有效 vs 被证伪/脆弱

| 特征 | 独立工作反复使用？ | 在 Reme（单目 2D COCO-17）下的地位 | 关键一手证据 |
|---|---|---|---|
| **关键点 y 的序关系 / 骨架内部长度比** | 隐含于几乎所有姿态工作；Yu 2012 显式用长短轴长度归一化投影直方图以获得距离不变性 | **一等特征，建议作为规则骨架**：尺度不变、距离不变、无需米制 | [Yu 2012](https://doi.org/10.1109/TITB.2012.2214786) `[读全文]` |
| **垂直度 / 身体长轴方向** | 是（椭圆方向、上身-下身方向） | **可用（P）**，但沿光轴方向失效 | [Yu 2012]、[Sierra 2026](https://arxiv.org/abs/2605.00890) fall backward 60.02% |
| **包围盒 / 椭圆宽高比** | 是，使用频次最高（Vishwakarma 2007、Rougier 2011、Yu 2012、Kwolek 2014） | **可用（P）**，但阈值必须每机位校准；不是视角不变量 | Yu 2012 明确靠"多方向采集"换取视角鲁棒；[Auvinet 2011](https://doi.org/10.1109/TITB.2010.2087385) 改用多相机 |
| **膝/髋屈曲角** | 是（Sierra 的 48 维距离+角度） | **可用（P）**，sit/crouch 的主判别，但投影有偏、且 Sierra 未公开具体角定义 | [Sierra 2026] `[读全文]` |
| **CoM 竖直速度** | 是，跌倒检测的核心信号之一 | **只能作代理**（躯干长度/秒）；**禁止称 m/s**；原始形式需 3D 重建或 IMU | [Rougier 2006](https://doi.org/10.1109/IEMBS.2006.260829)（单目但重建了 3D 头部轨迹）；Bourke3 的 −0.7 m/s |
| **躯干倾角变化率** | 是（20° 朝向变化） | **可用（P）**，需配 `foreshorten_flag` | Bagalà 2012 对 Chen 算法的描述 |
| **落地后静止时长** | 是（Nait-Charif 2004、Noury 2007、Bourke2/3、Yu 2012、Kwolek 2014） | **降级为佐证**，不得作必要条件 | **Bagalà 2012 反证**：真实跌倒常止于坐/跪/倚靠，从未进入躺姿 `[读全文]` |
| **空间语境（地面区域 / 惯常静止区）** | 是，且被独立提出两次 | **几何不可得；退化为每机位统计先验**，未校准则拒判 | [Nait-Charif 2004](http://nccastaff.bournemouth.ac.uk/hncharif/Publications/activitysummarisation.pdf) `[读全文]`；Yu 2012 的地面区域条件 |
| **多条件合取（冲击+姿态+静止）** | 是，Noury 的经典范式 | **在 Reme 只剩两相**；且 Bagalà 明确指出合取项越多漏检越多 → 应改为**加权证据 + 拒判**而非硬合取 | Bagalà 2012 `[读全文]`；Noury 2007 `[读摘要]` |
| **训练/模拟数据上的准确率** | 被广泛报告 | **被证伪为部署指标的预测量** | Bagalà 2012（57.0%±27.3%）、Sierra 2026（99.24%→74.06%） |
| **深度/3D 派生量（真实身高 mm、到地面距离、40 cm 体积占比）** | 是，且效果好 | **完全不可用**（需要 Kinect/多相机） | [UR Fall 数据集特征表](https://fenix.ur.edu.pl/mkepski/ds/uf.html)、Auvinet 2011 |
| **事后归因（saliency/SHAP）作为"给理由"的手段** | 广泛使用 | **不建议作为主解释**；改用规则+证据条目 | [Ghassemi 等 2021](https://doi.org/10.1016/S2589-7500(21)00208-9) `[读摘要]`；[Rudin 2019](https://arxiv.org/abs/1811.10154) `[读摘要]` |

### 6.2 建议的技术取舍

1. **先修 schema，再谈特征**：补 `image_width_px/image_height_px`，并让 A 角色书面确认归一化基准是原始帧还是 padded 方形输入。在此之前所有角度类实验的数值不可信。
2. **规则骨架 + 玻璃箱学习器，不上黑箱**：用 §4 的无量纲特征写一层显式规则（CORELS 风格可枚举规则列表），学习器（若需要）用 EBM 而非深网络；这样"为什么"是模型的一部分而不是附加物（Rudin 2019 / Caruana 2015）。
3. **`unknown` 用选择性预测定阈值**：声明可接受风险 → 从验证集 risk–coverage 曲线取阈值 → 报告覆盖率。拒判率是要公布的指标，不是耻辱（Chow 1970；Geifman & El-Yaniv 2017）。
4. **`fall_like_transition` 用加权证据而非硬合取**：给"骨盆快速下降 / 垂直度骤降 / 躯干角速率大 / 宽高比跃变 / 事件后静止"各自打分并累计，达阈值即报候选，静止只加分不设门；这直接对冲 Bagalà 观察到的"合取越多漏检越多"。
5. **每机位校准 + 校准记录落盘**；跨机位复用阈值必须在输出里显式标注 `calibration.uncalibrated=true` 并强制降级。
6. **评测协议照抄 Yu 2012 的两个好习惯**：(a) 按人留一（leave-one-person-out）而不是随机切帧；(b) **额外报一次含噪条件下的指标**（例如人为压低 10% 帧的关键点置信度、或注入 10% 标签噪声），观察退化幅度。
7. **建立"沿光轴方向"的专项测试集**：分别录制朝向相机 / 背向相机 / 侧向的同一动作，单独报告这三组的指标。若前后向明显更差（预期会），把它写进 Model Card 的局限章节。
8. **随附 Model Card**：预期用途、非用途（明确写"不用于医疗诊断、不做跌倒的医学判定"）、评测条件、分组性能（按人物/机位/朝向）、已知局限（§3 的 X 与 P 列表）。参照 Mitchell 等 2019 与 FDA 透明度原则的内容项。

### 6.3 风险清单

| 风险 | 触发条件 | 缓解 |
|---|---|---|
| 各向异性归一化导致全部角度系统性错误 | schema 缺 W/H；或误以为 x,y 同尺度 | §4.0 的 Gate；加单元测试：合成一条已知 45° 线，断言算出 45°±1° |
| 归一化基准不明（原始帧 vs padded 方形） | A/B 角色接口未书面约定 | 书面确认 + 在 JSONL 增 `coordinate_space` 的子类型 |
| 前后向跌倒漏检 | 相机正对/背对人体运动方向 | `foreshorten_flag` → `uncertain_transition`；产品文案公开此盲区；机位安装建议侧向 |
| 单视频/单人指标虚高 | 随机切帧划分、相邻帧高度相关 | 按事件/人物划分；明确声明"仅表示对该视频的拟合" |
| 把论文准确率写进 PRD | — | 硬性禁止；所有指标必须来自本项目验证集，并标注数据规模 |
| 躺姿下姿态估计器本身失准 | 训练分布以直立为主 | 用 `landmark_quality` + `usable_ratio` 拒判；把"躺姿关键点质量"单独统计并报告（SLP/TPAMI 2022 表明卧姿是显著的域外场景） |
| "沙发 vs 地板"误判引发不当告警 | 无地面平面信息 | 该判别不做承诺；只输出"低位持续"这一可观测事实，不输出"摔在地上" |
| 医疗声明越界 | 文案写"检测跌倒/评估跌倒风险" | 标签名保持 `fall_like_transition`；文案统一为"运动学上类似跌倒的姿态转变"，并附拒判说明 |
| 阈值随时间漂移（相机被挪动、家具变化） | 长期部署 | `calibration.calibrated_at` + 漂移监控（`L_ref` 分位数、站立样本的视觉竖直方向变化） |

---

## 7 本轮读透的一手来源清单（含阅读深度）

| # | 来源 | 深度 | 链接/DOI |
|---|---|---|---|
| 1 | Bagalà F. et al., *Evaluation of Accelerometer-Based Fall Detection Algorithms on Real-World Falls*, PLoS ONE 7(5):e37062, 2012 | 读全文（PMC） | [10.1371/journal.pone.0037062](https://doi.org/10.1371/journal.pone.0037062) |
| 2 | Sierra S. D. M. et al., *Skeleton-Based Posture Classification to Promote Safer Walker-Assisted Gait in Older Adults*, arXiv:2605.00890, 2026（预印本） | 读全文（PDF） | <https://arxiv.org/abs/2605.00890> |
| 3 | Yu M. et al., *A Posture Recognition-Based Fall Detection System…*, IEEE TITB 16(6):1274–1286, 2012 | 读全文（镜像 PDF） | [10.1109/TITB.2012.2214786](https://doi.org/10.1109/TITB.2012.2214786) |
| 4 | Nait-Charif H., McKenna S. J., *Activity Summarisation and Fall Detection in a Supportive Home Environment*, ICPR 2004 | 读全文（作者自存 PDF） | <http://nccastaff.bournemouth.ac.uk/hncharif/Publications/activitysummarisation.pdf> |
| 5 | Igual R., Medrano C., Plaza I., *Challenges, issues and trends in fall detection systems*, BioMed Eng OnLine 12:66, 2013 | 读全文（PMC） | [10.1186/1475-925X-12-66](https://doi.org/10.1186/1475-925X-12-66) |
| 6 | TensorFlow Hub, *MoveNet model tutorial*（官方） | 读全文 | <https://www.tensorflow.org/hub/tutorials/movenet> |
| 7 | Hof A. L., Gazendam M. G. J., Sinke W. E., *The condition for dynamic stability*, J Biomech 38(1):1–8, 2005 | 读摘要 | [10.1016/j.jbiomech.2004.03.025](https://doi.org/10.1016/j.jbiomech.2004.03.025) |
| 8 | Ghassemi M., Oakden-Rayner L., Beam A. L., *The false hope of current approaches to XAI in health care*, Lancet Digital Health 3(11):e745–e750, 2021 | 读摘要 | [10.1016/S2589-7500(21)00208-9](https://doi.org/10.1016/S2589-7500(21)00208-9) |
| 9 | EU AI Act, Regulation (EU) 2024/1689, **Article 86**（欧委会 AI Act Service Desk 官方条文） | 读全文 | <https://ai-act-service-desk.ec.europa.eu/en/ai-act/article-86> |
| 10 | FDA / Health Canada / MHRA, *Transparency for Machine Learning-Enabled Medical Devices: Guiding Principles*, 2024-06 | 读官方页文本（未逐条读 PDF） | <https://www.fda.gov/media/179269/download> |
| 11 | Rudin C., *Stop Explaining Black Box ML Models…*, Nature Machine Intelligence 1:206–215, 2019 | 读摘要 | <https://arxiv.org/abs/1811.10154> |
| 12 | Caruana R. et al., *Intelligible Models for HealthCare*, KDD 2015 | 读摘要 | [10.1145/2783258.2788613](https://doi.org/10.1145/2783258.2788613) |
| 13 | Anderson D. et al., *Linguistic summarization of video for fall detection using voxel person and fuzzy logic*, CVIU 113(1):80–89, 2009 | 读摘要 | [10.1016/j.cviu.2008.07.006](https://doi.org/10.1016/j.cviu.2008.07.006) |
| 14 | Kwolek B., Kępski M., CMPB 117(3):489–501, 2014 + UR Fall 官方数据集页 | 读数据集页全文 | [10.1016/j.cmpb.2014.09.005](https://doi.org/10.1016/j.cmpb.2014.09.005) · <https://fenix.ur.edu.pl/mkepski/ds/uf.html> |
| 15 | Noury N. et al., *Fall detection — Principles and Methods*, IEEE EMBC 2007 | 读摘要 | [10.1109/IEMBS.2007.4352627](https://doi.org/10.1109/IEMBS.2007.4352627) |
| 16 | Rougier C. et al., *Monocular 3D Head Tracking to Detect Falls of Elderly People*, IEEE EMBC 2006 | 读摘要 | [10.1109/IEMBS.2006.260829](https://doi.org/10.1109/IEMBS.2006.260829) |
| 17 | Chow C. K., *On optimum recognition error and reject tradeoff*, IEEE TIT 16(1):41–46, 1970 | 读摘要 | [10.1109/TIT.1970.1054406](https://doi.org/10.1109/TIT.1970.1054406) |
| 18 | Geifman Y., El-Yaniv R., *Selective Classification for Deep Neural Networks*, NeurIPS 2017 | 读摘要 | <https://papers.nips.cc/paper/7073-selective-classification-for-deep-neural-networks> |
| 19 | Koh P. W. et al., *Concept Bottleneck Models*, ICML 2020 | 读摘要 | <https://proceedings.mlr.press/v119/koh20a.html> |
| 20 | Ribeiro M. T., Singh S., Guestrin C., *Anchors: High-Precision Model-Agnostic Explanations*, AAAI 2018 | 读摘要 | <https://aaai.org/papers/11491-anchors-high-precision-model-agnostic-explanations/> |

**未读原文、仅作书目锚点（不引用其定量结论）**：Rougier et al. TCSVT 2011（[10.1109/TCSVT.2011.2129370](https://doi.org/10.1109/TCSVT.2011.2129370)）；Vishwakarma et al. PReMI 2007（[10.1007/978-3-540-77046-6_76](https://doi.org/10.1007/978-3-540-77046-6_76)）；Auvinet et al. TITB 2011（[10.1109/TITB.2010.2087385](https://doi.org/10.1109/TITB.2010.2087385)）；Debard et al. JAISE 2016（[10.3233/AIS-160369](https://doi.org/10.3233/AIS-160369)）与 HTL 2016（[10.1049/htl.2015.0047](https://doi.org/10.1049/htl.2015.0047)，IET 站点 403）；Adebayo et al. NeurIPS 2018；de Leva 1996 的参数表（[10.1016/0021-9290(95)00178-6](https://doi.org/10.1016/0021-9290(95)00178-6)，实现时必须回读原表）。
