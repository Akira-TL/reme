# 人体质心（CoM）与环节参数：从稀疏 2D 关键点（COCO-17 / MoveNet）估计的理论边界与可编码方案

> 调研范围：Dempster (1955)、Winter、Zatsiorsky–Seluyanov、de Leva (1996) 的原始环节质量分数与环节质心比例；HAT 合并环节；COCO-17 缺失环节的系统偏差；"髋中点近似 CoM""躯干中点近似 CoM"的误差量级；2D 投影加权质心与真实 3D CoM 的关系。
> 输入前提（唯一）：A 角色 JSONL，`schema_version="movenet-17/v0-experiment"`，17 个归一化图像坐标关键点 + score，无深度 / 无内外参 / 无米制尺度 / 无力板 / 无 IMU / 无 3D。单人、室内固定机位、30 FPS、输出 5–10 Hz。
> 本文所有"毫米"数字**均为对刚体连杆模型做的闭式算术**（脚本 `scratchpad/com_bias.py`、`coco_weights.py`、`persp.py`），**不是实测精度，不得作为产品指标或医疗依据**。文献报告的精度只用于交叉印证量级，不迁移为本项目指标。

---

## 1 结论摘要

1. **COCO-17 能构造出覆盖 89.1% 体重的 5 类环节（躯干 / 上臂 / 前臂 / 大腿 / 小腿），缺失的 10.9%（头 6.94% + 双手 1.22% + 双足 2.74%，de Leva 男性）绝对不能"丢弃后重归一化"**。重归一化偏差的闭式解是 `bias = W_miss × (ĉ_retained − c_missing)`——它随姿态改变**方向甚至符号**：站立时偏低 −0.0134 H，弯腰时偏高 +0.0096 H 且水平偏后 −0.0242 H。这恰好横跨 `standing` 与 `bending_or_crouching` 的判别边界，任何固定常数补偿都是有害的。

2. **正确做法是"就近归并"而非"丢弃 + 重归一化"**：头部质量放到**双耳中点**（Dempster 1955 Table 14 原文：head-and-neck 质心的体表投影就在"supratragic notch 前方 10 mm"，即耳屏上切迹——COCO 的 `left_ear/right_ear` 正是这个位置），手部质量放到腕关键点，足部质量放到踝关键点。总质量守恒（Σw=1，无需重归一化）。五种姿态下残差从 17.4–45.4 mm 降到 1.5–5.1 mm，且不再随姿态翻转符号。

3. **整个 CoM 代理量可折叠成一个 14 项定常线性组合**：`CoM_proxy = Σ_j a_j · p_j`，j 只跑 14 个关键点（nose / 双眼权重恒为 0）。左右同名系数严格相等，因此**该估计量对 MoveNet 常见的左右肢体标签互换完全免疫**——这是单目侧视场景下极有价值的鲁棒性。噪声增益 `√Σa_j² = 0.346`，比"髋中点"估计量（0.707）低约 2.04 倍。

4. **"髋中点 ≈ CoM"在本项目里不成立**：模型算术给出 77 mm（站立）/ 200 mm（坐）/ 71 mm（躺）/ 282 mm（弯腰）/ 245 mm（深蹲）的偏移，且方向随姿态大幅摆动。文献里 Yang & Pai (2014) 报告骶骨标记与分段法 CoM 相关系数 R>0.97（步行）/ R>0.90（滑倒），但那是**同一姿态类内部的时序相关性**，不是**跨姿态类的绝对位置一致性**；Eames et al. (1999) 明确报告骨盆中心的位移幅度系统性大于力板法。把 R 高当成"可以用髋中点代替 CoM"是本项目最容易犯的错误。"躯干中点"更差（116–187 mm）。

5. **投影层面的好消息与坏消息**：仿射（弱透视）相机下"投影的质心 = 各环节质心投影的加权平均"是**严格等式**，所以 2D 加权质心是 3D CoM 的**无偏投影代理**；实测式透视相机下的破缺量在室内 3 m、身体深度展布 0.6 m 时仅为人体投影宽度的 p95≈1.8%——二阶小量。真正不可观测的是：**深度分量、米制尺度、重力方向**。因此 CoM 的"高度"在归一化图像里只是 y_norm，是相机坐标量而非重力高度；一切米制导出量（m/s、m/s²、mgh）在本项目**根本不可观测**，禁止出现在特征里。

---

## 2 理论与一手文献

### 2.1 Dempster (1955)：全部现代环节参数表的根

**论断 A｜Dempster 的环节质心位置比例（原文 Table 15，逐条）**

出处：Dempster, W. T. (1955). *Space Requirements of the Seated Operator: Geometrical, Kinematic, and Mechanical Aspects of the Body with Special Reference to the Limbs.* WADC Technical Report 55-159, Wright Air Development Center. 记录页：<https://contrails.library.iit.edu/item/154630>（PB121053 / AD0087892，公开可用）。以下为报告第 192–193 页 Table 15 的 OCR 逐条转录（本会话已下载 274 页原始 PDF 并 OCR）：

| # | 环节与参考标志 | N | 质心相对距离 |
|---|---|---|---|
| 1 | Hand（rest position），wrist axis → knuckle III | 16 | 50.6% to wrist axis / 49.4% to knuckle III |
| 2 | Forearm，elbow axis → wrist axis | 16 | **43.0% to elbow axis** / 57.0% to wrist axis |
| 3 | Upper arm，gleno-humeral axis → elbow axis | 16 | **43.6% to gleno-humeral axis** / 56.4% to elbow axis |
| 4 | Forearm + hand，elbow axis → ulnar styloid | 16 | 67.7% to elbow / 32.3% to ulnar styloid |
| 5 | Whole upper limb，gleno-humeral axis → ulnar styloid | 16 | 51.2% / 48.8% |
| 6 | Shoulder mass | 14 | 84.0% / 71.2%（斜向，见原注） |
| 7 | Foot，heel → toe II | 16 | 24.9% of foot link to ankle axis（斜向）；沿 heel–toe 方向 42.9 : 57.1 |
| 8 | Lower leg（shank），knee axis → ankle axis | 16 | **43.3% to knee axis** / 56.7% to ankle axis |
| 9 | Thigh，hip axis → knee axis | 16 | **43.3% to hip axis** / 56.7% to knee axis |
| 10 | Leg + foot，knee axis → medial malleolus | 16 | 43.4% / 56.6% |
| 11 | Whole lower limb，hip axis → medial malleolus | 16 | 43.4% / 56.6% |
| 12 | **Head and trunk minus limbs**，vertex → 髋轴横线 | 7 | 60.4% to vertex / 39.6% to hip axes（OCR 将 39.6 误读为 49.6，按 #13 的 64.3+35.7=100 校正） |
| 13 | Head and trunk minus limbs and shoulders，vertex → 髋轴线 | 7 | 64.3% to vertex / 35.7% to hip axes |
| 15 | Head and neck，vertex → 第七颈椎椎体 | 6 | 43.3% to vertex / 56.7% to centrum |
| 16 | Thorax，T1 → T12 椎体 | 6 | 62.7% to T1 / 37.3% to T12 |
| 17 | Abdomino-pelvic mass，L1 椎体 → 髋轴 | 5 | 59.9% to L1 / 40.1% to hip axes |

