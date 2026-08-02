# 认知增强层文献依据（ADR-0006 配套）

本文件是 [ADR-0006](../adr/0006-behavior-memory-home-cognition.md) 的证据台账：每一条进入代码的阈值、特征或产品主张，必须在这里能找到出处，或被明确标注为"工程约定，无文献支撑"。

## 使用规则（对答辩与对代码同时生效）

1. **阅读深度必须标注**：`[读全文]` / `[读摘要]` / `[未读原文]`。标注为"未读原文"的条目只能作书目锚点，**不得引用其定量结论**。
2. **文献数字不是产品指标**：任何论文报告的准确率、灵敏度、角度阈值都不得移植为 Reme 的性能承诺——原始条件（3D 动捕、力板、体戴传感器、实验室跌倒）与我们的输入（单目未标定摄像头、5-10 Hz 去标识姿态流）不同。
3. **文献支持的是"方向"，不是"数值"**：我们的常数是在文献给出的量级内自选的工程值，代码注释与本表都必须如实这样写。
4. 与文献不符的既有表述，以本表为准回改正文。

---

## R1 · Choi, Wakeling & Robinovitch (2015)

*Kinematic analysis of video-captured falls experienced by older adults in long-term care.* Journal of Biomechanics 48(6):911–920. DOI [10.1016/j.jbiomech.2015.02.025](https://doi.org/10.1016/j.jbiomech.2015.02.025) · PMID [25769730](https://pubmed.ncbi.nlm.nih.gov/25769730/) · `[读摘要]`

**报告的事实**：真实（非模拟）跌倒中，从失衡起点到骨盆着地 1271 ± 648 ms；**从下降开始到骨盆着地 583 ± 255 ms**。

**支撑我们的**：`behavior.py` 的下坠时长闸门 `FALL_DESCENT_MIN_MS=150` / `FALL_DESCENT_MAX_MS=2000`。上界取在均值 + 约 5.6σ 的宽松侧（宁可放过不合理筛除），下界 150 ms 是采样抖动地板，**两个数都是我们自选的工程值，文献只给出"下降相在数百毫秒量级"这一量级依据**。

**不支撑的**：不能宣称我们"测得"下降时长或冲击速度。同一批作者的输入是多相机视频 + 人工标注，我们的是上游转述的转换事件。

---

## R2 · Robinovitch, Feldman, Yang, et al. (2013)

*Video capture of the circumstances of falls in elderly people residing in long-term care: an observational study.* The Lancet 381(9860):47–54. DOI [10.1016/S0140-6736(12)61263-X](https://doi.org/10.1016/S0140-6736(12)61263-X) · PMID [23083889](https://pubmed.ncbi.nlm.nih.gov/23083889/) · `[读摘要]`

**报告的事实**：227 例真实跌倒的录像分析——跌倒并非都发生在行走中，相当比例发生于站立静止与坐下/起身过程。

**支撑我们的**：ADR-0005 与 ADR-0006 共同的立论——`standing→lying` 这一类"瞬间跌倒硬规则"在真实分布下覆盖不足，因此产品价值锚点必须落在**姿态后的持续状态**（静止时长、位置语义）而不是跌倒瞬间。

---

## R3 · Fleming & Brayne (2008)

*Inability to get up after falling, subsequent time on floor, and summoning help: prospective cohort study in people over 90.* BMJ 337:a2227. DOI [10.1136/bmj.a2227](https://doi.org/10.1136/bmj.a2227) · PMID [19015185](https://pubmed.ncbi.nlm.nih.gov/19015185/) · `[读全文]`

**报告的事实**：90 岁以上跌倒者中 80%（53/66）至少一次无法自行起身；30%（20/66）曾在地上躺 ≥1 小时；长躺与严重伤害相关（adjusted OR 4.2）；97%（37/38）的长躺事件中呼叫器可用却未被按下。

**支撑我们的**：①"long lie"是 B 的最高优先监测对象——跌倒假设后的持续静止必须走确定性升级链（ADR-0005）；②"呼叫器在手边却没被按"直接支撑 Reme 的**主动问候**产品形态：等待老人求助的被动设备在这一人群中失效。

---

## R4 · Schwickert, Klenk, Zijlstra, et al. (2017)

*Reading from the black box: what sensors tell us about resting and recovery after real-world falls.* Gerontology 64(1):90–95. DOI [10.1159/000478092](https://doi.org/10.1159/000478092) · PMID [28848150](https://pubmed.ncbi.nlm.nih.gov/28848150/) · `[读摘要]`

**报告的事实**：真实跌倒的体戴传感器信号中，能自行起身者跌后静止（resting）中位 10.5 s，无法起身者 34.5 s；**静止 > 24.5 s 预测无法自行起身**。

**支撑我们的**：跌倒后"静止时长"作为一级观察量的合理性（`behavior.py` 的 stillness episode 与 `longest_still_ms`）。

**不支撑的**：24.5 s 这个界值来自体戴加速度计，**我们没有把它写成代码阈值**——B 的跌倒后处置由 ADR-0005 的问候+超时链驱动，不做该界值的迁移。

---

## R5 · Tinetti, Liu & Claus (1993)

*Predictors and prognosis of inability to get up after falls among elderly persons.* JAMA 269(1):65–70. DOI [10.1001/jama.1993.03500010075035](https://doi.org/10.1001/jama.1993.03500010075035) · `[读摘要]`

**报告的事实**：跌倒后无法自行起身者，后续死亡、住院、日常生活能力（ADL）下降的风险更高。

**支撑我们的**：把"跌倒后是否恢复活动"当作值得升级告知家人的信号，而非仅记录一次事件。

---

## R6 · Bagalà, Becker, Cappello, et al. (2012)

*Evaluation of accelerometer-based fall detection algorithms on real-world falls.* PLoS ONE 7(5):e37062. DOI [10.1371/journal.pone.0037062](https://doi.org/10.1371/journal.pone.0037062) · PMID [22615890](https://pubmed.ncbi.nlm.nih.gov/22615890/) · `[读全文]`

**报告的事实**：13 个已发表算法在 29 例真实老人跌倒上重测，平均灵敏度 **57.0% ± 27.3%**（其原论文多报 90–100%）；最差配置每天 22–85 次误报。

**支撑我们的**：①**任何论文准确率都不得移植为 Reme 指标**（本表规则 2 的直接来源）；②系统设计必须容忍漏检——这正是"先问候、不擅自定性"的产品逻辑，而不是追求跌倒检测率的逻辑。

---

## R7 · Kerr, White, Barr & Mollan (1997)

*Analysis of the sit-stand-sit movement cycle in normal subjects.* Clinical Biomechanics 12(4):236–245. DOI [10.1016/S0268-0033(96)00077-0](https://doi.org/10.1016/S0268-0033(96)00077-0) · PMID [11415728](https://pubmed.ncbi.nlm.nih.gov/11415728/) · `[读摘要]`

**报告的事实**：自选速度下起立约 1.91 s、坐下约 1.97 s。

**支撑我们的**：与 R1 对照构成 3–5 倍的时间尺度差——受控体位转换与失控下坠在**时长**上可分，这是 `plausible_fall_dynamics` 用时长而非速度做筛查的依据（时间是单目 2D 下唯一未被投影破坏的物理量）。

**不支撑的**：我们统计的 `sit_to_stand_count` 只是转换**次数**，不是坐立测试计时，更不构成任何肌力或跌倒风险筛查结论。

---

## R8 · Lyden, John, Dall & Granat (2016)

*Differentiating sitting and lying using a thigh-worn accelerometer.* Medicine & Science in Sports & Exercise 48(4):742–747. DOI [10.1249/MSS.0000000000000804](https://doi.org/10.1249/MSS.0000000000000804) · `[读全文（作者接受稿）]`

**报告的事实**：即使用大腿佩戴的加速度计，区分 sitting 与 lying 也需要额外的绕长轴旋转自由度（±65°）才达到 sensitivity 96.7% / specificity 92.9%。

**支撑我们的**：坐/躺区分的难度来自问题本身。B 因此**不自行推翻上游给出的 posture 标签**，只在其上做时序与上下文推理；卫生间躺卧的处置靠 `home.py` 的上下文规则，而不是靠 B 重新判定体位。

---

## R9 · Skotte, Korshøj, Kristiansen, et al. (2014)

*Detection of physical activity types using triaxial accelerometers.* Journal of Physical Activity and Health 11(1):76–84. DOI [10.1123/jpah.2011-0347](https://doi.org/10.1123/jpah.2011-0347) · PMID [23249722](https://pubmed.ncbi.nlm.nih.gov/23249722/) · `[读摘要]`

**报告的事实**：Acti4 体系用"大腿与竖直夹角 > 45° 且加速度标准差 < 100 mg"判定久坐。

**支撑我们的**：**低运动 + 长时长 = 值得关注**这一操作化范式的既有工程口径（`MotionLevel` 低带 + `long_still_min_ms`）。

**不支撑的**：其角度阈值是**相对重力**的，我们的输入没有重力方向，故一个角度都没有搬进代码。

---

## R10 · de Leva (1996)

*Adjustments to Zatsiorsky-Seluyanov's segment inertia parameters.* Journal of Biomechanics 29(9):1223–1230. DOI [10.1016/0021-9290(95)00178-6](https://doi.org/10.1016/0021-9290(95)00178-6) · `[读摘要，未读参数表]`

## R11 · Dempster (1955)

*Space Requirements of the Seated Operator.* WADC Technical Report 55-159. 原始 PDF：<https://contrails.library.iit.edu/item/154630> · `[读全文，Tables 10–15 逐字]`

**R10/R11 支撑我们的**：质心（CoM）类空间量的定义来源——`SpatialHints.com_drop_ratio` 的"质心下降比"概念出自此体系。

**不支撑的（重要）**：这两份的参数是**3D 体段端点**条件下的。我们的 evidence 通道只接受**无量纲比值**，且该比值由上游生产者定义与计算；B 侧不自行从关键点估计 CoM，也不宣称任何米制量。详见 `.scratch/posture-classifier-theory/notes/com-anthropometry.md` 的完整误差分析。

---

## R12 · Yang & Pai (2014)

*Can sacral marker approximate center of mass during gait and slip-fall recovery among community-dwelling older adults?* Journal of Biomechanics 47(16):3807–3812. DOI [10.1016/j.jbiomech.2014.10.027](https://doi.org/10.1016/j.jbiomech.2014.10.027) · `[读摘要]`

## R13 · Eames, Cosgrove & Baker (1999)

*Comparing methods of estimating the total body centre of mass in three-dimensions in normal and pathological gaits.* Human Movement Science 18(5):637–646. DOI [10.1016/S0167-9457(99)00022-6](https://doi.org/10.1016/S0167-9457(99)00022-6) · `[读摘要]`

**R12/R13 支撑我们的**：**反面证据**——"用髋/骶部单点近似 CoM"在跨姿态类时不成立（相关系数高只说明同姿态类内的时序相关）。这是我们拒绝在 B 侧自造空间量、只接受上游显式提供的 evidence 的直接理由。

---

## R14 · Winter (2009)

*Biomechanics and Motor Control of Human Movement*, 4th ed. Wiley. DOI [10.1002/9780470549148](https://doi.org/10.1002/9780470549148) · `[未读原文]`

书目锚点（人体测量与信号处理章节）。**不引用其任何具体数值。**

---

## R15 · Wild, Nayak & Isaacs (1981)

*How dangerous are falls in old people at home?* British Medical Journal (Clin Res Ed) 282(6260):266–268. DOI [10.1136/bmj.282.6260.266](https://doi.org/10.1136/bmj.282.6260.266) · PMID [6779979](https://pubmed.ncbi.nlm.nih.gov/6779979/) · `[读摘要]`

**报告的事实**：125 名居家跌倒的 65 岁以上老人中，20 人卧地超过 1 小时；**这 20 人中一半在 6 个月内死亡**。该文即"long lie ≥1 小时"这一判定口径的经典出处。

**支撑我们的**：与 R3 共同构成跌倒后持续静止的优先级依据。

**明确不支撑的（重要纠正）**：一手摘要**没有**给出脱水、压疮、横纹肌溶解的定量数据（作者检查了低体温，未发现病例）。这三项并发症的关联属二级综述/教科书口径，**不得挂在本文名下**。ADR-0006 已据此把表述收窄为"与短期死亡率显著升高相关"。

---

## R16 · Bohannon (2006)

*Reference values for the five-repetition sit-to-stand test: a descriptive meta-analysis of data from elders.* Perceptual and Motor Skills 103(1):215–222. DOI [10.2466/pms.103.1.215-222](https://doi.org/10.2466/pms.103.1.215-222) · PMID [17037663](https://pubmed.ncbi.nlm.nih.gov/17037663/) · `[读摘要]`

**报告的事实**：五次坐立试验按年龄分层的"劣于平均"界值——60–69 岁 >11.4 s，70–79 岁 >12.6 s，80–89 岁 >14.8 s。

## R17 · Buatois, Perret-Guillaume, Gueguen, et al. (2010)

*A simple clinical scale to stratify risk of recurrent falls in community-dwelling adults aged 65 years and older.* Physical Therapy 90(4):550–560. DOI [10.2522/ptj.20090158](https://doi.org/10.2522/ptj.20090158) · PMID [20203094](https://pubmed.ncbi.nlm.nih.gov/20203094/) · `[读摘要]`

**报告的事实**：1618 名社区老人前瞻队列，五次坐立 >15 s 使中等风险组的复发跌倒风险翻倍。

**R16/R17 支撑我们的**：坐↔站转换能力与跌倒风险有临床意义，因此把 `sit_to_stand_count` 作为**方向一致的粗代理**记录下来是合理的。

**不支撑的**：这些界值是**计时五次连续坐立**的标准化测试口径。我们既不计时也不指定次数，只数窗口内的转换次数，**因此不得声称实现了 FTSST 或引用其界值**。

---

## R18 · Vaughan, Brown, Goode, et al. (2010)

*The association of nocturia with incident falls in an elderly community-dwelling cohort.* International Journal of Clinical Practice 64(5):577–583. DOI [10.1111/j.1742-1241.2009.02326.x](https://doi.org/10.1111/j.1742-1241.2009.02326.x) · PMID [20456212](https://pubmed.ncbi.nlm.nih.gov/20456212/) · `[读摘要]`

**报告的事实**：692 名前一年无跌倒史的社区老人中，**每晚 ≥3 次**夜尿与 3 年内跌倒风险增加 28% 相关（RR 1.28，95% CI 1.02–1.59）。

## R19 · Pesonen, Vernooij, Cartwright, et al. (2020)

*The impact of nocturia on falls and fractures: a systematic review and meta-analysis.* The Journal of Urology 203(4):674–683（Epub 2019）. DOI [10.1097/JU.0000000000000459](https://doi.org/10.1097/JU.0000000000000459) · PMID [31347956](https://pubmed.ncbi.nlm.nih.gov/31347956/) · `[读摘要]`

**报告的事实**：夜尿与跌倒风险合并 RR 1.20（95% CI 1.05–1.37，证据质量中等）；与**骨折**风险合并 RR 1.32，但 **95% CI 0.99–1.76 未达统计学显著，证据质量为低**。

**R18/R19 支撑我们的**：夜间如厕活动值得纳入记忆与上下文（`home.py` 的夜间/卫生间语义、记忆的分时段基线）。

**不支撑的（两处收窄）**：①常被引用的"≥2 次"不是这两篇的切点，R18 的切点是 **≥3 次**；②"夜尿与骨折风险相关"证据弱于跌倒，引用时必须带上未显著这一事实。

**已删除的主张**：ADR-0006 原写"频次突增可能是感染等急症的行为前兆"——**未核实到任何一手研究**把夜尿频次骤增当作急症预警指标。该句已从 ADR 删除，仅保留 R20–R22 支持的较弱说法。

---

## R20 · Jarrett, Rockwood, Carver, et al. (1995)

*Illness presentation in elderly patients.* Archives of Internal Medicine 155(10):1060–1064. PMID [7748049](https://pubmed.ncbi.nlm.nih.gov/7748049/)（该记录无 DOI）· `[读摘要]`

**报告的事实**：193 名老年住院患者队列——体弱（frail）者非典型疾病表现发生率 **59%**，健康老人 25%（p<.001）；体弱者最常见为谵妄（61%），健康老人最常见为跌倒（37%）与谵妄（32%）；非典型表现独立预测不良住院结局（OR 2.37，95% CI 1.20–4.67）。

## R21 · Dutta, Pasha, Paul, et al. (2022)

*Urinary tract infection induced delirium in elderly patients: a systematic review.* Cureus 14(12):e32321. DOI [10.7759/cureus.32321](https://doi.org/10.7759/cureus.32321) · PMID [36632270](https://pubmed.ncbi.nlm.nih.gov/36632270/) · `[读摘要]`

## R22 · Matthews & Lancaster (2011)

*Urinary tract infections in the elderly population.* The American Journal of Geriatric Pharmacotherapy 9(5):286–309. PMID [21840265](https://pubmed.ncbi.nlm.nih.gov/21840265/) · `[读摘要]`

**R20–R22 支撑我们的**：老年急症常以**行为改变**（跌倒、谵妄、嗜睡、食欲下降）而非典型症状起病。这是**记忆层存在的核心理由**——相对个人基线的偏离比绝对阈值更有信息量。

**不支撑的**：R20 是队列研究，不是共识声明；ADR-0006 原文的"教学共识"措辞已改。我们也不做任何感染或谵妄的判断，只把偏离作为问候理由。

---

## R23 · Martino-Saltzman, Blasch, Morris & McNeal (1991)

*Travel behavior of nursing home residents perceived as wanderers and nonwanderers.* The Gerontologist 31(5):666–672. DOI [10.1093/geront/31.5.666](https://doi.org/10.1093/geront/31.5.666) · PMID [1778493](https://pubmed.ncbi.nlm.nih.gov/1778493/) · `[读摘要]`

**报告的事实**：40 名疗养院居民、30 天连续录像、逾 5000 次无协助行走事件，识别出四种行走模式——direct 86.8%、lapping 11.6%、random 0.9%、pacing 0.7%；"直接行走"占比与认知状态显著相关（r = .56）。

**支撑我们的**：行走/移动模式确实可分型且与认知状态相关——这是把轨迹级分析列为**休眠能力**（等上游提供空间序列）的理由。

**不支撑的（口径纠正）**：论文报告的是**行走事件层面**的模式占比，不是把人固定归为某一"徘徊类型"。ADR-0006 的措辞已按此收窄。我们当前的 `restlessness_score` 只是体位/运动带翻动率，**与该四型分类没有对应关系**。

---

## R24 · Tranah, Blackwell, Stone, et al. (2011)

*Circadian activity rhythms and risk of incident dementia and mild cognitive impairment in older women.* Annals of Neurology 70(5):722–732. DOI [10.1002/ana.22468](https://doi.org/10.1002/ana.22468) · PMID [22162057](https://pubmed.ncbi.nlm.nih.gov/22162057/) · `[读摘要]`

**报告的事实**：1282 名社区老年女性（平均 83 岁）腕动计测量，随访 4.9 年——节律振幅低、稳健性低、活动高峰延迟者发生痴呆/MCI 风险显著更高（OR 1.57–1.83）。

## R25 · Haghayegh, Gao, Sugg, et al. (2024)

*Association of rest-activity rhythm and risk of developing dementia or mild cognitive impairment in the middle-aged and older population: prospective cohort study.* JMIR Public Health and Surveillance 10:e55211. DOI [10.2196/55211](https://doi.org/10.2196/55211) · PMID [38713911](https://pubmed.ncbi.nlm.nih.gov/38713911/) · `[读摘要]`

**报告的事实**：UK Biobank 91,517 人腕动计数据、随访最长 7.5 年——静息-活动节律受抑制/碎片化与随后痴呆/MCI 风险独立正相关（HR 1.14–1.32）。

**R24/R25 支撑我们的**：日常节律的稳定性本身是有前瞻价值的健康信号（两项均为前瞻队列，非横断面）。这是 `memory.py` 分时段基线的设计理由。

**不支撑的**：两项都用**腕动计连续测量**并计算 M10/L5/相对振幅等标准节律指标。我们的分时段 EWMA 是极简近似，**不是节律指标，也不做任何痴呆风险判断**。

---

## R26 · Sobin & Sackeim (1997)

*Psychomotor symptoms of depression.* American Journal of Psychiatry 154(1):4–17. DOI [10.1176/ajp.154.1.4](https://doi.org/10.1176/ajp.154.1.4) · PMID [8988952](https://pubmed.ncbi.nlm.nih.gov/8988952/) · `[读摘要]`

## R27 · Buyukdura, McClintock & Croarkin (2011)

*Psychomotor retardation in depression: biological underpinnings, measurement, and treatment.* Progress in Neuro-Psychopharmacology & Biological Psychiatry 35(2):395–409. DOI [10.1016/j.pnpbp.2010.10.019](https://doi.org/10.1016/j.pnpbp.2010.10.019) · PMID [21044654](https://pubmed.ncbi.nlm.nih.gov/21044654/) · `[读摘要]`

**R26/R27 支撑我们的**：精神运动性迟滞（动作减少、启动变慢、活动量下降）是**抑郁**的既有表现，因此"活动量持续低于个人基线"值得一句问候。

**明确不支撑的（已据此删改 ADR）**：这两篇都聚焦**抑郁**语境，**不支持**把精神运动性迟滞作为"认知衰退/痴呆"的表现。ADR-0006 原文写的"抑郁与认知衰退的公认表现"已删去后半句。

---

## R28 · Grant, Ryan, Tigbe & Granat (2006)

*The validation of a novel activity monitor in the measurement of posture and motion during everyday activities.* British Journal of Sports Medicine 40(12):992–997. DOI [10.1136/bjsm.2006.030262](https://doi.org/10.1136/bjsm.2006.030262) · PMID [16980531](https://pubmed.ncbi.nlm.nih.gov/16980531/) · `[读摘要]`

## R29 · Stemland, Ingebrigtsen, Christiansen, et al. (2015)

*Validity of the Acti4 method for detection of physical activity types in free-living settings: comparison with video analysis.* Ergonomics 58(6):953–965. DOI [10.1080/00140139.2014.998724](https://doi.org/10.1080/00140139.2014.998724) · PMID [25588819](https://pubmed.ncbi.nlm.nih.gov/25588819/) · `[读摘要]`

**R28/R29 支撑我们的**：体位识别在**自由生活**环境下的表现显著低于标准化测试（R29 报告敏感度随动作复杂度在 49.9%–99.4% 间波动）——与 R6 同向：实验室数字不可外推，系统必须为误判留出余地。

---

## 核实过程中的两次裁决（如实记录）

**① Lyden 2016 的归属曾被质疑，经查证成立。** 一次独立核实认为 Kate Lyden 名下没有专做坐/躺判别的论文、疑为误记。经 PubMed 直接检索确认该文真实存在（PMID 26516691，标题、作者四人、卷期页与 DOI 全部吻合，摘要明载 ±65° 阈值与 96.7%/92.9%），故 **R8 维持原样**。记录此事是为了留下"结论以工具查证为准、不以任一方断言为准"的痕迹。

**② Acti4/activPAL 的角度阈值数字未能回到原文。** R9 中"45° + 100 mg"来自二手转述；Skotte 2014 全文受付费墙限制未获取，且不同复现研究给出的阈值在 10°–66° 之间互相矛盾，R28 原始验证论文的摘要也未公开阈值（属厂商专有算法）。**结论：任何单一角度数字都不可当权威引用**——所幸我们一个角度都没有搬进代码（我们的输入没有重力方向），此条仅作范式依据。

---

## 无文献支撑的工程约定（如实登记）

这些数字**没有**文献依据，是为演示可复现性自选的，答辩时不得说成"有研究支持"：

| 常量 | 值 | 依据 |
|---|---|---|
| `DEFAULT_WINDOW_MS` | 120000 | 演示可观察性：两分钟窗口在一次演示内能填满 |
| `STILL_EPISODE_MIN_MS` | 10000 | 低于此长度的静止在 5-10 Hz 流上噪声占比过高 |
| restlessness 的 20 秒一格 | 20000 | 使分数在两分钟窗口内落在 0..1 的可读区间 |
| `home.py` 缩放表（0.5 / 3.0 / 0.75） | — | 语义方向来自常识与 R3/R4 的关注点，**倍数本身是工程自选**并被钳制在 [0.5, 3.0] |
| `DEVIATION_MENTION_MIN` | 1.5 | 只在明显偏离时才提示模型，避免噪声驱动 |
| `MEMORY_OBSERVE_INTERVAL_MS` | 60000 | 防止重叠窗口淹没 EWMA |
