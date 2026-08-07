# 临床/老年医学的姿态操作化定义与姿态转移运动学 —— 在单目 2D COCO-17 下的可辩护性调研

- Type: research-note
- Status: draft-for-review
- Date: 2026-08-01
- Scope: standing / sitting / lying / bending_or_crouching 的临床操作化定义；sit-to-stand 与跌倒的运动学分期；这些理论在 **单目、无标定、归一化 2D 关键点** 下的可观测性边界
- 输入前提（唯一）：A 角色 `movenet-17/v0-experiment` JSONL，COCO-17 关键点，`x_norm, y_norm ∈ [0,1]`，原点左上，y 向下；无深度、无内外参、无米制尺度、无力板、无 IMU、无 3D；单人、室内固定机位、30 FPS、输出 5–10 Hz
- 排除信源：MDPI、Frontiers（项目既有约定）
- 红线：本文不产生任何医疗声明，不给出任何未经本项目验证集测量的准确率数字

---

## 1 结论摘要

1. **临床与久坐行为研究里 sitting/standing 的黄金操作化定义是「大腿段相对重力方向的倾角」，阈值集中在离竖直 40–60°（俗称 45°）。** 它之所以可靠，不是因为 45° 有生理意义，而是因为坐姿强制 ~90° 髋屈曲、站姿大腿近乎竖直，**这个量在真实生活中是强双峰分布**，45° 落在几乎无质量的谷底。三套独立实现互相印证：Acti4 用「与竖直夹角 > 45° 且加速度标准差 < 100 mg → sedentary」（[Skotte 2014](https://doi.org/10.1123/jpah.2011-0347)）；activPAL 实测拐点为离水平 ~40°（坐→站）与 ~10°（站→坐）的滞回带；ActiGraph 为离水平 50–60° 单阈值（[Radtke 2021](https://doi.org/10.1371/journal.pone.0252659)）。**关键：这是相对重力的角度，不是相对相机的角度。**

2. **同一套体系明确承认：单一大腿传感器无法区分 sitting 与 lying，必须增加一个正交自由度。** [Lyden 2016](https://doi.org/10.1249/MSS.0000000000000804) 用大腿绕长轴的横断面旋转 ±65° 才把 lying 从 sedentary 里分出来（sensitivity 96.7%、specificity 92.9%，7 天自由生活）。这条对 Reme 是硬约束：**任何单一「躯干与竖直夹角」都不足以分开 sitting 与 lying**，必须并联「身体长轴倾角」「躯干/下肢长度比」「关键点集合的展平度」三类互补几何证据，并保留拒判。

3. **Sit-to-Stand 与真实跌倒的时间尺度差 3–5 倍，这是单目 2D 下最可辩护的判别特征。** Schenkman 四期（flexion-momentum / momentum-transfer / extension / stabilization，[Schenkman 1990](https://doi.org/10.1093/ptj/70.10.638)）整体量级：自选速度起立 1.91 s、坐下 1.97 s（[Kerr 1997](https://doi.org/10.1016/S0268-0033(96)00077-0)）。真实跌倒：从失衡起点到骨盆着地 1271 ± 648 ms，**从下降开始到骨盆着地仅 583 ± 255 ms**（[Choi 2015](https://doi.org/10.1016/j.jbiomech.2015.02.025)）。**结论：正确的时序特征是「完成一个归一化落差所用的时间」，而不是「像素速度阈值」——因为时间是单目 2D 下唯一没有被投影破坏的物理量。**

4. **老年医学真正关心的不是「某帧是躺」，而是「冲击后静止的持续时长」。** [Schwickert 2017](https://doi.org/10.1159/000478092) 用真实跌倒的体戴传感器信号得到：自行起身者 resting 中位 10.5 s，无法起身者 34.5 s，**resting > 24.5 s 预测无法自行起身**。[Fleming & Brayne 2008](https://doi.org/10.1136/bmj.a2227)：90 岁以上跌倒者 80%（53/66）至少一次无法自行起身，30%（20/66）曾在地上躺 ≥1 小时；长躺与严重伤害强相关（adjusted OR 4.2），且 97%（37/38）的长躺事件里呼叫器可用却未被按下。[Tinetti 1993](https://doi.org/10.1001/jama.1993.03500010075035)：无法起身者更易死亡、住院、ADL 下降。**这决定了 Reme 的产品价值锚点应该是「静止时长 + 位置」，而不是「跌倒瞬间检测」。**

5. **在 `x,y ∈ [0,1]` 归一化坐标下，所有角度都被两层扭曲，文献阈值一律不得硬编码。** (a) 归一化抹掉了长宽比：直接对 `(x_norm, y_norm)` 做 `atan2` 会系统性压扁水平分量，16:9 下真实 45° 会算成 **29.4°**、20° 算成 11.6°、65° 算成 50.3°——这是必须先修的实现级错误，且当前 schema **没有携带 `image_width/height`，属于接口缺口**。(b) 出平面方位角 φ 使投影角满足 `tan θ' = tan θ · cos φ`：真实 45° 的段在 φ=60° 时只投影出 **26.6°**，同时段长按 `√(1 − sin²θ·sin²φ)` 收缩，躺姿沿光轴时长度趋于 0、角度数值奇异。**因此 45°/65°/20°/60° 只能作为「存在一个拐点」的先验，具体数值必须在本项目验证集上校准，并且必须配一条基于尺度塌缩与低置信度的显式拒判规则。**

---

## 2 理论与一手文献

每小节格式：**论断 → 出处 → 原始条件（在什么传感/实验条件下成立）**。

### 2.1 大腿倾角为什么能可靠分开 sitting 与 standing

**论断 A1**：activPAL 类设备用大腿段的静态（重力）加速度推算大腿相对重力的倾角，把 sitting/lying 与 standing 分开，并用动态加速度判定 stepping。原始验证以同步录像的直接观察为金标准。

- 出处：Grant PM, Ryan CG, Tigbe WW, Granat MH. *The validation of a novel activity monitor in the measurement of posture and motion during everyday activities.* Br J Sports Med 2006;40(12):992–997. DOI [10.1136/bjsm.2006.030262](https://doi.org/10.1136/bjsm.2006.030262)（PMID [16980531](https://pubmed.ncbi.nlm.nih.gov/16980531/)）
- 原文报告：坐姿时间平均百分差 0.19%（LoA −0.68%–1.06%），站立 1.4%（LoA −6.2%–9.1%），行走 −2.0%（LoA −16.1%–12.1%），逐秒一致率 95.9%。
- **原始条件**：10 名健康受试者，每人同时佩戴 3 台 activPAL，执行随机分配的日常任务（走/站/坐），数字摄像机同步录像做视觉分类。**实验室/半结构化环境、健康成人、传感器直接贴在大腿上测重力方向。**

**论断 A2**：非专有算法 Acti4 给出了可复现的显式阈值：若大腿加速度的标准差 SD(x) < 100 mg 且**推算倾角 > 45°（相对竖直）**，该 epoch 判为 sedentary（sitting 或 lying）。

- 出处：Skotte J, Korshøj M, Kristiansen J, Hanisch C, Holtermann A. *Detection of physical activity types using triaxial accelerometers.* J Phys Act Health 2014;11(1):76–84. DOI [10.1123/jpah.2011-0347](https://doi.org/10.1123/jpah.2011-0347)（PMID [23249722](https://pubmed.ncbi.nlm.nih.gov/23249722/)）
- 原文报告：标准化试验中 sitting/standing/walking/running/cycling 的 sensitivity 99–100%（walking stairs 95%），specificity 全部 > 99%；140 小时自由生活中 sitting 姿态的 sensitivity 98%、specificity 93%（金标准为口袋压力传感器）。
- **原始条件**：17 名受试者，ActiGraph GT3X+ 同时佩戴于大腿与髋；阈值是在**重力参考系**下的倾角，不是任何相机参考系。阈值的 45° 数值与「标准差 < 100 mg」是**耦合的一对**，单独搬走角度阈值不成立。
- 注：ProPASS 联盟的跨品牌一致性论文（[Crowley 2019, IJBNPA, DOI 10.1186/s12966-019-0835-0](https://doi.org/10.1186/s12966-019-0835-0)）明确只说 Acti4 用「倾角分布 + 大腿加速度最大标准差的规则树」，把具体阈值指回 Skotte 2014，未重复数值。

**论断 A3**：不同厂商的实际拐点并不相同，且 activPAL 存在方向性滞回；实验室实测的误分类模式非常具体。

- 出处：Radtke T, Rodriguez M, Braun J, Dressel H. *Criterion validity of the ActiGraph and activPAL in classifying posture and motion in office-based workers: A cross-sectional laboratory study.* PLOS ONE 2021;16(6):e0252659. DOI [10.1371/journal.pone.0252659](https://doi.org/10.1371/journal.pone.0252659)
- 原文报告的阈值描述：ActiGraph 把**离水平 0°–50~60°** 判为 sitting、> 50~60° 判为 standing；activPAL 的坐→站拐点约**离水平 40°**、站→坐拐点约**离水平 10°**（即方向不对称的滞回带）。
- 原文报告的准确率（20 人 40 次重复）：activPAL sitting 85% / standing 100% / stepping 100% / 姿态转移 73%；ActiGraph sitting 100% / standing 87% / stepping 100% / 转移 100%。
- 原文报告的关键误分类：**activPAL 把「伸直腿坐」误判为 standing 的比例达 70%**，「腿收到椅下坐」45%，含下蹲的复合转移 65%；ActiGraph 把「一只脚踩搁脚凳站立」误判为 sitting 65%。
- **原始条件**：办公室工作者，实验室内标准化任务，直接观察为金标准。

**为什么 45° 有效（机制解释，可辩护）**：坐姿在解剖上强制髋关节屈曲接近 90°，大腿从近竖直转到近水平；站姿大腿近竖直。自由生活中**人几乎不会长时间静态维持中间倾角**，所以「大腿相对重力倾角」是强双峰分布，任何落在 40–60° 的阈值都工作良好。A3 的误分类清单正是这个双峰假设被破坏时发生的事（伸直腿坐 → 大腿抬回竖直侧）。**这个机制解释也直接说明它在 2D 投影下会失效的原因：投影把双峰抹平（见 §3）。**

### 2.2 sitting 与 lying：单一自由度不够

**论断 B1**：单个大腿传感器给出的倾角**无法区分 sitting 与 lying**（两者大腿都可能近水平）；必须引入大腿绕自身长轴的旋转作为第二自由度。

- 出处：Lyden K, John D, Dall P, Granat MH. *Differentiating sitting and lying using a thigh-worn accelerometer.* Med Sci Sports Exerc 2016;48(4):742–747. DOI [10.1249/MSS.0000000000000804](https://doi.org/10.1249/MSS.0000000000000804)（作者接受稿全文已读：<https://researchonline.gcu.ac.uk/ws/files/23873804/Dall_P_2016_Lyden_etal_DistinguishingSittingFromLying_MSSE.pdf>）
- 算法原文：对 y 轴（与股骨长轴同平面但垂直）静态加速度做 20 秒滑动均值滤波，反正弦得到 ±90° 的旋转角；**0° 为仰卧、+90° 为右侧卧、−90° 为左侧卧**；某个 sedentary 事件内只要旋转角**跨越过 ±65° 阈值至少一次**（即出现过 1 和 0 的交叉），该事件判为 lying。
- 结果：sensitivity 96.7%（in-bed 时间被判为 lying 的比例），specificity 92.9%；验证组 11 人 77 天，估计卧床时间偏差 −3.9 h/记录期（约 36.2 min/夜）。
- **原文自陈的失效模式（对 Reme 极其重要）**：*"if an individual is in the lying posture, but does not rotate their thigh beyond the [threshold] at any point during the sedentary event, the current algorithm will misclassify the event as sitting."* 即**该算法靠「时间窗内出现过翻身」来判躺，不是靠单帧几何**。它引用文献称正常人 8 小时睡眠中约翻身 45 次、> 90% 的翻身间隔在 10–15 分钟内。
- **原始条件**：14 名健康办公人群，7 天自由生活，金标准是自报「上床/起床」日记（经事件文件精修）。**注意：金标准是日记，不是录像；「非在床时间一律视为非躺」是该研究显式承认的假设偏倚。**

**对 Reme 的直接推论**：Lyden 的做法在原理上等价于「不要试图从单帧判躺，要从一段时间窗的姿态**变化模式**判躺」。这条思路可以平移到 2D：短窗内身体长轴方向的稳定性 + 尺度塌缩，比单帧角度更可辩护。

### 2.3 躯干倾角：临床与人因工程的阈值与测量法

**论断 C1**：人因工程国际标准把「trunk inclination」定义为**肩关节–髋关节连线相对重力竖直的夹角**，并给出三段式判据：< 20° 始终可接受；20°–60° 可接受时长从 4 min 线性降到 1 min；**> 60° 不推荐**（高腰痛风险）。

- 出处：ISO 11226:2000 *Ergonomics — Evaluation of static working postures*，标准页 <https://standards.iteh.ai/catalog/standards/iso/0bd9cbcd-32e5-4fa3-94ca-5ff699c55588/iso-11226-2000>（公开样张 PDF：<https://cdn.standards.iteh.ai/samples/25573/2abcc229c27d4a1daa69ce1930a901a0/ISO-11226-2000.pdf>）
- 二次描述见 Delleman NJ, Dul J, *International standards on working postures and movements ISO 11226 and EN 1005-4*, Ergonomics 2007（**未读原文，仅见摘要与转述**）。
- **原始条件**：静态工作姿态评估，人体测量或图像/量角器读数，参考系为**真实重力竖直**。这是一个「暴露–风险」标准，不是「姿态分类」标准；20°/60° 是健康风险分界，不是「站立 vs 弯腰」的分类分界。**把它当分类阈值用属于借用，必须说明。**

**论断 C2**：观察法姿态分类（OWAS）把背部分为「直/前弯/扭转/前弯并扭转/前弯并侧弯」，"bent" 的实践门槛通常取前屈 > 20°。

- 出处：Karhu O, Kansi P, Kuorinka I. *Correcting working postures in industry: A practical method for analysis.* Appl Ergon 1977;8(4):199–201。相关应用示例见 Appl Ergon 1981 <https://www.sciencedirect.com/science/article/abs/pii/0003687081900880>（**未读原文，仅见检索摘要与后续综述转述**）。
- **原始条件**：人工观察者按固定时间间隔（30 s–5 min）打标，工业现场。**是粗分类而非连续测量**，本身就承认 ±10° 级别的判读误差。

**论断 C3**：临床用倾角仪测躯干倾角时，读数与真实躯干倾角的关系依传感器贴放位置（L4 / Th12 / Th5）而变，分别呈凹/直/凸曲线；且受「前弯 vs 下蹲」策略影响（L4 处最明显），受负重影响可忽略。

- 出处：Seo A, et al. *Estimation of trunk inclination by means of an inclinometer.* J Occup Health 1997;39(1):51–56. DOI [10.1539/joh.39.51](https://doi.org/10.1539/joh.39.51)
- **原始条件**：贴体倾角仪 + 理论模型分析，负重 1/5/10 kg、取物高度 0–60 cm。
- **对 Reme 的意义**：即便在**接触式、直接测重力**的条件下，「躯干倾角」也不是一个唯一定义的量——放在腰和放在胸背得到的曲线不同。COCO-17 的「肩中点–髋中点连线」在语义上最接近 ISO 11226 的定义（肩–髋连线），**不是**腰椎屈曲角；这两者必须在文档里严格区分，否则会出现「弯腰但腰不动（髋铰链式前屈）」被当成腰椎屈曲的错误叙述。

**论断 C4（临床「躺 vs 坐」是连续谱，不是二分）**：护理实践用床头抬高角度定义体位带：low Fowler 15–30°、semi-Fowler 30–45°、Fowler 45–60°、high Fowler 60–90°。

- 出处：**未找到可引用的一手期刊/标准原文**；检索到的均为教科书式二次资料（如 <https://en.wikipedia.org/wiki/Fowler%27s_position>、<https://nurseslabs.com/patient-positioning/>）。**标注为「未读原文，仅见二手转述」，不得作为阈值依据。**
- **保留它的唯一理由**：它证明**临床自己就承认 lying↔sitting 之间存在 15°–60° 的连续过渡带**。因此 Reme 在这一带上输出 `unknown` 是**符合临床直觉**的，而不是能力不足。

### 2.4 Sit-to-Stand 的运动学分期

**论断 D1（四期模型）**：起立动作分四期——
- **Phase I flexion-momentum**：躯干前屈产生初始动量（臀部仍在座面）；
- **Phase II momentum-transfer**：从**离座（seat-off）**开始，到**踝最大背屈**结束；上身水平动量转为全身水平+垂直动量；
- **Phase III extension**：伸展至完全直立；
- **Phase IV stabilization**：稳定期。
四期按**动量与稳定性特征**区分。

- 出处：Schenkman M, Berger RA, Riley PO, Mann RW, Hodge WA. *Whole-body movements during rising to standing from sitting.* Phys Ther 1990;70(10):638–648. DOI [10.1093/ptj/70.10.638](https://doi.org/10.1093/ptj/70.10.638)（PMID [2217543](https://pubmed.ncbi.nlm.nih.gov/2217543/)）
- **原始条件**：**9 名健康受试者，受控条件下的全身运动学 + 动力学分析（需要测力台与三维运动测量）**。摘要**不报告**各期时长与关节角数值——任何声称「Schenkman 给出各期时长」的说法都需要回到全文核对；本文不引用未核实的时长。
- **关键**：Phase I/II 的分界事件是 **seat-off**（臀部离开座面），Phase II/III 的分界是**踝最大背屈**。这两个事件在单目 2D 里都**不可直接观测**（见 §3）。

**论断 D2（事件化定义体系）**：起立/坐下的规范化事件与相对时间区间可以基于矢状面测角 + 地面反作用力定义，得到类似「步态周期图」的标准化描述。

- 出处：Kralj A, Jaeger RJ, Munih M. *Analysis of standing up and sitting down in humans: definitions and normative data presentation.* J Biomech 1990;23(11):1123–1138. DOI [10.1016/0021-9290(90)90005-N](https://doi.org/10.1016/0021-9290(90)90005-N)（PMID [2277047](https://pubmed.ncbi.nlm.nih.gov/2277047/)）
- **原始条件**：20 名正常人，**矢状面测角仪 + 测力台**；原文明确「特征事件主要依据地面反作用力的变化选取」。**→ 该体系的事件定义在没有测力台时原理上不可复现。**

**论断 D3（时长量级）**：自选速度下，起立平均 1.91 s、坐下平均 1.97 s。

- 出处：Kerr KM, White JA, Barr DA, Mollan RA. *Analysis of the sit-stand-sit movement cycle in normal subjects.* Clin Biomech 1997;12(4):236–245. DOI [10.1016/S0268-0033(96)00077-0](https://doi.org/10.1016/S0268-0033(96)00077-0)（PMID [11415728](https://pubmed.ncbi.nlm.nih.gov/11415728/)）
- **原始条件**：50 名正常人（25 男 25 女），20.1–78.3 岁（均值 46.8 岁），自选速度。**1.91 s / 1.97 s 两个数字来自检索结果对摘要原文的引用，PubMed 摘要页在本次会话被 reCAPTCHA 拦截，未直接打开原页面——标注为「摘要转述，未直接读取原页」。**

**论断 D4（最大努力下的下界）**：五次起坐测试（FTSTS）的年龄参考值——超过 11.4 s（60–69 岁）、12.6 s（70–79 岁）、14.8 s（80–89 岁）视为低于平均水平。

- 出处：Bohannon RW. *Reference values for the five-repetition sit-to-stand test: a descriptive meta-analysis of data from elders.* Percept Mot Skills 2006;103(1):215–222. DOI [10.2466/pms.103.1.215-222](https://doi.org/10.2466/pms.103.1.215-222)
- **原始条件**：13 篇论文 14 项研究的描述性 meta 分析；**FTSTS 是最大努力测试**，因此它给出的是「起+坐一个循环 2.3–3.0 s」，单次起立在**最快**情况下约 1.1–1.5 s。
- **对 Reme 的意义**：**老年人自愿姿态转移的时间下界约 1.0–1.2 s 量级**；这条下界与 §2.6 的跌倒下降期 0.583 s 之间存在 2 倍以上的可分间隔。

**论断 D5（老年人 STS 的形态差异）**：老年人 STS 转移时间更长、躯干前屈更大、水平方向摆动更大；离座后先把质心带到支撑面上方再开始上升。

- 出处：Millington PJ, Myklebust BM, Shambes GM. *Biomechanical analysis of the sit-to-stand motion in elderly persons.* Arch Phys Med Rehabil 1992;73(7):609–617. DOI [10.1016/0003-9993(92)90124-F](https://doi.org/10.1016/0003-9993(92)90124-F)（PMID [1622314](https://pubmed.ncbi.nlm.nih.gov/1622314/)）（**未读全文，仅见摘要与检索转述**）
- **原始条件**：老年人三维运动学 + 测力台。

### 2.5 躺卧姿态（supine / lateral / prone）的定义

**论断 E1**：客观测量研究中，睡姿由体戴加速度计相对重力的取向定义；自由生活人群里侧卧 54.1%、仰卧 37.5%、俯卧 7.3%，翻身约 1.6 次/小时。

- 出处：Skarpsno ES, Mork PJ, Nilsen TIL, Holtermann A. *Sleep positions and nocturnal body movements based on free-living accelerometer recordings: association with demographics, lifestyle, and insomnia symptoms.* Nat Sci Sleep 2017;9:267–275. DOI [10.2147/NSS.S145777](https://doi.org/10.2147/NSS.S145777)（PMID [29138608](https://pubmed.ncbi.nlm.nih.gov/29138608/)）
- **原始条件**：363 男 301 女的工作人群，加速度计佩戴于**大腿、上背、上臂三处**。摘要未给出各体位的角度判据细节（**全文页 Dove Press / T&F 在本次会话均返回 403，未读全文**）。
- **注**：Dove Medical Press 不在本项目排除名单（仅排除 MDPI、Frontiers），但该刊等级偏低，此处只用其分布性结论，不用其算法细节。
- **对 Reme 的意义**：**「躺」在临床上是一个含子类（仰/侧/俯）的集合，而且人在躺着时会持续变换子类。** 用 COCO-17 从固定机位区分仰/侧/俯需要面部关键点（0–4）可见性与左右肩髋前后顺序，二者在 2D 里都极不稳定。**建议 Reme 只输出 `lying` 集合标签，明确声明不区分子类。**

**论断 E2**：临床本身把「躺」按床头抬高角度分成连续带（见 C4），**未找到一手来源，标注为二手**。

### 2.6 老年人跌倒的生物力学分期与量级

**论断 F1（分期）**：基于真实世界体戴传感器录制，跌倒可分为 **pre-fall / falling（free-fall） / impact / resting / recovery** 五期。

- 出处：Becker C, Schwickert L, Mellone S, et al. (FARSEEING Consortium). *Proposal for a multiphase fall model based on real-world fall recordings with body-fixed sensors.* Z Gerontol Geriatr 2012;45(8):707–715. DOI [10.1007/s00391-012-0403-6](https://doi.org/10.1007/s00391-012-0403-6)（PMID [23184296](https://pubmed.ncbi.nlm.nih.gov/23184296/)）
- **原始条件**：真实世界体戴惯性传感器信号；摘要未给出各期时长。原文明确指出「患者与旁观者往往无法就这些分期给出细节」——即**分期是传感器才能给出的构造，不是主观可报告的**。

**论断 F2（视频学派的分期）**：视频跌倒分析用 Fall Video Analysis Questionnaire 的三期（initiation / descent / impact），或 Noury 的四期（prefall / critical / postfall / recovery）。

- 出处：Ariyanto D, et al. *Investigating the biomechanics of falls in older adults in long-term care using a video camera: a scoping review.* BMC Geriatr 2024;24:.... DOI [10.1186/s12877-024-05395-2](https://doi.org/10.1186/s12877-024-05395-2)（全文已读；这是**综述**，其中引用的原始数据已回溯到 Choi 2015）
- **原始条件**：长期照护机构公共区域的**固定摄像头视频**——这是与 Reme 最接近的原始条件，但**分期是人工逐帧标注得出的，不是自动算法**。

**论断 F3（下降期时长与冲击速度）**：真实跌倒中，从失衡起点到骨盆着地平均 **1271 ± 648 ms**，从**下降开始**到骨盆着地平均 **583 ± 255 ms**；垂直冲击速度骨盆 **2.14 ± 0.63 m/s**、头 2.91 ± 0.86 m/s、手 2.87 ± 1.60 m/s。

- 出处：Choi WJ, Wakeling JM, Robinovitch SN. *Kinematic analysis of video-captured falls experienced by older adults in long-term care.* J Biomech 2015;48(6):911–920. DOI [10.1016/j.jbiomech.2015.02.025](https://doi.org/10.1016/j.jbiomech.2015.02.025)（PMID [25769730](https://pubmed.ncbi.nlm.nih.gov/25769730/)）
- **原始条件**：25 次跌倒 / 23 名受试（均值 80 ± 9.8 岁），**多机位视频 + 人工标注 + 三维重建**（这是从视频里恢复米制速度的必要条件，Reme 不具备）。

**自由落体 √(2gh) 的现实修正（本文推导，用 F3 的实测值锚定）**：
- 设老年人站立时骨盆高约 0.90 m，着地时约 0.15 m，落差 h ≈ 0.75 m。
- 纯自由落体：`t = √(2h/g) = √(2×0.75/9.81) ≈ 0.391 s`，`v = √(2gh) = √(2×9.81×0.75) ≈ 3.84 m/s`。
- 实测（Choi 2015）：下降期 **0.583 s**（≈ 自由落体的 **1.49 倍**），骨盆冲击速度 **2.14 m/s**（≈ 自由落体的 **0.56 倍**）。
- **结论：真实跌倒不是自由落体。** 保护性下肢/上肢动作、家具接触、躯干旋转都在耗散能量。**任何以 √(2gh) 为阈值的「跌倒速度」判据都会显著偏高、导致漏检。** 而在归一化 2D 下我们连 m/s 都得不到，只能得到「归一化体长/秒」。

**论断 F4（跌倒前的姿态不一定是站立行走）**：227 次视频记录的跌倒中，失衡原因为重心转移不当 41%、绊倒 21%、被撞 11%、失去支撑 11%、瘫倒（collapse）11%、滑倒 3%；跌倒时的活动为向前行走 24%、**静止站立 13%**、**正在坐下 12%**。

- 出处：Robinovitch SN, Feldman F, Yang Y, et al. *Video capture of the circumstances of falls in elderly people residing in long-term care: an observational study.* Lancet 2013;381(9860):47–54. DOI [10.1016/S0140-6736(12)61263-X](https://doi.org/10.1016/S0140-6736(12)61263-X)（PMID [23083889](https://pubmed.ncbi.nlm.nih.gov/23083889/)）
- **原始条件**：2007–2010 年，加拿大 BC 省两家长期照护机构餐厅/休息室/走廊的固定摄像头；每段视频用经验证的问卷双人复核。
- **对 Reme 的致命推论**：**「站立 → 躺」不是跌倒的必要前置模式。** 至少 12% 的跌倒发生在「正在坐下」的过程中（前置姿态是 sitting 或 transition），13% 发生在静止站立。因此把 `fall_like_transition` 定义为「`posture_before=standing` 且 `posture_after=lying`」会在**设计上**漏掉超过四分之一的真实跌倒场景，且会把「快速坐下」误报。**这条必须写进接口注释。**

### 2.7 冲击后静止（post-fall inactivity / long lie）的老年医学意义

**论断 G1（可量化的时间阈值）**：真实跌倒后，能自行站起者的 resting 中位时长 **10.5 s**，不能者 **34.5 s**；**resting > 24.5 s 预测无法恢复到站立**。恢复过程的累计角度俯仰运动，成功者中位 76°、失败者 308°。

- 出处：Schwickert L, Klenk J, Zijlstra W, et al. *Reading from the black box: what sensors tell us about resting and recovery after real-world falls.* Gerontology 2017;64(1):90–95. DOI [10.1159/000478092](https://doi.org/10.1159/000478092)（PMID [28848150](https://pubmed.ncbi.nlm.nih.gov/28848150/)）
- **原始条件**：FARSEEING 真实跌倒数据库的体戴惯性传感器信号（腰部），非视频。**24.5 s 是「静止 vs 起身」的判别阈值，不是「是否跌倒」的阈值。**

**论断 G2（长躺的流行病学与后果）**：90 岁以上人群中，跌倒者 **80%（53/66）** 至少一次无法自行起身，**30%（20/66）** 曾在地上待 ≥1 小时；所有跌倒报告中 15%（40/265）导致在地 ≥1 小时；54%（144/265）的报告描述为「被发现躺在地上」；82% 的跌倒发生在独处时；「独自跌倒且无法自起」子组中 28%（40/143）在地 > 1 小时。长躺与严重伤害相关（**adjusted OR 4.2**）；受影响的 20 人中 60% 在随访期内因跌倒住院。呼叫器普遍配备但绝大多数未被使用：**97%（37/38）** 的长躺事件里呼叫器可用却未激活。

- 出处：Fleming J, Brayne C. *Inability to get up after falling, subsequent time on floor, and summoning help: prospective cohort study in people over 90.* BMJ 2008;337:a2227. DOI [10.1136/bmj.a2227](https://doi.org/10.1136/bmj.a2227)（PMID [19015185](https://pubmed.ncbi.nlm.nih.gov/19015185/)，PMC 全文已读）
- **原始条件**：Cambridge City over-75s Cohort 的 90+ 存活者 110 人（90 女 20 男），1 年前瞻随访（跌倒日历 + 电话 + 家访），**在地时长分档沿用 Nevitt 等的分类：< 5 min、5 min–1 h、1–2 h、> 2 h**。
- **注意**：这是**自报 + 访谈**得到的时长，不是仪器测量的；作为「时长分档的临床合理性」证据可用，作为算法精度基准不可用。

**论断 G3（无法起身本身是独立预后指标）**：与非跌倒者相比，无法起身的独立危险因素包括年龄 ≥ 80（adjusted RR 1.6, 95% CI 1.2–2.1）、抑郁（RR 1.5, 1.1–2.0）、平衡与步态差；无法起身的跌倒者更易死亡、住院、出现持续 ≥ 3 天的 ADL 下降。

- 出处：Tinetti ME, Liu WL, Claus EB. *Predictors and prognosis of inability to get up after falls among elderly persons.* JAMA 1993;269(1):65–70. DOI [10.1001/jama.1993.03500010075035](https://doi.org/10.1001/jama.1993.03500010075035)（PMID [8416408](https://pubmed.ncbi.nlm.nih.gov/8416408/)）
- **原始条件**：1103 名 ≥72 岁社区居民（New Haven），平均 21 个月随访。**社区人群，问卷/随访，非仪器。**

**论断 G4（照护机构中的在地时长）**：住民跌倒后未使用呼叫器时平均在地 28 ± 25.4 分钟（范围 2–59），使用呼叫器时 11 ± 9.2 分钟（3–38）；无人能自行起身。

- 出处：Vlaeyen 等的原始数据，本文**经由** BMC Geriatr 2024 scoping review 转引（DOI [10.1186/s12877-024-05395-2](https://doi.org/10.1186/s12877-024-05395-2)）。**未读 Vlaeyen 原文，标注为二手转述。**

### 2.8 为什么单帧 lying ≠ 跌倒

**论断 H1（定义层面就不成立）**：WHO 的跌倒定义是 *"an event which results in a person coming to rest **inadvertently** on the ground or floor or other lower level."*

- 出处：WHO Falls fact sheet <https://www.who.int/news-room/fact-sheets/detail/falls>
- ProFaNE 共识把跌倒的统一定义与结局数据集标准化：Lamb SE, Jorstad-Stein EC, Hauer K, Becker C. *Development of a common outcome data set for fall injury prevention trials: the Prevention of Falls Network Europe consensus.* J Am Geriatr Soc 2005;53(9):1618–1622. DOI [10.1111/j.1532-5415.2005.53455.x](https://doi.org/10.1111/j.1532-5415.2005.53455.x)（PMID [16137297](https://pubmed.ncbi.nlm.nih.gov/16137297/)）——**该共识定义的逐字原文本次未取得（Wiley 403、PubMed 摘要未含定义句），标注为「未读定义原句」；此处只用 WHO 的逐字定义。**
- **推论（这是本节最重要的一条）**：`inadvertently` / `unexpected` 是**意图属性**，**在任何几何观测里都不可观测**。一个 65 岁的人主动躺到地板上做拉伸、在沙发上侧躺看电视、蹲下捡东西后坐到地上休息——几何上与跌倒后的终态**无法区分**。因此**「单帧躺姿 → 跌倒」在定义层面就是错误的推理**，不是精度问题。

**论断 H2（真实世界数据层面也不成立）**：13 个已发表的加速度计跌倒检测算法在 29 次真实跌倒上重测，sensitivity 跌到 **57.0% ± 27.3%**（最高 82.8%），而这些算法原文报告的是 76–97%；24 小时监测中不同算法每天误报 5–85 次。原文明确指出：许多真实跌倒**并不产生算法期待的「躺姿」特征**——受试者常跌坐在臀部、跪姿、或倚在家具上，从未进入用于确认跌倒的垂直加速度区间（≤ 0.5 g），导致即使冲击被正确检测也判定失败。

- 出处：Bagalà F, Becker C, Cappello A, et al. *Evaluation of accelerometer-based fall detection algorithms on real-world falls.* PLoS ONE 2012;7(5):e37062. DOI [10.1371/journal.pone.0037062](https://doi.org/10.1371/journal.pone.0037062)（PMID [22615890](https://pubmed.ncbi.nlm.nih.gov/22615890/)）
- **原始条件**：15 名高跌倒风险老人（均值 66.4 ± 6.2 岁）的真实跌倒；对照是这些算法**在模拟跌倒上的原始报告值**。
- **推论**：**（i）** 姿态终态不是躺的跌倒占相当比例（跌坐、跪倒、靠家具）；**（ii）** 用模拟跌倒调出来的阈值到真实场景会显著退化；**（iii）** 论文报告的准确率与本项目无关，**禁止引用为 Reme 的指标**。

**论断 H3（前置姿态也不成立）**：见 F4——12% 的跌倒发生在「正在坐下」中，13% 在静止站立中；即「standing → lying」既非充分也非必要。

### 2.9 单目/无标记姿态估计本身的误差与官方边界

**论断 I1（关键点定位误差）**：与光学标记式动捕相比，主流姿态估计方法的关节中心系统偏差：髋 OpenPose 29–36 mm / AlphaPose 31–36 mm / DeepLabCut 43–53 mm；膝 29–41 / 27–48 / 35–58 mm；踝 14–23 / 14–36 / 15–52 mm。作者结论：*"markerless pose estimation using the methods described in this study do not yet match the performance of marker-based motion capture at all joint centres."*

- 出处：Needham L, Evans M, Cosker DP, et al. *The accuracy of several pose estimation methods for 3D joint centre localisation.* Sci Rep 2021;11:20673. DOI [10.1038/s41598-021-00212-x](https://doi.org/10.1038/s41598-021-00212-x)（PMC [8526586](https://pmc.ncbi.nlm.nih.gov/articles/PMC8526586/)）
- **原始条件**：**多机位 200 Hz 同步高速摄像 + 三维重建**（比 Reme 好得多的条件），健康成人走/跑/跳。原文**只评估位置误差，未报告角度误差**。
- **推论（本文推导）**：肩中点–髋中点的躯干段长约 0.45–0.55 m。若两端各有 ~30 mm 的独立定位噪声，端点相对误差合成 ≈ √2 × 30 ≈ 42 mm，对应的**角度噪声量级 ≈ atan(0.042/0.50) ≈ 4.9°**（1σ 级别，在**多机位三维**条件下）。大腿段更短（约 0.40 m）且髋膝误差更大，角度噪声更高。**单目 2D + Lightning 级模型的角度噪声只会更大，不会更小。** 因此任何比 5–10° 更细的角度分箱在本项目里没有意义。

**论断 I2（MoveNet 官方边界，逐字）**：

- 出处：MoveNet.SinglePose Model Card（Google 官方 PDF，全文已读）：<https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf>
- 官方逐字要点：
  - 输出张量最后一维前两通道是 **`yx` 顺序**（"the yx coordinates (normalized to image frame, i.e. range in [0.0, 1.0])"）——**注意与我方 schema 的 `x_norm, y_norm` 顺序相反，需确认 A 角色的转换正确。**
  - *"Most suitable for detecting the pose of a single person who is **3ft ~ 6ft** away from a device's webcam"* → **官方最佳距离约 0.9–1.8 m**。Reme 的固定室内机位通常 2–5 m，**已在官方声明的适用范围之外**。
  - *"The model predicts 17 human keypoints of the full body **even when they are occluded**… A confidence threshold (**recommended default: 0.3**) can be used to filter out unconfident predictions."* → **被遮挡的点会被「补全」出来，score 是唯一的护栏。**
  - *"Tuned to be robust on detecting **fitness/fast movement**…"*；训练集为 COCO 2017（滤除 ≥3 人后 28k 图）+ 23.5k 张 YouTube **健身/瑜伽/舞蹈**图。**训练分布里没有「跌倒后躺在地板上的老年人」。**
  - 公平性表：COCO val 单人集上 Lightning 的 keypoint mAP 为 65.4–74.4（按性别/年龄/肤色分组）；Active 集上 85.7–92.9。**「Old」组在 Active 集只占 1.9%。**
  - 越界用途逐字：*"**Any form of surveillance or identity recognition is explicitly out of scope and not enabled by this technology.**"* → **这条必须进 Reme 的合规叙述**：产品定位必须是「居家照护对象在知情同意下的动作事实提取」，不能表述为监控。

**论断 I3（2D 视频测角的公认限制）**：2D 视频分析在**矢状面且运动方向与相机垂直**时与 3D 有较好一致；在额状面/横断面（身体旋转）时准确性低。

- 出处：Michelini A, Eshraghi A, Andrysek J. *Two-dimensional video gait analysis: A systematic review of reliability, validity, and best practice considerations.* Prosthet Orthot Int 2020;44(4):245–262. DOI [10.1177/0309364620921290](https://doi.org/10.1177/0309364620921290)（**未读全文，本次会话该站点连接失败；仅见检索摘要转述**）
- 另见 J Biomech 2023 关于跑步 2D 测角效度的系统综述与 meta 分析：<https://doi.org/10.1016/j.jbiomech.2023.111716>（**未读原文**）。
- **原始条件**：这些结论建立在「受试者相对相机的朝向是已知且受控的」前提上。Reme 的老人**在房间里任意朝向**，这个前提不成立。

---

## 3 在单目 2D COCO-17 下可观测 / 代理 / 不可观测的逐项判定

判定口径：
- **可观测**：能从 `(x_norm, y_norm, score)` 与帧号直接算出，且其数值含义不依赖未知相机参数。
- **投影代理**：能算出一个数，但它是真实物理量经未知投影后的像，数值随机位/人朝向系统性漂移。
- **不可观测**：没有任何函数能从本输入恢复，包括「加更多规则」也不行。

| # | 物理/临床量 | 判定 | 说明与失真机制 |
|---|---|---|---|
| 1 | **时间**（时长、静止时长、跨越某落差所需时间） | **可观测** | 帧率已知即可。**这是本输入下唯一未被投影破坏的物理量。**（30 FPS 下 0.583 s 的跌倒下降期 ≈ 17.5 帧；5–10 Hz 输出只有 3–6 个样本 → **时序判别必须在 30 Hz 内部管线上做，不能在 5–10 Hz 输出上做**） |
| 2 | 关键点存在性与 `score` 统计 | **可观测** | 但 `score` 不是校准过的概率；官方明确遮挡点也会被补出（I2）。只能当「可用性护栏」，不能当置信度。 |
| 3 | 图像内**长度比**（如 `‖肩中–髋中‖ / ‖髋中–踝中‖`） | **可观测（比值）** / 投影代理（对应到解剖比例） | 比值消掉了像素尺度，但**没有**消掉透视前缩：段长按 `√(1 − sin²θ·sin²φ)` 收缩（θ=真实倾角，φ=出平面方位角）。 |
| 4 | 关键点集合的形状统计（PCA 主轴方向、扁率、包围盒长宽比） | **投影代理** | 对应「身体长轴相对重力的方向」。仰赖图像竖直 ≈ 重力竖直，这在**相机有俯仰/滚转 + 透视**时不成立。 |
| 5 | **躯干倾角** θ_trunk（肩中–髋中 vs 图像竖直） | **投影代理** | 对应 ISO 11226 的 trunk inclination（C1）。失真：`tan θ' = tan θ · cos φ`。**且它对应的是肩–髋连线，不是腰椎屈曲角**（C3）。 |
| 6 | **大腿倾角** θ_thigh（髋–膝 vs 图像竖直） | **投影代理** | 对应 activPAL/Acti4 的核心量（A1–A3）。**双峰结构在投影下被抹平**：站立（真实 ~0–15°）在 φ 任意时投影仍接近竖直，但坐姿（真实 ~90°）在 φ→90° 时段长趋 0、角度数值奇异；中间朝向会把两峰之间填满。 |
| 7 | 髋/膝**内含角**（2D 三点夹角） | **投影代理** | 与解剖学关节角不同，且**永远小于等于**真实三维夹角（投影只会压缩夹角，不会放大）。 |
| 8 | 帧间关键点位移速率（归一化单位/秒） | **投影代理** | 对应质心速度。**深度方向的运动几乎不产生像素位移**（一个朝相机方向倒下的人在图像里可能几乎不动）。 |
| 9 | 真实**重力方向** | **不可观测** | 只有「图像竖直」。相机俯仰使世界竖直线汇聚到有限的消失点，画面边缘的竖直物体在图像里是倾斜的；相机滚转直接整体旋转。**无内外参 → 无法纠正。** |
| 10 | **深度 / 出平面方位角 φ** | **不可观测** | 因此 §3 中每一个「投影代理」的**失真量本身也不可估计**。这是最关键的一条：我们不仅角度错了，还**不知道错了多少**。 |
| 11 | **米制尺度**（m、m/s、身高） | **不可观测** | 无标定、无参照物。→ 不可能计算 CoM 垂直速度 (m/s)，不可能与 2.14 m/s 这类文献值比较。 |
| 12 | **质心（CoM）位置与速度** | **不可观测** | CoM 需要节段质量分布 + 三维位置。2D 关键点几何中心 ≠ CoM，且缺尺度。 |
| 13 | **seat-off 事件**（Schenkman Phase I/II 分界） | **不可观测** | 定义为臀部离开座面，需要座面接触信息（测力台/座垫传感器）。2D 里没有「座面」这个对象。可尝试的代理（髋点 y 开始单调上升）**不是同一事件**，会有系统性提前/滞后。 |
| 14 | **最大踝背屈**（Phase II/III 分界） | **不可观测** | 踝角在 2D 里被鞋、地面遮挡、投影三重破坏；且 Needham 2021 显示即使多机位三维，踝定位误差仍 14–52 mm。 |
| 15 | **地面反作用力 / 冲量 / 冲击部位** | **不可观测** | Kralj 1990 的事件体系原理上不可复现（D2）。 |
| 16 | **地面平面位置 / 人离地高度** | **不可观测（未标定时）** | 「躺在地上」vs「躺在床上/沙发上」在无标定单目下无法区分——而这两者的临床意义完全不同。**这是 Reme 的一个必须承认的能力缺口。** |
| 17 | **仰卧 / 侧卧 / 俯卧 子类** | **严重有偏，实质不可观测** | 需要绕身体长轴的旋转角（Lyden 用 ±65°，B1）。2D 里只能靠面部关键点（0–4）可见性和左右肩/髋的前后遮挡顺序弱推断；在固定机位 + 低分辨率下极不稳定。**建议不输出子类。** |
| 18 | **「inadvertently / unexpected」（跌倒的意图属性）** | **根本不可观测** | WHO 定义的核心成分（H1）。**没有任何几何特征能恢复意图。** 这是「单帧 lying ≠ 跌倒」的定义级理由。 |
| 19 | **是否受伤 / 是否失去意识** | **根本不可观测** | 属于医疗判断，Reme 红线内禁止推断。 |
| 20 | **腰椎屈曲角 (lumbar flexion)** | **不可观测** | COCO-17 没有脊柱点。只能得到 5 号量（肩–髋连线倾角），二者在「髋铰链式前屈」时差异极大。 |

### 3.1 两层角度失真的定量形式（本文推导，必须写进代码注释）

**第一层：归一化坐标的长宽比畸变（可完全消除）**

设图像 W×H 像素，`x_norm = x_px/W`、`y_norm = y_px/H`。段的像素增量 `(Δx_px, Δy_px)`，则

```
tan θ_pixel = Δx_px / Δy_px
tan θ_norm  = (Δx_px/W) / (Δy_px/H) = (H/W) · tan θ_pixel
```

16:9 时 `H/W = 0.5625`：

| 真实像素角（离竖直） | 直接在 norm 坐标上算出的角 |
|---|---|
| 20° | **11.6°** |
| 45° | **29.4°** |
| 60° | **44.3°** |
| 65° | **50.3°** |

反过来：在 norm 坐标里量到 45°，真实像素角是 `atan(1/0.5625) = 60.6°`。**这是一个静默的、系统性的、幅度巨大的错误。**
**修复**：所有几何计算前先做 `u = x_norm · (W/H)`、`v = y_norm`。**当前 `FrameLandmarks` schema 不含 `image_width/image_height`，必须向 A 角色补充该字段（或至少 `aspect_ratio`），否则 B/C 侧无法正确还原任何角度。这是本次调研发现的最高优先级接口缺口。**

**第二层：出平面前缩（不可完全消除）**

正交投影近似下，设段的真实倾角为 θ（相对重力竖直），其水平分量相对图像平面的方位角为 φ，则

```
tan θ' = tan θ · cos φ                     （投影角）
L'     = L · √(1 − sin²θ · sin²φ)          （投影长度）
```

| θ (真实) | φ=0° | φ=30° | φ=45° | φ=60° | φ=75° | φ=90° |
|---|---|---|---|---|---|---|
| 20° | 20.0° | 17.5° | 14.4° | 10.3° | 5.4° | 0° |
| 45° | 45.0° | 40.9° | 35.3° | **26.6°** | 14.5° | 0° |
| 65° | 65.0° | 61.7° | 56.6° | **47.0°** | 29.0° | 0° |
| 90° | 90.0° | 90.0° | 90.0° | 90.0° | 90.0° | **奇异（L′=0）** |

三条必须记住的结论：
1. **θ=90°（完全水平的躺姿）在正交投影下角度不变，但长度按 cos φ 收缩，φ→90°（沿光轴躺）时段长趋 0、角度完全由噪声决定。** → **「头朝相机躺」是本系统最危险的失效模式**：躯干投影极短、方向随机，可能表现为「竖直」，被判成 standing。
2. **中间角度被系统性低估**：45° 在 φ=60° 时只剩 26.6°。→ 直接搬 45° 阈值会**把坐姿判成站立**，方向与 activPAL 「伸直腿坐 → 70% 判为站立」的错误一致（A3），但机制不同。
3. **透视（非正交）还会额外引入位置相关的倾斜**：相机俯仰使世界竖直线汇聚于有限消失点，画面边缘的竖直段在图像中倾斜。倾斜量取决于未知的焦距与俯仰角，**不可估计**，只能通过「加宽死区 + 拒判」或「每个安装点做一次校准」来吸收。

---

## 4 可直接编码的量与公式（COCO-17 索引）

约定：索引 `0 nose, 1 Leye, 2 Reye, 3 Lear, 4 Rear, 5 Lsho, 6 Rsho, 7 Lelb, 8 Relb, 9 Lwri, 10 Rwri, 11 Lhip, 12 Rhip, 13 Lkne, 14 Rkne, 15 Lank, 16 Rank`。

### 4.0 预处理（强制）

```python
AR = W / H                      # 必须由 A 提供；缺失则整条链路的角度不可用
u_j = kp[j].x_norm * AR
v_j = kp[j].y_norm              # v 向下为正
s_j = kp[j].score
USE = 0.3                       # MoveNet 官方推荐默认阈值（Model Card 逐字）
```

置信加权中点（两侧都不可用时返回 None，并向上冒泡为 `unknown`）：

```python
def mid(a, b):
    wa, wb = max(s[a]-USE, 0), max(s[b]-USE, 0)
    if wa + wb == 0: return None
    return ((wa*u[a] + wb*u[b])/(wa+wb), (wa*v[a] + wb*v[b])/(wa+wb))

S  = mid(5, 6)     # 肩中点
Hc = mid(11, 12)   # 髋中点
K  = mid(13, 14)   # 膝中点
A  = mid(15, 16)   # 踝中点
Hd = mid(3, 4) or (u[0], v[0])   # 头点：优先双耳中点，退化到鼻
```

### 4.1 段倾角（相对**图像**竖直向下，0°=指向图像下方，90°=水平，180°=指向上方）

```python
def seg_angle(p, q):            # 从 p 指向 q
    du, dv = q[0]-p[0], q[1]-p[1]
    L = hypot(du, dv)
    if L < L_MIN: return None, L # 尺度塌缩 → 拒判（见 4.6）
    return degrees(acos(dv / L)), L
```

| 量 | 定义 | 对应文献量 | 直立时 | 坐姿时 | 躺姿时 |
|---|---|---|---|---|---|
| `theta_trunk` | `seg_angle(S, Hc)` | ISO 11226 trunk inclination 的投影（§2.3 C1） | ≈ 0–20° | ≈ 0–40° | ≈ 60–90° |
| `theta_thigh_L/R` | `seg_angle(hip_i, knee_i)` | activPAL/Acti4 大腿倾角的投影（§2.1） | ≈ 0–20° | ≈ 60–90° | ≈ 60–90° |
| `theta_shank_L/R` | `seg_angle(knee_i, ankle_i)` | — | ≈ 0–15° | ≈ 0–30° | ≈ 60–90° |
| `theta_head_trunk` | `seg_angle(Hd, S)` 的补角 | 头–躯干轴 | ≈ 0–15° | ≈ 0–20° | ≈ 60–90° |

**注意 `theta_trunk` 在坐姿与站姿高度重叠**——这正是 §2.1 说明大腿段才是判别器的原因。`theta_thigh` 在坐姿与躺姿高度重叠——这正是 §2.2 说明需要第二自由度的原因。**两个量都不能单独用；必须联合。**

### 4.2 关节内含角（投影代理，永远 ≤ 真实三维角）

```python
def joint_angle(a, b, c):       # b 为顶点
    v1 = (a[0]-b[0], a[1]-b[1]); v2 = (c[0]-b[0], c[1]-b[1])
    n1, n2 = hypot(*v1), hypot(*v2)
    if n1 < L_MIN or n2 < L_MIN: return None
    cosv = (v1[0]*v2[0] + v1[1]*v2[1]) / (n1*n2)
    return degrees(acos(clamp(cosv, -1, 1)))

hip_angle_L  = joint_angle(S,  (u[11],v[11]), (u[13],v[13]))   # 肩–髋–膝
knee_angle_L = joint_angle((u[11],v[11]), (u[13],v[13]), (u[15],v[15]))
```

参考量级（**三维真实值**，仅作方向性先验，**不得作为 2D 阈值**）：站立 hip≈175°、knee≈178°；标准坐姿 hip≈90–110°、knee≈85–100°；深蹲 hip<90°、knee<80°；髋铰链式弯腰 hip≈70–110° 但 **knee 仍 >150°**（这是区分 bending 与 crouching 的核心几何差异）。

### 4.3 身体形状统计量（躺姿的主要证据）

```python
P = [(u_j, v_j) for j in range(17) if s_j >= USE]
# 主轴：2x2 协方差特征分解
lam1 >= lam2, e1 = 主特征向量
axis_angle   = degrees(acos(abs(e1 · (0,1))))   # 0°=主轴沿图像竖直, 90°=水平
elongation   = sqrt(lam2 / lam1)                # 0=线状, 1=各向同性
bbox_w = max(u)-min(u); bbox_h = max(v)-min(v)
bbox_ratio = bbox_h / max(bbox_w, EPS)
```

| 量 | standing | sitting | lying | bending/crouching |
|---|---|---|---|---|
| `axis_angle` | 小 | 中（不稳定） | **大** | 中–大 |
| `elongation` | **小**（细长） | 大（折叠） | **小**（细长） | 大 |
| `bbox_ratio` | **大** | 中 | **小** | 中–小 |

关键：`(axis_angle, elongation)` 联合能把 standing 与 lying 分开（都细长，但主轴方向正交），而 `elongation` 大是 sitting/bending 的共同标志。**这三个量彼此不独立，但它们的失效模式不同**，适合做投票而非加和。

### 4.4 尺度不变的高度代理

```python
L_torso = ||S - Hc||
L_leg   = ||Hc - A||    # 髋到踝
S_ref   = 会话级 robust 尺度参考 = rolling_p90( max_pairwise_dist(P) )   # 见 4.6
h_hip_norm  = (v_A - v_Hc) / S_ref      # 髋相对踝的图像竖直落差 / 会话尺度
r_torso_leg = L_torso / max(L_leg, EPS)
compactness = max_pairwise_dist(P) / S_ref     # 瞬时尺度 / 会话参考
```

`compactness` 是**最重要的护栏量**：躺姿沿光轴时它会塌到 0.4–0.5 以下；这是「我看不清」的直接信号，应触发 `unknown` 而不是猜。

### 4.5 时序量（本输入下最可辩护的一类）

**核心设计原则：用「跨越一个归一化落差所需的时间」，不要用「像素速度」。**

```python
# 在 30 Hz 原始序列上计算（不要在 5-10 Hz 输出上算）
d(t)   = v_Hc(t) / S_ref                       # 髋中点的归一化竖直位置
# 找到最近的单调下降段 [t1, t2]，落差 D = d(t2) - d(t1)
# 特征 1：达到某个参考落差 D0 所需时间
T_drop(D0) = min{ t2 - t1 : d(t2) - d(t1) >= D0 }
# 特征 2：静止度
m(t) = median_j( ||p_j(t) - p_j(t - 0.2s)|| ) / S_ref
still(t) = 1 if m(t) < m_thr else 0
still_duration = 连续 still 的秒数
```

**文献锚定（用于设计特征的量级，不是用于设阈值）：**

| 事件 | 文献时长 | 出处 | 30 FPS 帧数 |
|---|---|---|---|
| 真实跌倒：失衡起点 → 骨盆着地 | 1271 ± 648 ms | Choi 2015 | ≈ 38 帧 |
| 真实跌倒：**下降开始 → 骨盆着地** | **583 ± 255 ms** | Choi 2015 | **≈ 17.5 帧** |
| 自选速度起立 | 1.91 s | Kerr 1997（摘要转述） | ≈ 57 帧 |
| 自选速度坐下 | 1.97 s | Kerr 1997（摘要转述） | ≈ 59 帧 |
| 最大努力单次起立（FTSTS 推算） | ≈ 1.1–1.5 s | Bohannon 2006 推算 | ≈ 33–45 帧 |
| 跌倒后静止 → 能自行起身（中位） | 10.5 s | Schwickert 2017 | — |
| 跌倒后静止 → **不能**自行起身（中位） | 34.5 s | Schwickert 2017 | — |
| **静止 > 24.5 s 预测无法起身** | 24.5 s | Schwickert 2017 | — |

**可分性论证**：正常坐下（1.97 s）与跌倒下降（0.583 s）差 3.4×；即便取跌倒的慢尾（0.583+0.255=0.838 s）与最大努力起立的快端（1.1 s），仍有 1.3× 间隔。**在 30 FPS 下这是可测的；在 5–10 Hz 输出上就不是了（0.583 s 只有 3–6 个样本）。**

**自由落体现实修正（写进注释，防止有人加错阈值）**：
```
落差 h ≈ 0.75 m  →  自由落体 t = 0.391 s, v = 3.84 m/s
实测（Choi 2015）  t = 0.583 s (×1.49), v = 2.14 m/s (×0.56)
→ 真实跌倒是被显著阻尼的。任何以 √(2gh) 为准的速度阈值都会偏高、漏检。
→ 且本项目无米制尺度，m/s 根本不可计算。禁止在代码里出现 9.81。
```

### 4.6 拒判（`unknown`）的强制触发条件

这不是可选项，是本调研认为的**产品红线的技术落实**：

```python
def must_reject(frame) -> bool:
    return any([
        landmark_quality == "unavailable",
        not person_detected,
        visible_keypoint_ratio < R_MIN,                    # 校准
        (S is None) or (Hc is None),                       # 躯干不可定位
        compactness < C_MIN,                               # 尺度塌缩（沿光轴）
        L_torso < L_MIN,                                   # 段长退化 → 角度奇异
        (K is None and A is None),                         # 下肢完全不可见 → 无法用大腿判据
        deadband_hit,                                      # 落在阈值死区（见 §5）
        AR is None,                                        # 长宽比缺失 → 角度无意义
    ])
```

`unknown` 必须是**一等标签**，不是 fallback；`posture_confidence` 在 `unknown` 时应报告实际低值而非 0。

---

## 5 阈值与参数：文献先验 / 必须校准 / 禁止硬编码

### 5.1 有文献先验，但**只能作为「存在拐点」的方向性提示**

| 参数 | 文献值 | 来源 | 在 2D 下是否成立 |
|---|---|---|---|
| 大腿倾角分界 | **离竖直 45°**（Acti4）；离水平 40°/10° 滞回（activPAL）；离水平 50–60°（ActiGraph） | Skotte 2014 / Radtke 2021 | **不成立为数值。** 只成立为「大腿倾角是最强的 sit/stand 判别量」这一结构性结论。数值被 §3.1 两层失真扭曲，且失真量不可估计。 |
| 躺姿的第二自由度阈值 | 大腿绕长轴 **±65°** | Lyden 2016 | **不可迁移**（我们没有绕长轴旋转这个量）。可迁移的是**方法论**：躺的判据应基于时间窗内的姿态变化，而非单帧。 |
| 躯干倾角风险带 | < 20° / 20–60° / > 60° | ISO 11226 | **不成立为分类阈值**（原本就是暴露–风险标准，不是分类标准），且被投影扭曲。 |
| 「弯腰」的观察法门槛 | 背部前屈 > 20° | OWAS (Karhu 1977) | 同上，且 OWAS 本身是人工粗判。 |
| 跌倒下降期时长 | 583 ± 255 ms | Choi 2015 | **成立**（时间不被投影破坏）。可作为窗口长度与特征尺度的设计依据。 |
| 正常起立/坐下时长 | 1.91 / 1.97 s | Kerr 1997 | **成立**（同上）。 |
| 静止 > 24.5 s 预测无法起身 | 24.5 s | Schwickert 2017 | **成立为时间尺度**，但它是「能否起身」的阈值，**不是「是否跌倒」的阈值**。 |
| 长躺分档 | < 5 min / 5 min–1 h / 1–2 h / > 2 h | Fleming 2008（沿用 Nevitt） | **成立为上报分档的临床合理性**。 |
| MoveNet 关键点可用阈值 | **0.3** | MoveNet Model Card（官方逐字） | **成立**（是模型自身的推荐值，与相机几何无关）。仍应在验证集上确认。 |

### 5.2 **必须**在本项目验证集上校准的参数（不得从文献抄）

全部几何阈值，无一例外：

- `theta_thigh` 的 sit/stand 判别点与其**死区宽度**（建议初始死区不小于 ±15°，理由见 I1 的角度噪声推导 ≈ 5° 以及 §3.1 的投影失真）
- `theta_trunk` 的 upright/bending 判别点与死区
- `axis_angle`、`elongation`、`bbox_ratio` 的分界
- `compactness`（`C_MIN`）、`L_MIN`、`R_MIN`（visible_keypoint_ratio 下限）
- `m_thr`（静止判定的归一化位移阈值）与 `still` 的时间平滑窗
- `T_drop(D0)` 中的参考落差 `D0` 与判别时间
- 所有平滑/迟滞参数（滞回带宽、最小驻留时长）

**校准协议要求（否则校准出来的阈值也不可辩护）**：
1. 验证集必须覆盖**多个机位高度与俯仰角**、**人相对相机的多个朝向（至少 0°/45°/90° 三档方位）**；否则你校准到的是这一个机位的阈值。
2. 必须显式收集 §3 表格里标注的**已知失效场景**：伸直腿坐、沿光轴躺（头朝/脚朝相机）、蹲下、坐在地上、俯身捡物、坐在低矮沙发上。
3. 阈值必须报告**在不同机位子集上的漂移量**；漂移大的量降权或不用。
4. 任何单一样本量 < 30 的类别不得用于设定阈值，只能用于报告失败案例。

### 5.3 **禁止**硬编码的量（写进 code review checklist）

- 任何 `9.81` / `√(2gh)` / 米制速度阈值 —— §4.5 已论证不可计算且会偏高。
- 任何直接来自文献的角度常量（45 / 65 / 20 / 60）出现在几何判据里而没有「本项目校准后覆盖」的注释。
- 任何在**未做长宽比校正**的 `x_norm, y_norm` 上计算的 `atan2` —— §3.1 第一层。
- 任何「`posture_before == standing and posture_after == lying` → 跌倒」的硬规则 —— §2.6 F4 已证明其在设计上漏掉 ≥ 25% 的真实跌倒场景。
- 任何把 `score` 当作校准概率来相乘/取阈的做法（官方明确遮挡点也会被补出）。
- 任何从文献抄来的准确率数字进入本项目的 README / 演示话术。

---

## 6 对 Reme 的取舍建议与风险

### 6.1 建议采纳（按优先级）

**R1｜先补接口，再谈算法。** `FrameLandmarks` 必须携带 `image_width` / `image_height`（或 `aspect_ratio`）。没有它，B/C 侧算出的每一个角度都被系统性压缩（16:9 下 45°→29.4°），且这个错误是静默的。**这是本次调研发现的最高优先级问题。** 顺带确认 A 角色是否正确处理了 MoveNet 输出的 `yx` 顺序（官方 Model Card 逐字为 `yx`，我方 schema 为 `x_norm, y_norm`）。

**R2｜静态分类采用「大腿主判 + 形状复核 + 强制死区」的三层结构，而不是单阈值。**
- 第一层：`theta_thigh`（双侧置信加权）→ 这是文献最强的判别量（§2.1）。
- 第二层：`(axis_angle, elongation, bbox_ratio)` 投票 → 解决 sitting/lying 在大腿倾角上的重合（§2.2）。
- 第三层：`compactness` + `visible_keypoint_ratio` + 死区 → 强制拒判（§4.6）。
- **不要**训练一个直接吃 34 维原始坐标的黑箱分类器作为第一版：它会把机位几何学进去，换个机位就崩，而且无法向评审解释。**先做可解释的几何 + 校准阈值，再考虑用小模型替换。**

**R3｜时序判别放在 30 Hz 内部管线，输出降到 5–10 Hz。** 跌倒下降期 583 ms 在 30 FPS 下是 17.5 帧、在 10 Hz 下只有 5.8 帧、在 5 Hz 下只有 2.9 帧。**在输出频率上做时序判别等于自毁。**（§4.5）

**R4｜`fall_like_transition` 的定义不要绑定 `standing → lying`。** 按 Robinovitch 2013，12% 的跌倒发生在「正在坐下」时、13% 在静止站立时。建议定义为「**在异常短的时间内完成了异常大的归一化竖直落差，且随后进入低运动状态**」，前置姿态作为证据字段而非门槛。同时保留现有合同约束「`lying` 单独存在时不得生成跌倒事件」——这条约束**被 WHO 的定义直接支持**（§2.8 H1），应在文档里标注其临床依据，这是一个可以拿出去讲的加分项。

**R5｜把产品价值锚点从「跌倒瞬间检测」移到「静止时长 + 无人应答」。** 老年医学文献的支持强度在这一侧压倒性地高：Fleming 2008（80% 无法自起、30% 长躺 ≥1h、长躺 aOR 4.2、97% 长躺未按呼叫器）、Tinetti 1993（无法起身独立预测死亡/住院/ADL 下降）、Schwickert 2017（静止 > 24.5 s 预测无法起身）。**「跌倒瞬间」难测且已有大量失败先例（Bagalà 2012：真实场景 sensitivity 掉到 57%）；「静止很久且没人来」既好测又是真正的临床终点。** 这一条建议同时降低技术风险与医疗声明风险。

**R6｜明确声明能力边界，把它当特性而非缺陷。** 建议在 README / 演示里逐条写清：不区分仰/侧/俯；无法区分「躺在地上」与「躺在床/沙发上」（无标定单目的固有限制）；不推断意图、不推断受伤；证据不足时输出 `unknown`。**§2.3 C4 显示临床自己就把 15–60° 当作 lying↔sitting 的过渡带**，所以在这一带拒判是符合临床直觉的，不是能力不足。

**R7｜合规叙述必须避开「监控」。** MoveNet 官方 Model Card 逐字写明 *"Any form of surveillance or identity recognition is explicitly out of scope and not enabled by this technology."* Reme 使用 MoveNet 就必须与这句话一致：定位为「知情同意下的居家动作事实提取」，不得表述为监控产品。

### 6.2 主要风险（按严重度）

**风险 1（严重，几乎必然发生）｜沿光轴躺 → 判成 standing。**
机制：θ=90° 时投影长度按 cos φ 收缩，φ→90° 时段长趋 0、角度由噪声决定（§3.1 第二层）。
缓解：`compactness` 与 `L_torso` 硬护栏 → `unknown`；机位选择上**避免让常用休息区（床、沙发）的长轴对准光轴**；演示脚本里回避这个机位。
**残留风险**：无法根除，必须写进文档。

**风险 2（严重）｜验证集只覆盖单一机位 → 阈值过拟合到机位几何。**
机制：§3.1 第二层的失真量随机位与人朝向变化且不可估计。
缓解：§5.2 的校准协议（多机位高度/俯仰/方位）。
**判据**：若某阈值在不同机位子集上的最优值漂移超过其死区宽度，该量不可单独使用。

**风险 3（中–严重）｜MoveNet 在本场景处于官方声明的适用范围之外。**
机制：官方最佳距离 3–6 ft（0.9–1.8 m），Reme 固定机位通常 2–5 m；训练分布是 COCO + YouTube 健身/瑜伽/舞蹈，**没有「跌倒后躺在地板上的老年人」**；Active 集里 "Old" 组只占 1.9%；遮挡点会被补全出来。
缓解：`score ≥ 0.3` 官方阈值 + `visible_keypoint_ratio` 护栏 + 在验证集上单独统计「躺姿帧」的关键点可用率并作为准入门槛。
**残留风险**：躺姿下的关键点质量可能系统性差于站姿，这会让 lying 类的召回天然偏低。**必须实测并在报告里披露，不得用整体准确率掩盖。**

**风险 4（中）｜把 sitting 与 bending_or_crouching 混淆。**
机制：两者的 `elongation` 都大、`theta_thigh` 都偏离竖直。真正的区分在膝：髋铰链式弯腰 hip≈70–110° 而 **knee > 150°**；蹲 knee < 80°；坐 knee ≈ 85–100°。
缓解：把 `knee_angle` 作为该二分的主判据，并接受它在下肢被家具遮挡时不可用 → `unknown`。
**注意**：坐在椅子上时膝盖常被桌子/自身遮挡，`knee_angle` 可用率可能很低。**必须先测可用率再决定是否依赖它。**

**风险 5（中）｜时间特征被输出降采样破坏。** 见 R3。这是一个纯工程风险，代价是漏掉整个跌倒下降期。

**风险 6（中）｜团队在压力下引用文献准确率。**
Bagalà 2012 是最好的反例教材：13 个算法在自己论文里报 76–97%，在真实跌倒上掉到 57.0% ± 27.3%，每天误报最多 85 次。**任何「文献说这类方法能到 9x%」的话术都必须被拦下。** 本项目只能报告自己验证集上的数字，并说明验证集构成与规模。

### 6.3 不建议做的事

- 不要试图从单目 2D 恢复米制速度或 CoM 高度（§3 第 11、12 项，不可观测）。
- 不要输出仰/侧/俯子类（§3 第 17 项）。
- 不要基于姿态推断「是否受伤」「是否失去意识」（红线）。
- 不要把 Schenkman 四期作为**可检测的状态机**实现——它的两个关键分界事件（seat-off、最大踝背屈）在本输入下不可观测（§3 第 13、14 项）。**四期模型的正确用法是解释「为什么起立需要 ~2 s 而跌倒只要 ~0.6 s」，而不是逐期检测。**
- 不要在第一版就上「多人」「跨房间」「区分床与地面」——都需要本输入不具备的信息。

---

## 附录 A：一手来源清单（含读取深度）

| # | 引用 | DOI / URL | 读取深度 |
|---|---|---|---|
| 1 | Schenkman et al. 1990, Phys Ther 70(10):638–648 | [10.1093/ptj/70.10.638](https://doi.org/10.1093/ptj/70.10.638) | 摘要全文（PubMed） |
| 2 | Kralj, Jaeger, Munih 1990, J Biomech 23(11):1123–1138 | [10.1016/0021-9290(90)90005-N](https://doi.org/10.1016/0021-9290(90)90005-N) | 摘要 |
| 3 | Kerr et al. 1997, Clin Biomech 12(4):236–245 | [10.1016/S0268-0033(96)00077-0](https://doi.org/10.1016/S0268-0033(96)00077-0) | **摘要转述（PubMed 被 reCAPTCHA 拦截，未直接打开）** |
| 4 | Millington et al. 1992, Arch Phys Med Rehabil 73(7):609–617 | [10.1016/0003-9993(92)90124-F](https://doi.org/10.1016/0003-9993(92)90124-F) | **未读原文，仅摘要转述** |
| 5 | Bohannon 2006, Percept Mot Skills 103(1):215–222 | [10.2466/pms.103.1.215-222](https://doi.org/10.2466/pms.103.1.215-222) | 摘要要点 |
| 6 | Grant et al. 2006, Br J Sports Med 40(12):992–997 | [10.1136/bjsm.2006.030262](https://doi.org/10.1136/bjsm.2006.030262) | 摘要全文（PubMed） |
| 7 | Skotte et al. 2014, J Phys Act Health 11(1):76–84 | [10.1123/jpah.2011-0347](https://doi.org/10.1123/jpah.2011-0347) | 摘要全文 |
| 8 | Lyden et al. 2016, Med Sci Sports Exerc 48(4):742–747 | [10.1249/MSS.0000000000000804](https://doi.org/10.1249/MSS.0000000000000804) | **全文（作者接受稿 PDF）** |
| 9 | Radtke et al. 2021, PLOS ONE 16(6):e0252659 | [10.1371/journal.pone.0252659](https://doi.org/10.1371/journal.pone.0252659) | 全文要点（含阈值与误分类表） |
| 10 | Crowley et al. 2019, Int J Behav Nutr Phys Act 16:65 | [10.1186/s12966-019-0835-0](https://doi.org/10.1186/s12966-019-0835-0) | 全文（算法描述部分） |
| 11 | Robinovitch et al. 2013, Lancet 381(9860):47–54 | [10.1016/S0140-6736(12)61263-X](https://doi.org/10.1016/S0140-6736(12)61263-X) | 摘要全文 |
| 12 | Choi, Wakeling, Robinovitch 2015, J Biomech 48(6):911–920 | [10.1016/j.jbiomech.2015.02.025](https://doi.org/10.1016/j.jbiomech.2015.02.025) | 摘要全文 |
| 13 | Becker et al. 2012, Z Gerontol Geriatr 45(8):707–715 | [10.1007/s00391-012-0403-6](https://doi.org/10.1007/s00391-012-0403-6) | 摘要 |
| 14 | Schwickert et al. 2017, Gerontology 64(1):90–95 | [10.1159/000478092](https://doi.org/10.1159/000478092) | 摘要全文 |
| 15 | Fleming & Brayne 2008, BMJ 337:a2227 | [10.1136/bmj.a2227](https://doi.org/10.1136/bmj.a2227) | **全文（PMC）** |
| 16 | Tinetti, Liu, Claus 1993, JAMA 269(1):65–70 | [10.1001/jama.1993.03500010075035](https://doi.org/10.1001/jama.1993.03500010075035) | 摘要 |
| 17 | Bagalà et al. 2012, PLoS ONE 7(5):e37062 | [10.1371/journal.pone.0037062](https://doi.org/10.1371/journal.pone.0037062) | 全文要点 |
| 18 | Lamb et al. 2005, J Am Geriatr Soc 53(9):1618–1622 | [10.1111/j.1532-5415.2005.53455.x](https://doi.org/10.1111/j.1532-5415.2005.53455.x) | **摘要；共识定义原句未取得** |
| 19 | WHO, Falls fact sheet | <https://www.who.int/news-room/fact-sheets/detail/falls> | 全文（定义逐字） |
| 20 | Skarpsno et al. 2017, Nat Sci Sleep 9:267–275 | [10.2147/NSS.S145777](https://doi.org/10.2147/NSS.S145777) | **摘要；全文 403 未读** |
| 21 | ISO 11226:2000 | <https://standards.iteh.ai/catalog/standards/iso/0bd9cbcd-32e5-4fa3-94ca-5ff699c55588/iso-11226-2000> | 标准页 + 公开样张；**正文条款经二手转述** |
| 22 | Seo et al. 1997, J Occup Health 39(1):51–56 | [10.1539/joh.39.51](https://doi.org/10.1539/joh.39.51) | 摘要全文 |
| 23 | Karhu et al. 1977, Appl Ergon 8(4):199–201 (OWAS) | <https://www.sciencedirect.com/science/article/abs/pii/0003687081900880>（1981 应用篇） | **未读原文，仅转述** |
| 24 | Needham et al. 2021, Sci Rep 11:20673 | [10.1038/s41598-021-00212-x](https://doi.org/10.1038/s41598-021-00212-x) | 全文要点（PMC） |
| 25 | Ariyanto et al. 2024, BMC Geriatr（video fall biomechanics scoping review） | [10.1186/s12877-024-05395-2](https://doi.org/10.1186/s12877-024-05395-2) | 全文要点（**综述**，用于分期框架与转引） |
| 26 | Michelini, Eshraghi, Andrysek 2020, Prosthet Orthot Int 44(4):245–262 | [10.1177/0309364620921290](https://doi.org/10.1177/0309364620921290) | **未读原文，仅检索摘要转述** |
| 27 | MoveNet.SinglePose Model Card（Google 官方） | <https://storage.googleapis.com/movenet/MoveNet.SinglePose%20Model%20Card.pdf> | **全文（逐字）** |

已排除信源：MDPI（含 Sensors、Applied Sciences）、Frontiers —— 检索过程中出现但未采用。

## 附录 B：本文自行推导、未直接引自文献的内容（需复核）

1. §3.1 两层角度失真的公式与数值表（长宽比畸变、`tan θ' = tan θ · cos φ`、`L' = L√(1 − sin²θ sin²φ)`）——标准投影几何，非文献引用。
2. §2.6 的自由落体现实修正算式（h=0.75 m 的假设来自「老年人站立骨盆高约 0.90 m、着地约 0.15 m」的常识估计，**该假设本身未经文献核实**）；比值 ×1.49 / ×0.56 依赖此假设。
3. §2.9 I1 的角度噪声推导（30 mm 位置误差 → ~4.9° 角度噪声）——由 Needham 2021 的位置误差与典型段长自行合成，**原文未报告角度误差**。
4. §2.4 D4 的「单次起立 1.1–1.5 s」由 FTSTS 参考值除以循环数推算，**Bohannon 原文未直接给出单次时长**。
5. §4 的全部代码骨架与阈值表中的「量级」列——为工程指引，**非文献数值，不得当作阈值**。
