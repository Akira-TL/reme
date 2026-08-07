# 姿态时间序列的状态估计、滞回与生理可行的转移约束

- Type: research-note（实现前置理论调研）
- Date: 2026-08-01
- Scope: A 角色 `FrameLandmarks`（MoveNet SinglePose Lightning / COCO-17 / normalized image coords / 30 FPS 单目固定机位）→ `PostureObservation` + `TransitionEvent` 的时序状态估计层
- 排除来源约定: 不引用 MDPI、不引用 Frontiers
- 产品红线: 不编造准确率、不做医疗声明、证据不足必须拒判

> 阅读顺序建议：先读 §3（可观测性判定）再读 §4（公式）。§3 是本次调研的核心产出——它决定了 §4 里哪些量允许出现在特征向量里。

---

## 1 结论摘要（5 条）

1. **30 FPS 单目 2D 能观测跌倒的"下降相"，不能观测"冲击相"。** 真实跌倒从下降开始到骨盆撞地的中位时长为 583 ± 255 ms（Choi et al., *J Biomech* 2015），@30 FPS ≈ 17.5 帧，完全可采样；但在同样是 30 FPS 单目视频 + 姿态估计的实证研究里，髋部**速度**估计误差 7.28 ± 5.21%，髋部**加速度**估计误差 26.3 ± 19.4%，且对 >3.0 g 的冲击系统性低估 21.4%（Sci Rep 2025, DOI 10.1038/s41598-025-85934-y）。**结论：`fall_like_transition` 必须建立在位形 + 速度特征上，任何基于"加速度峰值 / 冲击强度"的判据在本项目输入下都是伪特征，必须删除。**

2. **时间平滑必须分两层，且两层不能互相替代。** 观测层（几何量的中值 + Savitzky–Golay/零相位低通）负责压制关键点飞点与微分噪声放大；标签层（受约束 Viterbi + 滞回 + 最小驻留）负责压制标签抖动（action segmentation 文献称 over-segmentation，Abu Farha & Gall, CVPR 2019）。只做观测层平滑会留下边界处的高频标签翻转；只做标签层平滑会把飞点带来的错误证据固化成"稳定的错标签"。

3. **生理可行的转移矩阵只能编码"顺序约束"和"时间下界"，不能编码"时长即语义"。** 受控 standing→lying 与真实跌倒 descent 的时长分布**重叠**（受控起立半周期量级 1.1–1.5 s，由 Bohannon 2006 的 5 次坐立参考值反推；跌倒 descent 583 ± 255 ms，Choi 2015 的 +1.6σ 已经接近 1.0 s）。因此转移矩阵里只能硬编码"standing 与 lying 之间不存在单帧直达路径"，而**区分受控 vs 跌倒必须靠速度峰值形状 + 中间状态驻留时长，不能靠总时长阈值**。

4. **归一化图像坐标下没有米制尺度，所有速度阈值必须做体长归一化并在验证集上校准。** 文献里的绝对阈值（如 Bourke et al. 2008 的躯干垂直速度 −1.3 m/s）在本项目输入下**不可直接使用**——没有内参、没有深度、没有像素/米换算。它们只能作为量级参照（换算见 §5.4）。所有阈值都是"场景参数"而不是"人体参数"：换一个机位俯仰角，θ_trunk 的分界就变。

5. **拒判是一等公民，且必须用分布无关的方法而非 softmax 阈值。** 现代分类器的 confidence 本身不是校准概率（Guo et al., ICML 2017）；Chow (1970) 的最优拒判规则需要真后验，我们没有。可实施方案是 label-conditional（Mondrian）split conformal（Vovk 2012；Angelopoulos & Bates 2021）：在**按场景分组切分**的校准集上给每类算分位数，预测集为空 → `unknown`。必须显式声明：帧序列强相关，破坏 exchangeability，覆盖保证只在"片段级/场景级"意义上近似成立（Barber et al., *Ann. Statist.* 2023）。

---

## 2 理论与一手文献

每小节格式：**论断 → 出处 → 原始条件（该结论成立所依赖的实验/传感条件）**。

### 2.1 序列标签的时间平滑：HMM / Bayes 滤波 / CRF

#### 2.1.1 HMM 与 Viterbi 解码

**论断**：把逐帧分类器的输出当作 HMM 的观测似然、把姿态类别当作隐状态，用带转移先验的 Viterbi 解码，可以在"最大化整段序列联合概率"的意义上消除孤立的单帧翻转。转移矩阵中把不可能的转移设为 −∞ 就是硬约束的实现方式。

