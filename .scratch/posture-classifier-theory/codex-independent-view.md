# 静态姿态分类器物理判据层：独立第二意见

> 日期：2026-08-01
>
> 输入边界：仅 MoveNet SinglePose Lightning 的 COCO-17 单目 2D 关键点。
>
> 本文没有读取或借鉴仓库中任何既有调研、草稿或同课题分析。

## 先给出测量边界

本文把结论分成三种证据类型：

- **实测事实**：题目给出的 2370 帧 standing 数据；本文不重新声称它能代表其他姿态。
- **文献先验**：人体分段质量、分段质心比例及老年人群人体测量结果。
- **工程假设**：分类角度、拒判边界和置信度门限；均须用未来验证集校准。

单目 2D 可以直接计算的是：像素平面上的点、长度、夹角、顺序、面积、比值、帧间位移，
以及在明确人体分段先验下得到的**图像平面伪质心**。它不能直接给出：米制长度、真实 3D
关节角、身体纵深方向、真实全身质心、支撑面、接触状态、地面反力、CoP、ZMP、关节力矩或
静态平衡裕度。后面任何出现的 `COM2D` 都只指投影/伪质心，绝不等同于 CoP 或 ZMP。

### 坐标与基本量

不能直接在 `(x_norm, y_norm)` 上算角度，因为两个轴的单位分别是图像宽和高。先转为像素：

\[
P_i=(1280x_i,\;720y_i),\quad i=0,\ldots,16.
\]

否则 16:9 的纵横比会系统性扭曲所有角度。这是实现中的硬性前置条件。

定义：

\[
S=(P_5+P_6)/2,\quad H=(P_{11}+P_{12})/2,
\]

分别为肩中点和髋中点。左右侧用

\[
(Sh,El,Wr,Hp,Kn,An)=
\begin{cases}
(5,7,9,11,13,15),&L\\
(6,8,10,12,14,16),&R.
\end{cases}
\]

固定机位如果有滚转，可用 standing 标定段中 `H -> ankle_mid` 单位向量的稳健中位数作为
图像重力方向 `g_hat`；未做该标定时才用 `g=(0,1)`。这只能修正图像滚转，不能恢复相机俯仰
和 3D 地面法向。

对向量 `v` 定义：

\[
\alpha_v=\arccos\frac{|v\cdot \hat g|}{\|v\|}
\]

为与图像竖直方向的锐角；`beta_v = 90° - alpha_v` 为与图像水平的锐角。躯干角
`alpha_T = alpha_(H-S)`。三点内角为 `angle(A,B,C)`，并定义：

\[
f_{knee}=180^\circ-\angle(Hp,Kn,An),\qquad
f_{hip}=180^\circ-\angle(S,H,Kn).
\]

于是投影中完全伸直约为 `0°` 屈曲，直角约为 `90°` 屈曲。二者仍是**投影角**。

---

## 1. 质心估计

### 1.1 我主张的分段表

中心方案采用 de Leva 对 Zatsiorsky–Seluyanov 参数的关节中心化修正。原因是它区分男女、
来自活体 gamma-ray 扫描数据，且端点比原始 Zatsiorsky 骨性标志更接近关键点骨架。
原研究人群是年轻白人大学生，不能宣称适配本项目的老年用户；输入中也没有性别或体型信息，
所以运行时只能取男女表算术中点，并把男女差和替代表作为模型不确定度，而不是猜测性别。