原始条件：**8 具白人男性尸体，中老年（Drillis 等转述为 52–83 岁），平均体重仅 131.4 lb（≈59.6 kg）**；解冻—分解—悬吊—浸没等多道工序，作者自陈"若把表里的质量相加或相减，常出现几百克的差值"。冻结分解、按关节中心平面切割、中位关节角。**这是"完整尸体解剖 + 三维平衡钻孔定位"的条件，与本项目毫无重叠。**

**论断 B｜Dempster 的环节质量分数（原文 Table 10/11/12 的样本均值）**

同一报告第 186–188 页。均值（占全身体重百分比）：

- Table 10（躯干）：trunk minus limbs **56.5%**；trunk minus shoulders **46.9%**；both shoulders **10.3%**；**head and neck 7.9%**；thorax 11.0%；abdomen + pelvis 26.4%。
- Table 11（上肢，左/右）：entire upper extremity **4.8 / 4.9%**；arm（上臂）**2.6 / 2.7%**；forearm + hand 2.1 / 2.2%；forearm **1.5 / 1.6%**；hand **0.6 / 0.6%**。
- Table 12（下肢，左/右）：entire lower extremity **15.7 / 15.7%**；thigh **9.7 / 9.6%**；leg + foot 6.0 / 5.9%；leg（小腿）**4.5 / 4.5%**；foot **1.4 / 1.4%**。

**关键提醒**：Winter 教科书 Table 4.1 里广为流传的 head&neck 0.081 / trunk 0.497 / upper arm 0.028 / forearm 0.016 / hand 0.006 / thigh 0.100 / leg 0.0465 / foot 0.0145 / total arm 0.050 / total leg 0.161 / **HAT 0.678**，是 Dempster 原始均值经"归一到 Σ=1.000"再转述（Winter 表里逐行标注为 "Dempster via Miller and Nelson" / "Dempster via Plagenhoef"）后的版本，与上表原始均值有 2–5% 相对差（如 thigh 9.7% → 0.100，head&neck 7.9% → 0.081）。可验证的一致性：0.081 + 0.497 + 2×0.050 + 2×0.161 = 1.000，且 HAT = 0.081 + 0.497 + 2×0.050 = **0.678**。

出处：Winter, D. A. *Biomechanics and Motor Control of Human Movement*, 4th ed., Wiley 2009, Ch. 4 Anthropometry，DOI <https://doi.org/10.1002/9780470549148.ch4>。
**诚实标注：本会话未能取得 Winter Table 4.1 的原书页面（Wiley 403，ndl 镜像 404，多个 .edu 副本 403）。上述 Winter 数值来自二手教学材料转述 + 与 Dempster 原始表的一致性核对（Σ=1.000、Dempster #1/#2/#3/#8/#9 的 50.6/43.0/43.6/43.3/43.3 与 Winter 的 0.506/0.430/0.436/0.433/0.433 逐位吻合），可信度高但"未读原书页"。若要写进代码常量，建议以 de Leva 为准（下节，已读原文）。**

**论断 C（本调研最重要的单条事实）｜head-and-neck 的质心体表投影就在耳屏位置**

Dempster (1955) Table 14「Anatomical location of segment centers of gravity」原文：

> Head and neck — 8 mm anterior to basion on the inferior surface of the basioccipital bone or within the bone 24.0 ± 5.0 mm from the crest of the dorsum sellae; **on the surface of the head a point 10 mm anterior to the supratragic notch above the head of the mandible is directly lateral.**

supratragic notch = 耳屏上切迹，即 COCO `left_ear/right_ear` 的标注位置。这为 Winter 表里"head and neck 的 CoM/segment length 从近端算为 1.000（即质心落在 ear canal）"给出了**一手来源**，也直接给了本项目一个几乎免费的头部质心锚点。

**论断 D｜Dempster 亲口指出的"环节质心近似落在相邻关节中心连线上"**

原文（报告第 189 页）：

> The three-dimensional data showed that the centers of gravity of the limb segments, except for the shoulders, were characteristically aligned between the joint-center regions. ... Since centers of gravity tend to be aligned between adjacent joint centers, data for more or less general use on the location of many centers of gravity of the limb segments may be based simply on the relative distance of the center to adjacent proximal and distal joint centers.

这是"用两个关键点线性插值得到环节质心"这一整套做法的**原始许可条款**，并且原文点名了例外：**肩部质量（shoulder mass）不在关节连线上**，三个测量方向互不共线。这一点直接影响我们对躯干近端的建模（见 §3.3）。

### 2.2 Zatsiorsky–Seluyanov + de Leva (1996)：唯一活体、唯一含女性的成套参数

**论断 E｜原始数据条件**

出处：de Leva, P. (1996). Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters. *J. Biomech.* 29(9):1223–1230. DOI <https://doi.org/10.1016/0021-9290(95)00178-6>（PubMed PMID 8872282；本会话已读全文 PDF）。

原始条件：Zatsiorsky et al. (1990a) 用 **γ 射线扫描（gamma-ray scanning）活体测量 100 名男性 + 15 名女性高加索人**，平均年龄 24 / 19 岁，多为体育学院本科生。de Leva 报告的参考体：**女 61.9 kg / 1.735 m，男 73.0 kg / 1.741 m**。这是"活体、年轻、运动人群"，与 Dempster 的"老年男性尸体"是两个完全不同的总体。

**论断 F｜de Leva 做了什么调整、为什么必须用他的版本**

Zatsiorsky 组用**骨性标志**（如大腿近端用 iliospinale）而非关节中心作参考点，有些标志离关节中心很远，关节屈曲时该距离显著变化，导致无法准确定位环节质心。de Leva 的工作就是把质心百分比与回转半径**重新参照到关节中心**（HJC/KJC/AJC/SJC/EJC/WJC）或常用标志。de Leva 还给出了他自己的验证数据（引 de Leva 1993）：用 Clauser 尸体参数估计大学生运动员平躺位 CoM，纵向平均误差女 53 mm（SD 18）、男 38 mm（SD 13）；换成 Zatsiorsky 参数后降到 **16 mm（SD 17）与 −4 mm（SD 13）**。

**论断 G｜de Leva (1996) Table 4 中本项目直接可用的行（逐字）**

（Mass 为占全身质量百分比；CM position 为占该环节长度的百分比，自 origin 起算。F = 女，M = 男。）

| Segment | Origin | Other endpoint | Mass F | Mass M | CM F | CM M |
|---|---|---|---|---|---|---|
| Head | VERT | MIDG | 6.68 | 6.94 | 58.94 | 59.76 |
| Head（备选端点） | VERT | CERV | 6.68 | 6.94 | 48.41 | 50.02 |
| Trunk | SUPR | MIDH | 42.57 | 43.46 | 41.51 | 44.86 |
| Trunk（备选端点） | CERV | MIDH | 42.57 | 43.46 | 49.64 | 51.38 |
| **Trunk（备选端点，本项目采用）** | **MIDS** | **MIDH** | **42.57** | **43.46** | **37.82** | **43.10** |
| Upper arm | SJC | EJC | 2.55 | 2.71 | 57.54 | 57.72 |
| Forearm | EJC | WJC | 1.38 | 1.62 | 45.59 | 45.74 |
| Hand | WJC | MET3 | 0.56 | 0.61 | 74.74 | 79.00 |
| Thigh | HJC | KJC | 14.78 | 14.16 | 36.12 | 40.95 |
| Shank | KJC | LMAL | 4.81 | 4.33 | 44.16 | 44.59 |
| **Shank（备选端点，本项目采用）** | **KJC** | **AJC** | **4.81** | **4.33** | **43.52** | **43.95** |
| Foot | HEEL | TTIP | 1.29 | 1.37 | 40.14 | 44.15 |

