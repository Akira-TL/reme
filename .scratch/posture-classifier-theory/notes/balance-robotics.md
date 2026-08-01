# 平衡与支撑判据：从人体姿势控制到仿人机器人，以及它们在单目 2D 归一化关键点下还剩什么

调研日期：2026-08-01
适用输入：A 角色 JSONL，`schema_version="movenet-17/v0-experiment"`，MoveNet SinglePose Lightning COCO-17，
`coordinate_space="normalized_image_top_left"`，x,y ∈ [0,1]，y 轴向下，30 FPS 输入 / 5–10 Hz 输出，
单人、室内固定机位。**无深度、无相机内外参、无米制尺度、无力板、无 IMU、无 3D。**

本文所有"可观测/代理/不可观测"判定均在上述前提下做出。凡涉及假设的地方，假设与其失效条件一并写出；
写不出失效条件的假设，一律按"不可观测"处理。

---

## 1 结论摘要

1. **ZMP 在本项目中完全不可观测，必须整条放弃。** ZMP 的严格定义要么需要测量足底接触压力分布
   （Vukobratović & Borovac 2004 明确说"信息可通过测量地面与机构接触处的力获得"），要么需要全身动力学量
   $m$、$\mathbf{a}_G$（质心加速度）与 $\dot{\boldsymbol\delta}_G$（质心处角动量变化率）（Sardain & Bessonnet 2004 Eq. 8–9）。
   单目 2D 关键点一个都给不了。更关键的是：Sardain & Bessonnet 证明只要还有接触，**CoP 与 ZMP 恒为同一点**；
   Vukobratović & Borovac 则指出算出来落在支撑多边形外的那个点是 **FZMP（fictitious ZMP），物理上不存在**。
   所以"用视觉估计 ZMP"在最好的情况下也只是在估计一个假想刚体模型的 FZMP，没有物理含义。**禁止在 Reme 中出现 ZMP 字样。**

2. **XCoM / Capture Point 这一族在 2D 下只剩一个"图像平面内的无量纲代理"，且只有 medio-lateral（左右）分量。**
   Hof et al. (2005) 的 $\mathrm{XCoM} = x + v/\omega_0$、$\omega_0=\sqrt{g/l}$ 与 Pratt et al. (2006) 的
   $x_{capture} = \dot{x}\sqrt{z_0/g}$ 是同一个式子。好消息：$\omega_0 \propto H^{-1/2}$，成年人身高 1.50–1.90 m
   对应 $\omega_0 \approx 2.8$–$3.2\ \mathrm{s^{-1}}$（±6%），所以在"体高归一化"坐标系里这个常数几乎可以当固定值用。
   坏消息：(a) 前后（A/P）分量沿光轴，**完全不可观测**；(b) 判据要拿它跟 BoS 边界比，而 **BoS 在 COCO-17 下没有脚尖/脚跟点，
   前后向长度为零信息**；(c) Hof 报告的行走中 margin of stability 仅 2–3 cm ≈ 体高的 1.1–1.7%，而 COCO 髋关键点的
   标注一致性 sigma 就是 $0.107\sqrt{A}$（约体高的 3–4%）——**生理裕度比关键点噪声还小一个身位，绝对值比较必然失败**。
   结论：只能当作**同一机位内单调的相对特征**用，不能与文献数值比。

3. **真正在 2D 下"可直接计算且物理正确"的，是各体段相对重力方向的三维倾角** ——
   在正交（弱透视）投影、相机 roll≈0、pitch≈0 下，严格有 $\cos\theta_{3D} = |\Delta y_{img}| / (k L)$，
   其中 $kL$ 是该体段"若竖直时"的图像长度。**只用 y 分量**，因此对图像宽高比归一化的不确定性免疫，
   对方位角 $\psi$（人朝向）免疫。这条给了静态四分类（standing/sitting/lying/bending_or_crouching）一个真正的物理基座，
   而不是靠 bbox 长宽比这种纯启发式。它的失效条件是相机俯仰角不为零、人离相机太近（透视非弱）、以及 $kL$ 估计不准。

4. **仿人机器人跌倒预测的实际做法中，唯一能整条搬到 2D 的是"质心高度下降"判据与"预测历史去抖"规则**，
   不是 CoP/角动量那些。Kalyanakrishnan & Goswami (2011) 用的 16 维特征里，CoM 位移是相对 CoP 定义的、
   还有线动量/角动量及其变化率、以及"足部接触模式（CoP 在支撑多边形的哪条边）"——这些在 2D 下全灭。
   但他们的 `fallen` 判据（质心低于阈值高度，其机器人 0.33 m / 标称 0.59 m）、误报兜底规则（0.48 m / 0.59 m）、
   `t_height-drop`（质心高度开始单调下降的时刻）、以及 $\tau_{his}$（只有过去 $\tau_{his}$ 窗口内全部判为 falling 才输出 falling）
   是**纯结构性的、与传感器无关的**，可以直接映射成"髋中点相对踝线的归一化高度"及其单调下降段 + 持续性门。
   他们的评估框架（False Positive Rate vs Lead Time 两目标权衡，训练标签用 $\tau^+$ 截断）也应当整套借用。

5. **全身角动量 $L$ 不可观测，但 Herr & Popovic (2008) 的发现可以用来"论证特征方向"，不能用来"定阈值"。**
   他们用 16 段模型 + VICON + 测力台算出正常行走时归一化 $|L|$ 的均值加一个标准差在三个轴上分别 < 0.05 / 0.03 / 0.01，
   即**全身角动量被极紧地调节在零附近**。这给了"图像中躯干角速率持续大幅偏离即为异常"一个物理理由；
   但他们的实验条件是自选速度平地稳态行走，不覆盖坐下/弯腰，所以**不构成任何阈值先验**。
   他们的 CMP（$x_{CMP} = x_{CM} - (F_x/F_z)z_{CM}$）需要地面反力，同样不可观测。

---

## 2 理论与一手文献

每小节格式：**论断 → 出处 → 该论断成立所依赖的原始测量条件**。

### 2.1 静立的倒立摆模型（inverted pendulum model of quiet standing）

**论断**：人体安静站立的平衡问题可以近似为一个绕踝关节转动的单刚体倒立摆；CoP 与 CoM 的水平偏差正比于 CoM 的水平加速度。