**出处**：Rabiner, L.R. (1989). *A Tutorial on Hidden Markov Models and Selected Applications in Speech Recognition*. Proceedings of the IEEE 77(2):257–286. DOI [10.1109/5.18626](https://doi.org/10.1109/5.18626)

**原始条件**：
- 一阶马尔可夫（下一状态只依赖当前状态）；
- 观测在给定状态下条件独立（**本项目严重违反**：相邻帧的关键点强相关，所以 HMM 的"证据量"会被高估，等价于转移惩罚被相对削弱 → 必须人为加大转移惩罚 λ，这是一个必须在验证集上调的量，不是理论给的）；
- **Viterbi 需要整段序列**。实时链路只能用 online forward filtering 或 fixed-lag smoothing，延迟必须显式记账（§4.6）。

#### 2.1.2 CRF：去掉观测独立假设

**论断**：CRF 是判别式的序列标注模型，条件于**整个**观测序列，因而不需要观测独立假设，也不受 MEMM 的 label bias 之苦。

**出处**：Lafferty, J., McCallum, A., Pereira, F. (2001). *Conditional Random Fields: Probabilistic Models for Segmenting and Labeling Sequence Data*. ICML 2001, pp. 282–289. ACM DL: <https://dl.acm.org/doi/10.5555/645530.655813>

**原始条件**：需要有标注的序列训练数据来学特征权重。本项目"单视频、小样本"条件下，**线性链 CRF 的参数量已经超出可靠估计范围**——建议退化为"结构固定、参数手工设定的 HMM/受约束 Viterbi"，把自由度留给 §5 里少数几个必须校准的标量。

#### 2.1.3 CRF 用于活动识别（HAR 一手来源）

**论断**：CRF 在活动/行为序列标注上优于生成式 HMM，尤其当观测特征之间高度相关时。

**出处**：Vail, D.L., Veloso, M.M., Lafferty, J.D. (2007). *Conditional random fields for activity recognition*. AAMAS 2007. DOI [10.1145/1329125.1329409](https://doi.org/10.1145/1329125.1329409)（作者博士论文全文：<https://www.cs.cmu.edu/~dvail2/pubs/doug_vail_thesis.pdf>）

**原始条件**：机器人足球域，观测是机器人自身的连续状态量，采样规整、无遮挡。

#### 2.1.4 HMM vs CRF 在真实居家活动识别上的直接对比

**论断**：在同一份真实居家 28 天传感器数据上直接对比 HMM 与 CRF 的序列标注表现。

**出处**：van Kasteren, T., Noulas, A., Englebienne, G., Kröse, B. (2008). *Accurate activity recognition in a home setting*. UbiComp 2008, pp. 1–9. DOI [10.1145/1409635.1409637](https://doi.org/10.1145/1409635.1409637)

**原始条件**：二值状态传感器（门磁、压力垫）网络，不是视觉；标注由被试自报。**不要把它的数字迁移到本项目**——传感模态、类别定义、评测协议全不同。

#### 2.1.5 HAR 的标准处理链与 NULL 类

**论断**：HAR 的标准流程（Activity Recognition Chain, ARC）是 预处理 → 分割（滑窗）→ 特征 → 分类 → 后处理；其中 **NULL 类（"不属于任何目标活动"）是所有实际系统的主要错误来源**，必须显式建模而不是靠"最大后验硬分类"兜住。

**出处**：Bulling, A., Blanke, U., Schiele, B. (2014). *A Tutorial on Human Activity Recognition Using Body-Worn Inertial Sensors*. ACM Computing Surveys 46(3):33. DOI [10.1145/2499621](https://doi.org/10.1145/2499621)（配套开源工具箱 <https://github.com/andreas-bulling/ActRecTut>）

**原始条件**：体佩 IMU。但 ARC 的结构和 NULL 类的论点是模态无关的方法论，可以迁移。**对 Reme 的直接含义：`unknown` 就是 NULL 类，它不是"分类失败的兜底"，而是一个必须被建模、被评测、被单独校准的类。**

#### 2.1.6 标签抖动 = over-segmentation，是帧级分类器的固有失效模式

**论断**：帧级分类器在时序分割任务上的主要错误不是"分错类"，而是"在一个真实片段内部反复横跳"（over-segmentation）。MS-TCN 用一个截断 MSE 平滑损失，惩罚相邻帧对数概率的跳变，来专门压制它。

**出处**：Abu Farha, Y., Gall, J. (2019). *MS-TCN: Multi-Stage Temporal Convolutional Network for Action Segmentation*. CVPR 2019, pp. 3575–3584. 开放获取：<https://openaccess.thecvf.com/content_CVPR_2019/html/Abu_Farha_MS-TCN_Multi-Stage_Temporal_Convolutional_Network_for_Action_Segmentation_CVPR_2019_paper.html>；arXiv:[1903.01945](https://arxiv.org/abs/1903.01945)；官方代码 <https://github.com/yabufarha/ms-tcn>

**原始条件**：大规模标注视频数据集（Breakfast / 50Salads / GTEA）上的**训练时**正则项。本项目样本量不足以训练这种模型 → 取其**诊断结论**（over-segmentation 是主要失效模式，必须专门治理），治理手段改用推理期的滞回 + 驻留（§2.2），不用训练期损失。

> 我未能取得 MS-TCN 正文 PDF（openaccess/CVF 对本工具返回 403），截断阈值 τ 与损失权重 λ 的确切数值**未读原文**，此处只引用其定性结论。

---

### 2.2 滞回（hysteresis）与最小驻留时间（minimum dwell time）

#### 2.2.1 滞回的原始形式

**论断**：用两个不同的阈值（进入阈值与退出阈值之间留回差）替代单阈值比较，可以让输出对叠加在输入上的噪声不敏感——这是抑制阈值附近反复翻转的原始电子学方案。

**出处**：Schmitt, O.H. (1938). *A thermionic trigger*. Journal of Scientific Instruments 15(1):24. DOI [10.1088/0950-7671/15/1/305](https://doi.org/10.1088/0950-7671/15/1/305)

**原始条件**：模拟电压比较器。迁移到标签层是**结构类比**：θ_in（要判 lying 需要 θ_trunk > θ_in）与 θ_out（已经是 lying，要退出需要 θ_trunk < θ_out < θ_in）。

#### 2.2.2 驻留时间的可证明形式

**论断**：如果每次切换之后系统必须在新模式停留至少 τ_D（dwell time），或"平均驻留时间"不低于 τ_a（average dwell time），则可以给出切换次数的上界；这是"慢切换"能带来可证明性质的原始表述。

**出处**：
- Hespanha, J.P., Morse, A.S. (1999). *Stability of switched systems with average dwell-time*. Proc. 38th IEEE CDC, pp. 2655–2660. DOI [10.1109/CDC.1999.831330](https://doi.org/10.1109/CDC.1999.831330)（作者页 PDF：<https://web.ece.ucsb.edu/~hespanha/published/avedwell.pdf>）
- Hespanha, J.P., Liberzon, D., Morse, A.S. (2003). *Hysteresis-based switching algorithms for supervisory control of uncertain systems*. Automatica 39(2):263–272. DOI [10.1016/S0005-1098(02)00241-8](https://doi.org/10.1016/S0005-1098(02)00241-8)（作者页 PDF：<https://web.ece.ucsb.edu/~hespanha/published/journal-hhs-final.pdf>）

**原始条件（必须诚实标注）**：这两篇讲的是**切换线性/不确定系统的 Lyapunov 稳定性**，结论形式是"若 τ_a 大于某个由子系统衰减率与切换代价决定的下界，则整体一致指数稳定"。我们**不迁移稳定性结论**，只迁移两个结构性事实：
- (a) 滞回切换逻辑在任意有限区间内的切换次数有界；
- (b) 驻留时间下界是把"抖动"变成"可界定量"的正确旋钮。

把它们当作"定理支持我们的阈值"是错误的引用方式。本项目里 T_dwell 的取值**只能靠验证集**。

#### 2.2.3 工程映射

| 控制论概念 | 本项目实现 |
|---|---|
| hysteresis 回差 | 每个几何判据双阈值：进入严、退出松 |
| dwell time τ_D | `T_dwell(state)`：某标签提交后至少保持这么久才允许被替换 |
| average dwell time τ_a | 滑动 10 s 窗口内的标签切换次数上限（作为运行时健康指标，超限即降级到 `unknown` 并报 `degraded`） |
| 切换代价 | Viterbi 转移矩阵里的 −λ |

---

### 2.3 生理可行的转移：时长量级与"什么在物理上不可能"

#### 2.3.1 真实跌倒的时长与冲击速度（一手、真实跌倒、非模拟）

**论断**：在长期照护机构监控视频里捕获的 25 起**真实**跌倒中，
- 从失衡起始到骨盆撞击：**1271 ± 648 ms**
- 从下降开始到骨盆撞击：**583 ± 255 ms**
- 骨盆垂直冲击速度 2.14 ± 0.63 m/s，头部 2.91 ± 0.86 m/s，手 2.87 ± 1.60 m/s
- 实测冲击速度显著**低于**倒立摆模型预测（骨盆低 38%）——即"人在下落过程中会主动减速/抓扶"，纯自由落体模型高估。

**出处**：Choi, W.J., Wakeling, J.M., Robinovitch, S.N. (2015). *Kinematic analysis of video-captured falls experienced by older adults in long-term care*. Journal of Biomechanics 48(6):911–920. DOI [10.1016/j.jbiomech.2015.02.025](https://doi.org/10.1016/j.jbiomech.2015.02.025) · PubMed <https://pubmed.ncbi.nlm.nih.gov/25769730/>

**原始条件**：监控视频人工数字化 + 已知场景标定；样本 n=25，平均年龄 80，长期照护环境。**该研究的视频帧率我未从摘要中确认（未读原文），因此不能把"583 ms ≈ 17.5 帧"当作他们的采样结论，只能当作我们自己在 30 FPS 下的推算。**

#### 2.3.2 真实跌倒的成因分布（说明"跌倒 ≠ 垂直坠落"）

**出处**：Robinovitch, S.N. et al. (2013). *Video capture of the circumstances of falls in elderly people residing in long-term care: an observational study*. The Lancet 381(9860):47–54. DOI [10.1016/S0140-6736(12)61263-X](https://doi.org/10.1016/S0140-6736(12)61263-X)

**对本项目的含义**：跌倒方向、初始诱因（重心转移错误、绊倒、打滑、坍塌）差异极大，**侧向与沿光轴方向的跌倒在单目图像里位移很小**（§3 不可观测项）。这必须写进已知局限，而不是靠调阈值掩盖。

#### 2.3.3 跌倒的预冲击速度阈值（可作量级参照，不可直接用）

**论断**：躯干垂直速度阈值 −1.3 m/s 可在其数据集上把跌倒与日常活动分开，且触发时刻平均早于躯干撞击 323 ms、早于膝撞击 140 ms。

**出处**：Bourke, A.K., O'Donovan, K.J., ÓLaighin, G. (2008). *The identification of vertical velocity profiles using an inertial sensor to investigate pre-impact detection of falls*. Medical Engineering & Physics 30(7):937–946. DOI [10.1016/j.medengphy.2007.12.003](https://doi.org/10.1016/j.medengphy.2007.12.003) · PubMed <https://pubmed.ncbi.nlm.nih.gov/18243034/>

**原始条件（关键）**：躯干佩戴 IMU；**跌倒是健康年轻被试的模拟跌倒**，ADL 来自老年被试。它报告的分离度是在这个受控数据集上的，**不是真实跌倒的性能**，也**不是**我们的传感条件（我们没有 IMU、没有米制速度）。只取 −1.3 m/s 这个**量级**。

#### 2.3.4 受控 sit↔stand 的时长量级

**论断 A（事件定义）**：站起/坐下可以被拆成一组明确定义的特征事件与相对时间区间，并给出健康被试规范数据。
**出处**：Kralj, A., Jaeger, R.J., Munih, M. (1990). *Analysis of standing up and sitting down in humans: definitions and normative data presentation*. Journal of Biomechanics 23(11):1123–1138. DOI [10.1016/0021-9290(90)90005-N](https://doi.org/10.1016/0021-9290(90)90005-N)
**原始条件**：实验室、测力台 + 运动学。我未能取得全文（ScienceDirect 403），**具体秒数未读原文**。

**论断 B（三相划分）**：老年人 sit-to-stand 可划分为 weight shift / transition / lift 三相。
**出处**：Ikeda, E.R. et al. (1991/1992). *Biomechanical analysis of the sit-to-stand motion in elderly persons*. Arch Phys Med Rehabil. PubMed <https://pubmed.ncbi.nlm.nih.gov/1622314/>（摘要**未报告绝对秒数**）

**论断 C（可用于反推量级的规范值）**：5 次连续坐-立-坐的年龄分层参考上限为 11.4 s（60–69 岁）、12.6 s（70–79 岁）、14.8 s（80–89 岁）。
**出处**：Bohannon, R.W. (2006). *Reference Values for the Five-Repetition Sit-to-Stand Test: A Descriptive Meta-Analysis of Data from Elders*. Perceptual and Motor Skills 103(1):215–222. DOI [10.2466/pms.103.1.215-222](https://doi.org/10.2466/pms.103.1.215-222)
**推算**：11.4 s / 5 次 ≈ 2.3 s 一个"起立+坐下"完整周期 → 单向半周期约 **1.1–1.5 s**（这是我做的算术推算，不是原文结论，且 5×STS 是**尽力而为的快速测试**，日常自然速度只会更慢）。

#### 2.3.5 从地面起身（lying → standing 的反向路径）

**出处**：Klima, D.W. et al. (2016). *Standing from the Floor in Community-Dwelling Older Adults*. Journal of Aging and Physical Activity. DOI [10.1123/japa.2015-0081](https://doi.org/10.1123/japa.2015-0081) · PubMed <https://pubmed.ncbi.nlm.nih.gov/26291641/>
**关键定性结论**：90.6% 的被试采用"先翻身（rolling）再非对称蹲起（asymmetrical squat）"的策略——即**lying → 中间位形 → standing**，从不是直达。这直接支持我们的转移矩阵硬约束。
**原始条件**：n=53，社区居住老年人，计时 supine-to-stand。摘要**未报告绝对秒数**（未读原文）。

#### 2.3.6 由上述得到的"物理不可能"清单

| 转移 | 判定 | 依据 |
|---|---|---|
| standing → lying 在 1 帧（33 ms）内完成 | **不可能** | 人体重心从站立高度降到地面，即使自由落体（h≈0.9 m）也需 ≈0.43 s；实测 descent 583 ± 255 ms（Choi 2015）且实测速度低于自由落体模型 |
| standing → lying 完全不经过任何中间位形 | **不可能** | 起身路径的逆过程必经中间位形（Klima 2016 的 roll + squat 策略）；跌倒同样经过躯干旋转的中间位形，只是驻留极短 |
| standing → sitting 在 <0.3 s 完成 | **可疑，但不是不可能** | 5×STS 半周期量级 1.1–1.5 s（Bohannon 反推），但"跌坐"（collapse into chair）可以显著更快 → 只能作为软约束 |
| lying → standing 在 <1 s 完成 | **可疑** | Klima 2016 的策略描述蕴含多相运动；但缺绝对秒数，**必须在自己的验证集上定下界** |
| 任意状态 ↔ unknown | **总是允许** | 遮挡/离开画面是瞬时事件 |

**最重要的一条否定结论**：**不能用"转移总时长"来区分受控躺下与跌倒**。受控 standing→(bending)→lying 的量级（≳1 s）与跌倒 descent + 1σ（≈0.84 s）重叠。区分必须靠 §4.4 的形状特征。

---

### 2.4 从含噪 2D 关键点稳健估计速度/加速度

#### 2.4.1 微分的噪声放大（问题定义）

**论断**：位移数据的微分在频域是乘 jω，二次微分是乘 −ω²；因此白噪声经一次微分后功率谱按 ω² 放大、二次微分后按 ω⁴ 放大。运动学信号能量集中在低频而噪声宽带 → 不先低通就微分必然被噪声淹没。

**出处（一手）**：
- Winter, D.A., Sidwall, H.G., Hobson, D.A. (1974). *Measurement and reduction of noise in kinematics of locomotion*. Journal of Biomechanics 7(2):157–159. DOI [10.1016/0021-9290(74)90056-6](https://doi.org/10.1016/0021-9290(74)90056-6)
- Woltring, H.J. (1985). *On optimal smoothing and derivative estimation from noisy displacement data in biomechanics*. Human Movement Science 4(3):229–245. DOI [10.1016/0167-9457(85)90004-1](https://doi.org/10.1016/0167-9457(85)90004-1)
- Antonsson, E.K., Mann, R.W. (1985). *The frequency content of gait*. Journal of Biomechanics 18(1):39–47. DOI [10.1016/0021-9290(85)90043-0](https://doi.org/10.1016/0021-9290(85)90043-0) · PubMed <https://pubmed.ncbi.nlm.nih.gov/3980487/> — 摘要明确指出该文正是为"位移二次微分中的噪声放大"提供信号/噪声频域测量。**该文常被转述为"99% 的信号功率在 15 Hz 以下"，我未读到原文正文，仅见二手转述，此处不作为定量依据引用。**

**原始条件**：实验室 TV/影片数字化或测力台，受试为步行。频谱结论是**步态**的，对"跌倒"这种非周期瞬变事件不能直接外推——跌倒的频谱更宽。

#### 2.4.2 Savitzky–Golay：局部多项式最小二乘，同时给平滑值与导数

**论断**：在等间隔采样的移动窗口上做低阶多项式最小二乘拟合，等价于一次卷积；同一套系数可以直接给出平滑后的 0 阶值和任意阶导数，且相比等宽滑动平均能更好保留极值与峰宽。

**出处**：Savitzky, A., Golay, M.J.E. (1964). *Smoothing and Differentiation of Data by Simplified Least Squares Procedures*. Analytical Chemistry 36(8):1627–1639. DOI [10.1021/ac60214a047](https://doi.org/10.1021/ac60214a047) · <https://pubs.acs.org/doi/10.1021/ac60214a047>

**原始条件**：**等间隔采样**。本项目 `timestamp_ms` 在实时链路上可能非均匀（掉帧、编解码抖动）→ **必须先按固定 33.33 ms 网格重采样或做缺帧插值，否则 SG 与 Butterworth 的系数无意义。这是一个常见且致命的实现陷阱。**

#### 2.4.3 中值滤波：保阶跃、除脉冲

**论断**：长度 N=2k+1 的一维中值滤波器的 root signal（不动点）恰由"常值邻域"和"单调边沿"构成；宽度 ≤ k 的脉冲被完全去除，而阶跃边沿被完全保留。

**出处**：Gallagher, N.C., Wise, G.L. (1981). *A theoretical analysis of the properties of median filters*. IEEE Transactions on Acoustics, Speech, and Signal Processing 29(6):1136–1141. DOI [10.1109/TASSP.1981.1163708](https://doi.org/10.1109/TASSP.1981.1163708)

**为什么这条对本项目特别重要**：姿态的几何量在转移期近似**阶跃/斜坡**，而 MoveNet 的失效模式是**孤立飞点**（把手腕吸到脸上、把踝点吸到桌腿）。中值滤波正好是"去飞点但不糊边"的最优结构；线性低通做不到这一点。**中值必须放在线性滤波之前。**

#### 2.4.4 零相位滤波（filtfilt）与残差分析选截止频率

**论断**：正向 + 反向各跑一次二阶 Butterworth，可得零相移的四阶等效滤波器（代价：等效幅频响应是单次响应的平方，−3 dB 点右移，实际 −6 dB @ 标称 fc，标称截止需要相应修正）；截止频率的选择用残差分析——扫描 fc，画 raw 与 filtered 之差的 RMS 残差 vs fc 曲线，把高频段近似线性的部分外推到 f=0，截距即噪声 RMS 水平，该水平与残差曲线的交点给出 fc。

**出处**：Winter, D.A. *Biomechanics and Motor Control of Human Movement*, 4th ed., Wiley, 2009. DOI [10.1002/9780470549148](https://doi.org/10.1002/9780470549148)（信号处理/运动学章节）

> **未读原文页面**：Wiley 页面对本工具返回 403。上述方法描述来自我对该教材通行方法的既有知识 + 检索到的二手转述（残差分析在第 2 版中位于 pp. 41–43）。**实现前必须核对纸质/电子书原文的公式与页码**，尤其是 filtfilt 的截止频率修正因子。

**原始条件**：离线整段数据。**filtfilt 是非因果的，实时链路不能用**——实时只能用因果 SG / 1€ filter / 单向 Butterworth（有相移），或 fixed-lag 版本。这一条必须在代码里区分 offline / online 两条路径，不能共用一个函数。

#### 2.4.5 实时的 jitter/lag 折中：速度自适应低通

**论断**：人在慢速时对抖动（jitter）敏感、对延迟（lag）不敏感；快速时相反。因此把低通截止频率做成速度的单调递增函数（慢→低截止抗抖，快→高截止抗延迟），能在同等抖动抑制下取得更小的滞后。

**出处**：Casiez, G., Roussel, N., Vogel, D. (2012). *1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems*. CHI 2012, pp. 2527–2530. DOI [10.1145/2207676.2208639](https://doi.org/10.1145/2207676.2208639) · 官方页 <https://gery.casiez.net/1euro/> · 参考实现 <https://github.com/casiez/OneEuroFilter>

**原始条件**：交互式输入设备（鼠标/触控/6DOF 跟踪）。两个参数 f_cmin 与 β 需要按信号调。**对本项目的价值**：跌倒是"高速事件"，如果用固定 5 Hz 低通，descent 的速度峰会被削平；1€ filter 的自适应正好保住峰值。但它是**因果 + 有偏**的，不能用来做需要无偏导数的定量分析——只用于实时快通道。

#### 2.4.6 最重要的实证锚点：30 FPS 单目 + 姿态估计到底能测出什么

**论断**：用 30 fps / 1920×1080 单目视频 + OpenPose(BODY_25) 估计跌倒时的髋部运动学，与参考系统对比：
- 位置：4 阶零相位 Butterworth，fc = 5 Hz
- 速度：fc = 10 Hz；**误差 7.28 ± 5.21%，MAE 0.17 ± 0.13 m/s，偏差 −1.27%（基本无偏）**
- 加速度：fc = 8 Hz（敏感性分析选出）；**误差 26.3 ± 19.4%，MAE 0.57 ± 0.53 g，对 >3.0 g 的冲击系统性低估 −21.4%**

**出处**：*Estimating hip impact velocity and acceleration from video-captured falls using a pose estimation algorithm*. Scientific Reports (2025). DOI [10.1038/s41598-025-85934-y](https://doi.org/10.1038/s41598-025-85934-y) · 全文 <https://pmc.ncbi.nlm.nih.gov/articles/PMC11717977/>

**原始条件**：相机**垂直于**被试（额状面视角）、**有场景标定**（因此他们能得到 m/s；我们不能）、OpenPose 而非 MoveNet Lightning（后者更小更快、精度更低）。

**对 Reme 的直接结论**：
- 我们的条件**严格劣于**这项研究（更弱的模型、无标定、任意视角）→ 他们的误差是我们的**乐观下界**；
- **速度可用，加速度不可用**。这不是保守，是有实证的判定。

---

### 2.5 采样率与可观测事件带宽

#### 2.5.1 Nyquist 上界

**出处**：Shannon, C.E. (1949). *Communication in the Presence of Noise*. Proceedings of the IRE 37(1):10–21. DOI [10.1109/JRPROC.1949.232969](https://doi.org/10.1109/JRPROC.1949.232969)

30 FPS → 折叠频率 15 Hz。任何 >15 Hz 的成分**混叠**进低频，不可分辨也不可去除。

#### 2.5.2 人体运动的能量分布

- 步态运动学的能量集中在很低的频率，这是"运动学用 6 Hz 左右低通、力学用 10–15 Hz"这一生物力学通行做法的来源（Winter et al. 1974；Antonsson & Mann 1985；Sci Rep 2025 对髋位置就用了 5 Hz）。
- **"人体运动主要能量 <6 Hz"这一常被引用的说法，我未读到 Antonsson & Mann 或 Winter 原文中的确切表述与百分比，仅见二手转述。** 本项目按"实践共识 + Sci Rep 2025 的实际参数选择"来采用 5–6 Hz 作为位置滤波起点，并在验证集上用残差分析复核，不当作文献定论。

#### 2.5.3 30 FPS 能否观测跌倒的冲击相 —— 明确回答：**不能**

推理链（每一步都可核）：
1. 我们要输出的判据若含"冲击"，本质是加速度/力的瞬变；
2. 有标定、更强模型、正面视角的条件下，30 fps 视频估的髋加速度误差已达 26.3%，且 >3 g 时低估 21.4%（Sci Rep 2025）；
3. 常规位置滤波 fc = 5 Hz 会把 5 Hz 以上成分（即冲击瞬变的绝大部分）直接滤掉，而不滤则微分噪声按 ω⁴ 放大（§2.4.1）——两难，无解；
4. descent 相持续 583 ± 255 ms（Choi 2015），@30 FPS ≈ 17.5 帧，采样充分；
5. → **可观测的是 descent 的速度轮廓与终态位形；不可观测的是冲击本身。**

**因此 `TransitionEvent.evidence` 里不允许出现任何"冲击强度 / 加速度峰值 / 撞击力"字段。**

#### 2.5.4 30 FPS → 5–10 Hz 输出：必须先平滑再抽取

`PostureObservation` 目标频率 5–10 Hz，而输入 30 FPS。**不能直接取每 3 帧的原始标签**——那是对一个含高频抖动的信号做无抗混叠的下采样，抖动会混叠成低频的"随机翻转"，看起来更糟。正确顺序：30 FPS 全帧做几何量提取 → 滤波 → （可选）帧级分类 → 时序解码 → 抽取到 5–10 Hz 输出。

---

### 2.6 不确定性量化与拒判

#### 2.6.1 最优拒判的经典形式

**论断**：当最大后验概率低于阈值 t 时拒判是最优的 error–reject 折中规则，并给出错误率与拒判率之间的一般关系。
**出处**：Chow, C.K. (1970). *On optimum recognition error and reject tradeoff*. IEEE Transactions on Information Theory 16(1):41–46. DOI [10.1109/TIT.1970.1054406](https://doi.org/10.1109/TIT.1970.1054406)
**原始条件（致命）**：**需要真后验概率**。我们没有。直接把 softmax 当后验用 Chow 规则是错的（见 2.6.4）。

#### 2.6.2 Selective classification：给定风险水平求覆盖

**论断**：给定已训练模型和目标风险水平，可以构造一个 selective classifier，在高概率意义下保证 selective risk ≤ 目标值，代价是覆盖率下降。
**出处**：Geifman, Y., El-Yaniv, R. (2017). *Selective Classification for Deep Neural Networks*. NeurIPS 2017. <https://papers.neurips.cc/paper/7073-selective-classification-for-deep-neural-networks> · arXiv:[1705.08500](https://arxiv.org/abs/1705.08500) · 代码 <https://github.com/geifmany/selective_deep_learning>
**原始条件**：i.i.d. 校准样本；保证是关于校准集抽样的高概率陈述。

#### 2.6.3 Conformal prediction：分布无关的有限样本覆盖

**出处**：
- Shafer, G., Vovk, V. (2008). *A Tutorial on Conformal Prediction*. JMLR 9:371–421. <https://jmlr.org/papers/v9/shafer08a.html>
- Angelopoulos, A.N., Bates, S. (2021/2022). *A Gentle Introduction to Conformal Prediction and Distribution-Free Uncertainty Quantification*. arXiv:[2107.07511](https://arxiv.org/abs/2107.07511)
- Vovk, V. (2012). *Conditional Validity of Inductive Conformal Predictors*. PMLR 25:475–490. <https://proceedings.mlr.press/v25/vovk12.html> · arXiv:[1209.2673](https://arxiv.org/abs/1209.2673) —— **label-conditional / Mondrian 有效性**，类别不平衡时必须用它，否则 `lying`、`fall_like` 这些稀有类的覆盖会被 `standing` 淹没。

**Split conformal 的操作形式（可直接编码）**：
非一致性分数 `s(x, y) = 1 − p̂_y(x)`；在大小 n 的校准集上取 `q̂ = ⌈(n+1)(1−α)⌉ / n` 分位数；预测集 `C(x) = { y : s(x, y) ≤ q̂ }`。
- `|C(x)| = 1` → 输出该类；
- `|C(x)| = 0` → **`unknown`（拒判）**；
- `|C(x)| ≥ 2` → 若集合内是"粗类一致"（如 {sitting, bending}），可输出粗类；否则 `unknown`。

**原始条件（必须写进代码注释）**：**exchangeability**。校准样本与测试样本可交换。

#### 2.6.4 我们违反了 exchangeability，怎么办

**论断**：exchangeability 被破坏时，conformal 的覆盖损失可以被"分布偏移量"界定；且可以通过加权来部分补偿。
**出处**：Barber, R.F., Candès, E.J., Ramdas, A., Tibshirani, R.J. (2023). *Conformal prediction beyond exchangeability*. The Annals of Statistics 51(2):816–845. DOI [10.1214/23-AOS2276](https://doi.org/10.1214/23-AOS2276) · arXiv:[2202.13415](https://arxiv.org/abs/2202.13415)

**在线自适应**：Gibbs, I., Candès, E.J. (2021). *Adaptive Conformal Inference Under Distribution Shift*. NeurIPS 2021. <https://proceedings.neurips.cc/paper/2021/hash/0d441de75945e5acbc865406fc9a2559-Abstract.html> —— 用 `α_{t+1} = α_t + γ(α − err_t)` 在线调 α。

**对本项目的具体做法（三条硬规则）**：
1. **按 `scene_id` / 片段分组切分**校准集与训练集。同一段视频的帧绝不能同时出现在两边——否则覆盖率被严重高估（相邻帧近乎重复样本）。
2. **覆盖保证只在片段级声明**："在 K 个未见过的场景片段上，片段级 coverage 为 X%"，不声明帧级。
3. **报告有效样本量**。n=20、α=0.1 时 `⌈21×0.9⌉/20 = 19/20`，实际取的是接近最大值的分位数 → 保证极松。**必须把 n 和实际用到的分位数序号打印出来**，不能只说"我们用了 conformal prediction"。

#### 2.6.5 为什么不能直接对 softmax 设阈值

**出处**：Guo, C., Pleiss, G., Sun, Y., Weinberger, K.Q. (2017). *On Calibration of Modern Neural Networks*. ICML 2017, PMLR 70. <https://proceedings.mlr.press/v70/guo17a/guo17a.pdf> · arXiv:[1706.04599](https://arxiv.org/abs/1706.04599)
现代网络系统性过自信；温度标定（单参数）通常能大幅改善，但**参数必须在独立验证集上拟合**。

**额外一条**：MoveNet 输出的 `score` 是 keypoint heatmap 的峰值响应，**不是**"该关键点确实在该位置的概率"。官方教程里的 0.11 / 0.2 是**可视化与裁剪阈值**，不是决策阈值（<https://www.tensorflow.org/hub/tutorials/movenet>）。把它当概率用会产生错误的置信度。

---

### 2.7 单目 2D 姿态本身的先验限制

- **MoveNet 官方说明**：MobileNetV2 + FPN 的 bottom-up heatmap 模型；Lightning 输入 192×192，输出 `[1,1,17,3]` = (y_norm, x_norm, score)；使用上一帧检测结果做智能裁剪；官方 TF.js 实现对关键点流**已经内置了一个非线性鲁棒滤波器**用于抑制噪声与离群点。来源：<https://blog.tensorflow.org/2021/05/next-generation-pose-detection-with-movenet-and-tensorflowjs.html>、<https://www.tensorflow.org/hub/tutorials/movenet>
  **含义**：`FrameLandmarks.smoothed` 为 true 时，上游可能已经做过一层非线性滤波 —— 我们再叠一层强平滑会双重延迟。**必须按 `smoothed` 字段分支配置滤波强度，这是接口里已有但容易被忽略的关键字段。**
- **markerless 的当前能力边界**：时空参数（步频、步长这类）与 marker-based 大致等价，但**关节中心位置与关节角尚不足以支撑临床应用**；且"在缺乏双平面 X 光这类金标准对照的情况下，markerless 系统的真实精度仍然未知"。来源：Wade, L., Needham, L., McGuigan, P., Bilzon, J. (2022). *Applications and limitations of current markerless motion capture methods for clinical gait biomechanics*. PeerJ 10:e12995. DOI [10.7717/peerj.12995](https://doi.org/10.7717/peerj.12995) · <https://peerj.com/articles/12995/>
- **2D→3D 本质欠定**：从 2D 关节位置恢复 3D 姿态是**病态问题**，必须靠姿态先验（包括生理关节限位）才能约束。来源：Akhter, I., Black, M.J. (2015). *Pose-Conditioned Joint Angle Limits for 3D Human Pose Reconstruction*. CVPR 2015. <https://openaccess.thecvf.com/content_cvpr_2015/html/Akhter_Pose-Conditioned_Joint_Angle_2015_CVPR_paper.html>
- **形状/纵横比路线的先例**：单目监控视频下用人体形状变形做跌倒检测是有一手文献的路线，说明"投影几何代理量"是被接受的做法——但它本身就是代理，不是三维事实。来源：Rougier, C., Meunier, J., St-Arnaud, A., Rousseau, J. (2011). *Robust Video Surveillance for Fall Detection Based on Human Shape Deformation*. IEEE TCSVT 21(5):611–622. DOI [10.1109/TCSVT.2011.2129370](https://doi.org/10.1109/TCSVT.2011.2129370)

---

## 3 在单目 2D COCO-17 下可观测 / 代理 / 不可观测的逐项判定

**这是本次调研最重要的一节。** 三档定义：
- **可观测**：可从 `FrameLandmarks` 直接计算，且不依赖任何未知标定量；误差来源只有关键点噪声。
- **投影代理**：可以算出一个数，但它是三维量在像平面上的投影/比值，随相机俯仰角、被试与相机距离、被试朝向而系统性变化。**允许使用，但必须以"场景内相对量 + 验证集校准阈值"的形式使用，禁止跨场景迁移阈值。**
- **不可观测**：单目 2D 归一化坐标下原理上无法得到。**禁止在特征、evidence、日志、对外文案中出现。**

### 3.1 可观测

| 量 | 定义 | 备注 |
|---|---|---|
| 关键点归一化坐标 | `(x_norm, y_norm)`，原点左上，y 向下 | 含噪；缺失时 score 低但仍有坐标 |
| 关键点 score | MoveNet heatmap 峰值 | **不是概率**（§2.6.5） |
| 可见性比例 | `q = #{score ≥ τ_kp}/17`，`q_core` 取 {5,6,11,12} | 直接可算 |
| 图像平面内的躯干轴方向 | `atan2` of (肩中点 − 髋中点) | 是**像平面内**的角度，见 3.2 的限制 |
| 关键点包围盒与纵横比 | 由 score ≥ τ_kp 的点算 | Rougier 2011 路线 |
| 各几何量的时间导数（像平面） | 经 §2.4 管线 | 单位是 "归一化图像单位/秒" |
| 时间结构 | 驻留时长、切换次数、事件间隔 | 只依赖 `timestamp_ms` |

### 3.2 投影代理（有偏，必须场景内校准）

| 量 | 为什么只是代理 | 使用约束 |
|---|---|---|
| 躯干倾角 θ_trunk | 是三维躯干轴在像平面的投影角。**沿光轴方向的倾斜完全不可见**：正对相机向后倒下，θ_trunk 可能几乎不变 | 只能配合"体长投影缩短"联合判断；单用必漏检前后向跌倒 |
| 体长尺度 L_torso = ‖S−H‖ | 投影长度随 (a) 人与相机距离 (b) 躯干与像平面夹角 变化。躺下时若身体轴指向相机，L_torso 可缩短一半以上 | 用**场景内该个体的时间中位数**做归一化基准，并对"L 突然缩短"单独建一个"朝向变化"指标，而不是当作噪声 |
| 归一化重心高度 h = 1 − y_H | 同一物理高度在画面上下位置的 y_norm 不同（透视 + 相机俯仰）；且 y_norm 混合了"人体降低"与"人向远处走" | 只做**同一场景内的相对变化**；绝对阈值必须按场景校准 |
| 体长归一化速度 v_y (body-lengths/s) | 分子分母都是投影量，误差相关 | 唯一允许的"速度阈值载体"；仍须验证集定阈值 |
| 2D 关节角（膝、髋） | 三维关节角在像平面的投影 ≠ 三维角，除非运动平面平行像平面 | 只用作**粗糙的位形描述**（如"膝明显弯曲"），不报数值 |
| 上下身长度比 R_leg | 蹲下/坐下时腿段投影缩短，但同样受朝向影响 | 与 θ_trunk 联合，不单用 |
| 包围盒纵横比 AR | 强依赖视角；侧躺 vs 朝相机躺，AR 差异极大 | 作为弱特征进模型，不作硬规则 |

### 3.3 不可观测（禁止假装拥有）

| 量 | 为什么不可观测 |
|---|---|
| **米制尺度、绝对身高、绝对速度 (m/s)** | 单张针孔投影 + 无内参 + 无深度 + 无已知长度参照 → 尺度不可恢复。这是投影几何的基本事实，不是精度问题 |
| **深度 z、沿光轴的位移** | 单目无深度。正对相机的前后跌倒在图像上位移可以极小 |
| **三维关节角、真实躯干倾角** | 2D→3D 病态（Akhter & Black 2015）。单帧无法唯一恢复 |
| **加速度的冲击峰、冲击力、地面反力 (GRF)** | 30 FPS + 必需的低通把冲击瞬变滤掉；实证误差 26.3%、>3g 低估 21.4%（Sci Rep 2025）。**没有力板 = 没有力** |
| **质心 (COM)** | 需要人体节段质量参数 + 三维节段位置。`hip midpoint` **不是** COM，不能改名叫 COM |
| **压力中心 (COP)、稳定裕度 (MoS)、平衡指标** | 需要测力台/压力垫 |
| **关节力矩、功率、能量** | 需要逆动力学（三维运动学 + 惯性参数 + 外力）。全缺 |
| **遮挡下关键点的真实位置** | MoveNet 在遮挡时仍输出坐标；score 低只表示热图峰值弱，**不等于"位置未知"被正确表达**。必须靠 q_core + 时间一致性另行检测 |
| **"是否受伤 / 是否失去意识 / 是否需要就医"** | 医学判断。产品红线，永久禁止 |
| **跌倒 vs 主动躺下的"意图"** | 意图不可观测。我们只能输出 `fall_like_transition`（形态学描述），不能输出 "fall detected" |

### 3.4 一条容易被忽略的判定：`landmark_quality` 是输入不是结论

`FrameLandmarks.landmark_quality ∈ {usable, degraded, unavailable}` 是 A 的感知层给的**质量标记**。时序层必须：
- `unavailable` → 直接 `unknown`，**不进滤波器状态**（否则会污染 SG 窗口）；
- `degraded` → 进滤波器但把该帧的观测似然打平（提高对先验的依赖），并计入"降级帧比例"；
- 连续 `degraded/unavailable` 超过 N_gap 帧 → 强制 `unknown` 并在恢复后**重置滤波器与 dwell 计时**（不能假装中间那段没发生）。

---

## 4 可直接编码的量与公式（COCO-17 索引）

约定：`p_i = (x_i, y_i)` 为第 i 个关键点的归一化坐标，`s_i` 为其 score。y 轴向下（y 越小越靠近画面顶端）。索引按项目 schema：
`0 nose, 1 left_eye, 2 right_eye, 3 left_ear, 4 right_ear, 5 left_shoulder, 6 right_shoulder, 7 left_elbow, 8 right_elbow, 9 left_wrist, 10 right_wrist, 11 left_hip, 12 right_hip, 13 left_knee, 14 right_knee, 15 left_ankle, 16 right_ankle`

### 4.1 基础派生点

```
S  = (p5 + p6) / 2                      # 肩中点 shoulder midpoint
H  = (p11 + p12) / 2                    # 髋中点 hip midpoint（注意：不是 COM）
K  = (p13 + p14) / 2                    # 膝中点
A  = (p15 + p16) / 2                    # 踝中点
T  = S - H                              # 躯干向量（图像里指向上方 ⇒ T_y < 0）
```

有效性门（每帧）：
```
core_ok  = (s5 ≥ τ_kp) ∧ (s6 ≥ τ_kp) ∧ (s11 ≥ τ_kp) ∧ (s12 ≥ τ_kp)
q        = |{ i : s_i ≥ τ_kp }| / 17
q_core   = |{ i ∈ {5,6,11,12} : s_i ≥ τ_kp }| / 4
```
`core_ok = false` → 该帧不产生几何量（不是产生 0），交给 §4.7 的缺口处理。

### 4.2 位形量（scale-free）

```
# 躯干与图像竖直轴的夹角，0° = 直立，90° = 水平
θ_trunk = degrees( atan2( |T_x| , |T_y| ) )                    ∈ [0, 90]

# 有符号版本（用于区分左右倾，可选）
θ_signed = degrees( atan2( T_x , -T_y ) )                      ∈ (-180, 180]

# 躯干投影长度（尺度代理）
L_torso = ‖T‖ = sqrt(T_x² + T_y²)

# 个体尺度基准：本场景内 L_torso 的滚动中位数（窗口 ≥ 5 s，只统计 core_ok ∧ θ_trunk < 30° 的帧）
L_ref   = rolling_median( L_torso | core_ok ∧ θ_trunk < 30° )

# 躯干投影缩短率：接近 1 = 躯干与像平面平行；显著 < 1 = 躯干朝向/远离相机（可能是前后向跌倒）
c_fore  = L_torso / L_ref

# 归一化"重心高度"代理（越大越高）
h_hip   = 1 - H_y
h_sho   = 1 - S_y

# 膝相对髋的高度差（正 = 膝在髋下方，站立典型；≈0 = 坐/蹲；负 = 躺且腿抬起）
Δ_kh    = (K_y - H_y) / L_ref

# 踝相对髋
Δ_ah    = (A_y - H_y) / L_ref

# 下肢投影长度比（蹲下 / 坐下时缩短）
R_leg   = ‖H - A‖ / L_ref

# 关键点包围盒纵横比（只用 s_i ≥ τ_kp 的点）
AR      = (x_max - x_min) / max(y_max - y_min, ε)
```

**四个静态类的"位形直觉"（仅作特征设计依据，不是硬规则）**：

| 类 | θ_trunk | Δ_kh | R_leg | AR | h_hip |
|---|---|---|---|---|---|
| standing | 小 | 明显为正 | 大 | 小 | 大 |
| sitting | 小–中 | ≈0 或小正 | 中 | 中 | 中 |
| bending_or_crouching | 中–大 | 小 | 小 | 中–大 | 中–小 |
| lying | 大（或 c_fore 显著 <1） | ≈0 或负 | 视姿势 | 大 | 小 |

**注意 lying 的双通道判据**：侧躺/横躺 → θ_trunk 大；朝向相机的躺 → θ_trunk 可能仍小，但 `c_fore` 显著 < 1 且 `h_hip` 低。**只用 θ_trunk 会漏掉第二类，这是单目最容易踩的坑。**

### 4.3 滤波管线（顺序不可换）

```
阶段 0  时间基准化
        按 timestamp_ms 重采样到均匀 33.33 ms 网格；
        缺帧 ≤ N_hold(初值 3) 用线性插值补，> N_hold 标为 gap（不插值）。
        —— SG / Butterworth 的等间隔前提（§2.4.2）

阶段 1  逐关键点门控
        s_i < τ_kp → 该点本帧缺失，不参与任何几何量。

阶段 2  几何量的中值滤波（去飞点，保阶跃）
        对 θ_trunk, L_torso, h_hip, Δ_kh, R_leg, AR 各自
        medfilt(window = W_med, 初值 5 帧 ≈ 167 ms)
        —— Gallagher & Wise 1981：宽度 ≤ 2 帧的脉冲被完全去除，阶跃保留

阶段 3a 离线路径：零相位 Butterworth
        4 阶等效（2 阶双向 filtfilt），fc 初值 5 Hz，
        实际 fc 用残差分析在验证集上定（Winter）。
        速度用 fc_v = 10 Hz 通道单独滤（对齐 Sci Rep 2025 的做法）。

阶段 3b 实时路径：因果 Savitzky–Golay
        window = W_sg (初值 9 帧 = 300 ms), polyorder = 2
        同一套 SG 系数给 0 阶（平滑值）与 1 阶（速度）
        —— 显式延迟 = (W_sg − 1)/2 = 4 帧 = 133 ms（若用居中窗）

阶段 3c 快通道（仅供 fall 判据）：1€ filter
        f_cmin 与 β 在验证集上调；速度峰不被削平是唯一目标。
        绝不用它的输出做静态分类。

阶段 4  速度量（唯一允许的速度定义）
        v_y      = d(H_y)/dt / L_ref          # 单位: body-lengths/s，正 = 向下
        v_θ      = d(θ_trunk)/dt              # 单位: deg/s
        v_h      = -d(h_hip)/dt / 1           # = v_y（等价，保留一个即可）

        禁止：任何以 m/s、pixel/s 为单位的量进入判据。
```

### 4.4 时序判据（transition 分类的可编码定义）

给定一次状态切换的区间 `[t0, t1]`（由 §4.5 的状态机给出）：

```
descent_dur   = t1 - t0                                 (ms)
v_peak        = max_{t∈[t0,t1]}  v_y(t)                 (body-lengths/s)
v_peak_width  = |{ t : v_y(t) > 0.5 · v_peak }| · Δt    (ms)   # 速度峰的半高宽
Δθ            = θ_trunk(t1) - θ_trunk(t0)               (deg)
bc_dwell      = 中间状态 bending_or_crouching 的累计驻留 (ms)
end_static    = 结束后连续保持同一静态标签的时长        (ms)
```

三分类规则（**所有阈值均为待校准符号，不得硬编码数值**）：

```
fall_like_transition  当且仅当
    终态 = lying
  ∧ v_peak ≥ Θ_fall_v
  ∧ descent_dur ≤ Θ_fall_dur
  ∧ bc_dwell   ≤ Θ_bc_max          # 关键：跌倒时几乎不在中间位形驻留
  ∧ v_peak_width ≤ Θ_peak_w        # 关键：跌倒是单个尖峰；受控下降是平台
  ∧ 质量门通过（q_core 全程 ≥ Θ_q）

normal_transition     当且仅当
    起止两端都是高置信静态标签
  ∧ 路径在允许转移图内（§4.5）
  ∧ v_peak < Θ_fall_v
  ∧ descent_dur ≥ Θ_ctrl_min
  ∧ 质量门通过

uncertain_transition  其余全部
  （含：质量降级、遮挡、路径非法、指标落在两组阈值之间的灰带）
```

**为什么把 `bc_dwell` 和 `v_peak_width` 放在核心位置**：§2.3.6 已论证"总时长不能分离两类"。真正可分的是**形状**——受控下降有一段膝/髋屈曲的驻留和近似恒定的下降速度（平台），跌倒是单峰、无驻留。这两个量在单目 2D 下都是**可观测/代理**级别的，不依赖任何不可观测量。

### 4.5 状态机 / 滤波设计草案（完整）

#### 状态集
```
ST = standing
SI = sitting
BC = bending_or_crouching
LY = lying
UK = unknown            # NULL 类，一等公民
```

#### 允许转移图（受控通道）

```
            ST ←──────→ SI
             ↕           ↕
            BC ←──────→ LY
             ↑           ↑
             └─── 允许 ──┘

ST ↔ LY : 受控通道中【禁止】直达
任意 ↔ UK : 允许
```

#### 转移对数分数矩阵（Viterbi 用；值为待校准符号）

|  from \ to | ST | SI | BC | LY | UK |
|---|---|---|---|---|---|
| **ST** | 0 | −λ₁ | −λ₁ | **−∞** | −λ_u |
| **SI** | −λ₁ | 0 | −λ₁ | −λ₁ | −λ_u |
| **BC** | −λ₁ | −λ₁ | 0 | −λ₁ | −λ_u |
| **LY** | **−∞** | −λ₂ | −λ₁ | 0 | −λ_u |
| **UK** | −λ_r | −λ_r | −λ_r | −λ_r | 0 |

说明：
- `−∞` 两格是唯一的**硬**生理约束（§2.3.6）。它的含义是"在受控通道里不存在 ST↔LY 的单步路径"，**不是**"人不能从站着变成躺着"——后者通过 `ST → BC → LY` 或 fall 快通道表达。
- `λ₂ > λ₁`：LY→SI（自己坐起来）比 SI→LY（躺下）更费力，先验上更少见。
- `UK` 行全部是小惩罚 `−λ_r`：遮挡结束后人可能已经变了姿势，从 UK 出来不应被强惩罚。**如果这里惩罚太大，一次遮挡会让状态机"卡"在旧标签上，这是最危险的失效模式（人在遮挡后倒地而系统仍报 standing）。**
- λ 的量级必须补偿 §2.1.1 的"观测独立假设被违反"导致的证据量高估。

#### 逐层结构

```
Layer 0  质量门（硬）
    person_detected = false  ∨  landmark_quality = unavailable  ∨  q_core < Θ_q
        → 直接输出 UK，不进入 Layer 1–3，且冻结（不推进）dwell 计时

Layer 1  帧级分类器 → p_t ∈ Δ⁴  (ST/SI/BC/LY)
    输入 = §4.2 位形量 + §4.3 速度量 + 0.5 s / 1.5 s 窗口的 mean/std/min/max

Layer 2  conformal 拒判（label-conditional split conformal，§2.6.3）
    C_t = { y : 1 − p̂_y ≤ q̂_y }
    |C_t| = 0            → UK
    |C_t| = 1            → 该类，观测似然 = log p̂
    |C_t| ≥ 2 且粗类一致 → 粗类（如 "低位姿态"），观测似然打平
    |C_t| ≥ 2 且粗类不一致 → UK

Layer 3  固定滞后 Viterbi（fixed-lag smoothing）
    lag L = 15 帧 = 500 ms（可调，见延迟预算）
    在上表的受约束转移矩阵上解码；UK 作为正式状态参与解码

Layer 4  滞回 + 最小驻留（debounce）
    进入条件：新标签必须在连续 D_enter 个输出周期（@10 Hz）中胜出
    保持条件：已提交标签必须持续 ≥ T_dwell(state) 才允许被替换
    滞回：θ_trunk 等几何判据用双阈值（进 θ_in / 出 θ_out，θ_out < θ_in）
    健康指标：滑动 10 s 内切换次数 > N_max → 报 degraded 并降级到 UK

Layer 5  fall 快通道（旁路 Layer 3/4）
    条件：Layer 0 通过 ∧ v_y(快通道，1€ filter) ≥ Θ_fall_v
    动作：立刻开一个 transition 窗口，窗口结束后按 §4.4 判定
          fall_like_transition 的发布【不等】T_dwell
    理由：把最需要低延迟的事件压在最长的平滑链后面是设计错误，
          且不能靠"把 T_dwell 调小"解决——那会同时破坏静态标签的稳定性
```

#### 最小驻留初值（**全部待校准**，此处只给出量级依据）

| 状态 | T_dwell 初值 | 依据 |
|---|---|---|
| ST | 500 ms | 站立是稳定态，可以长 |
| SI | 700 ms | 坐下后短时间内再起身较少见 |
| **BC** | **250 ms** | **必须最短**。BC 本质是过渡位形；dwell 太长会把 `ST→BC→LY` 整条路径吞掉，导致 fall 被误报为 normal |
| LY | 700 ms | 躺下后稳定 |
| UK | 200 ms | 要能快速进出，不能卡住 |

**BC 的 dwell 是整个设计里最微妙的参数**：它同时出现在"稳定标签"和"区分受控 vs 跌倒的 `bc_dwell` 特征"里。建议在实现上把两者拆成两个独立参数（`T_dwell_BC` 用于标签稳定，`Θ_bc_max` 用于 transition 分类），不要复用同一个数。

### 4.6 延迟预算（30 FPS 输入，10 Hz 输出）

| 环节 | 延迟 | 备注 |
|---|---|---|
| 中值滤波 W_med=5（居中） | 67 ms | |
| SG W_sg=9（居中） | 133 ms | 实时若用因果 SG 则 0 但有偏 |
| fixed-lag Viterbi L=15 | 500 ms | 主要成本 |
| debounce D_enter=3 @10 Hz | 300 ms | |
| **静态标签总延迟** | **≈ 1.0 s** | 对 `PostureObservation` 可接受 |
| 快通道（中值 + 1€，无 Viterbi/debounce） | **≈ 70–150 ms** | 加上 descent 窗口本身（≈0.6 s）→ fall 事件端到端 ≈ 0.8 s |

**这张表必须进代码注释和对外文档。** 声称"实时"而不给延迟数字是不诚实的。

### 4.7 缺口与重置规则

```
gap 定义：连续 ≥ N_gap 帧 (初值 5 = 167 ms) 的 unavailable / core_ok=false
gap 期间：输出 UK；SG/中值缓冲区【冻结不推进】；dwell 计时【暂停】
gap 结束：
    - 若 gap 时长 < T_reset (初值 1.0 s)：恢复原状态机，但把该次切换标记为
      uncertain_transition（因为我们不知道 gap 里发生了什么）
    - 若 gap 时长 ≥ T_reset：【完全重置】滤波器与状态机，
      新的第一个静态标签不产生 TransitionEvent（不能凭空捏造一次转移）
```

**理由**：这是"人在沙发后面倒地"的核心失效场景。如果 gap 后直接接上旧状态，系统会报告一次不存在的平滑转移；如果 gap 后凭空生成 transition，会报告一次虚构的 fall。两者都不可接受，所以必须显式重置 + 标 uncertain。

---

## 5 阈值与参数：文献先验 / 必须校准 / 禁止硬编码

### 5.1 有文献先验（可作初值，但仍须验证集复核）

| 参数 | 初值 | 来源 |
|---|---|---|
| 位置低通截止 fc | 5 Hz | Sci Rep 2025 对髋位置用 5 Hz；与生物力学运动学 6 Hz 传统一致（Winter） |
| 速度通道截止 fc_v | 10 Hz | Sci Rep 2025 |
| SG 窗口 W_sg | 9 帧 (300 ms) | 由 fc≈5 Hz 在 30 FPS 下的等效带宽估算 |
| 中值窗 W_med | 5 帧 | Gallagher & Wise：可去除 ≤2 帧宽的飞点 |
| Θ_fall_dur（descent 上界） | 1.0–1.2 s | Choi 2015: 583 ± 255 ms，取 +1.6σ ~ +2.4σ |
| Θ_ctrl_min（受控下降下界） | 1.0 s | Bohannon 2006 反推的 sit↔stand 半周期 1.1–1.5 s 的下沿 |
| conformal α | 0.10 | 常规起点；需与拒判率一起权衡 |
| 分类器温度 T | 1.0 起，验证集拟合 | Guo et al. 2017 |

### 5.2 必须在验证集上校准（无文献可依）

| 参数 | 为什么无先验 |
|---|---|
| τ_kp（keypoint score 门限） | MoveNet 的 score 不是概率；官方 0.11/0.2 是可视化阈值。最优值随场景光照/距离变化 |
| Θ_q（q_core 拒判门限） | 取决于家具遮挡布局 |
| θ_in / θ_out（θ_trunk 双阈值） | **强依赖相机俯仰角**。相机高位俯拍与齐腰平拍下，同一个"躺"的 θ_trunk 差异巨大 |
| c_fore 的"朝向相机"门限 | 依赖镜头视场与人距 |
| Θ_fall_v（v_y 峰值门限，body-lengths/s） | 无任何文献给出体长归一化速度阈值 |
| Θ_bc_max, Θ_peak_w | 无文献；这是本设计新提的判据 |
| λ₁, λ₂, λ_u, λ_r（转移惩罚） | 必须补偿观测相关性；纯理论无解 |
| T_dwell(·), D_enter | §2.2.2 的定理不给数值 |
| q̂_y（conformal 分位数） | 定义上就是校准量 |
| L_ref 的滚动窗口长度 | 依赖被试活动节奏 |

### 5.3 禁止硬编码（出现即视为缺陷）

1. **任何 m/s 阈值**（含 Bourke 的 −1.3 m/s）。没有标定就没有米。
2. **任何 pixel 单位阈值**。分辨率一变就错。
3. **"45°"这类看起来合理的几何常数**，除非在验证集上验证过并把验证结果写进配置文件注释。
4. **任何准确率/召回率数字出现在未经本项目实测的位置**（产品红线）。文献里的 100%、95% 不是我们的指标。
5. **加速度 / 冲击强度 / 撞击力相关的任何字段**（§2.5.3 已论证不可观测）。
6. **医学判断词**（"受伤"、"昏迷"、"需要就医"）。
7. **跨场景复用的阈值文件**。阈值是场景参数，换机位必须重标。

### 5.4 一个必须做但结论是"不要用"的换算

为了说明为什么文献阈值不能直接用，把 Bourke 的 −1.3 m/s 与 Choi 的 2.14 m/s 换成本项目单位：

```
需要 L_torso 的米制值 →  L_torso ≈ (肩高 − 大转子高) × 身高
Winter 教材第 4 章的人体测量比例表给出这两个高度占身高的比例；
【我未取得该表原文（Wiley 403），下面用常被引用的 ~0.29H 做量级演算，必须核对后才能写进代码】

身高 1.65 m ⇒ L_torso ≈ 0.48 m
  Bourke  1.3 m/s  ≈ 2.7 body-lengths/s
  Choi    2.14 m/s ≈ 4.5 body-lengths/s
```

**结论**：这两个数只能告诉我们 `Θ_fall_v` 大概在个位数 body-lengths/s 量级，**不能当阈值**——因为
(a) `L_torso` 是**投影**长度，不是真实长度（§3.2）；
(b) `H_y` 的图像位移不等于真实竖直位移（透视 + 俯仰角）；
(c) 我们不知道被试身高。
**把这个演算写进文档的目的，是让后续任何人看到 `Θ_fall_v = 2.7` 这种数字时立刻意识到它是被非法搬运过来的。**

### 5.5 为什么必须验证集校准而不是拍脑袋（五条论证）

1. **所有几何量都是场景参数的函数**。θ_trunk、h_hip、AR 全部依赖相机俯仰角、焦距、人距。固定机位下它们是常数，所以校准可行；但它们是**这台相机在这个房间的常数**，不是人体常数。
2. **分类器 confidence 不是概率**（Guo et al., ICML 2017）。直接对 p 设 0.7 之类的阈值没有统计含义。
3. **Chow (1970) 的最优拒判需要真后验**，我们没有 → 只能用 conformal 的分布无关路线在校准集上取分位数（Vovk 2012；Angelopoulos & Bates 2021）。
4. **小样本时 conformal 保证会退化且必须如实报告**：n=20、α=0.1 时 `⌈(n+1)(1−α)⌉/n = ⌈18.9⌉/20 = 19/20`，即实际取的是第 19 大的分数，保证极松。必须打印 `n` 和分位数序号。
5. **exchangeability 被违反**（帧强相关）。必须按 `scene_id`/片段分组切分校准集，覆盖率只在片段级声明（Barber et al., AoS 2023）；在线运行还可用 ACI 调 α（Gibbs & Candès, NeurIPS 2021）。**同一段视频的帧同时进训练和校准 = 覆盖率被系统性高估，这是本项目最容易犯且最难被发现的错误。**

---

## 6 对 Reme 的取舍建议与风险

### 6.1 建议采纳

1. **接受"速度可用、加速度不可用"这条硬判定**，并在 `TransitionEvent.evidence` 的 schema 里**删除**任何加速度/冲击字段，只保留：`center_height_change`（= Δh_hip，已在合同里）、`peak_descent_speed_bl_per_s`、`descent_duration_ms`、`trunk_angle_change_deg`、`intermediate_dwell_ms`、`quality_min`。
2. **分层实现，两条延迟通道**：静态标签走完整链（≈1.0 s 延迟），fall-like 走快通道（≈0.15 s 滤波延迟 + descent 窗口）。在 `RuntimeSessionStatus` 里暴露实际延迟。
3. **`unknown` 按 NULL 类正式建模**（Bulling et al. 2014），有自己的转移弧、自己的 dwell、自己的评测指标（拒判率、拒判时的真实标签分布）。
4. **置信度对外用 conformal 集合语义**：`posture_confidence` 报"预测集大小 = 1 且分数余量为 m"，而不是 softmax 值；文档里写清"这是证据强度，不是概率"。
5. **保留 `fall_like_transition` 的措辞**（合同已经是对的）。任何界面文案、日志、提交信息里都不允许出现"检测到跌倒"。
6. **`smoothed` 字段必须分支**：上游已滤波时，本层减半平滑强度（MoveNet 官方实现内置非线性滤波器）。
7. **写一个"场景指纹"自检**：记录该场景下 `L_ref` 分布、站立时 θ_trunk 的分布、地面线的 y 范围。运行时偏离超过阈值 → 判定"机位已变"，全局降级到 `unknown` 并报 `degraded`，而不是继续用失效阈值输出。
8. **评测按片段分组**：训练/校准/测试三分，切分单位是 `scene_id` 或连续片段，绝不按帧随机切。

### 6.2 明确放弃

- 放弃在 A 层做任何 3D 重建或 3D 关节角（病态问题 + 小样本 + 无标定）。
- 放弃 CRF/TCN 等需要大量标注序列的判别式时序模型；改用"结构固定、参数少"的受约束 Viterbi。
- 放弃"用总时长区分受控躺下与跌倒"（分布重叠，§2.3.6）。
- 放弃跨场景通用阈值。

### 6.3 风险清单（按严重度）

| 风险 | 机制 | 缓解 | 残留 |
|---|---|---|---|
| **遮挡后状态卡死** | 人在沙发后倒地，UK→旧标签，系统仍报 standing | §4.7 的 gap 重置 + UK 出弧小惩罚 | 仍可能延迟报告；必须在文档里承认 |
| **沿光轴（前后向）跌倒漏检** | 图像位移小，θ_trunk 几乎不变 | `c_fore`（躯干投影缩短）作为第二通道 | 正对相机的跌倒仍是已知盲区，**必须写进产品说明** |
| **机位变更导致阈值全面失效** | 所有几何量是场景参数的函数 | 场景指纹自检 → 降级 | 需要人工重新标定 |
| **小样本下 conformal 保证名存实亡** | n 太小，分位数退化 | 强制打印 n 与分位数序号 | 只能靠扩数据 |
| **校准集泄漏导致覆盖率虚高** | 相邻帧近似重复样本 | 按片段分组切分（强制 code review 项） | — |
| **BC dwell 参数误设吞掉真实转移** | BC 是过渡态 | 拆成两个独立参数 | 需在验证集上单独扫描 |
| **`degraded` 帧污染滤波器** | SG 窗口被坏值带偏 | Layer 0 硬门 + 缓冲区冻结 | — |
| **把"躺着休息"当成"倒地不起"** | 单目 2D 无法区分意图 | 只能靠 post-event 静止时长 + 场景区域（床/沙发） | **区域需人工标注，不是从关键点得来的**；且这已经接近医学判断的边界，必须止步于"长时间保持 lying"这一事实陈述 |
| **误把文献数字当本项目指标** | 引用便利 | §5.3 禁令 + 引用时强制标原始条件 | — |

### 6.4 落地时的最小验证闭环（建议）

1. 用一段标注好的验证视频跑通完整链，输出：静态标签混淆矩阵、拒判率、每类 conformal 覆盖率（**片段级**）、10 s 窗口切换次数分布、端到端延迟实测。
2. 对 `Θ_fall_v`、`Θ_bc_max`、`T_dwell(BC)`、`τ_kp`、`α` 做一维扫描，画出"拒判率 vs 错误率"曲线（Chow 意义上的 error–reject 曲线）。
3. 做一次 ablation：关掉中值滤波 / 关掉 Viterbi 约束 / 关掉 dwell，看 over-segmentation 指标（切换次数）各变多少 —— 证明每一层都在做事。
4. 把 §4.6 的延迟预算表用实测值替换掉估算值。

**在这四步跑完之前，不允许对外声明任何性能数字。**

---

## 附：本文引用的一手来源清单

| # | 来源 | 用途 |
|---|---|---|
| 1 | Rabiner 1989, Proc. IEEE, DOI [10.1109/5.18626](https://doi.org/10.1109/5.18626) | HMM / Viterbi |
| 2 | Lafferty, McCallum, Pereira 2001, ICML, <https://dl.acm.org/doi/10.5555/645530.655813> | CRF / label bias |
| 3 | Vail, Veloso, Lafferty 2007, AAMAS, DOI [10.1145/1329125.1329409](https://doi.org/10.1145/1329125.1329409) | CRF for activity recognition |
| 4 | van Kasteren et al. 2008, UbiComp, DOI [10.1145/1409635.1409637](https://doi.org/10.1145/1409635.1409637) | HMM vs CRF, 真实居家 HAR |
| 5 | Bulling, Blanke, Schiele 2014, ACM CSUR, DOI [10.1145/2499621](https://doi.org/10.1145/2499621) | ARC 流程、NULL 类 |
| 6 | Abu Farha & Gall 2019, CVPR, arXiv:[1903.01945](https://arxiv.org/abs/1903.01945) | over-segmentation |
| 7 | Schmitt 1938, J Sci Instrum, DOI [10.1088/0950-7671/15/1/305](https://doi.org/10.1088/0950-7671/15/1/305) | 滞回原始形式 |
| 8 | Hespanha & Morse 1999, CDC, DOI [10.1109/CDC.1999.831330](https://doi.org/10.1109/CDC.1999.831330) | average dwell time |
| 9 | Hespanha, Liberzon, Morse 2003, Automatica, DOI [10.1016/S0005-1098(02)00241-8](https://doi.org/10.1016/S0005-1098(02)00241-8) | hysteresis switching、切换次数上界 |
| 10 | Choi, Wakeling, Robinovitch 2015, J Biomech, DOI [10.1016/j.jbiomech.2015.02.025](https://doi.org/10.1016/j.jbiomech.2015.02.025) | **真实跌倒时长与冲击速度** |
| 11 | Robinovitch et al. 2013, Lancet, DOI [10.1016/S0140-6736(12)61263-X](https://doi.org/10.1016/S0140-6736(12)61263-X) | 真实跌倒成因分布 |
| 12 | Bourke, O'Donovan, ÓLaighin 2008, Med Eng Phys, DOI [10.1016/j.medengphy.2007.12.003](https://doi.org/10.1016/j.medengphy.2007.12.003) | 垂直速度阈值（量级参照） |
| 13 | Kralj, Jaeger, Munih 1990, J Biomech, DOI [10.1016/0021-9290(90)90005-N](https://doi.org/10.1016/0021-9290(90)90005-N) | STS 事件定义（未读全文） |
| 14 | Bohannon 2006, Percept Mot Skills, DOI [10.2466/pms.103.1.215-222](https://doi.org/10.2466/pms.103.1.215-222) | 5×STS 参考值 |
| 15 | Klima et al. 2016, JAPA, DOI [10.1123/japa.2015-0081](https://doi.org/10.1123/japa.2015-0081) | 地面起身策略（必经中间位形） |
| 16 | Winter, Sidwall, Hobson 1974, J Biomech, DOI [10.1016/0021-9290(74)90056-6](https://doi.org/10.1016/0021-9290(74)90056-6) | 运动学噪声与滤波 |
| 17 | Woltring 1985, Hum Mov Sci, DOI [10.1016/0167-9457(85)90004-1](https://doi.org/10.1016/0167-9457(85)90004-1) | 含噪位移的最优平滑与求导 |
| 18 | Antonsson & Mann 1985, J Biomech, DOI [10.1016/0021-9290(85)90043-0](https://doi.org/10.1016/0021-9290(85)90043-0) | 步态频率内容（**正文未读**） |
| 19 | Savitzky & Golay 1964, Anal Chem, DOI [10.1021/ac60214a047](https://doi.org/10.1021/ac60214a047) | SG 平滑与求导 |
| 20 | Gallagher & Wise 1981, IEEE TASSP, DOI [10.1109/TASSP.1981.1163708](https://doi.org/10.1109/TASSP.1981.1163708) | 中值滤波保阶跃除脉冲 |
| 21 | Winter 2009, *Biomechanics and Motor Control of Human Movement* 4th ed., DOI [10.1002/9780470549148](https://doi.org/10.1002/9780470549148) | 残差分析、零相位滤波（**页面 403，未读原文**） |
| 22 | Casiez, Roussel, Vogel 2012, CHI, DOI [10.1145/2207676.2208639](https://doi.org/10.1145/2207676.2208639) | 1€ filter，jitter/lag 折中 |
| 23 | *Estimating hip impact velocity and acceleration from video-captured falls…*, Sci Rep 2025, DOI [10.1038/s41598-025-85934-y](https://doi.org/10.1038/s41598-025-85934-y) | **30 FPS 单目速度可用/加速度不可用的实证** |
| 24 | Shannon 1949, Proc IRE, DOI [10.1109/JRPROC.1949.232969](https://doi.org/10.1109/JRPROC.1949.232969) | 采样定理 |
| 25 | Chow 1970, IEEE TIT, DOI [10.1109/TIT.1970.1054406](https://doi.org/10.1109/TIT.1970.1054406) | 最优拒判 |
| 26 | Geifman & El-Yaniv 2017, NeurIPS, arXiv:[1705.08500](https://arxiv.org/abs/1705.08500) | selective classification |
| 27 | Shafer & Vovk 2008, JMLR 9:371–421, <https://jmlr.org/papers/v9/shafer08a.html> | conformal prediction |
| 28 | Vovk 2012, PMLR 25:475–490, <https://proceedings.mlr.press/v25/vovk12.html> | Mondrian / label-conditional |
| 29 | Angelopoulos & Bates 2021, arXiv:[2107.07511](https://arxiv.org/abs/2107.07511) | split conformal 操作流程 |
| 30 | Barber, Candès, Ramdas, Tibshirani 2023, Ann Statist, DOI [10.1214/23-AOS2276](https://doi.org/10.1214/23-AOS2276) | 非可交换下的 conformal |
| 31 | Gibbs & Candès 2021, NeurIPS, <https://proceedings.neurips.cc/paper/2021/hash/0d441de75945e5acbc865406fc9a2559-Abstract.html> | 在线自适应 α |
| 32 | Guo, Pleiss, Sun, Weinberger 2017, ICML, arXiv:[1706.04599](https://arxiv.org/abs/1706.04599) | 校准必须用验证集 |
| 33 | Wade, Needham, McGuigan, Bilzon 2022, PeerJ, DOI [10.7717/peerj.12995](https://doi.org/10.7717/peerj.12995) | markerless 当前能力边界 |
| 34 | Akhter & Black 2015, CVPR, <https://openaccess.thecvf.com/content_cvpr_2015/html/Akhter_Pose-Conditioned_Joint_Angle_2015_CVPR_paper.html> | 2D→3D 病态 |
| 35 | Rougier et al. 2011, IEEE TCSVT, DOI [10.1109/TCSVT.2011.2129370](https://doi.org/10.1109/TCSVT.2011.2129370) | 单目形状变形跌倒检测先例 |
| 36 | MoveNet 官方：<https://blog.tensorflow.org/2021/05/next-generation-pose-detection-with-movenet-and-tensorflowjs.html>、<https://www.tensorflow.org/hub/tutorials/movenet> | 模型输出语义、内置滤波、阈值语义 |

### 未读原文 / 仅见二手转述的条目（诚实标注）

- **Antonsson & Mann 1985** 正文的具体百分比（"99% 功率在 15 Hz 以下"之类）——只读到 PubMed 摘要，未读正文。
- **Winter 教材** 的残差分析公式、零相位滤波截止修正、第 4 章人体测量比例表——Wiley 页面 403，方法描述基于既有知识与二手转述，**实现前必须核对原书**。
- **Kralj et al. 1990** 的具体时长数值——ScienceDirect 403，未读。
- **Ikeda et al. 1992**、**Klima et al. 2016** 的绝对秒数——摘要未报告。
- **MS-TCN** 平滑损失的 τ 与 λ 数值——CVF 页面 403，只引用定性结论。
- **Choi et al. 2015** 所用视频的帧率——摘要未给出，"583 ms ≈ 17.5 帧"是本文在 30 FPS 假设下的推算，不是原文结论。