其中 **MIDS = 两侧肩关节中心的中点，MIDH = 两侧髋关节中心的中点**（de Leva 术语表原文定义）。de Leva 在正文中明确解释了为何提供 MIDS/MIDH 版本：

> In the author's opinion, the mid-hip (MIDH), a point midway between the hip joint centers (HJCs), is the most convenient choice for defining the trunk caudal endpoint. In fact, it can be easily computed from the positions of the HJCs...

**这一行（Trunk = MIDS → MIDH）是整份调研中与 COCO-17 契合度最高的条目**：COCO 的双肩中点与双髋中点正好就是 MIDS / MIDH 的图像投影近似。

质量和校验：男 6.94 + 43.46 + 2×(2.71+1.62+0.61) + 2×(14.16+4.33+1.37) = **100.00**；女同样为 **99.99**（四舍五入）。

**论断 H｜Dempster 与 de Leva 的分割面不同，两表绝不可混用**

同一条大腿：Winter/Dempster 0.100，de Leva 0.1416，**相对差 41.6%**。原因是分割面定义不同——Zatsiorsky 组用 **hip segmentation planes（HSPs）**：过两侧 iliospinale、平行于躯干矢状轴、与矢状面成 **37°** 的平面，把相当一部分臀部质量划给大腿；Dempster 则在髋关节处离断。两表各自内部自洽（都 Σ=1.000），但**任何跨表拼接都会破坏质量守恒并制造姿态相关的伪偏差**。

本项目模型算术：把同一组姿态用 Winter/Dempster 与 de Leva 两套系数分别算，站立时 CoM 差 **19.1 mm**（折叠成 §4.3 的关键点线性式后）或 **37.1 mm**（完整环节模型，含真实手/足位置），坐姿分别为 14.9 / 28.3 mm。**换表带来的位移，量级上相当于"就近归并残差"的 4–7 倍**——所以先冻结表，再谈别的。

### 2.3 HAT（Head-Arms-Trunk）合并环节

**论断 I｜HAT 的定义与数值**

HAT = 头颈 + 双上肢 + 躯干，Winter/Dempster 体系下质量分数 **0.678**（= 0.081 + 0.497 + 2×0.050），质心位置常被列为大转子→盂肱关节连线上距大转子 0.626。
**诚实标注：0.626 这一数值本会话未读到一手页面，仅见二手转述，不建议写入代码。** 而 0.678 = 0.081+0.497+2×0.050 可由 Winter 表内部一致性验证。

Dempster 原始表提供的最接近条目是 Table 15 #12「**Head and trunk minus limbs**，vertex → 髋轴横线：60.4% to vertex / 39.6% to hip axes」，注意它**不含上肢**（对应质量 56.5% + 7.9% ≈ trunk-minus-limbs + head&neck）。#13 进一步剔除肩部质量后为 64.3 / 35.7。

**论断 J｜HAT 合并的合理性与代价**

合理性有两层：
1. 上肢质量小（单侧 4.8–5.0%），且在 standing / sitting / lying 三类静态姿态中上肢相对躯干的位形变化对整体 CoM 影响有限；
2. de Leva 自己承认躯干常被当作单刚体处理：
   > researchers frequently prefer to model the trunk as a single rigid segment, neglecting the errors caused by trunk flexion (de Leva, 1993). The reason is that the landmarks defining the 'joints' between the trunk subsegments are difficult to locate.

代价是**恰好落在本项目最关键的判别边界上**：
- 单刚体躯干假设在**躯干屈曲**时误差最大——而 `bending_or_crouching` 正是靠躯干屈曲定义的；
- HAT 把上肢并进去以后，"举手""扶栏杆""伸手拿东西"这类日常动作会**污染 HAT 质心**，而这些动作与跌倒前兆在 2D 投影上容易混淆；
- Dempster 明确指出肩部质量（10.3% 体重）的质心**不在关节连线上**，落在腋窝或邻近胸壁内，所以任何"用肩关键点线性表示肩部质量"的做法都有系统性偏移。

**结论：本项目不使用 HAT 合并环节**。COCO-17 恰好提供了肩、肘、腕，把上肢单独建模的成本几乎为零（3 个系数），却能保住 9.88% 的质量不被误置。HAT 只在"上肢关键点大面积失效"时作为退化路径（见 §5.3）。

### 2.4 "髋中点 ≈ CoM"与"躯干中点 ≈ CoM"

**论断 K｜骶骨/骨盆单点与分段法 CoM 高度相关，但不等价**

- Yang, F. & Pai, Y.-C. (2014). Can sacral marker approximate center of mass during gait and slip-fall recovery among community-dwelling older adults? *J. Biomech.* 47(16):3807–12. DOI <https://doi.org/10.1016/j.jbiomech.2014.10.027>。187 名社区老年人，正常行走 R>0.97、滑倒试次 R>0.90，但作者写明 "There were detectable kinematic difference between the COM and the sacral for both trials"。**原始条件：多相机动捕 + 力板 + 全身分段模型的 3D 实验室。**
- Eames, M. H. A., Cosgrove, A., Baker, R. (1999). Comparing methods of estimating the total body centre of mass in three-dimensions in normal and pathological gaits. *Hum. Mov. Sci.* 18(5):637–646. DOI <https://doi.org/10.1016/S0167-9457(99)00022-6>。11 名健康者 + 5 名腰骶脊膜膨出患儿；结论是骨盆中心（CP）的位移幅度与力板法（GRF）**存在显著差异，CP 的总位移始终大于 GRF**。（摘要级，未读全文数值表。）
- Gutierrez-Farewik, E. M., Bartonek, Å., Saraste, H. (2006). Comparison and evaluation of two common methods to measure center of mass displacement in three dimensions during gait. *Hum. Mov. Sci.* 25(2):238–56. DOI <https://doi.org/10.1016/j.humov.2005.11.001>。运动学质心法与力板双积分法在前后/垂直方向位移幅度平均差 <10 mm，RMS 差 6 与 13 mm；侧向差 <2 mm，RMS 5 mm。**同时报告了敏感性：质量估计偏 5% 会使计算出的垂直位移幅度翻倍。**
- Lintmeijer, L. L. et al. (2018). An accurate estimation of the horizontal acceleration of a rower's centre of mass using inertial sensors: a validation. *Eur. J. Sport Sci.* 18(7):940–946. DOI <https://doi.org/10.1080/17461391.2018.1465126>。全身 IMU + 质量分布模型 ICC>0.988 / nRMSE<3.81%；**只用一个骨盆 IMU 时降到 ICC 0.877–0.960、nRMSE 6.11–13.61%**，作者结论："accurate determination of a rower's AP CoM acceleration is **not** possible on the basis of the pelvis acceleration only."

