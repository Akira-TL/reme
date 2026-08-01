# 17 关键点骨架姿态分类与动作识别文献调研

- 日期：2026-08-01
- 面向项目：Reme 姿态分类可行性 Gate
- 当前输入：MoveNet SinglePose Lightning 输出的 COCO 风格 17 点二维骨架序列
- 当前目标标签：`standing`、`sitting`、`lying`、`bending_or_crouching`、`unknown`，以及单独的时间序列标签 `normal_transition`、`fall_like_transition`、`uncertain_transition`
- 检索约束：优先论文原文、会议官网、作者官方仓库与官方框架文档；排除 MDPI 和 Frontiers 来源

## 1. 结论摘要

对 Reme 当前只有一段 79 秒目标视频、2370 帧、单人物 17 点骨架的条件，最合适的实验顺序不是直接训练大型图卷积网络，而是：

1. **静态姿态基线**：归一化 17 点坐标、置信度、关节角、骨骼长度比例、人体包围盒长宽比、躯干方向和人体中心高度，先比较几何规则、XGBoost、SVM/随机森林和小型 MLP。
2. **时间序列基线**：在 1.5–3 秒短窗上加入速度、加速度、角速度和高度变化，比较特征窗口模型与轻量 Conv1D/TCN。
3. **研究型对照**：标注片段和跨人物数据足够后，再比较 ST-GCN++、2s-AGCN 或 PoseC3D。
4. **3D 展示路线**：MotionBERT 可继续用于 17 点骨架的 2D-to-3D 提升和展示，但不应把其 NTU 预训练动作头直接当成 Reme 自定义姿态分类器。

理由是：大型骨架动作网络通常在 NTU RGB+D、Kinetics-Skeleton 等大规模数据集上训练；当前单视频相邻帧高度相关，直接随机切帧训练很容易得到虚高指标。近期与老年辅助设备相关的骨架姿态研究也表明，简单几何方法和 XGBoost 对有限、结构化姿态任务有很强竞争力，而多类姿态对未见人物的泛化明显低于训练指标。

## 2. 与 17 关键点直接相关的资料

### 2.1 TensorFlow 官方：MoveNet + TFLite 姿态分类教程

- 类型：官方工程教程，不是同行评审论文
- 输入：MoveNet 的 17 个关键点坐标与置信度
- 分类器：将关键点预处理为 CSV，训练小型全连接分类网络，再转换为 TFLite
- 直接适配度：**最高**
- 项目价值：可作为 Reme 的最小可运行静态姿态分类基线；输出链路与当前 LiteRT/MoveNet 实验一致
- 局限：示例主要面向单帧瑜伽姿态，不能单独解决正常躺下与跌倒式转变

来源：