**出处（一手）**：
- D. A. Winter, "Human balance and posture control during standing and walking," *Gait & Posture* 3(4):193–214, 1995.
  DOI: [10.1016/0966-6362(96)82849-9](https://doi.org/10.1016/0966-6362(96)82849-9)。
  关键词由期刊记录为 "Balance; inverted pendulum model; standing; walking"。
  （**未读全文，仅读到期刊书目页与 Hof 2005 对其的一手引用**；下面的方程形式取自 Hof et al. 2005 中对 Winter 1995b 的直接转写。）
- D. A. Winter et al., "Stiffness control of balance in quiet standing," *J. Neurophysiol.* 80(3):1211–1221, 1998.
  DOI: [10.1152/jn.1998.80.3.1211](https://doi.org/10.1152/jn.1998.80.3.1211)。
  （**未读全文，出版方域名在本机网络下 403**；仅用于佐证 "COP−COM 是平衡控制的误差信号" 这一提法的出处。）

**原始条件**：需要测力台给出 CoP，需要运动捕捉 + 多段人体模型给出 CoM。Winter 1998 的具体推导本次未取得原文。

**Hof et al. (2005) 中的一手转写（已读原文 PDF）**：以踝为转动中心、质量 $m$、有效摆长 $l$、$I = ml^2$，
CoM 水平投影 $x$、CoP 位置 $u$：

$$(u - x)mg = I\alpha \approx -ml^2\frac{\ddot{x}}{l} \quad\Longrightarrow\quad u - x = -\frac{l}{g}\ddot{x} = -\frac{\ddot{x}}{\omega_0^2},\qquad \omega_0 = \sqrt{g/l}$$

模型的三条明写假设（Hof 2005, §2）：(1) 平衡问题可完全由全身 CoM 的运动描述；(2) 从转动轴到 CoM 的距离 $l$ 保持常数；
(3) CoM 的位移相对 $l$ 很小。

**对 Reme 最要命的一条**：假设 (2) 在**弯腰、下蹲、坐下**时被直接违反——而这恰恰是 Reme 必须分类的三类姿态。
Hof 自己在 Discussion 里写明："Movements in which the distance from foot to CoM shows major changes will probably not follow the rules put forward here."
所以**倒立摆族的一切判据在 Reme 的目标姿态里有一半是模型外的**，这不是精度问题，是适用性问题。

### 2.2 有效摆长 $l$ 与 $\omega_0$ 的数值

**论断**：$l$ 不是腿长，而是"等效摆长"。

**出处**：Hof et al. 2005, §2.2（已读原文）。矢状面：$l = 1.20$ 或 $1.24 \times$ 大转子高度（躯干保持竖直 / 躯干与腿同角度），
引自 Geurtsen et al. (1975) 与 Winter (1979) 的人体测量数据；额状面：$l = 1.34 \times$ 大转子高度，引自 Massen & Kodde (1979)。
其站立实验受试者腿长均值 0.936 m（SD 0.06），行走示例受试者腿长 1.06 m。

**由此推出的 $\omega_0$ 数值范围**（本文自行计算，非文献直接给出）：

| $l$ 取法 | $l$ (m) | $\omega_0$ (s⁻¹) | $1/\omega_0$ (s) |
|---|---|---|---|
| $l$ = 腿长 0.936（摘要口径） | 0.936 | 3.24 | 0.31 |
| $l = 1.20\times 0.936$（矢状面口径） | 1.123 | 2.96 | 0.34 |
| $l = 1.34\times 0.936$（额状面口径） | 1.254 | 2.80 | 0.36 |
| 行走受试者 $l=1.20\times 1.06$ | 1.272 | 2.78 | 0.36 |

**跨身高的敏感性**（取 $l \approx 1.20\times 0.53H$，其中 0.53 为大转子高/身高的常用比例，**该比例本次未从一手表格核实**）：

| 身高 H (m) | 1.10 | 1.50 | 1.70 | 1.90 |
|---|---|---|---|---|
| $\omega_0$ (s⁻¹) | 3.75 | 3.21 | 3.01 | 2.85 |

**这是本次调研最有工程价值的数值结论之一**：因为 $\omega_0 \propto H^{-1/2}$，成年人（1.50–1.90 m）范围内 $\omega_0$ 只变化 ±6%。
即：**在"体高归一化"坐标系里，$\omega_0 \approx 3.0\ \mathrm{s^{-1}}$ 可以当成人常数用，误差 ±6%**。
但若目标人群包含儿童（1.10 m → $\omega_0=3.75$，+25%），该近似失效，必须按人分档或拒判。

推论：**人体倾覆的自然时间常数 $1/\omega_0 \approx 0.30$–$0.36$ s**。这直接约束 Reme 的时序管线（见 §5、§6）。

### 2.3 Base of Support (BoS) 与 Center of Pressure (CoP)

**论断**：BoS 定义为 **CoP 的可能取值范围**，而不是"脚的轮廓"。

**出处**：Hof et al. 2005, §1 与 §2（已读原文）："The 'base of support', or 'supporting area', is defined as the possible range
of the centre of pressure (CoP), the origin of the ground reaction vector." §3.2 记录了他们**怎么测**这个 BoS：
让受试者单脚站立、扶扶手、尽量向前后内外移重心，用 Bertec 40×60 cm 测力台把 CoP 的极限轨迹记成一个闭环，再用直线段拟合边界。

**原始条件**：**BoS 只能用测力台测出来**，它不是几何形状而是力学可达集。Hof 同时用 RSscan Footscan 足底压力系统记录了
足底压力分布与 BoS 面积的关系，说明二者相近但不等同。

**CoP 的定义（更严格的一手来源）**：Sardain & Bessonnet 2004（已读原文 PDF）：单脚接触时，法向压力场等价于作用在
"合力矩为零之点"的单一合力，该点即 CoP。CoP 的存在依赖于接触压力场的单向性（压力只能推、不能拉），因此
**CoP 恒在支撑多边形内**（"the unilaterality of the foot-ground contact ... implies that the CoP lies within the support polygon"）。

**对 Reme 的直接后果**：BoS 与 CoP 都是**力学量**，与关键点几何无因果关系。COCO-17 只有踝（15/16），没有脚跟、脚尖、
足内外侧缘，因此连"脚的几何轮廓"这个更弱的东西都拿不到。

### 2.4 Extrapolated Center of Mass (XCoM) 与 Margin of Stability

**论断（原文核心）**：静态判据"CoM 竖直投影落在 BoS 内"在动态情形下不充分；正确的推广是
"CoM 位置加上其速度乘以 $\sqrt{l/g}$ 落在 BoS 内"。

**出处**：A. L. Hof, M. G. J. Gazendam, W. E. Sinke, "The condition for dynamic stability," *J. Biomech.* 38(1):1–8, 2005.
DOI: [10.1016/j.jbiomech.2004.03.025](https://doi.org/10.1016/j.jbiomech.2004.03.025)。已读原文 PDF。

**逐条原文推导**（Hof 2005 §2）：
- 解 $\ddot{x} = \omega_0^2 (x-u)$，$u$ 常数，初值 $(x_0, v_0)$：
  $$x(t) = u + (x_0-u)\cosh(\omega_0 t) + \frac{v_0}{\omega_0}\sinh(\omega_0 t) \tag{Eq.3}$$
- "CoM 不越过 CoP" 对任意 $t$ 成立的条件化简为
  $$x_0 + \frac{v_0}{\omega_0} \le u \tag{Eq.5}$$
- 二维推广：$\mathbf{r} + \mathbf{v}/\omega_0$ 应落在 BoS 内 (Eq.6)。作者为 $\mathbf{r}+\mathbf{v}/\omega_0$ 命名 **XcoM**。
- **Margin of stability**：$b = |u_{max} - (x + v/\omega_0)|$ (Eq.7)，二维下取 XcoM 到 BoS 边界的最短垂距。
- **力学含义**：$m\Delta v = m\omega_0 \cdot b$ (Eq.8)，即 $b$ 正比于"把人推失衡所需的最小冲量"。
- **Temporal stability margin**：$\tau \approx \dfrac{u_{max}-(x+v/\omega_0)}{v} = \dfrac{b}{v}$ (Eq.9)，作者注明这是近似
  （精确解需对时变 $u(t)$ 解微分方程）。
- 三种情形：(a) CoM < XcoM < CoP < BoS_max，无需动作；(b) CoM < CoP < XcoM < BoS_max，需在 $\tau$ 时间内把 CoP 移到 XcoM 前方；
  (c) XcoM > BoS_max，**倒立摆模型内无解**，只能靠迈步改变 BoS 或摆动躯干/手臂（作者明说这两者"不在倒立摆模型描述范围内"）。
- 关系式：$\mathrm{XcoM} = x + \dot{x}/\omega_0$ (Eq.10)，$\mathrm{CoP} = x - \ddot{x}/\omega_0^2$ (Eq.11)，
  **Eq.11 只在倒立摆模型条件下成立**（原文明写 "valid only under the conditions of the inverted pendulum model"）。

**数值**：行走中侧向 CoP 距 XcoM 仅约 2.5 cm，作者据此估计行走中 $b$ 只有 **2–3 cm**。
（换算：占身高 1.75 m 的 1.1%–1.7%。这个数字在 §3 中会成为致命约束。）

**原始条件**：Bertec 测力台 + ELITE 光学动捕 + 15 段人体模型（Winter 1979 人体测量数据）；CoM 由测力台 CoP 与地面反力水平分量
按 Zatsiorsky & King (1998) 方法求出，或由动捕的 15 段模型求出。

**补充一手来源**：A. L. Hof, "The 'extrapolated center of mass' concept suggests a simple control of balance in walking,"
*Hum. Mov. Sci.* 27(1):112–125, 2008. DOI: [10.1016/j.humov.2007.08.003](https://doi.org/10.1016/j.humov.2007.08.003)，
PMID [17935808](https://pubmed.ncbi.nlm.nih.gov/17935808/)（已读摘要全文）。摘要原文给出 $\xi = \chi + \nu/\omega_0$，
并明写"$\omega_0$ is a constant related to stature"——即 **$\omega_0$ 由身材决定，是可以按人群固定的常数**，
这正是 §2.2 数值分析的文献依据。该文还给出扰动补偿规则：CoM 速度变化 $\Delta v$ 可由脚落点（CoP）沿同向移动 $\Delta v/\omega_0$ 补偿。

### 2.5 Zero Moment Point（严格定义、它需要什么测量、为什么纯视觉拿不到）

**出处 A**：M. Vukobratović, B. Borovac, "Zero-moment point — thirty five years of its life,"
*Int. J. Humanoid Robotics* 1(1):157–173, 2004. DOI: [10.1142/S0219843604000083](https://doi.org/10.1142/S0219843604000083)。
已读原文 PDF（[CMU 镜像](https://www.cs.cmu.edu/~cga/legs/vukobratovic.pdf)）。

**严格定义（原文）**：机构处于动力学平衡的充要条件是，在地面反力作用点 $P$ 处
$$M_x = 0,\quad M_y = 0 \tag{Eq.1}$$
"Since both components relevant to the realization of dynamic balance are equal to zero, a natural choice to name this point
was Zero-Moment Point."

**计算所需**（原文 Eq.2–4）：支撑足的静力平衡
$$\mathbf{R} + \mathbf{F}_A + m_s\mathbf{g} = 0$$
$$(\overrightarrow{OP}\times\mathbf{R})_H + \overrightarrow{OG}\times m_s\mathbf{g} + \mathbf{M}_A^H + (\overrightarrow{OA}\times\mathbf{F}_A)_H = 0$$
即需要：踝关节处的力 $\mathbf{F}_A$ 与力矩 $\mathbf{M}_A$（原文："can be obtained from the model of the mechanism dynamics"）、
足质量 $m_s$、足质心位置 $G$、踝位置 $A$。**在真实机器人上，原文明写获取方式是"用足底力传感器测量地面接触处的力"**
（"information about ZMP position can be obtained by measuring forces acting at the contact of the ground and the mechanism,
with the aid of force sensors on the mechanism's sole"），并且强调**只有当所有力传感器都接触地面时测量才有效**。

**FZMP（原文最重要的澄清）**：若按 Eq.4 算出的 $P$ 落在支撑多边形外，则它是 **fictitious ZMP**；
"in reality, ZMP can exist only within the support polygon"，"a ZMP outside the support polygon practically has no sense,
as in ZMP de facto does not exist"。此时真实的地面反力作用点在多边形边缘（即 CoP），
FZMP 到边缘的距离正比于导致倾覆的扰动力矩。

**ZMP 与 CoP 的关系（原文总结）**："the ZMP always coincides with the CoP (dynamically balanced gait),
but the CoP is not always ZMP (dynamically unbalanced gait). However, the FZMP never coincides with the CoP
because CoP cannot, naturally, exist outside the support polygon."

**出处 B（更严格的力学论证）**：P. Sardain, G. Bessonnet, "Forces acting on a biped robot. Center of pressure—zero moment point,"
*IEEE Trans. SMC-A* 34(5):630–637, 2004. DOI: [10.1109/TSMCA.2004.832811](https://doi.org/10.1109/TSMCA.2004.832811)。
已读原文 PDF（[CMU 镜像](https://www.cs.cmu.edu/~cga/legs/sardain-bessonnet.pdf)）。

- **ZMP 定义**："The ZMP is the point on the ground where the tipping moment acting on the biped, due to gravity and inertia forces,
  equals zero, the tipping moment being defined as the component of the moment that is tangential to the supporting surface."
  作者指出 ZMP 这个名字其实不精确，应读作 "zero **tipping** moment point"。
- **重力+惯性力旋量**（原文 Eq.8–9）：合力由总质量 $m$、重力加速度 $\mathbf{g}$、质心 $G$ 的加速度 $\mathbf{a}_G$ 决定；
  对任意点的力矩还需要 **$G$ 处的角动量变化率 $\dot{\boldsymbol\delta}_G$**。
- **重合性证明**：只要所有足-地接触落在同一平面上，"the CoP and the ZMP are absolutely and definitely the same point"，
  且"it is true when the walker is falling down, as long as a contact exists with the ground"。
- **ZMP 的最大优势恰恰是"可测"**："The major advantage of the CoP-ZMP concept is that this point can be measured:
  measuring the contact pressure force-moment allows the CoP to be reconstructed, and the ZMP by coincidence."
- **不定义的情形**：腾空期支撑多边形消失，CoP-ZMP 不存在。

**对 Reme 的结论**：ZMP 的两条计算路径——(i) 测接触压力，(ii) 全身动力学 $\{m, \mathbf{a}_G, \dot{\boldsymbol\delta}_G\}$
加上地面平面与重力方向在相机系中的位姿——在本项目下**全部缺失**。**不存在"加一个假设就能算 ZMP"的说法。**

### 2.6 Capture Point / Instantaneous Capture Point

**出处**：J. Pratt, J. Carff, S. Drakunov, A. Goswami, "Capture Point: A Step toward Humanoid Push Recovery,"
*Proc. IEEE-RAS Humanoids 2006*, pp. 200–207. DOI: [10.1109/ICHR.2006.321385](https://doi.org/10.1109/ICHR.2006.321385)。
已读原文 PDF（[CMU 镜像](https://www.cs.cmu.edu/~cga/legs/Pratt_Goswami_Humanoids2006.pdf)）。

**形式化定义（原文 Def.1–4）**：
- *Capture State*：动能为零且可用关节力矩保持为零的状态；此状态下 CoM 必须在 CoP 正上方。
- *Capture Point* $P$：地面上一点，若机器人把 BoS 覆盖到 $P$（用支撑足或迈一步）并把 CoP 保持在 $P$ 上，则存在一条
  安全可行轨迹到达 Capture State。
- *Capture Region*：所有 Capture Point 的集合。

**LIPM 下的闭式解**（原文 Eq.7–10）：$\ddot{x} = \frac{g}{z_0}x$，轨道能 $E_{LIP} = \frac12\dot{x}^2 - \frac{g}{2z_0}x^2$，
稳定特征向量 $\dot{x} = -x\sqrt{g/z_0}$，于是
$$x_{capture} = \dot{x}\sqrt{\frac{z_0}{g}} \tag{Eq.10}$$
**这与 Hof 的 $\mathrm{XCoM}-x = v/\omega_0$ 是同一个量**（$\sqrt{z_0/g}=1/\omega_0$，$z_0$ 为质心高度）。

**决策规则（原文 §III）**：Capture Point 落在足支撑凸包（BoS）内 ⇒ 不用迈步，调 CoP 即可；落在外 ⇒ 必须迈步，
且落脚要让新 BoS 与 Capture Region 相交；Capture Region 整体落在摆动足工作空间外 ⇒ 一步收不住。

**飞轮扩展**：把点质量换成飞轮（转动惯量 $J$、力矩上限 $\tau_{max}$、角度上限 $\theta_{max}$），Capture Point 扩展成 Capture Region
（原文 Eq.11–12、Eq.26）。这需要 $J$、$m$、$z_0$、$\tau_{max}$、$\theta_{max}$，**在人身上没有一个可测**。

**量纲分析（原文 §V-H，对本项目极重要）**：定义无量纲量
$$x' \equiv \frac{x}{z_0},\quad \dot{x}' \equiv \frac{\dot{x}}{\sqrt{g z_0}},\quad t'\equiv t\sqrt{\frac{g}{z_0}},\quad J'\equiv \frac{J}{mz_0^2}=\frac{R_{gyr}^2}{z_0^2},\quad \tau'\equiv\frac{\tau}{mgz_0}$$
运动方程化为 $\ddot{x}' = x' - \tau'$，$\ddot{\theta}' = \tau'$。
**这说明：只要采用"质心高度归一化的位置"与"$\sqrt{gz_0}$ 归一化的速度"，整个 capture point 理论是无量纲的。**
注意 $\dot{x}/\sqrt{gz_0} = (\dot{x}/z_0)/\omega_0$，即"每秒多少个体高" ÷ $\omega_0$ —— 与 §2.2 的结论完全一致：
**唯一进入公式的米制量是 $\omega_0$，而 $\omega_0$ 在成人范围内近乎常数。**

**扩展一手来源**：T. Koolen, T. de Boer, J. Rebula, A. Goswami, J. Pratt,
"Capturability-based analysis and control of legged locomotion, Part 1," *Int. J. Robotics Research* 31(9):1094–1113, 2012.
DOI: [10.1177/0278364912452673](https://doi.org/10.1177/0278364912452673)。
（**未读全文，仅读官方摘要**。）定义 *N-step capturability*：系统能否在 N 步或更少步内停下而不摔倒；
并定义 *N-step capturability margin* 为 N-step capture region 的大小。这是把 Hof 的标量 $b$ 推广成集合测度的正统做法。

### 2.7 全身角动量（whole-body angular momentum）

**出处**：H. Herr, M. Popovic, "Angular momentum in human walking," *J. Exp. Biol.* 211(4):467–481, 2008.
DOI: [10.1242/jeb.008573](https://doi.org/10.1242/jeb.008573)。
[官方页面](https://journals.biologists.com/jeb/article/211/4/467/18040/Angular-momentum-in-human-walking)（已通过 WebFetch 读取正文要点）。

**定义（原文 Eq.4）**：
$$\mathbf{L} = \sum_i \left[(\mathbf{r}^i_{CM}-\mathbf{r}_{CM})\times m_i(\boldsymbol\nu^i-\boldsymbol\nu_{CM}) + \mathbf{I}^i\boldsymbol\omega^i\right]$$
第一项为各段质心绕全身质心的"轨道"角动量，第二项为各段绕自身质心的"自旋"角动量。

**归一化常数**：$N = M_{subject}\times V_{subject}\times H_{subject}$（体重 × 自选步速 × 站立时质心高度）。

**核心发现**：归一化后 $|L|$ 的（均值 + 1 SD）在内外侧 < 0.05、前后向 < 0.03、垂直向 < 0.01。
即**尽管各体段的角动量很大，全身角动量在整个步态周期中都被紧紧调节在零附近**。

**与 CoP 的关系（原文 Eq.6）**：
$$\left.\mathbf{T}\right|_{hor} = \left[(\mathbf{r}_{CP}-\mathbf{r}_{CM})\times\mathbf{F}\right]_{hor} = \left.\frac{d\mathbf{L}}{dt}\right|_{hor}$$
当 $d\mathbf{L}/dt \approx 0$ 时，**Centroidal Moment Pivot (CMP)** 与实测 CP 重合：
$$x_{CMP} = x_{CM} - \frac{F_x}{F_z}z_{CM},\qquad y_{CMP} = y_{CM} - \frac{F_y}{F_z}z_{CM}$$
实测 CMP 与 CP 的归一化间距均值仅为足长的 **14 ± 2%**。

**原始条件**：16 刚体段模型（双足、双胫、双股、双手、双前臂、双上臂、骨盆-腹、胸、颈、头），
VICON 512 八相机 120 fps + 33 个反光标记，两块交错测力台 1080 Hz。

**对 Reme 的意义**：$L$ 本身要求各段质量与惯量张量、以及三维速度——一个都拿不到。
但"正常运动中 $L\approx 0$"这个**发现**给了一个合法的推理方向：图像中若观测到躯干朝某方向持续、单向、大幅的角速率，
说明存在未被调节的整体转动，是异常信号。**这只支持特征方向，不支持阈值**（他们的条件是平地稳态行走）。

### 2.8 仿人机器人跌倒预测中实际使用的判据

**出处**：S. Kalyanakrishnan, A. Goswami, "Learning to Predict Humanoid Fall,"
*Int. J. Humanoid Robotics* 8(2):245–273, 2011. DOI: [10.1142/S0219843611002496](https://doi.org/10.1142/S0219843611002496)。
已读原文 PDF（[作者主页](https://www.cse.iitb.ac.in/~shivaram/papers/kg_ijhr_2011.pdf)）。

**平台**：Webots 仿真的 ASIMO-like 26-DoF 机器人，质量 42.1 kg，标称质心高 0.59 m，单足 0.225 × 0.157 m。

**状态三分类**：`balanced` / `falling` / `fallen`。`fallen` 的判定规则原文明写：
"whether parts of the robot's body other than its feet are in contact with the ground, **or its CoM falls below some threshold height
(set to 0.33 m in our experiments to determine fallen)**"。

**16 维特征（原文 Table 1）**——全部在**以 CoP 为原点**的笛卡尔系中定义（x 矢状、y 额状、z 垂直）：

| 物理量 | 类型 | 维数 |
|---|---|---|
| CoM displacement（相对 CoP） | 实值 | 3 |
| Linear momentum | 实值 | 3 |
| Angular momentum about CoM | 实值 | 3 |
| Rate of change of linear momentum | 实值 | 3 |
| Rate of change of angular momentum about CoM | 实值 | 3 |
| **Foot contact mode** | 离散，16 类 | 1 |

`Foot contact mode` 的含义：左/右足是否触地，以及 **CoP 落在支撑多边形的内部还是某条边**（LR-INSIDE / LR-FRONT / LR-BACK /
L-LEFT / R-RIGHT / OUTSIDE 等 16 类）。原文对每个 contact mode 单独学一棵决策列表，效果优于把 contact mode 当成一维特征。
其理由原文写得很清楚："It is well known that when the robot starts tipping, the CoP resides at some edge or corner of the support polygon."

**三条与传感器无关、可整套搬走的结构性规则**：
1. **误报兜底规则**："False negatives can be weeded out effectively by adding a rule to predict `falling`
   if the CoM drops below some vertical height threshold (0.48 m for our robot)."
   （0.48 / 0.59 = **0.81**；`fallen` 用 0.33 / 0.59 = **0.56**。两级高度判据。）
2. **`t_height-drop`**：定义为"质心高度开始单调下降直到进入 `fallen` 的时刻"。训练时只把
   $[t_{height\text{-}drop}+\tau^+,\ t_{fallen}]$ 区间内的状态作为正样本，$\tau^+$ 是显式权衡旋钮：
   $\tau^+$ 增大 ⇒ FPR 降、lead time 降；$\tau^+$ 减小（可为负）⇒ 两者都升。
3. **$\tau_{his}$ 去抖**："a history of the predictions made in the past duration of $\tau_{his}$ is maintained.
   At time $t$, `falling` is predicted only if all atomic predictions made in the interval $[t-\tau_{his}, t]$ are `falling`."

**评估协议（强烈建议 Reme 照抄）**：两个目标——
- **FPR**：在 `balanced` 轨迹上误报 `falling` 的轨迹比例（要最小化）；
- **Lead Time $\tau_{lead}$**：$t_{fallen}-t_{predict}$ 在真跌倒轨迹上的均值（要最大化）。
原文明确指出这是一对冲突目标，并且**"prediction accuracy over all the recorded states does not necessarily yield lower FPR and higher $\tau_{lead}$"**。
——这条直接对上 Reme 的产品红线：**不要报"准确率"，报 FPR + lead time 曲线**。

**旁证（一手，未读全文）**：K. Yun, A. Goswami, Y. Sakagami, "Safe Fall: Humanoid robot fall direction change through intelligent
stepping and inertia shaping," *ICRA 2009*。DOI: [10.1109/ROBOT.2009.5152755](https://doi.org/10.1109/ROBOT.2009.5152755)。
（**未读原文，PDF 源 405；仅见二手转述**：其要点为 CoM 位置单独作为判据"给出的跌倒预警太晚，因为没有包含 CoM 速度"，
这与 Hof/Pratt 引入速度项的动机一致。此论断在本文中只作为动机引用，不作为依据。）

### 2.9 传感侧与投影侧的一手约束

**MoveNet.SinglePose 官方 Model Card**（Google，Apache-2.0）：
<https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf>（已读原文 PDF）。

- **输出**：float32 `[1,1,17,3]`，前两通道是 **yx** 坐标，"normalized to image frame, i.e. range in [0.0, 1.0]"，
  第三通道是置信度 [0,1]。关键点顺序与 Reme schema 一致。
- **输入**：Lightning 为 **192×192×3**。
- **推荐置信阈值**：0.3（"A confidence threshold (recommended default: 0.3) can be used to filter out unconfident predictions"）。
- **最要命的一条限制**："The model predicts 17 human keypoints of the full body **even when they are occluded**."
  ⇒ 被家具遮挡的踝/膝会被**编造出来**，只靠低置信度提示。任何依赖踝的支撑判据必须硬门控置信度。
- **适用距离**："Most suitable for detecting the pose of a single person who is **3 ft ~ 6 ft** away from a device's webcam."
  ⇒ 室内固定机位若在 3–5 m，已在标称适用域之外。
- **训练/评估域**：COCO Keypoints + "Active Dataset"（YouTube 健身、瑜伽、舞蹈视频）。
  ⇒ **躺卧、跌倒、老年人室内场景不在训练分布内**，属分布外使用。
- **公平性差距**（COCO val2017 单人集，Lightning 的 keypoint mAP）：Darker 60.5 / Medium 61.2 / Lighter 74.4；
  Old 72.1 / Middle 68.0 / Young 65.6。**肤色组间差距约 14 个 mAP 点**。这对"不得编造准确率"的红线是直接相关的证据：
  任何单一总体指标都会掩盖这个差距。
- **明示不适用**："Any form of surveillance or identity recognition is explicitly out of scope and not enabled by this technology."
  ⇒ Reme 的产品叙事必须避开"监控"框架。

**COCO Object Keypoint Similarity 的每关键点 sigma**（官方 `cocoapi`，`pycocotools/cocoeval.py` 中 `setKpParams`）：
<https://github.com/cocodataset/cocoapi/blob/master/PythonAPI/pycocotools/cocoeval.py>（已读源码）

```python
self.kpt_oks_sigmas = np.array([.26,.25,.25,.35,.35,.79,.79,.72,.72,.62,.62,1.07,1.07,.87,.87,.89,.89])/10.0
```
按 COCO-17 顺序即：nose .026 / eyes .025 / ears .035 / **shoulders .079** / elbows .072 / wrists .062 /
**hips .107** / **knees .087** / **ankles .089**。
OKS 实现为 $e = (dx^2+dy^2)/(2\sigma_i)^2/(2\cdot\mathrm{area})$，$\mathrm{OKS}=e^{-e}$，
即 $\sigma_i$ 是**按 $\sqrt{\mathrm{area}}$ 归一化的标注者不一致度标准差**。

**这组数字对本项目是结构性坏消息**：Reme 最需要的三组点（髋、膝、踝）恰好是标注不确定性最大的三组，
而面部四点（最精确）对平衡毫无用处。**髋 $\sigma=0.107\sqrt{A}$** ——若粗估站立人体轮廓面积 $A\approx 0.12H^2$
（$\sqrt{A}\approx 0.35H$，**此系数为本文估算，非文献值**），则 $\sigma_{hip}\approx 0.037H$，约体高的 **3.7%**。
对照 §2.4：Hof 报告的行走 margin of stability 是体高的 **1.1%–1.7%**。
⇒ **单帧髋点的标注级不确定度已经是整个生理平衡裕度的 2–3 倍。**

**投影几何**：R. Hartley, A. Zisserman, *Multiple View Geometry in Computer Vision*, 2nd ed., Cambridge University Press, 2004,
ISBN 9780521540513，[官方页面](https://www.cambridge.org/9780521540513)。（**未读原书，作为标准教科书引用其公认结论**：
单幅图像的一个像素只确定一条射线，场景结构在无额外约束时无法确定深度；无标定单视图不能恢复米制尺度。）

**二维视频跌倒检测中常用的投影代理量**（作为"业界确实这么做"的一手佐证）：
C. Rougier, J. Meunier, A. St-Arnaud, J. Rousseau, "Robust Video Surveillance for Fall Detection Based on Human Shape Deformation,"
*IEEE Trans. Circuits Syst. Video Technol.* 21(5):611–622, 2011. DOI: [10.1109/TCSVT.2011.2129370](https://doi.org/10.1109/TCSVT.2011.2129370)。
（**未读全文，仅见题录**；此处只用来说明"人体形状形变/长宽比/倾角"这类纯投影量是该领域的既有做法，
**不引用其任何精度数字**。）

---

## 3 在单目 2D COCO-17 下可观测 / 代理 / 不可观测的逐项判定

### 3.0 三条必须先说清的几何前提

在做任何判定前，必须固定成像模型与三个尚未确定的输入事实。它们不是学术细节，是会直接把公式算错的东西。

**(P1) 投影模型**：本文统一采用**弱透视（scaled orthographic）**近似：设被摄者所在深度处的尺度因子为 $k$（图像单位/米），
世界坐标 $x$ 向右、$y$ 向前（远离相机）、$z$ 向上，图像 $u$ 向右、$v$ 向下。
弱透视成立的条件是"人体前后厚度 ≪ 人到相机距离"。室内 3–5 m、人体厚度 ~0.3 m 时相对误差约 6%–10%，可接受；
人走到 1 m 以内时失效。

**(P2) 相机 roll 与 pitch**：
- **roll ≈ 0** 时，世界竖直方向在图像中只有 $v$ 分量。这是本文所有"竖直"论断的前提。
  固定室内机位通常 roll 很小但**必须实测**，或用长期站立姿态的躯干轴中位数自校准。
- **pitch ≈ 0**（光轴水平）时，$\theta_{img}\le\theta_{3D}$ 的单调下界关系成立（见 3.6）。
  **pitch ≠ 0（例如吊装俯视）时该保证失效**：向相机方向的前倾会被放大成更大的图像倾角。

**(P3) 归一化的各向异性（本项目的 schema 缺口，必须解决）**：
MoveNet 的原生输出归一化到 **192×192 的方形输入**。若 A 角色喂的是 letterbox 后的方图，则 x/y 同尺度（各向同性）；
若 A 角色把坐标映射回原始非方帧再各自除以宽/高，则 **x 与 y 的单位不同**（16:9 帧下 x 方向被拉伸 1.78 倍）。
schema 里的 `coordinate_space="normalized_image_top_left"` 说不清是哪一种。
**后果**：任何混用 $\Delta x$ 与 $\Delta y$ 的量（角度、欧氏长度、bbox 长宽比）在两种约定下差 1.78 倍。
**处置**：(a) 要求 A 角色在 schema 增加 `frame_width_px`/`frame_height_px` 或 `pixel_aspect`；
在拿到之前，(b) 所有特征优先构造成**只用 y 分量**或**同轴比值**，这类量对 P3 免疫。
本文 §4 的核心特征就是按这条设计的。

### 3.1 逐项判定汇总表

判定分三档：**(1) 可直接计算** / **(2) 只能得到无量纲投影代理量** / **(3) 完全不可观测，必须放弃**。

| # | 判据 / 量 | 判定 | 说明（代理量是什么、单调性是否保持 / 放弃理由） |
|---|---|---|---|
| A | 倒立摆模型本身（作为框架） | (2) | 框架可借，但假设"CoM 到踝距离 $l$ 恒定"在弯腰/下蹲/坐下时被违反，而这三类正是 Reme 的目标标签。**静态四分类不应建立在倒立摆之上。** |
| B | $\omega_0=\sqrt{g/l}$ | (1)*，但是常数不是测量 | 成人 $\omega_0\approx 3.0\ \mathrm{s^{-1}}$（±6%，见 §2.2）。**不是从图像算出来的，是从人群先验取的常数。** 儿童失效（+25%）。 |
| C | 全身 CoM 位置 | (2) | 代理：髋中点 $c=((x_{11}+x_{12})/2,(y_{11}+y_{12})/2)$，或加权关键点质心。**单调性：站立/坐姿下与真 CoM 近似同向；弯腰时真 CoM 会移出躯干而髋中点不会，单调性破坏。** 且髋点 OKS sigma 最大（0.107）。 |
| D | CoM 速度 $v$ | (2) | 代理：$\hat{v}=\frac{d}{dt}(c/s)$，单位"体尺度/秒"。方向只有图像平面内两个分量，**沿光轴的分量恒为 0（不是"小"，是"结构性缺失"）**。 |
| E | CoM 加速度 $\ddot{x}$ | (2)，实务上禁用 | 二次差分把关键点抖动放大 $\sim f^2$；30 FPS 下要压住噪声必须重滤波，而重滤波会抹掉 $1/\omega_0\approx 0.33$ s 的跌倒特征。**理论上有代理，工程上不可用。** |
| F | Center of Pressure (CoP) | (3) | 无任何力/压力测量。CoP 是力学量，与关键点几何无因果链。|
| F' | CoP 的倒立摆反演 $u=x-\ddot{x}/\omega_0^2$ | (2)"纸面上"，实务判 (3) | Hof 2005 Eq.11 明写"valid only under the conditions of the inverted pendulum model"。三重失效：(i) 弯腰/坐下违反 $l$ 恒定；(ii) 需要真 CoM 而非髋代理；(iii) 见 E 的二次微分噪声。**在 Reme 中按不可观测处理。** |
| G | Base of Support — 侧向（M/L）范围 | (2)，弱 | 代理：$w = |x_{15}-x_{16}|/s$（双踝 x 间距 / 体尺度）。**单调性部分保持**：真实站距增大 ⇒ 代理增大；但人体偏航（yaw）会把它压缩到 0，**侧视时该代理与真实站距完全脱钩**。且真实 BoS 边界在踝外侧 3–5 cm 处，图像上不可见 ⇒ **有未知加性偏移**。 |
| H | Base of Support — 前后（A/P）范围 | (3) | COCO-17 **没有脚跟、脚尖、足内外缘**；且 A/P 方向对正面机位就是深度方向。两重结构性缺失。**放弃。** |
| I | BoS 的严格定义（CoP 可达集） | (3) | Hof 2005 的测法是"扶扶手把 CoP 推到极限画闭环"，本质是力学可达集，图像无从谈起。 |
| J | CoM 与 BoS 的静态关系（"投影在支撑面内"） | (2)，仅 M/L | 代理：$m_{ML}=(c_x - \bar{x}_{ankle})/w$，即髋中点相对双踝中点的横向偏移，以踝间距为分母 ⇒ **同轴比值，对 P3 免疫**。单调性在正面视角下保持，侧视/偏航时崩。 |
| K | XCoM $= x + v/\omega_0$（Hof 2005） | (2)，仅图像平面内 | 代理：$\widehat{\mathrm{XCoM}}_x = \hat{c}_x + \hat{v}_x/\omega_0$，无量纲（体尺度单位）。$\omega_0$ 取 3.0。**单调性在图像平面内保持**（这是精确的线性组合，不含近似）；**A/P 分量整条不存在**。 |
| L | Margin of stability $b=u_{max}-\mathrm{XCoM}$ | (2)，有未知加性偏移 | 分母/边界来自 G 的代理边界，含未知偏移。⇒ **只能作同一机位内的单调相对特征**，**禁止与 Hof 的 2–3 cm 比较**（见 §2.9 的噪声论证）。 |
| M | Temporal stability margin $\tau=b/v$（Hof Eq.9） | (2)，且**尺度不变** | **这是本族里性质最好的量**：$b$ 与 $v$ 同为图像 x 单位，比值单位是**秒**，未知尺度 $k$ 与宽高比同时约掉。仍受 G 的偏移与偏航影响，但受尺度估计误差影响远小于 K/L。**优先采用。** |
| N | Zero Moment Point（严格 ZMP） | (3) | 见 §2.5。两条计算路径（测足底力 / 全身 $\{m,\mathbf{a}_G,\dot{\boldsymbol\delta}_G\}$ + 地面平面 + 重力方向）全缺。**不存在任何可列举失效条件的可行假设。** |
| N' | FZMP（支撑多边形外的"ZMP"） | (3)，且概念上不该要 | Vukobratović & Borovac：FZMP"de facto does not exist"。即使能算也不是物理点。 |
| O | Capture Point / ICP（Pratt 2006 Eq.10） | (2)，等同于 K | 数学上与 XCoM 同式。**决策规则**（CP 是否落在 BoS 内）因 H 而退化为只剩 M/L 一维的弱判断。 |
| P | Capture Region（飞轮扩展） | (3) | 需 $J$、$\tau_{max}$、$\theta_{max}$、$m$、$z_0$。人身上不可测。 |
| Q | N-step capturability margin（Koolen 2012） | (3) | 需要完整的可达集计算，依赖 P 的全部参数。 |
| R | 全身角动量 $\mathbf{L}$（Herr & Popovic Eq.4） | (3) | 需 16 段质量 + 惯量张量 + 三维线/角速度。**放弃。** |
| R' | "整体转动率"的投影代理 | (2)，**单调性不保持** | 代理：躯干轴在图像中的角速率 $\dot{\theta}_{trunk}$（rad/s）。它**不是** $\mathbf{L}$ 的单调函数：重躯干慢转与轻手臂快转可给出相同图像角速率；沿光轴方向的转动完全不可见。**只能作异常指示器，物理依据是"正常运动中 $L\approx 0$"（Herr & Popovic），不得当成 $L$ 的估计。** |
| S | CMP（centroidal moment pivot） | (3) | $x_{CMP}=x_{CM}-(F_x/F_z)z_{CM}$ 需地面反力。 |
| T | 机器人跌倒特征：CoM displacement relative to CoP | (3) | 原点就是 CoP。 |
| U | 机器人跌倒特征：linear momentum | (2) | 质量未知 ⇒ 只剩归一化速度（同 D）。 |
| V | 机器人跌倒特征：angular momentum + 其变化率 | (3) | 同 R。 |
| W | 机器人跌倒特征：foot contact mode（CoP 在多边形哪条边） | (3) | 同 F + H。 |
| X | 机器人跌倒判据：**CoM 高度下降**（K&G 2011 的 0.48/0.59 与 0.33/0.59 两级） | (2)，性质良好 | 代理：$\hat{h}=(\bar{y}_{ankle}-c_y)/s$，即髋中点在踝线之上的归一化高度。**全部是 y 分量与同轴比值 ⇒ 对 P3 免疫**。单调性保持（真实质心下降 ⇒ 代理下降），主要污染源是踝点被遮挡/编造与相机 pitch。**阈值不可搬**（0.81/0.56 是那台机器人的），但**两级结构可搬**。 |
| Y | 机器人跌倒判据：$t_{height\text{-}drop}$（质心高度开始单调下降的时刻） | (1) | 这是对 X 的时序算子，纯定义，不需要额外测量。**可直接实现。** |
| Z | 机器人跌倒判据：$\tau_{his}$ 预测历史去抖 | (1) | 决策规则，与传感器无关。**可直接实现。** |
| AA | 评估协议：FPR + Lead Time 双目标、$\tau^+$ 标签截断 | (1) | 方法论，可直接照搬，且正好对上"不得编造准确率"的红线。 |
| AB | **体段相对重力的三维倾角**（本文推导，见 3.6） | (1)*，在 P1+P2 下 | $\cos\theta_{3D}=|\Delta y_{img}|/(kL)$。**这是唯一一个在 2D 下能恢复出真三维物理角的量**，且只用 y 分量。星号：需要 $kL$ 的可靠估计。 |

### 3.2 为什么 A/P（前后）方向是结构性缺失，而不是"精度差"

对正面固定机位，人体的矢状面（前后倾）方向近似与相机光轴平行。设躯干轴 $\mathbf{v}=(\sin\theta\cos\psi,\ \sin\theta\sin\psi,\ \cos\theta)$
（$\psi$ 为倾斜方位角，$\psi=\pm90°$ 表示纯前后倾）。弱透视、roll=0、pitch=0 时投影为
$$(u,\,v)_{img} = k L\,(\sin\theta\cos\psi,\ -\cos\theta)$$
**图像 x 分量只含 $\cos\psi$**。当 $\psi=\pm90°$（纯前后倾）时图像 x 分量恒为 0，无论 $\theta$ 多大。
所以"人向前倾 60°"和"人站直"在图像 x 上完全不可区分。**这不是噪声，是投影核里的零空间。**
任何"A/P margin of stability"、"A/P capture point"、"前后向 CoM 速度"在本项目中都是不可观测量。

**但是**——图像 y 分量仍然含 $\cos\theta$，与 $\psi$ 无关。这正是 3.6 的出发点：
**前后倾的信息没有消失，它跑到 y 分量（缩短量）里去了，只是丢掉了正负号。**

### 3.3 为什么"用某个假设就能算 ZMP"这类说法不成立

若有人提出"假设人体是绕踝的单刚体倒立摆，则 ZMP = CoP = $x-\ddot{x}/\omega_0^2$"，其完整前提链条是：
1. 已知全身 CoM 的**三维**位置（2D 只有投影，且是髋代理）；
2. 已知 CoM 的**三维**加速度（A/P 分量结构性缺失，见 3.2；且见 E 的二次微分噪声）；
3. $l$ 恒定（弯腰/坐下/下蹲直接违反）；
4. 全身角动量变化率 $\dot{\boldsymbol\delta}_G \approx 0$（Herr & Popovic 只在**平地稳态行走**中验证了这一点；跌倒时正是 $dL/dt$ 大的时刻）；
5. 地面为单一平面且其在相机系中的位姿已知（无标定，未知）；
6. 重力方向在相机系中的姿态已知（roll/pitch 未知）。

**第 4 条尤其致命且自相矛盾**：$\dot{\boldsymbol\delta}_G\approx0$ 恰好是"没在跌倒"的等价条件（Herr & Popovic Eq.6：
$\left.\frac{d\mathbf{L}}{dt}\right|_{hor} = [(\mathbf{r}_{CP}-\mathbf{r}_{CM})\times\mathbf{F}]_{hor}$）。
用"没在跌倒"作为前提去检测跌倒，是循环论证。
**结论：Reme 中不得出现任何形式的 ZMP 估计，包括改名为"稳定点""压力中心估计"的变体。**

### 3.4 尺度 $k$：能不能约掉，以及什么时候约不掉

未知尺度 $k$（图像单位/米）会随人到相机的距离变化。三类特征的表现完全不同：

- **同轴比值型**（如 $\hat{h}=(\bar{y}_{ankle}-c_y)/s$、$m_{ML}=(c_x-\bar{x}_{ankle})/w$）：$k$ 在分子分母同时出现，**一阶约掉**。
  残余误差来自透视非均匀（头部与足部深度不同 ⇒ 有效 $k$ 不同），在 3–5 m 距离下约几个百分点。
- **时间比值型**（如 $\tau=b/v$）：$k$ 与宽高比同时约掉，**结果单位是秒**。最稳健。
- **含 $\omega_0$ 的绝对型**（如 XCoM 偏移量本身）：需要把速度换算成"体高/秒"，因此需要一个体尺度估计 $s$。
  $s$ 估不准就直接线性放大误差。

**体尺度 $s$ 的估计原则（本文提出，基于投影是收缩映射这一事实）**：
弱透视下任意刚性体段的图像长度 $\le kL$，等号在体段平行于像平面时取到。
因此在一个时间窗内取**观测长度的上分位数**（如 90%），比取瞬时值更接近 $kL$。
对**只用 y 分量**的口径，取 $S_y = Q_{0.9}\big(\bar{y}_{ankle}-y_{head}\big)$ 作为"人在该窗口内最直立且最正对时的图像体高"。

**该估计的失效条件**：整个窗口内人都在躺着/深蹲 ⇒ 上分位数严重低估 ⇒ 所有归一化量爆表。
**处置**：$S_y$ 必须带"最近一次可信站立观测"的记忆与老化；若窗口内无可信直立样本，**输出 `unknown`，不要猜**。

### 3.5 时间：$1/\omega_0\approx 0.33$ s 对管线的硬约束

- 人体倾覆的自然时间常数 $1/\omega_0 = 0.30$–$0.36$ s（§2.2）。
- 质心从 0.9 m 自由落体到地面约 0.43 s（$\sqrt{2h/g}$，本文计算）。
- 30 FPS ⇒ 一个时间常数约 10 帧；5–10 Hz 输出 ⇒ 一个时间常数只有 **3–4 个输出样本**。

**推论 1**：任何平滑窗口都必须显著短于 0.33 s。**0.5 s 的滑动平均会把跌倒抹平成"缓慢坐下"。**
**推论 2（schema 缺口）**：JSONL 里有 `smoothed: bool`，但**没有记录滤波器类型与截止频率**。
若 A 角色用了未知带宽的时序平滑，B 角色算出的所有速度类特征都不可解释。
**必须要求 A 角色补充 `smoothing: {type, window_ms | cutoff_hz}`，或提供未平滑的原始序列。**
**推论 3**：5 Hz 输出对 fall_like 判定偏紧；建议**内部以 30 Hz 计算特征与时序状态机，只把决策降采样到 5–10 Hz 输出**，
而不是先降采样再算特征。

### 3.6 唯一能恢复的三维物理量：体段相对重力的倾角

**命题**：在弱透视、相机 roll=0、pitch=0 下，对任意刚性体段（3D 长度 $L$，与世界竖直方向夹角 $\theta$，方位角 $\psi$ 任意），
其图像竖直位移满足
$$|\Delta y_{img}| = kL\cos\theta \quad\Longrightarrow\quad \boxed{\ \cos\theta_{3D} = \frac{|\Delta y_{img}|}{kL}\ }$$

**推导**：世界方向 $\mathbf{v}=L(\sin\theta\cos\psi,\ \sin\theta\sin\psi,\ \cos\theta)$；
roll=0、pitch=0 时图像 $u$ 轴对应世界 $x$、图像 $v$ 轴对应世界 $-z$，弱透视缩放 $k$：
$\Delta u = kL\sin\theta\cos\psi$，$\Delta y_{img} = -kL\cos\theta$。**$\Delta y_{img}$ 与 $\psi$ 无关。**∎

**这条为什么重要**：
- 它给出的是**真三维倾角**，不是"图像里看起来的倾角"。人朝任何方向弯腰、正对或背对相机，结果都一样。
- 它**只用 y 分量** ⇒ 对 §3.0-P3 的宽高比歧义完全免疫。
- 它把"前后倾在图像 x 上不可见"（3.2）这个坏消息，转换成"前后倾表现为体段的竖直缩短"这个可用信号。
- 代价：**丢失符号**——向前倾 30° 与向后倾 30° 给出相同的 $|\Delta y|$。前后方向不可判，这与 3.2 一致。

**失效条件（必须逐条在部署时确认）**：
1. **pitch ≠ 0**：俯视相机下 $\Delta y_{img} = -kL(\cos\theta\cos\phi + \sin\theta\sin\psi\sin\phi)$，重新引入 $\psi$ 依赖。
   $\phi=15°$ 时对 $\theta=45°$ 的角度误差可达十几度。⇒ **必须记录机位俯仰角，或在验证集上按机位标定一个修正表。**
2. **roll ≠ 0**：直接把世界竖直方向的一部分转到图像 x 上。⇒ 需实测，或用长期站立姿态的躯干轴中位数自校准。
3. **弱透视失效**（人离相机 < 1.5 m 或体段深度跨度大）。
4. **$kL$ 估计误差**：这是主要误差源。见 3.4。
5. **关键点被编造**（MoveNet 在遮挡时仍输出全部 17 点）⇒ 必须硬门控置信度。

**尺度自消去的变体（推荐）**：对同一条运动链上的两个体段，$kL_i$ 中的 $k$ 相同，于是
$$\frac{\cos\theta_i}{\cos\theta_j} = \frac{|\Delta y_i|}{|\Delta y_j|}\cdot\frac{L_j}{L_i}$$
只需要**人体测量的长度比值**（无量纲人群先验），完全不需要 $k$。
这给出一组对深度变化免疫的姿态描述子（例如"大腿 vs 躯干的竖直度之比"直接区分坐姿与站姿）。

---

## 4 可直接编码的量与公式（COCO-17 索引）

索引约定：0 nose, 1 L_eye, 2 R_eye, 3 L_ear, 4 R_ear, 5 L_sh, 6 R_sh, 7 L_el, 8 R_el, 9 L_wr, 10 R_wr,
11 L_hip, 12 R_hip, 13 L_knee, 14 R_knee, 15 L_ank, 16 R_ank。
坐标 $(x_i,y_i)\in[0,1]^2$，**y 向下**，置信度 $p_i$。

### 4.0 预处理与门控

```
# 置信门（依据 MoveNet Model Card 推荐值 0.3；本项目建议对承重点更严）
P_MIN_GENERIC = 0.30      # 文献先验（官方 model card）
P_MIN_WEIGHT  = TBD_CAL   # 髋/膝/踝：必须验证集校准，建议起点 0.4–0.5

ok(i) := p_i >= P_MIN
```

派生点（仅当两侧均 ok 时；单侧 ok 时降级并记 degraded）：

```
mid_sh  = ((x5+x6)/2, (y5+y6)/2)
mid_hip = ((x11+x12)/2, (y11+y12)/2)          # CoM 代理 c
ankle_line_y = (y15+y16)/2                     # 地面代理（不是地面）
head_y  = y0                                   # 或 min(y0..y4) 中 ok 的最小值
```

体尺度（**只用 y，免疫宽高比歧义**）：

```
raw_Sy(t) = ankle_line_y(t) - head_y(t)        # 当前帧的图像竖直体高
S_y(t)    = Q90( raw_Sy over window W_scale )  # 投影是收缩映射 -> 取上分位数
                                               # W_scale 建议 3–10 s，必须校准
```

若窗口内没有 $\ge$ N 帧满足"直立且所有承重点 ok"，**S_y 置为不可信 → 该帧输出 unknown**。

### 4.1 体段三维倾角（§3.6 的实现）

需要一组无量纲人体测量比值 $r_i = L_i / H$。
**⚠ 本次调研未从一手表格核实这些数值，禁止凭记忆硬编码。** 两条合规取法：
(a) 从 Winter, *Biomechanics and Motor Control of Human Movement*, "Anthropometry" 章
（[DOI 10.1002/9780470549148.ch4](https://doi.org/10.1002/9780470549148.ch4)，第 5 版 [Wiley](https://www.wiley.com/en-us/Winter's+Biomechanics+and+Motor+Control+of+Human+Movement%2C+5th+Edition-p-9781119827047)）
逐个抄录并在代码注释里标明页码；
(b) 直接在验证集上用"确认直立正对"的帧标定 $r_i$（更推荐——它同时吸收了机位 pitch 的系统偏差）。

```
def seg_cos_theta(a, b, r_seg, S_y):
    """a,b: 体段两端关键点；r_seg: L_seg/H 的人群比值；返回该体段与重力方向夹角的 cos"""
    dy = abs(y[a] - y[b])
    kL = S_y * r_seg
    return clamp(dy / kL, 0.0, 1.0)

cos_trunk = seg_cos_theta(mid_hip, mid_sh, r_trunk, S_y)   # 1=竖直, 0=水平
cos_thighL = seg_cos_theta(11, 13, r_thigh, S_y)
cos_shankL = seg_cos_theta(13, 15, r_shank, S_y)
# 右侧同理；左右取均值或取 ok 的一侧
theta_trunk = acos(cos_trunk)      # 弧度，0=直立，pi/2=水平
```

**尺度自消去变体（推荐并行计算，作为交叉校验）**：

```
ratio_thigh_trunk = (abs(y11-y13)/abs(y11-y5)) * (r_trunk/r_thigh)   # = cosθ_thigh / cosθ_trunk
```

### 4.2 静态四分类的候选特征（standing / sitting / lying / bending_or_crouching）

| 特征 | 公式 | 物理含义 | 判定档 |
|---|---|---|---|
| `trunk_verticality` | $\cos\theta_{trunk}$（4.1） | 躯干与重力夹角（三维） | (1)* |
| `thigh_verticality` | $\cos\theta_{thigh}$ | 大腿与重力夹角（三维） | (1)* |
| `shank_verticality` | $\cos\theta_{shank}$ | 小腿与重力夹角（三维） | (1)* |
| `chain_extension` | $(\bar{y}_{ank}-y_{mid\_sh}) / (S_y\cdot(r_{shank}+r_{thigh}+r_{trunk}))$ | 踝→肩运动链的整体竖直伸展度 ∈[0,1] | (1)* |
| `com_height_norm` $\hat{h}$ | $(\bar{y}_{ank} - c_y)/S_y$ | **CoM 高度的 2D 代理**（K&G 2011 的 CoM-height 判据的移植） | (2) |
| `hip_knee_flexion_proxy` | $\cos\theta_{thigh}$ 与 $\cos\theta_{shank}$ 的联合 | 屈髋/屈膝 | (1)* |
| `stance_width` $w$ | $\lvert x_{15}-x_{16}\rvert / \lvert x_5-x_6\rvert$ | **同轴比值**（踝间距/肩宽），部分抵消偏航 | (2) |
| `ml_com_offset` | $(c_x - \bar{x}_{ank}) / \lvert x_{15}-x_{16}\rvert$ | CoM 代理相对支撑中心的横向归一化偏移 | (2) |

星号 (1)* = 在 §3.0 的 P1+P2 前提与 4.1 的 $r_i$ 标定下可直接计算。

**四类的物理区分逻辑（结构，不是阈值）**：
- standing：`chain_extension` 高、三个 verticality 都接近 1；
- sitting：`trunk_verticality` 高、`thigh_verticality` 低（大腿接近水平）、`shank_verticality` 高、$\hat h$ 中等；
- lying：`trunk_verticality` 接近 0（躯干接近水平）、$\hat h$ 很低、`chain_extension` 低；
- bending_or_crouching：`trunk_verticality` 中低 **或** `thigh_verticality`+`shank_verticality` 同时低（蹲）、$\hat h$ 中低。

**sitting 与 crouching 的天然混淆**：两者的躯干与大腿构型接近，主要差别在小腿竖直度与踝-髋高差；
而"坐在低矮沙发上"与"深蹲"在本特征集下**可能确实不可分** ⇒ 这是 `unknown` 的正当用途，不要用阈值硬拆。

### 4.3 时序特征（normal / fall_like / uncertain transition）

全部在 **30 Hz** 上计算，决策再降采样到 5–10 Hz（§3.5 推论 3）。

```
# 1) CoM 高度代理及其单调下降段（K&G 2011 的 t_height-drop 的直接移植）
h_hat(t) = (ankle_line_y(t) - c_y(t)) / S_y
t_height_drop = 最近一次 h_hat 开始单调下降的时刻（带小容差以抗抖动）
drop_depth    = h_hat(t_height_drop) - h_hat(t)
drop_duration = t - t_height_drop
drop_rate     = drop_depth / drop_duration      # 单位：体尺度/秒，尺度不变

# 2) 时间尺度判别（物理先验，非阈值）
#    自由落体 0.9 m ≈ 0.43 s；倒立摆时间常数 1/ω0 ≈ 0.33 s
#    受控坐下的下降通常显著慢于此 —— 但具体分界必须验证集校准

# 3) 躯干角速率（Herr & Popovic 论证方向，不给阈值）
theta_trunk(t) = acos(cos_trunk(t))
omega_trunk    = d theta_trunk / dt             # rad/s，尺度不变、宽高比免疫

# 4) 侧向时间裕度代理（Hof Eq.9 的 2D 移植，单位：秒，尺度与宽高比全部约掉）
xcom_x_hat = c_x + (d c_x/dt) / OMEGA0          # OMEGA0 = 3.0 s^-1（成人常数，见 §2.2）
b_ml       = (外侧踝 x) - xcom_x_hat            # 注意：含未知加性偏移（真实足外缘不可见）
tau_ml     = b_ml / (d c_x/dt)                  # 秒

# 5) 支撑瓦解指示（H 不可观测的补偿：只做 M/L）
stance_collapse = d(stance_width)/dt            # 站距突然变化

# 6) 持续性门（K&G 2011 的 τ_his，可直接实现）
fire_fall_like  <=>  过去 τ_his 窗口内所有原子判定都是 fall_like
```

**重要提醒**：`tau_ml` 与 `b_ml` 只在**正面机位 + 双踝高置信可见 + 人体正对**时有意义。
其余情形应当直接把它们标为不可用，而不是输出一个坏值。

### 4.4 拒判（unknown）触发条件

必须支持的拒判，逐条对应上文的失效条件：

1. `landmark_quality == "unavailable"` 或 `person_detected == false`；
2. 髋/膝/踝任一侧的承重点置信度 < `P_MIN_WEIGHT` 且对侧也不可用（⇒ §2.9：MoveNet 会编造被遮挡点）；
3. `S_y` 不可信（窗口内无可信直立样本，§3.4）；
4. `raw_Sy / S_y` 过小（人体在图像中过小或极度前后缩短 ⇒ 弱透视与关键点精度同时恶化）；
5. 任一关键点贴在图像边界（$x$ 或 $y$ 落在 $[0,\epsilon]\cup[1-\epsilon,1]$）⇒ 出画，几何量无效；
6. `smoothed == true` 且 A 角色未提供滤波带宽（§3.5 推论 2）⇒ 时序头拒判（静态头可放行）；
7. 特征落在训练分布外（用简单的 Mahalanobis 或 one-class 打分），特别是"躺卧 + 极端俯仰"这类
   MoveNet 官方训练域不覆盖的组合（§2.9）。

---

## 5 阈值与参数：哪些有文献先验、哪些必须验证集校准、哪些禁止硬编码

### 5.1 有文献先验、可以作为**起点**写进代码（须注明出处）

| 参数 | 值 | 出处 | 备注 |
|---|---|---|---|
| `P_MIN_GENERIC` 关键点置信阈 | 0.30 | MoveNet.SinglePose Model Card（官方，"recommended default: 0.3"） | 是模型作者的通用建议，非本任务最优 |
| $\omega_0$ | **3.0 s⁻¹**（成人；范围 2.8–3.2） | Hof et al. 2005 §2.2 的 $l$ 定义 + 该文受试者腿长 0.936/1.06 m，本文换算 | 只对成人有效；儿童 1.10 m 时 3.75，偏 +25% |
| 倾覆时间常数 $1/\omega_0$ | 0.30–0.36 s | 同上 | 用于**设计滤波器带宽与窗口长度**，不用于分类 |
| 自由落体时间尺度 | 0.9 m → 0.43 s | 本文由 $\sqrt{2h/g}$ 计算 | 物理量级参考，非阈值 |
| 关键点噪声量级（髋 $\sigma=0.107\sqrt{A}$、踝 0.089、膝 0.087、肩 0.079） | 见 §2.9 | COCO `cocoeval.py` 官方源码 | 用于**判断某个特征是否在噪声下方**，不是分类阈值 |
| 跌倒判据的**两级高度结构** | 早期告警级 + `fallen` 级 | Kalyanakrishnan & Goswami 2011（其机器人 0.81 / 0.56 的比值） | **结构可搬，数值不可搬** |
| 评估协议 | FPR + Lead Time 双目标；$\tau^+$ 标签截断；$\tau_{his}$ 去抖 | 同上 | 方法论，可整套照搬 |

### 5.2 必须在验证集上校准（且必须按机位分组校准）

| 参数 | 为什么必须校准 |
|---|---|
| 人体测量比值 $r_{trunk}, r_{thigh}, r_{shank}$ | 本次未从一手表格核实；且在验证集上标定可同时吸收机位 pitch 的系统偏差（§4.1） |
| 相机 roll / pitch 修正 | §3.6 失效条件 1、2。每个机位一套 |
| `P_MIN_WEIGHT`（髋/膝/踝的严格置信阈） | 直接决定"编造关键点"的漏网率，与场景遮挡程度强相关 |
| `S_y` 的窗口长度与分位数（0.9?） | 取决于场景中人的活动节律；窗口太长会被姿态变化污染，太短会低估 |
| 四个静态类的所有决策边界 | 依赖 §5.1 的 $r_i$ 标定与机位几何；**不存在通用值** |
| 下降速率 / 下降时长的 fall_like 分界 | 受控坐下 vs 跌倒的时间分界因人（尤其老年人）而异 |
| $\tau_{his}$（持续性窗口长度） | 是 FPR / lead time 的显式旋钮，必须在验证集上画曲线选点 |
| $\tau^+$（训练正样本截断） | 同上；K&G 2011 明写这是权衡参数 |
| `unknown` 的拒判边界（第 4、7 条） | 需要在验证集上按"拒判率 vs 剩余错误率"曲线选点 |

### 5.3 禁止硬编码

1. **任何来自机器人文献的绝对数值**：0.48 m、0.33 m、0.59 m、42.1 kg、足长 0.225 m——这些是那台 ASIMO-like 仿真机器人的，
   与人体无关。只准搬结构，不准搬数字。
2. **Hof 的 margin of stability 数值（2–3 cm）**：见 §2.9，它比髋关键点的标注不确定度还小，
   在本项目里做绝对比较是数值上的自欺。
3. **Herr & Popovic 的角动量阈值（0.05 / 0.03 / 0.01）**：那是归一化全身角动量，本项目算不出这个量；
   把它套到图像角速率上是量纲错误。
4. **任何 bbox 长宽比的"魔法阈值"**（如 w/h > 1 判躺）：它同时依赖机位 pitch、人的朝向、以及 §3.0-P3 的归一化约定，
   三者任一变化都会让阈值失效。若要用，必须走 §3.6 的 $\cos\theta$ 路线并按机位标定。
5. **$\omega_0$ 对儿童 / 使用助行器 / 坐轮椅人群的沿用**：$l$ 的定义前提（绕踝的单刚体倒立摆）不成立。
6. **任何准确率数字**：本调研中的所有论文精度数字（包括 MoveNet 的 mAP）都不是本项目的指标。
   MoveNet Model Card 中肤色组间 14 个 mAP 点的差距，本身就是"单一总体指标会掩盖分组失效"的证据。

---

## 6 对 Reme 的取舍建议与风险

### 6.1 建议采纳

1. **静态四分类不要建立在平衡理论上，要建立在 §3.6 的体段倾角恢复上。**
   standing/sitting/lying/bending 是**运动学构型问题**，不是平衡问题。倒立摆族的假设（$l$ 恒定）在其中三类里是违反的。
   把 §4.1–4.2 的 verticality 特征作为静态头的骨架，是本次调研最实在的产出。

2. **时序头只保留三件事**：
   - `h_hat` 的单调下降段（Y：$t_{height\text{-}drop}$ 算子）+ 下降深度 / 时长 / 速率；
   - 躯干角速率 $\omega_{trunk}$（R'：只作异常指示，物理理由是 Herr & Popovic 的 $L\approx 0$）；
   - $\tau_{his}$ 持续性门（Z）。
   把 `tau_ml`、`b_ml`、`stance_width` 作为**可选增强特征**，且必须带"本帧是否可用"的伴随标志。

3. **内部 30 Hz 计算、5–10 Hz 输出**；所有平滑窗口 < 0.15 s（$\ll 1/\omega_0$）。

4. **整套采用 K&G 2011 的评估协议**：报 FPR vs Lead Time 曲线，不报单一准确率。
   这既是学术上正确的做法，也正好落在"不得编造准确率"的产品红线里侧。

5. **向 A 角色提三条 schema 需求**（按优先级）：
   - (a) `pixel_aspect` 或 `frame_width_px`/`frame_height_px`（解决 §3.0-P3）；
   - (b) `smoothing: {type, window_ms | cutoff_hz}`，或提供未平滑序列（解决 §3.5 推论 2）；
   - (c) 每个 `scene_id` 的机位元数据（俯仰角、安装高度、到活动区距离），哪怕只是人工填的粗值（解决 §3.6 失效条件 1、2）。
   拿不到 (a) 时，B 角色的特征集必须全部走"只用 y 分量 / 同轴比值"路线——§4 已按此设计。

### 6.2 明确放弃（写进设计文档，防止后续被"再想想办法"拉回来）

| 放弃项 | 放弃理由（一句话） |
|---|---|
| ZMP / FZMP | 两条计算路径（足底测力、全身动力学+地面位姿）全缺；且"$\dot{\boldsymbol\delta}_G\approx0$"假设与跌倒检测循环论证（§3.3） |
| CoP（含倒立摆反演） | 力学量，无因果链；反演路径同时踩中模型失效 + 二次微分噪声 + A/P 缺失（§3.1 F/F'） |
| A/P 方向的一切平衡量 | 投影核零空间，不是精度问题（§3.2） |
| BoS 的前后向范围 | COCO-17 无脚跟/脚尖点，且 A/P 即深度（§3.1 H） |
| 全身角动量 $\mathbf{L}$、CMP | 需 16 段质量惯量 + 三维速度 + 地面反力（§3.1 R/S） |
| Capture Region / N-step capturability | 需 $J,\tau_{max},\theta_{max},m,z_0$（§3.1 P/Q） |
| 绝对的 margin of stability 数值 | 生理裕度（体高 1.1–1.7%）小于髋关键点标注不确定度（约 3.7%）（§2.9） |

### 6.3 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| **MoveNet 在遮挡时编造关键点** | 家具后的踝点会给出貌似合理的假支撑几何，导致漏报 | 承重点硬置信门 + `unknown` 优先；在验证集上专门构造"下半身遮挡"子集 |
| **躺卧/跌倒不在 MoveNet 训练分布内** | 恰在最需要可靠的时刻精度最差 | 分布外检测（§4.4 第 7 条）；对 lying 类给更保守的拒判 |
| **肤色分组 14 个 mAP 点的差距** | 系统性分组失效；且与"不得医疗声明"红线叠加会放大伤害 | 验证集必须分组评估；分组指标不达标就不上线该分组，而不是靠总体指标掩盖 |
| **机位 pitch 未知** | §3.6 的三维倾角恢复退化，`lying` 判定尤其敏感 | 每机位标定；无标定的机位降级为只输出 standing/unknown |
| **$S_y$ 在"长时间躺卧"场景崩溃** | 所有归一化量爆表 | 带老化的尺度记忆 + 无可信直立样本即拒判 |
| **A 角色的未知平滑** | 速度类特征不可解释，fall_like 可能被抹平 | 先拿到滤波元数据；拿不到就在时序头拒判 |
| **"坐在矮沙发" vs "深蹲" 本征不可分** | 强行分类会制造系统性错误 | 承认这是 `unknown` 的正当用途；产品文案不承诺区分 |
| **理论术语被误用到产品文案** | 出现"计算了压力中心/稳定裕度"这类不实表述 | 代码与文档统一命名：所有量加 `_proxy` / `_norm` 后缀，禁止出现 CoP/ZMP/MoS 的裸名 |
| **把论文精度当本项目指标** | 直接违反红线 | 本文所有精度数字均已标注为"来源条件下的数字，非本项目指标" |

### 6.4 一句话总结

在单目 2D 归一化 COCO-17 下：**ZMP、CoP、全身角动量、A/P 方向的一切平衡量整条不可观测；
XCoM/Capture Point 只剩图像平面内的无量纲代理且缺 BoS 对照；真正能拿到并且物理正确的，
是体段相对重力的三维倾角（$\cos\theta=|\Delta y|/kL$）与质心高度的归一化下降（K&G 2011 判据的 2D 移植），
再加上两条与传感器无关的决策规则（$t_{height\text{-}drop}$ 与 $\tau_{his}$）——Reme 的分类器应当且只应当建立在这四样东西上。**

---

## 附：一手来源清单（全部可点击）

已读原文（PDF 或正文）：
1. Hof, Gazendam, Sinke (2005), *J. Biomech.* 38(1):1–8. [doi:10.1016/j.jbiomech.2004.03.025](https://doi.org/10.1016/j.jbiomech.2004.03.025)
2. Vukobratović & Borovac (2004), *Int. J. Humanoid Robotics* 1(1):157–173. [doi:10.1142/S0219843604000083](https://doi.org/10.1142/S0219843604000083)
3. Sardain & Bessonnet (2004), *IEEE Trans. SMC-A* 34(5):630–637. [doi:10.1109/TSMCA.2004.832811](https://doi.org/10.1109/TSMCA.2004.832811)
4. Pratt, Carff, Drakunov, Goswami (2006), *IEEE-RAS Humanoids*, 200–207. [doi:10.1109/ICHR.2006.321385](https://doi.org/10.1109/ICHR.2006.321385)
5. Kalyanakrishnan & Goswami (2011), *Int. J. Humanoid Robotics* 8(2):245–273. [doi:10.1142/S0219843611002496](https://doi.org/10.1142/S0219843611002496)
6. Herr & Popovic (2008), *J. Exp. Biol.* 211(4):467–481. [doi:10.1242/jeb.008573](https://doi.org/10.1242/jeb.008573)
7. MoveNet.SinglePose Model Card (Google, Apache-2.0). [PDF](https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf)
8. COCO `cocoapi` / `pycocotools/cocoeval.py`（OKS 与每关键点 sigma 的官方实现）. [GitHub](https://github.com/cocodataset/cocoapi/blob/master/PythonAPI/pycocotools/cocoeval.py)

仅读摘要 / 书目：
9. Hof (2008), *Hum. Mov. Sci.* 27(1):112–125. [doi:10.1016/j.humov.2007.08.003](https://doi.org/10.1016/j.humov.2007.08.003)（摘要全文已读）
10. Koolen, de Boer, Rebula, Goswami, Pratt (2012), *IJRR* 31(9):1094–1113. [doi:10.1177/0278364912452673](https://doi.org/10.1177/0278364912452673)（摘要）
11. Winter (1995), *Gait & Posture* 3(4):193–214. [doi:10.1016/0966-6362(96)82849-9](https://doi.org/10.1016/0966-6362(96)82849-9)（书目 + Hof 2005 中的一手转写）
12. Winter et al. (1998), *J. Neurophysiol.* 80(3):1211–1221. [doi:10.1152/jn.1998.80.3.1211](https://doi.org/10.1152/jn.1998.80.3.1211)（**未读原文，域名 403**）
13. Winter, *Biomechanics and Motor Control of Human Movement*, "Anthropometry" 章. [doi:10.1002/9780470549148.ch4](https://doi.org/10.1002/9780470549148.ch4)（**未读原文**；人体测量比值须回此核对）
14. Goswami (1999), FRI point, *IJRR* 18(6). [doi:10.1177/02783649922066376](https://doi.org/10.1177/02783649922066376)（**未读原文**；Vukobratović 2004 脚注中作为 FZMP 的另一命名提及）
15. Yun, Goswami, Sakagami (2009), *ICRA*. [doi:10.1109/ROBOT.2009.5152755](https://doi.org/10.1109/ROBOT.2009.5152755)（**未读原文，仅见二手转述**）
16. Rougier, Meunier, St-Arnaud, Rousseau (2011), *IEEE TCSVT* 21(5):611–622. [doi:10.1109/TCSVT.2011.2129370](https://doi.org/10.1109/TCSVT.2011.2129370)（**未读原文，仅见题录**）
17. Hartley & Zisserman (2004), *Multiple View Geometry in Computer Vision*, 2nd ed., CUP. [官方页面](https://www.cambridge.org/9780521540513)（标准教科书，引用公认结论）

按项目既有约定，本文**未引用任何 MDPI 或 Frontiers 来源**。