**对本项目的翻译**：这些文献一致说明"骨盆单点在**同一姿态类内部**是好的运动代理，但在**绝对位置**和**跨姿态类**上不是"。本项目的分类目标恰恰是跨姿态类判别，所以髋中点不能替代 CoM。

**论断 L｜本项目模型算术给出的量级**（de Leva 男性系数，单位：占身高 H 的比例，H=1741 mm）

| 姿态 | 真值 CoM (x,y) | 髋中点偏差 \|b\| | 躯干中点偏差 \|b\| | 丢弃+重归一化 \|b\| | 就近归并 \|b\| |
|---|---|---|---|---|---|
| standing | (+0.0012, +0.5786) | **77.0 mm** | 180.7 mm | 23.3 mm | **5.1 mm** |
| sitting | (+0.0570, +0.3700) | **200.4 mm** | 129.8 mm | 24.6 mm | **4.6 mm** |
| lying | (+0.5753, +0.0505) | **71.2 mm** | 186.6 mm | 17.4 mm | **1.5 mm** |
| bending（髋 90° 前屈） | (+0.1352, +0.4447) | **282.5 mm** | 157.8 mm | 45.4 mm | **4.8 mm** |
| crouching（深蹲 + 躯干前倾 45°） | (+0.0790, +0.3708) | **244.9 mm** | 116.0 mm | 29.1 mm | **3.8 mm** |

（真值 CoM 站立高度 0.5786 H，除以本模型顶点高度 1.0204 H 得 **0.567 倍身高**，与教科书常引的 55–57% 身高吻合，说明模型自洽。）

注意 **丢弃+重归一化** 的分量符号：站立 (−0.0012, **−0.0134**)、弯腰 (**−0.0242**, **+0.0096**)。垂直分量在两个类之间**翻符号**，水平分量放大 20 倍。这就是"重归一化本身引入的偏差"的具体形态。

### 2.5 尸体表 / 成人表迁移到别的总体

出处：Otmani, S., Michon, G., Watier, B. (2023). Use of adult anthropometric tables to estimate children body segment inertial parameters. *International Biomechanics* 10(1):18–28. DOI <https://doi.org/10.1080/23335432.2023.2268686>（开放获取）。把 5 套成人表用到 4–15 岁儿童身上，环节质量平均差 12%、质心位置平均差 12%、横向转动惯量平均差 25%，**头、手、足三个环节差异最大**；女性偏差更大（因成人样本以男性为主）。

同源提醒：Clauser, C. E., McConville, J. T., Young, J. W. (1969). *Weight, Volume, and Center of Mass of Segments of the Human Body*, AMRL-TR-69-70（13 具尸体，平均年龄 49 岁）。全文开放：<https://ntrs.nasa.gov/api/citations/19700027497/downloads/19700027497.pdf>。de Leva 用它做过对照，结论是尸体表外推到年轻活体会产生 38–53 mm 的纵向 CoM 误差。

**对 Reme 的直接含义**：目标用户是**老年人**。Dempster 的样本正好是中老年男性尸体（52–83 岁），de Leva 的样本是 19–24 岁运动系学生。两者都不是"老年活体"。目前没有任何一套表能声称对老年人无偏；Otmani 等的证据说明跨总体迁移会产生 ~12% 量级的环节参数偏差。**这是产品红线相关项：不得声称本系统的 CoM 估计对老年人"准确"。**

### 2.6 2D / 单目条件下的证据

出处：Wade, L., Needham, L., Evans, M., McGuigan, P., Colyer, S., Cosker, D., Bilzon, J. (2023). Examination of 2D frontal and sagittal markerless motion capture: Implications for markerless applications. *PLoS ONE* 18(11):e0293917. DOI <https://doi.org/10.1371/journal.pone.0293917>（开放获取）。15 名受试者、15 台标记式相机 + 2 台机器视觉相机（矢状 + 冠状）、130 次成功步行、13 231 个数据点，2D markerless 用 OpenPose。

矢状面关节角与标记式参考的 bias ± SD：

| 关节 | 近相机侧 | 被遮挡侧 | SD 恶化 |
|---|---|---|---|
| Knee | 1.5 ± 4.1° | 1.6 ± 6.9° | +69% |
| Hip | −3.6 ± 4.6° | −4.6 ± 9.5° | +108% |
| Ankle | −8.4 ± 5.2° | −9.3 ± 7.3° | +40% |

冠状面：knee 1.6 ± 4.2°，hip −4.6 ± 3.7°，**ankle 0.2 ± 12.0°**（一致性界限 −23.4–23.8°，基本不可用）。

**原始条件**：受试者是健康成年人、实验室步行、专业机器视觉相机、OpenPose。与 Reme 的"室内固定机位监控 + MoveNet Lightning + 老年人"仍有明显差距，**其数值不得作为本项目指标**，只能用作"被遮挡侧的离散度大约是可见侧的 1.4–2.1 倍"这一**结构性结论**。

MoveNet / COCO-17 官方定义：TensorFlow.js `pose-detection` 官方文档 <https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/README.md>。关键点顺序 0 nose, 1 left_eye, 2 right_eye, 3 left_ear, 4 right_ear, 5 left_shoulder, 6 right_shoulder, 7 left_elbow, 8 right_elbow, 9 left_wrist, 10 right_wrist, 11 left_hip, 12 right_hip, 13 left_knee, 14 right_knee, 15 left_ankle, 16 right_ankle。官方明确写道 score "represents the model's confidence of a keypoint"，并且 **"confidence values are not calibrated between models"**——即 **score 不是概率，不能直接当权重或当作可信度阈值的普适刻度**。

相机模型：Hartley, R. & Zisserman, A. *Multiple View Geometry in Computer Vision*, 2nd ed., Cambridge University Press, 2004（官方页 <https://www.robots.ox.ac.uk/~vgg/hzbook/>）。仿射相机 x = A X + b 是 3D→2D 的仿射映射；仿射映射与凸组合可交换，这是 §3.1 论断的数学依据。

---

## 3 在单目 2D COCO-17 下可观测 / 代理 / 不可观测的逐项判定

### 3.1 【可观测——严格意义上的投影代理，且是无偏的】图像平面加权质心

**判定：可算，且在仿射（弱透视）相机假设下与真实 3D CoM 的投影严格相等。**

设仿射相机 π(X) = A X + b（A ∈ ℝ^{2×3}）。对任意权重 Σw_i = 1：

```
π(Σ w_i X_i) = A(Σ w_i X_i) + b = Σ w_i (A X_i) + (Σ w_i) b = Σ w_i π(X_i)
```

即"3D 质心的投影"= "各点投影的加权平均"。所以 `CoM_proxy_2D` 是 3D CoM 的**投影**，不是"近似"。

实测式透视相机下该等式破缺，破缺量 ∝ Cov_w(横向偏移, 深度偏移)/D²。蒙特卡洛（`persp.py`，权重取 de Leva 8 组，横向展布 0.6 m）：

| 相机距离 D | 深度展布 | 误差 / 人体投影横向宽度 (mean / p95 / max) |
|---|---|---|
| 2.0 m | 0.6 m | 0.98% / 2.70% / 5.82% |
| 3.0 m | 0.6 m | 0.64% / 1.77% / 3.82% |
| 5.0 m | 0.6 m | 0.38% / 1.06% / 2.25% |
| 8.0 m | 0.6 m | 0.24% / 0.65% / 1.35% |
| 3.0 m | 1.0 m | 1.07% / 2.98% / 5.91% |