下表 `m` 是全身质量分数；`lambda` 是从近端到远端的环节质心比例。数值来自
[de Leva 1996](https://pubmed.ncbi.nlm.nih.gov/8872282/)，精确表值可与
[Visual3D 的 de Leva 参数表](https://www.has-motion.com/wiki/doku.php?id=visual3d%3Adocumentation%3Adefinitions%3Aadjusted_zatsiorsky-seluyanov_s_segment_inertia_parameters)
交叉核对。

| 环节 | COCO 近端→远端 | 女 `m / lambda` | 男 `m / lambda` | 无性别信息时的中心值 |
|---|---|---:|---:|---:|
| 头颈 | COCO 无正确端点 | 0.0668 / 0.4841 | 0.0694 / 0.5002 | 0.0681 / 0.4922 |
| 躯干 | `S -> H`（近似映射） | 0.4257 / 0.4964 | 0.4346 / 0.5138 | 0.43015 / 0.5051 |
| 上臂，每侧 | `5->7`, `6->8` | 0.0255 / 0.5754 | 0.0271 / 0.5772 | 0.0263 / 0.5763 |
| 前臂，每侧 | `7->9`, `8->10` | 0.0138 / 0.4559 | 0.0162 / 0.4574 | 0.0150 / 0.4567 |
| 手，每侧 | 腕→手远端，远端缺失 | 0.0056 / 0.7474 | 0.0061 / 0.7900 | 0.00585 / 0.7687 |
| 大腿，每侧 | `11->13`, `12->14` | 0.1478 / 0.3612 | 0.1416 / 0.4095 | 0.1447 / 0.3854 |
| 小腿，每侧 | `13->15`, `14->16` | 0.0481 / 0.4352 | 0.0433 / 0.4395 | 0.0457 / 0.4374 |
| 足，每侧 | 踝→足远端，远端缺失 | 0.0129 / 0.4014 | 0.0137 / 0.4415 | 0.0133 / 0.4215 |

中心值总和因小数舍入为 0.99995，编码时最后统一除以实际质量和。

对于存在合法端点的环节 `s`：

\[
C_s=(1-\lambda_s)P_{prox}+\lambda_sP_{dist},\qquad
COM_{2D}=\frac{\sum_s m_s C_s}{\sum_s m_s}.
\]

COCO 的髋点不是髋关节中心、肩点不是完整躯干分割面；因此即使数值来自文献，`S->H` 的
映射仍是工程近似。尤其不能把 de Leva 的头颈比例直接套在 `S->nose` 上：鼻尖不是头顶、
颈椎或耳道端点。头颈中心优先用双耳中点 `(P3+P4)/2` 作为代理；双耳不可用时依次退化为
双眼中点、鼻点，并提高模型不确定度。此代理没有被 de Leva 表验证，属于工程假设。

### 1.2 Dempster/Winter 不是“同一个答案”

Winter 汇编的 Dempster 系数常见值为：头颈 8.1%、躯干 49.7%、每侧上臂 2.8%、前臂
1.6%、手 0.6%、大腿 10.0%、小腿 4.65%、足 1.45%；相应近端质心比例约为头颈
100%、躯干 50%、上臂 43.6%、前臂 43.0%、手 50.6%、大腿 43.3%、小腿 43.3%、
足 50%。可核对 Winter 第 4 章及
[Wiley 书目页](https://onlinelibrary.wiley.com/doi/book/10.1002/9780470549148)。原始
[Dempster 1955 报告](https://deepblue.lib.umich.edu/items/a4869201-0cec-41ee-851c-2b0df68db9a3)
基于 8 名 52–83 岁男性白人尸体，样本同样很窄。

仅比较质量权重，de Leva 男女中点与上述 Winter/Dempster 表的总变差为约 8.94%；因此在
最坏几何布局下，两套权重本身就足以让质心相差最多约 8.94% 的骨架直径，尚未计入端点和
质心比例差异。这是保守数学上界，不是本项目实测误差。面向老年人的 83 人 DXA 研究还发现
年龄、性别和肥胖状态会改变分段质量和质心位置，说明不能把任一通用表当作个体真值：见
[Chambers 等，2010](https://pmc.ncbi.nlm.nih.gov/articles/PMC2820296/)。

建议输出三个量而非一个假精确点：`COM2D_deleva_mid`、男女表产生的包络、以及
`deLeva vs Winter` 敏感性位移。若分类结果会随着表的选择改变，必须 `unknown`。

### 1.3 缺手、缺足时的重归一化偏差

若完全删除双手和双足，de Leva 女表丢失质量 3.70%，男表丢失 3.96%，中心值约 3.83%。
令遗漏质量为 `m_M`、遗漏环节联合质心为 `C_M`，完整质心为 `G`，重归一化结果为 `G_obs`：

\[
G_{obs}=\frac{G-m_MC_M}{1-m_M},\qquad
G_{obs}-G=\frac{m_M}{1-m_M}(G-C_M).
\]

所以偏差方向总是**背离遗漏环节**：正常站立时足和下垂的手通常低于全身质心，重归一化会
把图像质心向上推；手举过头时，遗漏双手反而会向下推。方向不是姿态无关常数。

中心表的放大因子 `m_M/(1-m_M)` 约为 3.98%。若遗漏质心与真实质心最多相隔一个骨架直径
`D`，则 `||G_obs-G|| <= 0.0398 D`；男女端点为约 3.84%–4.12% `D`。按典型站立示意几何
（足在最下、手在躯干下半部）代入上式常得到约 1%–2% 身体投影高度的向上位移，但这只是
量级演算，不是项目实测值，不能写成固定修正量。

比删除后重归一化更好的默认办法是：保留手和足质量，把手质心暂时压在腕点、足质心暂时压在
踝点，并按

\[
u_{missing}\le 2m_{hand}\lambda_{hand}L_{hand}
+2m_{foot}\lambda_{foot}L_{foot}
\]

给出定位误差上界。这样不会把 3.8% 质量重新分摊到躯干和腿上，但会把手/足质心向近端拉；
由于 COCO 没有手长和足长，数值上界仍不确定。两种方法都应在输出中注明。

### 1.4 髋中点是否更稳健

结论分两层：

- 若目标是**真实全身质心**，髋中点不是替代物。手臂、躯干和腿的姿态会让真实质心相对髋部
  移动，误差方向和量级强烈依赖姿态；在没有 3D 真值时该误差不确定。
- 若目标是**分类特征**，髋中点更稳健。双髋是现有数据中 score 最高的点，且髋高、髋膝序、
  髋膝踝构型直接对应 sitting/standing 的关节几何；它没有腕、踝、脸点的低 score 和
  分段质量模型偏差。

在纯随机、各点同方差 `sigma^2` 且所有代理端点都正确的理想模型里，双髋平均的坐标标准差是
`0.707 sigma`；按上表把全部点线性加权，本文映射的 `COM2D` 约为 `0.364 sigma`。所以不能
简单声称“髋中点随机噪声必然更小”。现实优势来自更少的系统假设和更高的关键点可见性，
而不是平均点数。score 未标定，不能把 score 差直接换算成像素误差；真正误差比较需要人工
标注关键点或受控静态重复测量。

我的取舍是：分类核心使用 `H` 和关节几何；`COM2D` 只做一致性/敏感性辅助，绝不作为
standing 与 sitting 的核心分界，更不作为“是否平衡”的判据。

---

## 2. 每个姿态类别的物理判据

### 2.1 通用派生量

每侧定义：

\[
L_{th}=\|P_{Hp}-P_{Kn}\|,\quad L_{sh}=\|P_{Kn}-P_{An}\|,
\]

\[
e=\frac{(P_{An}-P_{Hp})\cdot \hat g}{L_{th}+L_{sh}}.
\]

`e` 是投影腿的竖直伸展比：直腿竖直时接近 1，坐下或蹲下时下降。它是尺度无关的 2D 量，
不是米制髋高。左右可用可靠侧的中位数。

`chair_like` 只表示“投影像典型椅坐构型”，不表示检测到了椅子或支撑力：

\[
chair\_like := \beta_{thigh}\le40^\circ
\land \alpha_{shank}\le30^\circ.
\]

这等价于大腿大致水平、小腿大致竖直。以下数值均是**待校准工程起点**，不是人体姿态的
文献定义。每个不等式还要通过第 6 节的不确定度收紧；落在边界置信区间内一律 unknown。

### 2.2 可执行的高精度、低覆盖判据

| 标签 | 必需的强证据（投影几何） | 力学/解剖学解释 |
|---|---|---|
| `standing` | `alpha_T <= 25°`；可靠侧 `f_knee <= 25°`、`f_hip <= 30°`；`beta_thigh >= 60°`；`e >= 0.75`；两侧可见时 `y_H < y_K < y_A`（带噪声裕量） | 直立时躯干长轴近图像重力方向，髋膝大致伸展，大腿主要贡献竖直高度。不能据此声称足接触地面。 |
| `sitting` | 视角门控通过；`55° <= f_hip <= 125°`；`50° <= f_knee <= 130°`；至少一侧 `chair_like`；`e <= 0.80`；躯干不满足 lying | 典型坐姿的核心是股骨从竖直转为近水平、髋和膝均明显屈曲；“髋低”只是结果，不是核心。这里只覆盖典型椅坐，盘坐、躺椅、伸腿坐应拒判。 |
| `bending_or_crouching` 的 bending 子型 | `alpha_T >= 35°`；`f_hip >= 35°`；可靠侧 `f_knee <= 35°`；腿仍满足髋膝踝向下展开 | 弯腰主要由髋/躯干屈曲产生，膝仍较伸展；与 standing 留出 `25°–35°` 灰区。 |
| `bending_or_crouching` 的 crouching 子型 | 视角门控通过；`f_knee >= 45°`；`f_hip >= 35°`；`e <= 0.75`；且存在非 `chair_like` 的蹲伏证据，例如小腿偏离竖直 `>30°` | 蹲伏通常同时缩短髋踝竖直距离并增加髋膝屈曲。它描述关节构型，不声称支撑力由双足承担。 |
| `lying` | `alpha_T >= 65°`；可靠轴向点 PCA 主轴距水平 `<=25°`；主/次特征值伸长比 `sqrt(lambda1/lambda2) >= 2`；骨架 `y_span/x_span <= 0.60`；至少两个长轴环节与整体主轴一致 | 图像中头—躯干—腿的主要长轴接近水平且整体细长。它只能识别“长轴在成像平面内的横躺样投影”，不能直接检测身体与床/地面的接触。 |

决策不是按优先级强行选类，而是：

1. 先做输入、视角、几何和不确定度门控；
2. 分别计算五类强证据；
3. 恰好一个类别成立才输出该类；零个或多个成立都输出 `unknown`；
4. 使用连续多帧确认，但不能用平滑把矛盾证据掩盖掉。

### 2.3 standing 与 sitting 的核心区分

核心不是质心，也不是绝对髋高，而是：

1. **大腿相对图像重力方向的投影方向**：standing 大腿近竖直，典型 sitting 股骨近水平；
2. **髋、膝投影屈曲角**：standing 接近伸展，sitting 通常形成明显髋屈和膝屈；
3. **髋—膝的竖直关系**：standing 中髋明确高于膝，典型 sitting 中二者接近同高。

题给 standing 数据中大腿与水平夹角最小 73.7°、`髋<膝<踝` 100% 成立，正好支持前两项
几何的 standing 一侧；但它不能证明 sitting 阈值的特异性。

### 2.4 bending/crouching 与 sitting 为什么不能总是分开

弯腰子型较容易：膝仍伸展而躯干明显前倾，与典型 sitting 的双关节屈曲不同。

蹲伏与坐姿则存在不可消除的观测等价：一个深蹲者和一个坐在无靠背凳上的人可以有几乎相同的
`S,H,K,A` 投影。区别在于外部接触和支撑力分配——椅面承重还是双足承重——而输入没有椅子、
足部轮廓、深度或力。不能用 `COM2D` 是否落在两个踝之间替代这个缺失信息，因为踝不是足底
支撑多边形，图像投影也丢失纵深。

因此只能识别两个保守子集：典型“水平大腿+竖直小腿”为 sitting 强证据；明显胫骨倾斜并伴
髋膝屈曲/髋低为 crouching 强证据。两套证据重叠、都不成立，或疑似深蹲与坐姿同构时必须
`unknown`。这是可观测性限制，不是再调一个阈值就能解决的问题。

### 2.5 lying 朝相机纵深方向时的失效

若人从头到脚沿光轴躺下，身体纵轴会严重前缩：肩髋距离、髋膝距离和整体长宽比缩小，PCA
方向可能由肩宽或噪声主导。此时上述 lying 判据会假阴性；更危险的是紧凑投影可能像坐姿、
蹲姿甚至坏关键点。

单个 2D 投影对应多个可能 3D 姿态是单目 3D 姿态估计的固有歧义，参见
[Nie 等，ICCV 2017](https://openaccess.thecvf.com/content_iccv_2017/html/Nie_Monocular_3D_Human_ICCV_2017_paper.html)。
正确行为不是放宽 lying 阈值，而是利用第 4 节的环节前缩和 PCA 退化门控输出 `unknown`。

---

## 3. 阈值：来源、校准与当前可行方案

### 3.1 有文献先验的量

1. 第 1 节 de Leva/Zatsiorsky 和 Winter/Dempster 的质量分数与环节质心比例。
2. 老年人 DXA 数据中的环节长度分布。Chambers 等的 83 人数据中，各亚组平均值大致为：
   上臂 19.82%–20.78% 身高、前臂 15.74%–16.49%、大腿 26.68%–27.28%、小腿
   23.65%–24.45%。这些值可用于“端点明显不可能”的宽松核查，但 COCO 端点、2D 投影和
   论文解剖端点并不完全相同，不能直接当成分类阈值。
3. 第 6 节由一阶不确定度传播得到的“段长相对噪声”门限。其方法依据
   [JCGM 100:2008 GUM](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf)，
   但允许多少角度误差仍是项目选择。

本文**没有找到可合法迁移成这五类标签边界的通用生物力学文献阈值**。人体工效学中的躯干
倾角区间针对负荷/暴露风险，不等于 standing、sitting、bending、lying 的分类定义，硬套会
造成概念错误。

### 3.2 必须由验证集校准的量

- 表 2.2 中所有 `25°/30°/35°/40°/45°/55°/60°/65°/125°/130°` 角度；
- `e` 的 0.75、0.80；PCA 伸长比 2 和 `y_span/x_span` 的 0.60；
- 第 4 节视角质量的 0.5/0.8；
- score 与像素误差的映射、每个关键点的 `sigma`；
- 左右不对称和帧间跳变阈值；
- 连续确认帧数、灰区宽度和类别证据组合。

这些数字在本文只充当可执行的**影子模式起点**，不得据此宣称准确率或上线能力。

### 3.3 根本不该设阈值的量

- `COM2D` 相对踝点是否“在支撑面内”：没有足、深度或接触面。
- ZMP、真实 CoP、地面反力、关节力矩：输入不可观测。
- raw score 是否大于 0.5 就“可信”：score 未标定，且现有末端均值约 0.47–0.52。
- 绝对像素髋高：受身高、距相机距离、相机俯仰和透视影响；题给 44 px 只描述本视频。
- 任意单帧 2D 角是否等于真实 3D 关节角。
- 一条硬边界强制区分观测等价的深蹲和坐姿。

### 3.4 没有多类别验证集时的可行方案

当前只能合法地做**一类 standing 接受器**：

- 从 2370 帧估计每个关键点的像素抖动、standing 特征分布和固定机位图像重力方向；
- standing 上界用数据分位数与传播不确定度，例如
  `T_alpha = Q_0.995(alpha_T) + 2 * median(u_alpha)`；
- standing 大腿下界用
  `T_beta = Q_0.005(beta_thigh) - 2 * median(u_beta)`；
- 订单、髋高和骨长只用于检测“是否仍像该 standing 域”；超出时输出 unknown，而不是推断为
  另一个类别。

题给 `alpha_T max=13.7°`、大腿角 `min=73.7°`、竖直序 100% 和髋高漂移 44 px 可作为上述
一类边界的已知锚点，但仍要从原 JSONL 计算分位数和噪声，不能只用最大/最小值定阈值。

然后建立最小验证集，而不是训练分类器：本地拍摄、明确同意、固定机位，按 posture × 相机方位
× 人员 × 遮挡/服装分层；逐帧或片段标注“可判/不可判”，尤其纳入伸腿坐、靠躺、深蹲、弯腰、
朝光轴躺等困难负例。先校准拒判覆盖和每类混淆，再冻结阈值。3D 合成投影可做性质测试和寻找
反例，但不能替代真实多类别验证。验证完成前，其他四类只能在日志中产生 `candidate_*`，对外
仍返回 `unknown`。

---

## 4. 视角与前缩处理

### 4.1 肩宽/躯干长的弱透视方位代理

令

\[
r=\frac{\|P_5-P_6\|}{\|S-H\|},\qquad r_0=0.85.
\]

`r0=0.85` 是题目给出的正面人体测量学期望，不是本文新增文献值。弱透视、躯干近似在成像
平面、人体比例正确且肩点无偏时，设 `psi=0°` 为正面、`90°` 为完全侧面：

\[
q_{front}=clip(r/r_0,0,1),\quad
\hat\psi=\arccos q_{front},\quad
q_{sag}=\sin\hat\psi=\sqrt{1-q_{front}^2}.
\]

`q_sag` 近似表示人体前后方向投到图像水平轴后还保留多少幅度：正面时接近 0，侧面时接近
1。实测 `r=0.12` 时，`q_front≈0.141`、`psi≈81.9°`、`q_sag≈0.990`，说明该视频对矢状面
髋膝构型几何上有利；同时双肩投影重合，肩点自身可能更易遮挡。

该公式只是代理。透视、躯干扭转、肩部遮挡、个体肩宽、衣服及躯干前后倾都会破坏假设。
误差近似为

\[
u_\psi\approx\frac{u_r}{r_0\sqrt{1-(r/r_0)^2}},
\]

可见在接近正面时角度估计本身也病态；`r > r0` 不应被简单截断后视为 0°，而应标记模型
不一致。

### 4.2 变成置信度折扣/拒判

对依赖矢状面构型的 sitting、bending、crouching 特征：

\[
C_{class}=C_{keypoint}\,C_{angle}\,q_{sag}\,q_{segment}.
\]

其中：

- `C_angle = exp(-(1.96*u_angle/delta_budget)^2)`；`delta_budget` 是允许的 95% 角度半宽；
- `q_segment` 是所需环节前缩质量的最小值；
- `C_keypoint` 必须来自 score→误差标定或实测抖动，不能直接把 raw score 当概率。

初始影子模式规则：`q_sag < 0.5` 时拒绝所有依赖矢状面的类别；`0.5–0.8` 线性折扣；
`>=0.8` 不再因该项折扣。0.5 表示矢状位移仅保留一半，是工程可观测性选择，不是文献阈值。

### 4.3 环节自身朝光轴的前缩

肩宽只能估计躯干方位，不能保证股骨或身体纵轴没有朝光轴。对同一固定机位、同一人的每根刚性
环节 `b`，从 standing 标定或以后受控动作取“可靠最大投影长度” `L_b_ref`，并去除人员前后
移动导致的整体尺度 `a_t`：

\[
q_b=clip\left(\frac{L_b(t)}{a_tL_{b,ref}},0,1\right),\qquad
\hat\eta_b=\arccos q_b.
\]

在弱透视和 `L_b_ref` 真正接近面内长度时，`eta_b` 是该环节离开成像平面的代理角。若没有可靠
参考长度或无法估计 `a_t`，`eta_b` 不确定，只能使用第 6 节的段长/噪声门控。建议
`q_b < 0.5` 直接令涉及该环节的角度不可用；这同样是待验证工程门限。

lying 还需额外要求 PCA 伸长比和身体纵向链长度不过度缩短。朝相机方向躺下会同时让这些量
失败，正确结果是 unknown。

---

## 5. unknown：可运行的几何自洽性检验

### 5.1 检验顺序

1. **输入合法性**：恰有 17 点；坐标和 score 有限且在 `[0,1]`；转成像素后没有明显重复的
   非相邻关节；时间戳/FPS 连续。失败即 unknown。
2. **特征可计算性**：所需环节长度通过第 6 节门控，夹角分母非零；否则对应类别不可用。
3. **个人骨长/人体测量一致性**。
4. **左右、竖直拓扑和时间连续性**。
5. **视角/前缩门控**。
6. **类别互斥性**：恰好一个强证据成立才出标签。

### 5.2 骨长比例

对每根骨段建立个人参考：standing 标定中位数 `L_b_ref` 和稳健尺度
`s_b = 1.4826*MAD(L_b)`。固定机位下先用多个未前缩环节的中位倍率估计全局尺度 `a_t`，再算

\[
z_b=\frac{L_b(t)-a_tL_{b,ref}}
{\sqrt{s_b^2+u_{L_b}^2}}.
\]

初始规则：`|z_b| > 4` 视为坏点/尺度异常；长度缩短但未超出统计门限时，不称为“骨头变短”，
而是降低 `q_b` 并拒绝相关角度。`4` 是保守异常检测起点，不是人体测量文献阈值。

只有在两段都通过 `q_b >= 0.8` 的面内门控时，才应用老年人 DXA 的宽松比例核查：

\[
0.84\le L_{upperarm}/L_{forearm}\le1.92,
\]

\[
0.84\le L_{thigh}/L_{shank}\le1.49.
\]

这些区间是用 Chambers 表中各亚组均值和最大组内标准差构造的保守约三标准差包络，再向外
舍入；不是原论文直接给出的“正常范围”，因此仍属工程派生值。端点定义不同、种群不同或透视
前缩都会导致越界；越界的含义是“当前 2D 骨架不适合本判据”，不是人体异常或医疗判断。

重要限制：任一 3D 骨段投向光轴时，2D 长度可以任意接近零，因此在没有面内门控时，根本不
存在普适的 2D 骨长比下界。

### 5.3 左右对称性

对同名环节：

\[
A_b=\frac{|L_{b,L}-L_{b,R}|}{(L_{b,L}+L_{b,R})/2}.
\]

阈值优先取该人的 standing 分布 `Q_0.995(A_b)+2u_A`。无标定时可暂用 `A_b <= 0.25`；
25% 很宽，只用于发现左右点串位/严重遮挡，不是解剖学正常值。若一侧明显朝光轴，左右投影本来
就不对称，应降级为“该侧不可用”而不是断言骨架错误。左右肩、髋的连接线若瞬间互换方向且
人物没有转身，也应触发时间异常。

### 5.4 竖直序关系是类别条件，不是全局人体规则

standing 和 bending 子型要求每个可靠侧：

\[
(P_{Kn}-P_{Hp})\cdot\hat g > 2u_y,
\quad
(P_{An}-P_{Kn})\cdot\hat g > 2u_y.
\]

题给 standing 中 `髋<膝<踝` 100% 成立，可用于本机位的一类核查。sitting 可允许髋膝近同高，
lying 会整体破坏该顺序；因此顺序失败只能否决 standing/bending 证据，不能单独把任何合法
sitting/lying 帧判为 unknown。

### 5.5 时间连续性

对点 `i` 用三帧常速度残差：

\[
r_{i,t}=P_{i,t}-\frac{P_{i,t-1}+P_{i,t+1}}{2}.
\]

若三帧噪声独立同方差，则 `Var(r)=1.5 sigma_i^2`。用 standing 中每坐标的 MAD 估计
`sigma_i = 1.4826*MAD(r_i)/sqrt(1.5)`；真实加速度会让这个估计偏大，因此它是保守起点。
对残差按估计协方差白化，平方 Mahalanobis 距离大于 `9.21` 可作为二维高斯假设下 99% 的
统计门；但因为人体运动并非恒速，生产门限仍须用有动作的验证集校准。

在线因果实现可用 `P_hat_t=2P_(t-1)-P_(t-2)` 的创新替代。任何单点跳变时，不应让滤波后的
坐标悄悄通过；应保留 `raw_invalid` 并令使用该点的类别 unknown。静态标签可暂要求 5 个连续帧
都通过（30 FPS 下约 167 ms），这是去抖工程值，不是告警持续时间或安全政策。

### 5.6 score 的处理

score 均值最高仅约 0.72、末端约 0.47–0.52，且未经标定。因此：

- 不设置统一 `score >= 0.5` 硬门；
- 先在人工标注小集上拟合 `score, 部位, 遮挡状态 -> 像素误差分位数`；
- 标定前只把 score 用作同一关键点的相对排序，并以时间抖动/骨长残差给出误差上界；
- 关键点的误差上界不能满足第 6 节角度预算时，相关类别 unknown。

### 5.7 可编码决策伪代码

```text
P = pixels(keypoints, width=1280, height=720)
if not input_is_valid(P): return unknown

U = estimate_keypoint_uncertainty(P_history)  # 不是 1-score
F = geometry_features(P, gravity_from_standing_calibration)

available = length_and_angle_uncertainty_gates(F, U)
available &= personal_length_consistency(F)
available &= viewpoint_and_foreshortening_gates(F)

matches = []
if available.standing and standing_strong(F, U): matches += [standing]
if available.sitting and sitting_strong(F, U): matches += [sitting]
if available.bending and bending_strong(F, U): matches += [bending_or_crouching]
if available.crouching and crouching_strong(F, U): matches += [bending_or_crouching]
if available.lying and lying_strong(F, U): matches += [lying]

matches = unique(matches)
if len(matches) != 1: return unknown
if not temporally_confirmed(matches[0], raw_valid=True, frames=5): return unknown
return matches[0]
```

比较带不确定度的特征时，`f <= T` 只有在 `f + 1.96*u_f <= T` 时才算强证据；`f >= T` 只有
在 `f - 1.96*u_f >= T` 时成立。置信区间跨阈值就进入灰区。

---

## 6. 误差传播：像素噪声到角度不确定度

### 6.1 单段方向角

设向量 `v=B-A`、投影长度 `L=||v||`，两端独立各向同性像素标准差分别为 `sigma_A`、
`sigma_B`。对 `atan2` 做一阶 Taylor 传播：

\[
u_\theta\approx\frac{\sqrt{\sigma_A^2+\sigma_B^2}}{L}
\quad\text{radian}.
\]

同噪声时 `u_theta≈sqrt(2)*sigma/L`。这是小噪声近似；当 `L` 与噪声同量级、误差有偏或两点
相关时应改用 Monte Carlo，并直接拒判短段。

### 6.2 三点关节角

令 `L1=||A-B||`、`L2=||C-B||`，内角为 `phi`。独立各向同性误差的一阶结果为：

\[
u_\phi^2\approx
\frac{\sigma_A^2}{L_1^2}+
\frac{\sigma_C^2}{L_2^2}+
\sigma_B^2\left(
\frac{1}{L_1^2}+\frac{1}{L_2^2}
-\frac{2\cos\phi}{L_1L_2}
\right).
\]

共享顶点 `B` 的误差不能被当成两条独立线段角度误差简单相加。若 `L1=L2=L` 且三点同噪声，
直线附近 `u_phi≈sqrt(6)*sigma/L`，直角附近约为 `2*sigma/L`。

### 6.3 多短才不可信

不存在与分辨率无关的固定像素长度。给定 95% 角度半宽预算 `delta`：

\[
L\ge\frac{1.96\sqrt{2}\sigma}{\delta}
\]

是单段方向角的最低长度；等长且接近伸直的关节更保守地要求

\[
L\ge\frac{1.96\sqrt{6}\sigma}{\delta}.
\]

`delta` 用弧度。若预算为 10°，单段约需 `L>=15.9 sigma`，伸直关节每段约需
`L>=27.5 sigma`。例如 `sigma=4 px` 时分别约为 64 px 和 110 px；这只是公式代入示例，
不是本项目已测噪声。若允许 15°，要求会按 `10/15` 比例下降。项目应先从 standing 序列或
人工标注求每个点的 `sigma`，再动态决定角度是否可用。

### 6.4 最小 NumPy 实现

下面代码仅实现可核查的几何与一阶误差，不把工程阈值包装成已验证分类器。

```python
from __future__ import annotations

import math

import numpy as np
from numpy.typing import NDArray

FloatArray = NDArray[np.float64]


def to_pixels(keypoints: FloatArray, width: int = 1280, height: int = 720) -> FloatArray:
    """Return a copy shaped (17, 3), with x/y converted to pixels."""
    if keypoints.shape != (17, 3):
        raise ValueError("expected keypoints with shape (17, 3)")
    result: FloatArray = np.asarray(keypoints, dtype=np.float64).copy()
    result[:, 0] *= float(width)
    result[:, 1] *= float(height)
    return result


def point(keypoints_px: FloatArray, index: int) -> FloatArray:
    """Return the two-dimensional pixel coordinate for one COCO keypoint."""
    return keypoints_px[index, :2]


def angle_deg(a: FloatArray, b: FloatArray, c: FloatArray) -> float:
    """Return the unsigned interior angle ABC in degrees."""
    ba: FloatArray = a - b
    bc: FloatArray = c - b
    denominator = float(np.linalg.norm(ba) * np.linalg.norm(bc))
    if denominator <= 0.0:
        raise ValueError("angle is undefined for a zero-length segment")
    cosine = float(np.dot(ba, bc)) / denominator
    return math.degrees(math.acos(max(-1.0, min(1.0, cosine))))


def segment_angle_sd(length_px: float, sigma_a_px: float, sigma_b_px: float) -> float:
    """Return the first-order segment-angle standard uncertainty in radians."""
    if length_px <= 0.0:
        raise ValueError("length_px must be positive")
    return math.hypot(sigma_a_px, sigma_b_px) / length_px


def joint_angle_sd(
    length_ab_px: float,
    length_cb_px: float,
    angle_rad: float,
    sigma_a_px: float,
    sigma_b_px: float,
    sigma_c_px: float,
) -> float:
    """Return first-order uncertainty for angle ABC, in radians."""
    if length_ab_px <= 0.0 or length_cb_px <= 0.0:
        raise ValueError("segment lengths must be positive")
    variance = (sigma_a_px / length_ab_px) ** 2
    variance += (sigma_c_px / length_cb_px) ** 2
    variance += sigma_b_px**2 * (
        1.0 / length_ab_px**2
        + 1.0 / length_cb_px**2
        - 2.0 * math.cos(angle_rad) / (length_ab_px * length_cb_px)
    )
    return math.sqrt(max(0.0, variance))


def sagittal_observability(shoulder_ratio: float, frontal_ratio: float = 0.85) -> float:
    """Return the weak-perspective sagittal projection factor in [0, 1]."""
    if frontal_ratio <= 0.0 or shoulder_ratio < 0.0:
        raise ValueError("ratios must be non-negative and frontal_ratio positive")
    front = max(0.0, min(1.0, shoulder_ratio / frontal_ratio))
    return math.sqrt(max(0.0, 1.0 - front**2))
```

---

## 7. 三个最可能的致命设计错误

### 错误一：把归一化坐标或 2D 投影当成真实人体几何

直接对 `(x_norm,y_norm)` 算角度会先引入 1280:720 的轴尺度错误；即使改成像素，单目投影仍
没有深度。把投影膝角称作真实膝角、把朝光轴躺下漏掉、把短投影骨段解释成异常，都会让整个
物理层建立在错误量纲上。

### 错误二：用不可观测的“力学”概念制造确定性

拿 `COM2D` 与两个踝的关系冒充支撑面、CoP、ZMP 或稳定性，再用它区分坐下和深蹲，是最危险
的概念偷换。COCO 没有足底接触和外部支撑，单目也没有地面反力；坐姿与深蹲在 2D 关节构型
上可以完全同形。正确答案必须允许 unknown。

### 错误三：在只有 standing 数据时“调出”五分类阈值并报告性能

standing 的最大/最小值只能支持一类接受域，不能证明 sitting、lying、bending/crouching
边界的特异性。尤其把未标定 score 当概率、把当前侧视机位阈值推广到正面/纵深姿态、隐藏
灰区或强制 argmax，都会产生没有证据的多类能力。验证前应只开放 standing/unknown，其余
类别保留影子候选。

---

## 参考资料

1. de Leva, P. (1996). *Adjustments to Zatsiorsky-Seluyanov's segment inertia
   parameters*. Journal of Biomechanics, 29(9), 1223–1230.
   [PubMed 与 DOI](https://pubmed.ncbi.nlm.nih.gov/8872282/)。
2. Zatsiorsky, V. M., & Seluyanov, V. N. (1983/1990). 活体 gamma-ray 扫描的分段质量与惯性
   参数；本文使用 de Leva 调整后的表值，不单独声称原始骨性端点可直接映射 COCO。
3. Winter, D. A. (2009). *Biomechanics and Motor Control of Human Movement*, 4th ed.,
   Chapter 4. [Wiley](https://onlinelibrary.wiley.com/doi/book/10.1002/9780470549148)。
4. Dempster, W. T. (1955). *Space Requirements of the Seated Operator*, WADC TR 55-159.
   [University of Michigan 原始报告](https://deepblue.lib.umich.edu/items/a4869201-0cec-41ee-851c-2b0df68db9a3)。
5. Chambers, A. J., Sukits, A. L., McCrory, J. L., & Cham, R. (2010). *The effect of
   obesity and gender on body segment parameters in older adults*. Clinical Biomechanics,
   25(2), 131–136. [PMC 全文](https://pmc.ncbi.nlm.nih.gov/articles/PMC2820296/)。
6. JCGM (2008). *Evaluation of measurement data — Guide to the expression of uncertainty
   in measurement*, JCGM 100:2008. [BIPM PDF](https://www.bipm.org/documents/20126/2071204/JCGM_100_2008_E.pdf)。
7. Nie, B. X., Wei, P., & Zhu, S.-C. (2017). *Monocular 3D Human Pose Estimation by
   Predicting Depth on Joints*. ICCV 2017.
   [CVF Open Access](https://openaccess.thecvf.com/content_iccv_2017/html/Nie_Monocular_3D_Human_ICCV_2017_paper.html)。

## 核心结论摘要

- 当前输入能实现的是带不确定度和拒判的**2D 投影几何分类器**，不是 3D 动力学或平衡分析。
- standing 与典型 sitting 的核心分界是投影大腿方向及髋/膝屈曲，不是质心或绝对髋高。
- bending 可由“躯干/髋屈而膝较伸”识别；deep crouch 与 sitting 若 2D 同构，必须 unknown。
- lying 只在身体纵轴位于成像平面时可靠；朝光轴躺下会前缩，必须由长度/PCA 门控拒判。
- `COM2D` 应使用显式人体测量表并输出模型敏感性。缺手足后直接重归一化最多可造成约 4% 骨架
  直径的系统偏移；分类核心更适合使用高可见性的髋中点和关节拓扑。
- 没有多类别验证集时，只能开放 standing/unknown；其他阈值先以影子模式采集证据。
- 三个最致命错误是：**把非等尺度归一化坐标/2D 投影当真实几何；把伪质心冒充 CoP/ZMP/支撑
  力学；用 standing-only 数据伪造五分类阈值和性能。**