- [Human pose classification with MoveNet and TensorFlow Lite](https://www.tensorflow.org/lite/tutorials/pose_classification)
- [MoveNet model tutorial](https://www.tensorflow.org/hub/tutorials/movenet)

### 2.2 Hsu et al., 2026：MoveNet 17 点 + 轻量 Conv1D

- 题目：*From Keypoints to Actions: Real-Time Motion Analysis Using MoveNet and Lightweight Conv1D Networks*
- 期刊：Journal of Mechanics in Medicine and Biology，2026，已接收/在线出版信息已登记
- DOI：`10.1142/S0219519426500272`
- 输入：MoveNet 检测的 17 个关节坐标序列
- 方法：轻量 Conv1D，配合 Triplet-Center Loss 增强类别间分离
- 任务：23 个分解动作分类
- 直接适配度：**很高**
- 项目价值：这是目前检索到与“MoveNet 17 点序列直接做动作分类”最接近的同行评审方案，可作为 Reme 时序分类器的主要文献依据
- 代码状态：截至 2026-08-01，以完整标题、DOI、作者姓名和 `MoveNet Conv1D Triplet-Center Loss` 检索 GitHub/GitLab，未发现作者公开仓库；成大成果页也只提供 DOI 与 Scopus 链接
- 本地复现：`.scratch/conv1d-posture-classifier/` 已建立独立的 MoveNet17 + Conv1D + Triplet-Center Loss 原型，并明确不是作者官方代码或精确超参数复刻
- 局限：动作集与 Reme 的站/坐/躺/弯腰和跌倒式转变不同；论文报告的结果不能直接迁移为本项目指标

来源：

- [National Cheng Kung University research record](https://researchoutput.ncku.edu.tw/en/publications/from-keypoints-to-actions-real-time-motion-analysis-using-movenet/)

### 2.3 MotionBERT, ICCV 2023

- 题目：*MotionBERT: A Unified Perspective on Learning Human Motion Representations*
- 会议：ICCV 2023
- 输入：17 关节、每关节 3 通道的二维骨架序列；官方实现使用 Human3.6M 17 点顺序
- 方法：Dual-stream Spatio-temporal Transformer（DSTformer），从噪声和不完整二维观测中预训练三维运动表示，再微调下游任务头
- 直接适配度：**中高**，但需要 COCO17 → H36M17 映射
- 项目价值：
  - 已适合当前的三维骨架离线演示；
  - 可抽取时空运动表示，再训练一个很小的自定义分类头；
  - 对长时序和动作转变的表达能力强于单帧分类器
- 局限：
  - 模型和运行链路明显重于 XGBoost/Conv1D；
  - 预训练动作识别权重面向 NTU 类别，不包含 Reme 的自定义标签；
  - 2D 到 3D 的提升误差可能传递到分类器，必须单独评测

来源：

- [ICCV 2023 paper page](https://openaccess.thecvf.com/content/ICCV2023/html/Zhu_MotionBERT_A_Unified_Perspective_on_Learning_Human_Motion_Representations_ICCV_2023_paper.html)
- [Official MotionBERT repository](https://github.com/Walter0807/MotionBERT)

### 2.4 PoseC3D / PoseConv3D, CVPR 2022

- 题目：*Revisiting Skeleton-Based Action Recognition*
- 会议：CVPR 2022
- 方法：把二维骨架转换为关键点/肢体伪热图体积，再用 3D CNN 学习时空特征，而不是直接在关节图上做 GCN
- 输入兼容性：MMAction2 的骨架数据格式明确支持 `V=17` 的 COCO 关键点，形状为 `M × T × V × C`
- 直接适配度：**高**，但训练成本较高
- 项目价值：
  - 相较许多 GCN 方法，论文强调对姿态估计噪声的鲁棒性和跨数据集泛化；
  - 官方 MMAction2 提供模型、配置、自定义骨架数据格式和推理 Demo；
  - 可直接消费二维 COCO17 骨架，不要求先生成 3D
- 局限：
  - 对当前单视频、小类别数据明显偏重；
  - 需要按动作片段构造训练样本和足够的数据增强；
  - 不能直接套用 NTU/Kinetics 的分类头

来源：

- [CVPR 2022 paper page](https://openaccess.thecvf.com/content/CVPR2022/html/Duan_Revisiting_Skeleton-Based_Action_Recognition_CVPR_2022_paper.html)
- [MMAction2 PoseC3D documentation](https://github.com/open-mmlab/mmaction2/blob/main/configs/skeleton/posec3d/README.md)
- [MMAction2 skeleton dataset format](https://github.com/open-mmlab/mmaction2/blob/main/tools/data/skeleton/README.md)

### 2.5 PYSKL / ST-GCN++, ACM Multimedia 2022

- 题目：*PYSKL: Towards Good Practices for Skeleton Action Recognition*
- 会议：ACM Multimedia 2022
- 方法：统一实现 ST-GCN、2s-AGCN、MS-G3D、PoseC3D、ST-GCN++ 等多种骨架动作识别方法
- 直接适配度：**高，作为实验框架**
- 项目价值：适合在同一数据格式和评价协议下比较 GCN 与 CNN 路线；ST-GCN++ 是比复杂 SOTA 更合理的强基线
- 局限：原 PYSKL 仓库已注明不再维护；新实验更建议使用 MMAction2 的对应模块

来源：

- [PYSKL paper record](https://dblp.uni-trier.de/rec/conf/mm/DuanWCL22.html)
- [Official PYSKL repository](https://github.com/kennymckormick/pyskl)

## 3. 可适配到 COCO17 的经典骨架动作算法

以下方法的原始实验常使用 NTU 的 25 点或 Kinetics/OpenPose 的 18 点，但算法本身不依赖固定节点数。使用 COCO17 时需要定义 17 点邻接图、骨骼边、数据归一化和新的分类头，并重新训练或微调。

### 3.1 ST-GCN, AAAI 2018

- 题目：*Spatial Temporal Graph Convolutional Networks for Skeleton-Based Action Recognition*
- 核心思想：把每帧关节连接和跨帧同一关节连接组成时空图，联合学习空间结构与时间动态
- 价值：骨架动作识别最经典、最容易解释的 GCN 基线；适合验证“图结构是否比 Conv1D 更有价值”
- 风险：对小数据容易过拟合；原始代码和早期依赖较旧，建议使用 MMAction2/PYSKL 实现

来源：

- [AAAI paper page](https://ojs.aaai.org/index.php/aaai/article/view/12328)
- [Official ST-GCN repository](https://github.com/yysijie/st-gcn)

### 3.2 2s-AGCN, CVPR 2019

- 题目：*Two-Stream Adaptive Graph Convolutional Networks for Skeleton-Based Action Recognition*
- 核心思想：一条流学习关节坐标，一条流学习骨骼长度与方向；邻接关系可自适应学习
- 价值：对 Reme 很有启发，因为站、坐、躺、弯腰的差异同时体现在关节位置和骨骼方向
- 风险：比 ST-GCN 更复杂；数据不足时自适应图可能学习到机位或人物特征

来源：

- [CVPR 2019 paper page](https://openaccess.thecvf.com/content_CVPR_2019/html/Shi_Two-Stream_Adaptive_Graph_Convolutional_Networks_for_Skeleton-Based_Action_Recognition_CVPR_2019_paper.html)
- [Official 2s-AGCN repository](https://github.com/lshiwjx/2s-AGCN)

### 3.3 MS-G3D, CVPR 2020

- 题目：*Disentangling and Unifying Graph Convolutions for Skeleton-Based Action Recognition*
- 核心思想：同时建模多尺度远距离关节关系与跨时空依赖
- 价值：适合复杂动作和较长时序，可作为高级时序模型对照
- 风险：对当前四类姿态和少量片段明显过重，不应作为第一版

来源：

- [CVPR 2020 paper page](https://openaccess.thecvf.com/content_CVPR_2020/html/Liu_Disentangling_and_Unifying_Graph_Convolutions_for_Skeleton-Based_Action_Recognition_CVPR_2020_paper.html)

### 3.4 CTR-GCN, ICCV 2021

- 题目：*Channel-Wise Topology Refinement Graph Convolution for Skeleton-Based Action Recognition*
- 核心思想：不同特征通道动态学习不同的关节拓扑关系
- 价值：表达能力强，适合细粒度动作区分
- 风险：对数据规模要求更高，难以解释错误，不符合当前“先完成可解释 feasibility gate”的优先级

来源：

- [ICCV 2021 paper page](https://openaccess.thecvf.com/content/ICCV2021/html/Chen_Channel-Wise_Topology_Refinement_Graph_Convolution_for_Skeleton-Based_Action_Recognition_ICCV_2021_paper.html)

### 3.5 AdaSGN, ICCV 2021

- 题目：*AdaSGN: Adapting Joint Number and Model Size for Efficient Skeleton-Based Action Recognition*
- 核心价值：专门研究关节数量与模型规模的效率权衡，对 17 点、端侧部署和 Raspberry Pi 方向有参考意义
- 风险：仍是大规模动作数据集上的研究方法；不是无需训练即可迁移的通用模型

来源：

- [ICCV 2021 paper page](https://openaccess.thecvf.com/content/ICCV2021/html/Shi_AdaSGN_Adapting_Joint_Number_and_Model_Size_for_Efficient_Skeleton-Based_ICCV_2021_paper.html)

## 4. 静态姿态分类与老年关怀相关文献

### 4.1 Sierra et al., 2026：辅助步行器骨架姿态分类

- 题目：*Skeleton-Based Posture Classification to Promote Safer Walker-Assisted Gait in Older Adults*
- 状态：2026 arXiv 预印本，尚不能按正式同行评审论文看待
- 输入：MediaPipe Pose Landmarker 的 33 个三维关键点，不是 MoveNet 17 点
- 比较方法：48 维距离/角度特征、几何规则、SVM、XGBoost、4/6 层 CNN、Encoder-Decoder CNN
- 数据：21 名参与者；17 人用于训练/测试，另外 4 人用于未见人物预测
- 对 Reme 最重要的发现：
  - 简单几何方法在 8 类姿态上具有较强竞争力；
  - XGBoost 对二分类很强，但 17 类姿态在未见数据上的表现明显低于训练结果；
  - 多类姿态的泛化问题不能被训练准确率掩盖；
  - 个体校准的几何阈值可能适合单人家庭 Demo，但必须明确其个体化边界
- 直接适配度：**算法高，节点格式中等**。33 点特征需要缩减为 MoveNet 17 点可观测特征

来源：

- [arXiv paper page and HTML full text](https://arxiv.org/abs/2605.00890)

### 4.2 多特征 + 规则学习姿态识别, 2020

- 题目：*Human posture recognition based on multiple features and rule learning*
- 期刊：International Journal of Machine Learning and Cybernetics
- 方法：关节角度与距离特征，结合 Bagging、随机子空间和规则学习
- 项目价值：支持“先做角度/距离的可解释特征基线”，并强调规则模型相对深度网络的可解释性
- 局限：输入骨架和数据集与 MoveNet17 不完全一致，需要重新定义特征

来源：

- [Springer article page](https://link.springer.com/article/10.1007/s13042-020-01138-y)

## 5. 跌倒检测相关资料及隐私边界

跌倒不是单帧 `lying`，需要时序变化、失衡速度、人体中心高度下降和落地后的持续低位共同判断。检索到的若干跌倒工作并不都适合 Reme：

1. *Fall detection based on OpenPose and MobileNetV2 network*（IET Image Processing, 2023）同时使用关键点和原始图像特征。它可作为性能参考，但若复现其 RGB 融合路线，就不再是纯骨架隐私链路。
2. *Skeleton-based Fall Detection via Graph Convolutional Networks*（IEEE GCCE 2025）使用 AlphaPose，并把 13 点插值到 BlockGCN 所需的 25 点。它证明节点映射可行，但这种插值不增加真实观测信息，不能自动改善 Reme 的 COCO17 输入。
3. 2026 年预印本 *Unsupervised Keypoints for Real-Time Fall Detection* 报告了解剖关键点在遮挡和局部可见条件下可能显著漏检。该结论支持 Reme 保留 `unknown` 和 `uncertain_transition`，而不是在低置信度时强制给出跌倒判断。

来源：

- [IET Image Processing article](https://ietresearch.onlinelibrary.wiley.com/doi/10.1049/ipr2.12667)
- [IEEE GCCE 2025 bibliographic record](https://doi.org/10.1109/GCCE65946.2025.11274693)
- [2026 arXiv preprint](https://arxiv.org/abs/2607.15400)

## 6. 面向 Reme 的推荐实验矩阵

| 层级 | 输入 | 首选算法 | 作用 | 是否立即实施 |
|---|---|---|---|---|
| 静态几何基线 | 单帧/短窗中值的 17 点 | 规则 + 归一化角度/距离 | 建立可解释下限，发现不可分类别 | 是 |
| 静态学习基线 | 17 点归一化特征 | XGBoost、随机森林、小型 MLP | 分类站/坐/躺/弯腰/未知 | 是 |
| 轻量时序基线 | 1.5–3 秒 17 点序列 | Conv1D 或 TCN | 正常转变与跌倒式转变候选 | 是，完成标注后 |
| 图网络对照 | 17 点序列和 COCO17 邻接图 | ST-GCN++ 或 2s-AGCN | 验证图结构是否带来真实提升 | 有更多片段后 |
| 热图时序模型 | COCO17 关键点热图体积 | PoseC3D | 抗关键点噪声的高级对照 | 暂缓 |
| 3D 表示/展示 | COCO17 映射到 H36M17 | MotionBERT | 3D 骨架、运动表示、可选分类头 | 展示可继续，分类需另测 |

## 7. 建议的 17 点特征

### 7.1 归一化

1. 以左右髋中点为根节点；髋点不可见时退化为肩中点，并记录缺失标志。
2. 用肩宽、髋宽或躯干长度做尺度归一化；避免只按图像宽高归一化后学习到人与相机距离。
3. 保留每个关键点置信度，并在低置信度时生成缺失掩码，不要用 0 坐标冒充真实位置。
4. 左右镜像可作为数据增强，但必须保持标签语义一致。

### 7.2 静态特征

- 躯干向量与水平/竖直方向夹角；
- 左右髋、膝、踝的夹角和垂直顺序；
- 肩中点、髋中点、膝中点、踝中点的相对高度；
- 骨架包围盒宽高比；
- 鼻、肩、髋构成的躯干弯曲程度；
- 双侧骨骼长度比例及左右不对称性；
- 关键点可见率和低置信度区域。

### 7.3 时序特征

- 根节点高度的一阶、二阶变化；
- 躯干角速度；
- 肩/髋/膝/踝速度和加速度；
- 站立到低位的持续时间；
- 低位后的静止持续时间；
- 关键点突然丢失和重新出现的模式；
- 每帧分类分布的平滑结果，而不是只用硬标签序列。

## 8. 评价与数据泄漏要求

1. 不得随机打散相邻帧后再划分训练/测试；应按连续片段、完整动作事件或人物划分。
2. 当前只有单视频时，指标只能说明对该视频的拟合和片段外推，不能宣称跨人物泛化。
3. 静态姿态报告每类 precision、recall、F1、混淆矩阵、`unknown` 比例和标签抖动。
4. 转变检测按事件评估，报告漏检、正常转变误报、检测延迟和 `uncertain_transition` 比例。
5. 对置信度阈值做校准；低置信度时拒判通常比错误告警更符合 Reme 的产品边界。
6. 所有大型模型都必须与几何/XGBoost/Conv1D 基线使用相同的数据划分和相同评价指标。

## 9. 最终建议

本轮论文调研支持以下技术路线：

- **第一优先级**：实现官方 MoveNet 17 点分类流程的本地版本，并增加 Reme 所需的角度、速度、置信度和 `unknown` 机制；比较几何规则、XGBoost 与小型 MLP。
- **第二优先级**：按动作事件标注短窗，采用 Hsu et al. 的 MoveNet 17 点 + Conv1D 思路，建立正常转变/跌倒式转变的轻量时序基线。
- **第三优先级**：数据扩充后使用 MMAction2，以统一 COCO17 格式比较 ST-GCN++ 与 PoseC3D；不建议直接维护旧版 PYSKL 环境。
- **展示路线**：MotionBERT 继续负责 3D 骨架回放；分类与 3D 展示保持模块解耦，避免把展示成功误当成分类 Gate 通过。

当前最值得立即阅读和复现的四项资料依次为：

1. TensorFlow MoveNet 姿态分类官方教程；
2. Hsu et al. 2026 的 MoveNet 17 点 + Conv1D；
3. PoseC3D / MMAction2 的 COCO17 数据格式和自定义数据训练；
4. MotionBERT 的 17 点表示与下游分类头设计。