**结论：室内固定机位（典型 2.5–5 m）下透视非交换性是二阶小量，不是本项目的主要误差源。**可以放心用 `Σ a_j p_j`。

### 3.2 【可观测】尺度归一化后的相对几何量

可算：CoM 相对于髋中点、肩中点、踝中点、bounding box 的**相对位移**，以肩–髋距离或躯干长度为分母的**无量纲比值**；各环节方向向量之间的**夹角**（角度对相似变换不变）；bounding box 的宽高比。

必须注意：图像归一化坐标 x,y ∈ [0,1] 的两个轴的**像素纵横比不同**（除非画面是正方形）。计算任何长度或角度前必须先把 y 乘以 `aspect = H_px / W_px` 还原成同一像素度量。**A 角色的 JSONL 没有携带图像宽高**——这是当前 schema 的一个实质缺口，见 §6 风险清单。

### 3.3 【代理量——可算但有已知系统偏移】各环节质心与整体 CoM

**代理性质来源（三层，逐层记账）：**

1. **关键点 ≠ 关节中心。** COCO 的 `shoulder` 是标注员在肩部体表打的点，不是 SJC；`hip` 更是众所周知标注不一致，既非 HJC 也非大转子。de Leva 的整篇论文就是为了把参数**参照到关节中心**——我们拿不到关节中心，只能拿到体表标注点。这一层偏移**方向未知、随人随视角变化，必须靠验证集经验校准，不能靠文献常数修正**。
2. **躯干单刚体假设。** de Leva 亲口承认这会在躯干屈曲时产生误差；Dempster 也指出肩部质量（10.3% 体重）的质心根本不在关节连线上。在 `bending_or_crouching` 类里这一层误差最大。
3. **缺失环节的归并。** 见 §4.2，就近归并后残差 1.5–5.1 mm（模型算术）。

**判定：CoM_proxy 是一个"投影 + 体表标注 + 单刚体躯干"三重代理量。它足以支撑相对特征与类间判别，但绝不可标注为"质心（cm）"输出给用户，更不可用于任何医学解释。**

### 3.4 【代理量】"重力方向"

图像 y 轴向下。只有当相机**无 roll 且光轴接近水平**时，−y 才近似重力方向。室内监控常见的墙角高位斜俯拍会同时引入 roll 与 pitch，使 y_norm 混合了真实高度与深度。

- **可做的**：把重力方向当作一个**每场景（scene_id）常数**去标定——例如用大量 `standing` 样本的躯干主轴方向的稳健中位数当作该场景的"竖直方向"。这属于**每场景校准**，不是硬编码常数。
- **不可做的**：假设 y_norm 就是高度，跨场景共用一个阈值。

### 3.5 【不可观测——必须拒绝】

| 量 | 为什么不可观测 |
|---|---|
| **米制尺度（m）** | 无内参、无已知长度基准。归一化图像坐标只在"人在画面中的相对大小"层面有意义，而这个量同时受人的身高、体型和距相机距离影响，三者在单目无参数下不可分离。 |
| **深度 / 前后方向的 CoM 分量** | 单目无深度。CoM 的第三个分量完全不可观测。 |
| **CoM 的线速度 / 加速度（m/s, m/s²）** | 需要米制尺度 + 时间；时间有（30 FPS），尺度没有。**只有"归一化图像坐标每秒变化量"，它随人到相机距离变化而变化。** |
| **地面反作用力 / 支撑面 / 压力中心 (CoP)** | 无力板。CoP、CoM–CoP 距离、外推质心（XCoM）等全部不可观测。 |
| **机械能、势能 mgh、动量** | 依赖质量（kg）与米制尺度，两者都没有。 |
| **绝对身高、体重、性别、年龄** | 骨架不可反推。因此**不能选性别专属参数表**（见 §5.2）。 |
| **真实 3D 关节角** | 单目 2D 只能给投影角。Wade et al. (2023) 的被遮挡侧 SD 恶化 40–108% 是这一点的实测佐证。 |
| **"跌倒"的力学定义** | 跌倒的力学定义涉及 CoM 加速度、支撑面丢失、冲击力——全部不可观测。本项目只能做 `fall_like_transition`（形态学相似的转换），**不能做"跌倒检测"**。命名必须保持 `*_like`。 |

### 3.6 【条件可观测】遮挡与自遮挡

MoveNet 对被遮挡的关键点仍会输出坐标（幻觉值），score 通常但不必然降低，且官方说明 score 未跨模型校准。因此：

- **不能**把 score 当概率乘进权重（会让不同 scene 的 CoM 系数不再守恒，破坏 Σa=1）。
- **能**把 score 用作**二值门控**：`score_j ≥ τ` 才认为该关键点可用，τ 由验证集校准。
- **能**定义"**质量覆盖率**"这一物理量作为拒判依据（见 §4.4）——这是 score 唯一有物理意义的用法。

---

## 4 可直接编码的量与公式

以下所有下标为 COCO-17 索引。`p_j = (x_norm_j, y_norm_j)`。

### 4.1 主表：COCO-17 可构造的环节 → 质量分数 → 环节质心比例 → 来源

| # | 环节 | COCO 端点（索引） | 质量分数 (M / F / 均) | 质心比例（自 origin） | 来源 | 处置 |
|---|---|---|---|---|---|---|
| 1 | Trunk | MIDS=(5+6)/2 → MIDH=(11+12)/2 | 0.4346 / 0.4257 / **0.4302** | 0.4310 / 0.3782 / **0.4046** | de Leva 1996 T4 行 `Trunk MIDS/MIDH` | **直接用** |
| 2 | Upper arm ×2 | 5→7、6→8 | 0.0271 / 0.0255 / **0.0263** | 0.5772 / 0.5754 / **0.5763** | de Leva 1996 T4 `Upper arm SJC/EJC` | **直接用** |
| 3 | Forearm ×2 | 7→9、8→10 | 0.0162 / 0.0138 / **0.0150** | 0.4574 / 0.4559 / **0.4567** | de Leva 1996 T4 `Forearm EJC/WJC` | **直接用** |
| 4 | Thigh ×2 | 11→13、12→14 | 0.1416 / 0.1478 / **0.1447** | 0.4095 / 0.3612 / **0.3854** | de Leva 1996 T4 `Thigh HJC/KJC` | **直接用** |
| 5 | Shank ×2 | 13→15、14→16 | 0.0433 / 0.0481 / **0.0457** | 0.4395 / 0.4352 / **0.4374** | de Leva 1996 T4 `Shank KJC/AJC`（**用 AJC 行，不用 LMAL 行**） | **直接用** |
| 6 | Head (+neck) | **不可构造**（无 vertex / cervicale / gonion） | 0.0694 / 0.0668 / **0.0681** | — | de Leva 1996 T4 `Head` | **归并**：整块质量放到耳中点 (3+4)/2；依据 Dempster 1955 T14「10 mm anterior to supratragic notch ... is directly lateral」 |
| 7 | Hand ×2 | **不可构造**（无 MET3 / dactylion） | 0.0061 / 0.0056 / **0.0059** | — | de Leva 1996 T4 `Hand WJC/MET3` | **归并**：放到腕 9 / 10。残差 ≈ 0.79 × 手长 ≈ 0.039 H × 0.0059 = 0.023% H/侧 |
| 8 | Foot ×2 | **不可构造**（无 heel / toe） | 0.0137 / 0.0129 / **0.0133** | — | de Leva 1996 T4 `Foot HEEL/TTIP`；Dempster T15 #7「24.9% of foot link to ankle axis」 | **归并**：放到踝 15 / 16。残差 ≈ 0.048 H × 0.0133 = 0.064% H/侧 |
| — | Nose 0 / Eyes 1,2 | — | **0** | — | — | **丢弃（权重恒为 0）**。它们与头颈质心的关系随头部朝向剧烈变化，不如耳中点稳定 |

**丢弃 vs 归并的记账**：唯一被"丢弃"的是 nose/eyes——它们不携带独立质量（头颈质量已由耳中点承载），所以**丢弃它们不需要任何重归一化**。真正缺失的三类环节（头、手、足，合计 10.90% M / 10.38% F）全部通过就近归并保留，**Σ 权重恒等于 1，不做重归一化，因而不引入重归一化偏差**。

### 4.2 若坚持"丢弃 + 重归一化"，偏差的闭式解（用于证明为什么不该这么做）

令 S 为全体环节、R 为保留集、M = S∖R，`W_R = Σ_{i∈R} w_i`、`W_M = 1 − W_R`：

```
c_true = Σ_{i∈S} w_i q_i
ĉ      = (Σ_{i∈R} w_i q_i) / W_R            # 重归一化估计
bias   = ĉ − c_true = W_M · (ĉ − c_M)       # c_M = 缺失集自身的质心
```

即 **偏差 = 缺失质量分数 × (保留集质心 → 缺失集质心 的反向位移)**。它随姿态变化，不是常数，不能用常数补偿。数值见 §2.4 论断 L 表格（17.4–45.4 mm，垂直分量在 standing↔bending 之间翻符号）。

### 4.3 折叠后的最终编码形式（推荐默认：de Leva 性别平均）

```
CoM_proxy = Σ_{j∈J} a_j · p_j          # J = 14 个关键点，Σ a_j = 1
```

| COCO 索引 | 名称 | a_j（性别平均） | a_j（男） | a_j（女） |
|---|---|---|---|---|
| 0 | nose | 0.0000 | 0.0000 | 0.0000 |
| 1 | left_eye | 0.0000 | 0.0000 | 0.0000 |
| 2 | right_eye | 0.0000 | 0.0000 | 0.0000 |
| 3 | left_ear | **0.0341** | 0.0347 | 0.0334 |
| 4 | right_ear | **0.0341** | 0.0347 | 0.0334 |
| 5 | left_shoulder | **0.1392** | 0.1351 | 0.1432 |
| 6 | right_shoulder | **0.1392** | 0.1351 | 0.1432 |
| 7 | left_elbow | **0.0233** | 0.0244 | 0.0222 |
| 8 | right_elbow | **0.0233** | 0.0244 | 0.0222 |
| 9 | left_wrist | **0.0127** | 0.0135 | 0.0119 |
| 10 | right_wrist | **0.0127** | 0.0135 | 0.0119 |
| 11 | left_hip | **0.1760** | 0.1773 | 0.1749 |
| 12 | right_hip | **0.1760** | 0.1773 | 0.1749 |
| 13 | left_knee | **0.0815** | 0.0823 | 0.0806 |
| 14 | right_knee | **0.0815** | 0.0823 | 0.0806 |
| 15 | left_ankle | **0.0333** | 0.0327 | 0.0338 |
| 16 | right_ankle | **0.0333** | 0.0327 | 0.0338 |

（未取整时 Σ 精确等于 1；取到 4 位小数后性别平均一列 Σ = 1.0002，**所以代码里必须做一次 `a /= a.sum()`**。生成脚本 `scratchpad/coco_weights.py`。）

**三条由此立即得到的、可直接写进代码的性质：**

1. **左右互换不变性**：a_left_X ≡ a_right_X ⇒ 交换任意一对同名左右关键点，`CoM_proxy` 不变。MoveNet 在侧视时的 L/R 标签互换**不影响本估计量**。（注意：这不保护"单侧肢体整体错位"，只保护"标签互换"。）
2. **噪声增益**：设各关键点独立同分布噪声 σ，则 `std(CoM_proxy) = σ·√(Σ a_j²) = 0.346 σ`。对比"髋中点"估计量 `0.5·p11 + 0.5·p12` 的 0.707 σ ——**CoM_proxy 的噪声比髋中点低 2.04 倍**。这是采用它而非髋中点的第二个理由（第一个是 §2.4 的偏差）。
3. **影响力排序**：hip 0.176 > shoulder 0.139 > knee 0.0815 > ear 0.0341 ≈ ankle 0.0333 > elbow 0.0233 > wrist 0.0127。**髋与肩合计承载 63.0% 的权重**——它们的可靠性决定一切。

### 4.4 由权重直接导出的拒判量：质量覆盖率（mass coverage）

```
coverage(frame) = Σ_{j : score_j ≥ τ_kp} a_j       # ∈ [0, 1]
```

这是"本帧被可信关键点覆盖的体重比例"，是一个**有物理含义**的量，比"可见关键点个数"好得多（个数把鼻子和髋当成一样重要，实际差 ∞ 倍）。参考数值：

| 失效情形 | 剩余 coverage |
|---|---|
| 双耳丢失 | 0.932 |
| 双肩丢失 | 0.722 |
| 单侧整条腿丢失（hip+knee+ankle） | 0.709 |
| 双髋丢失 | **0.648** |

建议判据（阈值必须验证集校准，见 §5）：`coverage < τ_cov` 或 `landmark_quality != "usable"` ⇒ 直接输出 `unknown`，不进分类器。

### 4.5 其它可编码的派生量（全部尺度不变，全部先做 aspect 校正）

设 `u = MIDS − MIDH`（躯干向量），`L_trunk = ‖u‖`，`g_scene` = 该 scene 标定出的竖直单位向量（§3.4）。

```
# 1. 躯干倾角（相对场景竖直），投影量
theta_trunk = angle(u, g_scene)                     # 0 ≈ 直立, ~90° ≈ 平躺/前屈

# 2. CoM 的相对高度（尺度不变）
h_rel = ((MIDH − CoM_proxy) · g_scene) / L_trunk    # 用躯干长度归一，避免依赖身高

# 3. CoM 相对髋中点的位移（就是 §2.4 表格里"髋中点偏差"的负值，姿态敏感）
d_hip = (CoM_proxy − MIDH) / L_trunk

# 4. CoM 相对踝中点（支撑侧）的水平偏移，站立稳定性的投影代理
ankle_mid = (p15 + p16) / 2
d_base = ((CoM_proxy − ankle_mid) · perp(g_scene)) / L_trunk

# 5. 大腿轴与躯干轴夹角（髋屈曲的投影代理，坐/站的主判据之一）
theta_hip = angle(MIDH − MIDS, ((p13+p14)/2) − MIDH)

# 6. 小腿轴与躯干轴夹角（膝屈曲的投影代理）
theta_knee = angle(((p11+p12)/2) − ((p13+p14)/2), ((p15+p16)/2) − ((p13+p14)/2))

# 7. 身体主轴（对 a_j 加权的关键点云做 PCA 的第一主成分方向）
#    比单纯 bbox 宽高比稳健：bbox 会被伸出的手臂污染，加权 PCA 里手腕只有 0.0127
axis_body = PC1(points=p_j, weights=a_j)
theta_body = angle(axis_body, g_scene)
```

**明确禁止**的派生量：任何带米制单位的量、CoM 的绝对高度（米）、速度/加速度（m/s、m/s²）、势能、CoP、支撑面面积、XCoM。

### 4.6 时序侧（normal / fall_like / uncertain transition）能做与不能做

**能做**：`CoM_proxy` 的 y_norm 在 5–10 Hz 输出上的**归一化下降速率**——但必须用**当帧的 L_trunk 归一**（`Δ(CoM·g) / (L_trunk · Δt)`，单位 1/s，尺度不变）。`theta_body` 的角速度（deg/s，角度本身尺度不变，是本项目**唯一天然带物理单位且可观测**的时序量）。

**不能做**：把 y_norm 的变化当"下落高度"；把 Δy/Δt 当"下落速度"再和 √(2gh) 之类的自由落体判据比对——那需要米制尺度。**如果代码里出现 9.81，几乎一定是错的。**

---

## 5 阈值与参数：哪些有文献先验、哪些必须校准、哪些禁止硬编码

### 5.1 有文献先验、可以硬编码为常量的（附出处）

| 常量 | 值 | 出处 | 备注 |
|---|---|---|---|
| 14 个 a_j 系数 | §4.3 表 | de Leva 1996 T4（原文已读） | 建议同时保留 `WINTER_DEMPSTER` 一套用于敏感性分析，但**运行时只能启用一套** |
| 头颈质心锚点 = 耳中点 | — | Dempster 1955 T14（原文已读） | 不是拟合出来的，是解剖事实 |
| 环节质心落在相邻关节中心连线上 | — | Dempster 1955 p.189（原文已读） | 例外：shoulder mass（本项目已把肩部质量并入躯干，规避） |
| 站立时全身 CoM ≈ 0.55–0.57 身高 | — | Dempster；本模型自洽给 0.567 | **仅用于单元测试的合理性断言**，不得作为运行时先验 |

### 5.2 必须用验证集校准的（禁止照抄文献数字）

| 参数 | 为什么不能用文献值 |
|---|---|
| `τ_kp`（关键点 score 门限） | MoveNet 官方文档明写 "confidence values are not calibrated between models"。它还随分辨率、光照、遮挡、被试衣着分布漂移。必须在**本项目自己的验证集**上按目标 precision/recall 校准。 |
| `τ_cov`（质量覆盖率拒判门限） | 由 τ_kp 与真实遮挡分布共同决定，无文献先验。 |
| `theta_trunk / theta_body` 的 standing↔lying↔bending 分界 | 这些是**投影角**不是真实关节角。分界值取决于机位俯仰角、镜头畸变、被试相对相机的朝向。**必须逐场景或逐机位族校准。** |
| `h_rel`、`d_hip`、`d_base` 的分界 | 同上，且受体表标注偏移（§3.3 第 1 层）影响，该偏移无文献常数。 |
| 时序下降速率门限 | 尺度归一后仍与机位距离弱相关；必须校准。 |
| 性别参数表选择 | **骨架不可推断性别**。模型算术显示男女系数差异导致的 CoM 位移仅 4.2–5.0 mm，远小于换表（14.9–19.1 mm）和髋中点误差（71–283 mm）。**结论：直接用性别平均系数，不做性别推断**——这既是精度上的理性选择，也是隐私与伦理上的必须。 |

### 5.3 明确禁止硬编码的

- **任何以米、厘米、千克、m/s、m/s² 为单位的阈值**——这些量在本系统中不可观测（§3.5）。若出现，说明有人偷偷假设了尺度。
- **跨 scene 共用的绝对 y_norm 阈值**（如"CoM 的 y_norm > 0.7 就是躺着"）。y_norm 同时编码了人在画面里的位置和相机几何，跨 scene 无意义。
- **把 score 当概率乘进 a_j**。这会破坏 Σa = 1，使 CoM_proxy 在不同帧之间不可比，制造与遮挡强相关的伪特征。正确做法是二值门控 + 覆盖率拒判。
- **混用 Dempster/Winter 与 de Leva 的行**（如"质量用 Winter、质心比例用 de Leva"）。两者分割面不同（HSP 37° vs 髋关节离断），混用会破坏质量守恒且引入姿态相关的伪偏差（§2.2 论断 H）。
- **"丢弃 + 重归一化"**（§4.2）。
- **任何形式的固定"经验修正常数"** 用于补偿缺失环节——偏差随姿态翻符号，常数补偿在一半的类上会加大误差。
- **HAT 合并环节**作为主路径（§2.3 论断 J）。仅在上肢关键点大面积失效时，作为降级路径把上肢质量并入肩关键点，并且**必须在输出里标记为降级**。

---

## 6 对 Reme 的取舍建议与风险

### 6.1 建议（按优先级）

1. **冻结参数表为 de Leva (1996) 性别平均**，写成一个带出处注释的常量模块，含 `assert abs(sum(a)-1) < 1e-9`。把 Winter/Dempster 一套作为 `#[cfg(test)]`/敏感性分析用，不进运行时分支。

2. **实现单一函数 `com_proxy(keypoints) -> (Point, coverage)`**，14 项定常线性组合 + 覆盖率。不要写"分环节循环"——折叠成向量点积后代码更短、更快、更难出错，而且天然暴露"哪个关键点最重要"。

3. **绝不引入髋中点或躯干中点作为 CoM 的替代**。若出于计算预算考虑必须简化，正确的降级顺序是：全 14 项 → 去掉耳（0.932 覆盖）→ 去掉腕肘（0.891 覆盖）→ **停止**。降级到髋中点是从 5 mm 误差跳到 71–283 mm 误差，且误差方向随类别翻转，等于直接摧毁分类边界。

4. **补上 schema 缺口**：请 A 角色在 `FrameLandmarks` 里增加 `image_width_px` / `image_height_px`（或 `aspect_ratio`）。没有它，`x_norm/y_norm` 上算出的任何长度与角度都被未知的像素纵横比污染。这是当前 v0 schema 最实质的一个洞。**在补上之前，只使用"沿同一轴的比值"这类对各向异性缩放不敏感的特征，不要算角度。**

5. **每 scene 标定竖直方向 `g_scene`**，作为 scene 级配置持久化。标定方法：用该 scene 大量帧的躯干向量方向做稳健统计（例如方向的圆中位数），或由部署时的一次性人工确认。**不要假设 y 轴就是重力。**

6. **拒判优先**：`landmark_quality != "usable"` 或 `coverage < τ_cov` ⇒ `unknown` / `uncertain_transition`。这与产品红线一致，也与文献一致（Wade et al. 显示被遮挡侧的离散度是可见侧的 1.4–2.1 倍，冠状面踝关节 LoA ±23° 基本不可用）。

7. **命名纪律**：输出字段叫 `com_proxy_2d` 而非 `center_of_mass`；时序类别保持 `fall_like_transition` 而非 `fall`。这不是措辞洁癖——单目 2D 下"跌倒"的力学定义（CoM 加速度、支撑面丢失）根本不可观测（§3.5）。

### 6.2 风险清单

| 风险 | 性质 | 缓解 |
|---|---|---|
| **老年人体型与两套参数表的总体都不匹配** | 系统性、不可消除 | Otmani et al. (2023) 显示跨总体迁移带来 ~12% 的环节参数偏差。缓解只能靠"使用尺度不变的相对特征 + 验证集在目标人群上校准分界"。**绝不可声称对老年人准确。** |
| **COCO 的 hip 标注 ≠ 髋关节中心，且承载 35.2% 的总权重** | 系统性偏移，方向未知 | 这是最大的单点风险。缓解：分类器不依赖 CoM 的**绝对位置**，只用相对量；并在验证集上单独检查 hip 关键点在各姿态类下的稳定性。 |
| **躯干单刚体假设在 `bending_or_crouching` 上最弱** | 恰好压在关键判别边界 | de Leva 与 Dempster 都有明确记载。缓解：为该类额外引入不依赖躯干质心的特征（如 `theta_hip`、`theta_knee`、加权 PCA 主轴），并接受该类的拒判率更高。 |
| **lying 姿态下自遮挡最严重，且 CoM 的判别力最低** | 结构性 | lying 时 CoM 的 y_norm 与髋中点的 y_norm 几乎相同（模型算术：两者垂直分量差仅 0.0005 H）。**lying 必须靠"身体主轴方向"而非"CoM 高度"判别。** |
| **相机 roll/pitch 未知** | 使 y_norm 失去物理含义 | 每 scene 标定 `g_scene`；若标定失败则该 scene 只输出 `unknown`。 |
| **score 未校准** | 阈值不可移植 | 二值门控 + 覆盖率；τ 逐部署校准；不把 score 当权重。 |
| **透视非交换性** | 已量化，二阶小量 | 室内 3 m 下 p95 ≈ 1.8% 投影宽度，可忽略，但要在文档里留档，避免以后有人"发现"它并过度工程化。 |
| **有人日后偷偷加入米制假设** | 工程腐化 | 加一条 CI 检查：特征模块内禁止出现 9.8/9.81/`GRAVITY`/`meters` 等标识符。 |

### 6.3 一句话取舍

> 用 de Leva (1996) 的 MIDS–MIDH 躯干行 + 四肢行，把头颈质量锚到 COCO 双耳中点（Dempster 1955 Table 14 的解剖事实），手足质量就近并到腕踝，折叠成 14 项定常线性组合；**不重归一化、不用髋中点、不混表、不引米制**；所有分界阈值由验证集在目标人群与目标机位上校准，覆盖率不足即拒判。

---

## 附录 A：本次实际读到原文的一手来源清单

| # | 来源 | 获取方式 | 读到程度 |
|---|---|---|---|
| 1 | Dempster (1955) WADC TR 55-159 | IIT Contrails 记录页 <https://contrails.library.iit.edu/item/154630>，274 页原始 PDF + 本地 OCR | **Tables 10/11/12/13/14/15 逐字**，Ch. VII 正文 |
| 2 | de Leva (1996) *J Biomech* 29(9):1223-30，DOI <https://doi.org/10.1016/0021-9290(95)00178-6> | PDF 全文 | **全文 + Tables 1/2/3/4 逐字** |
| 3 | Drillis, Contini & Bluestein (1964) Body Segment Parameters: A Survey of Measurement Techniques, *Artificial Limbs* 8(1) | PDF 全文 | 正文（图表为图像未 OCR）；提供 Dempster 样本年龄/体重的独立佐证与 Fischer 系数 |
| 4 | Wade et al. (2023) *PLoS ONE* 18(11):e0293917，DOI <https://doi.org/10.1371/journal.pone.0293917> | 开放获取全文 | 结果表数值 |
| 5 | Yang & Pai (2014) *J Biomech* 47(16):3807-12，DOI <https://doi.org/10.1016/j.jbiomech.2014.10.027> | PubMed 摘要（PMC4469384） | 摘要级 |
| 6 | Gutierrez-Farewik et al. (2006) *Hum Mov Sci* 25(2):238-56，DOI <https://doi.org/10.1016/j.humov.2005.11.001> | PubMed 摘要 | 摘要级（含数值） |
| 7 | Lintmeijer et al. (2018) *Eur J Sport Sci* 18(7):940-6，DOI <https://doi.org/10.1080/17461391.2018.1465126> | PubMed 摘要 | 摘要级（含数值） |
| 8 | Otmani, Michon & Watier (2023) *International Biomechanics* 10(1):18-28，DOI <https://doi.org/10.1080/23335432.2023.2268686> | 开放获取 | 结果级 |
| 9 | Lafond, Duarte & Prince (2004) *J Biomech* 37(9):1421-6，DOI <https://doi.org/10.1016/S0021-9290(03)00251-3> | PubMed 摘要 | 摘要级 |
| 10 | Clauser, McConville & Young (1969) AMRL-TR-69-70 | NASA NTRS 全文 PDF <https://ntrs.nasa.gov/api/citations/19700027497/downloads/19700027497.pdf> | 首页与方法段（微缩胶片 OCR 质量差，数值表未采信） |
| 11 | TensorFlow.js `pose-detection` 官方文档 | <https://github.com/tensorflow/tfjs-models/blob/master/pose-detection/README.md> | 关键点定义、score 语义 |
| 12 | Hartley & Zisserman, *Multiple View Geometry in Computer Vision*, 2nd ed., CUP 2004 | 官方书页 <https://www.robots.ox.ac.uk/~vgg/hzbook/> | 引用其仿射相机模型（书本身未逐页读） |

**未读原文、仅见二手转述的条目（不得写入代码常量）**：
- Winter, D. A. *Biomechanics and Motor Control of Human Movement* 4th ed. Table 4.1 的原书页面（Wiley DOI <https://doi.org/10.1002/9780470549148.ch4>，403 无法获取）。文中给出的 Winter 数值来自二手教学材料 + 与 Dempster 原始表的逐位一致性核对。
- Winter 表中的 HAT 质心比例 0.626（仅二手转述）。
- Eames et al. (1999) 的具体毫米级数值（仅摘要级"CP 的总位移始终大于 GRF"）。
- Zatsiorsky & Seluyanov (1983) / Zatsiorsky et al. (1990a,b) 原始章节（经 de Leva 1996 转述，de Leva 本人已读原文）。

**按项目约定排除的来源**：MDPI（*Sensors* 21(8):2889 等）与 Frontiers（*Front. Physiol.* 8:129 等）在检索中出现但未采用。

## 附录 B：可复现脚本

- `scratchpad/coco_weights.py` — 从 de Leva/Winter 环节参数折叠出 §4.3 的 14 项系数、噪声增益、覆盖率
- `scratchpad/com_bias.py` — 五种姿态下四种估计量的偏差（§2.4 论断 L 表）
- `scratchpad/persp.py` — 透视非交换性的蒙特卡洛上界（§3.1 表）
- `scratchpad/dempster_ocr.py` / `dempster_ocr2.py` — Dempster 1955 原始 PDF 的分页 OCR

（脚本位于本次会话的 scratchpad，若需长期保留请复制到 `.scratch/posture-classifier-theory/` 下。）
