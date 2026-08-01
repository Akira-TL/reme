# A 角色工作说明：姿态分类训练、测试与交付

- Type: task
- Status: open
- Owner: A
- Date: 2026-08-01
- Project: Reme
- Scope: 原始视频、本地人体关键点提取、姿态分类与时序事件候选
- Implementation directory: `backend/reme/pose/`
- Shared interface: [`../abc-interface/spec.md`](../abc-interface/spec.md)

## 1. 角色目标

A 负责 Reme 的视觉感知与姿态分类链路，将团队确认可使用的原始视频转换为可复现、可评估、可被 B 和 C 消费的结构化结果。

A 的最终责任不是“跑出一个火柴人”，而是回答以下问题：

1. 视频中的 17 点人体骨骼是否连续、可信；
2. 哪些静态姿态可以被稳定分类；
3. 哪些动作转变可以被识别为正常转变、跌倒式转变或无法判断；
4. 模型在什么情况下必须返回 `unknown` 或 `uncertain_transition`；
5. B 和 C 能否通过固定命令、固定文件和明确字段直接复用结果。

一句话概括：

> A 负责让系统从视频中获得可验证的动作事实，不负责让 MiMo 作出关怀决策，也不负责最终软件界面和路演包装。

## 2. 当前已知事实

当前仓库已经完成目标视频 `148703662.mp4` 的 MoveNet 姿态提取实验：

- 视频为 1280 × 720、30 FPS、79 秒、2370 帧；
- MoveNet Lightning FP16 配合逐帧跟踪裁剪达到 100% 躯干覆盖；
- 2369/2370 帧的双肩、双髋、双膝和双踝置信度达到实验阈值；
- 已生成完整骨架视频和逐帧关键点 JSONL；
- 姿态提取 Gate 已通过。

这些事实只说明骨架提取链路可用，尚不能证明：

- 站立、坐姿、躺卧和弯腰等分类准确；
- 正常躺下与跌倒式转变可以可靠区分；
- 当前结果可以泛化到其他人物、机位和环境；
- 模型达到医疗或安全设备标准。

因此，A 当前工作的重点应从“继续寻找姿态模型”转为“标注、分类、比较、评估和交付”。

## 3. 职责边界

### 3.1 A 负责

- 整理并检查原始视频；
- 运行和维护人体关键点提取链路；
- 生成 2D 关键点和可选 3D 关键点数据；
- 设计并执行姿态片段标注；
- 训练、验证和测试姿态分类器；
- 建立透明几何基线，并与轻量学习模型比较；
- 将静态姿态和时序动作转变分开建模；
- 输出置信度、拒判状态和失败原因；
- 记录评价指标、测试条件和已知限制；
- 按共享接口向 B 提供姿态观察、转变事件和受控媒体引用；
- 按共享接口向 C 提供 SceneManifest、时间戳、关键点、姿态观察和转变事件；
- 在演示版本冻结后提供可重复生成结果的命令。

### 3.2 A 不负责

- MiMo Prompt、结构化推理和主动关怀策略，由 B 负责；
- 是否询问老人、通知家属或升级风险，由 B 负责；
- Web 页面、骨架渲染和演示交互，由 C 负责；
- PPT、产品叙事、商业价值和现场路演，由 D 负责；
- 医疗诊断、情绪识别、身份识别或疾病推断；
- 在没有评估数据时承诺准确率、误报率或支持动作数量；
- 将单帧 `lying` 直接定义为跌倒；
- 选择、上传或发送 MiMo 视觉上下文；ADR-0003 已允许显式、最小、可观察的关键帧或短视频路径，但具体发送和记录由 B 负责。

## 4. 输入内容

A 的正式输入包括：

1. 团队确认有权使用的原始视频；
2. 每段视频的场景说明；
3. 需要支持的姿态和动作转变范围；
4. 比赛演示需要出现的关键时间点；
5. 当前 MoveNet 17 点关键点结果；
6. 必要时补充拍摄的训练或验证视频。

每个输入视频至少需要记录：

| 字段 | 说明 |
|---|---|
| `scene_id` | 场景唯一标识 |
| `video_path` | 本地视频路径 |
| `person_id` | 匿名人物编号 |
| `camera_id` | 机位编号 |
| `fps` | 视频帧率 |
| `duration_ms` | 视频时长 |
| `usage` | train / val / test / demo |
| `notes` | 遮挡、光线、动作等说明 |

## 5. 标签体系

### 5.1 静态姿态

第一阶段使用项目已约定的最小候选标签：

| 标签 | 工作定义 |
|---|---|
| `standing` | 躯干总体直立，主要由腿部支撑 |
| `sitting` | 髋部由椅面、床沿或其他表面支撑 |
| `lying` | 躯干整体接近水平并由床、地面或沙发支撑 |
| `bending_or_crouching` | 明显弯腰、下蹲、跪姿或低位动作 |
| `unknown` | 人体离画、严重遮挡、多人重叠或证据不足 |

“走路”优先作为独立的运动属性 `moving=true`，不急于扩展为新的静态姿态类别。

### 5.2 时序动作转变

跌倒不是静态姿态，必须单独按时间窗口标注：

| 标签 | 工作定义 |
|---|---|
| `normal_transition` | 正常坐下、起身、躺下、翻身、下蹲等受控转变 |
| `fall_like_transition` | 短时间内从高位快速转为低位或水平状态，呈现明显失衡或冲击式变化 |
| `uncertain_transition` | 遮挡、镜头变化、关键点异常或动作语义不足，无法可靠判断 |

分类器必须允许拒判。无法证明的动作不能通过沿用上一标签或固定阈值被强制归类。

## 6. 工作阶段

### Phase A0：冻结输入与检查现有产物

#### 工作内容

- 确认比赛使用的视频及文件哈希；
- 检查视频编码、分辨率、帧率和时长；
- 人工并排播放原视频与 MotionBERT Three.js 三维骨架，必要时参考 2D 骨架诊断视频；
- 标记关键动作、遮挡、离画和骨架异常区间；
- 确认最佳 MoveNet 结果仍可复现；
- 将需要长期保留的派生产物放入被 Git 忽略的 `artifacts/`，不要依赖 `/tmp` 作为唯一副本。

#### 完成条件

- 输入视频清单固定；
- 每个视频有场景说明；
- 最佳关键点 JSONL 可访问；
- 骨架异常区间有初步记录。

### Phase A1：建立人工标注

#### 工作内容

- 按连续时间段标注静态姿态；
- 单独标注动作转变时间窗；
- 标记 `unknown` 和 `uncertain_transition`；
- 按人物、视频或连续片段划分 train / val / test；
- 避免相邻帧随机打散造成数据泄漏；
- 对边界模糊片段记录备注，不强行统一标签。

建议静态姿态标注格式：

```csv
scene_id,start_ms,end_ms,label,split,notes
living_room_01,0,8200,standing,train,正面站立
living_room_01,8200,15400,sitting,train,正常坐下后保持坐姿
living_room_01,15400,16900,unknown,train,动作边界与局部遮挡
```

建议转变事件标注格式：

```csv
scene_id,start_ms,end_ms,event_label,split,notes
fall_demo_01,6200,7900,fall_like_transition,test,快速失衡转为地面低位
fall_demo_01,12100,14400,normal_transition,test,主动缓慢躺下
```

#### 完成条件

- 所有演示关键片段均已标注；
- train / val / test 划分明确；
- 静态姿态与动作转变不存在字段混用；
- 标注中包含拒判样本。

### Phase A2：透明几何基线

#### 工作内容

先使用可解释特征建立基线，包括但不限于：

- 肩部中点与髋部中点形成的躯干方向；
- 髋、膝、踝的垂直关系；
- 躯干、股骨和小腿夹角；
- 骨架包围盒长宽比；
- 人体中心相对画面高度；
- 可见关键点比例；
- 短时间窗内关键点速度与变化量。

几何基线的目的不是追求最高指标，而是：

- 验证哪些标签确实可以从骨架中区分；
- 暴露错误数据和错误标注；
- 为学习模型提供可解释对照；
- 给 B 提供可理解的事件证据摘要。

#### 完成条件

- 有固定命令运行训练或校准；
- 在固定测试集上输出指标；
- 可以查看错误样本所在时间段；
- 阈值来自验证集，不是凭直觉写死。

### Phase A3：轻量姿态分类器

当前仓库已有 MoveNet17 + Conv1D 独立复现原型，可作为候选，不应直接视为已经验证的最终模型。

#### 工作内容

- 使用统一关键点归一化；
- 比较至少一个简单学习基线，例如逻辑回归、随机森林、XGBoost 或小型 MLP；
- 运行 Conv1D 时比较合理的时间窗口，例如 30、45、60、90 帧；
- 使用相同数据划分比较不同模型；
- 在验证集上校准 `unknown` 置信度阈值；
- 保存最佳模型、配置、类别映射和指标；
- 对错误分类进行逐段复查。

#### 评价指标

静态姿态至少报告：

- 每类 precision；
- 每类 recall；
- 每类 F1；
- macro-F1；
- 混淆矩阵；
- `unknown` / 拒判率；
- 标签抖动次数；
- 遮挡恢复时间。

不得只报告 overall accuracy，也不得引用其他论文的准确率作为本项目结果。

#### 完成条件

- 至少完成几何基线与一个学习模型的同集比较；
- 最佳模型选择有指标依据；
- 输出结果包含置信度和拒判状态；
- 可通过固定命令重复生成预测结果。

### Phase A4：时序转变与静止状态

#### 工作内容

- 计算人体中心高度、躯干方向和关键点速度的时间序列；
- 识别持续静止状态，但不把静止直接等同于危险；
- 比较正常坐下、正常躺下与跌倒式转变；
- 输出事件起止时间、置信度和关键证据；
- 对无法可靠区分的动作输出 `uncertain_transition`；
- 明确哪些事件只能作为比赛脚本触发，不能声称由模型自动识别。

#### 评价指标

时序事件至少报告：

- 每个标注事件是否检出；
- 正常转变误报数量；
- 事件检测延迟；
- `uncertain_transition` 比例；
- 正常躺下与跌倒式转变的混淆情况。

#### 完成条件

根据证据给出明确结论：

- **Go**：能够区分目标静态姿态，且至少一个跌倒式转变与正常转变可以区分；
- **Conditional Go**：静态姿态可靠，但跌倒式转变不可靠；Demo 只展示状态理解或脚本事件，不宣称跌倒检测；
- **No-Go**：关键点或分类结果不稳定；需要调整视频、机位、标签或方法。

### Phase A5：结果冻结与交接

#### 工作内容

- 固定比赛演示使用的模型和配置；
- 为每段 Demo 视频预生成关键点、分类和事件结果；
- 输出 schema 版本和字段说明；
- 提供一条完整复现命令；
- 向 B 和 C 进行联合验收；
- 冻结后只修复 P0 问题，不再随意增加标签或更换模型。

#### 完成条件

- B 可以读取 A 的分类和事件数据；
- C 可以同步播放视频、骨架和状态；
- 结果文件可在无模型运行环境下离线回放；
- 同一命令重复运行不出现结构漂移；
- 所有已知限制已写入交接说明。

## 7. A 向 B 的交付接口

B 负责 MiMo 推理、隐私判断和主动交互策略。A 只提供客观感知结果和必要的本地媒体引用。

建议输出两个文件：

### 7.1 姿态序列 `posture_predictions.jsonl`

```json
{
  "schema_version": "reme-posture/v0-experiment",
  "scene_id": "fall_demo_01",
  "timestamp_ms": 12500,
  "frame_index": 375,
  "person_detected": true,
  "posture": "lying",
  "posture_confidence": 0.88,
  "motion_state": "still",
  "visible_keypoint_ratio": 0.94,
  "quality_state": "usable"
}
```

### 7.2 事件候选 `transition_events.jsonl`

```json
{
  "schema_version": "reme-transition/v0-experiment",
  "scene_id": "fall_demo_01",
  "start_ms": 11100,
  "end_ms": 12700,
  "event_type": "fall_like_transition",
  "event_confidence": 0.76,
  "evidence": {
    "center_height_change": 0.41,
    "peak_keypoint_speed": 0.18,
    "posture_before": "standing",
    "posture_after": "lying"
  },
  "quality_state": "usable"
}
```

以上 schema 是实验接口，不是永久产品合同。字段调整需要同步 B 和 C，并记录版本变化。

### 原始媒体边界

根据团队当前分工，A 可以向 B 提供：

- 原始视频的本地路径或受控读取方式；
- 与事件时间对应的时间戳；
- 必要时用于视觉路径实验的候选关键帧时间点。

A 不负责执行网络发送，也不默认持久化导出的原始帧文件。根据 ADR-0003，B 可以比较结构化路径与最小视觉上下文路径；A 只负责提供经过确认的本地视频引用、候选时间窗或临时取帧能力。视觉请求必须由 B 明确触发，并记录发送内容、采样窗口、演示模式和本地生命周期。

## 8. A 向 C 的交付接口

C 负责软件演示、骨架可视化和接入 B 的交互结果。A 需要向 C 提供：

- 原始视频或比赛冻结后的 Demo 视频；
- 视频 FPS、时长和分辨率；
- 逐帧 2D 关键点；
- 可选 3D 关键点；
- 姿态分类时间序列；
- 动作转变事件；
- 关键点与分类置信度；
- `unknown`、`uncertain_transition` 和不可用状态；
- schema 版本及字段说明。

C 不应从 A 的模型内部直接读取临时变量，双方应只通过冻结文件或明确接口协作。

关键点输出必须保留：

- `scene_id`；
- `timestamp_ms`；
- `frame_index`；
- 17 点坐标和每点置信度；
- 输入视频尺寸；
- 关键点坐标空间说明；
- 是否经过平滑或插值。

## 9. 目录与产物建议

建议按以下结构保存 A 的工作：

```text
.scratch/pose-classification-owner-a/
├── spec.md
├── annotations/
│   ├── posture_segments.csv
│   └── transition_events.csv
├── results/
│   ├── baseline-report.md
│   ├── classifier-report.md
│   └── transition-report.md
└── handoff/
    ├── schema.md
    └── known-limitations.md

artifacts/
└── pose-classification/
    ├── models/
    ├── predictions/
    ├── keypoints/
    ├── skeleton-videos/
    └── metrics/
```

`.scratch/` 保存可审查的说明、标注和报告；大模型文件、视频和生成产物放入被 Git 忽略的 `artifacts/`。

## 10. 当前可复用命令

### 10.1 重建 MoveNet 关键点

```bash
.venv/bin/python .scratch/litert-movenet-feasibility/run.py \
  --model /tmp/movenet_lightning_f16_v4.tflite \
  --video 148703662.mp4 \
  --output-dir artifacts/pose-classification/keypoints/video-148703662 \
  --score-threshold 0.2 \
  --num-threads 4 \
  --tracking-crop
```

### 10.2 Conv1D 合成数据烟雾测试

```bash
conda run -n DL python \
  .scratch/conv1d-posture-classifier/train.py \
  --dry-run \
  --device cuda
```

### 10.3 使用真实标注训练

```bash
conda run -n DL python \
  .scratch/conv1d-posture-classifier/train.py \
  --keypoints artifacts/pose-classification/keypoints/video-148703662/keypoints.jsonl \
  --annotations .scratch/pose-classification-owner-a/annotations/posture_segments.csv \
  --output-dir artifacts/pose-classification/models/conv1d \
  --window-frames 60 \
  --stride-frames 15 \
  --device cuda
```

### 10.4 完整视频推理

```bash
conda run -n DL python \
  .scratch/conv1d-posture-classifier/infer.py \
  --keypoints artifacts/pose-classification/keypoints/video-148703662/keypoints.jsonl \
  --checkpoint artifacts/pose-classification/models/conv1d/best.pt \
  --output artifacts/pose-classification/predictions/posture_predictions.jsonl \
  --min-confidence 0.6 \
  --device cuda
```

命令中的窗口长度和置信度阈值只是实验起点，必须通过验证集校准。

## 11. 验收清单

### 数据与标注

- [ ] 比赛使用的视频已经冻结并登记；
- [ ] 静态姿态片段已经标注；
- [ ] 正常转变和跌倒式转变已经分开标注；
- [ ] 标注包含 `unknown` 和 `uncertain_transition`；
- [ ] train / val / test 不存在相邻帧泄漏。

### 模型与评估

- [ ] MoveNet 最佳结果可以复现；
- [ ] 几何基线已经完成；
- [ ] Ticket 02 证明样本覆盖充足时，至少完成一个轻量学习模型；样本不足时必须记录 no-go 和最小补拍要求，不强行训练；
- [ ] 实际参与比较的模型使用相同测试划分；
- [ ] 对实际完成且样本有效的模型输出每类 precision、recall、F1 和混淆矩阵；
- [ ] 输出拒判率和错误片段；
- [ ] 跌倒式转变按时间窗口评估；
- [ ] 没有将论文指标冒充项目指标。

### B 交接

- [ ] 提供姿态序列 JSONL；
- [ ] 提供事件候选 JSONL；
- [ ] 提供字段和 schema 说明；
- [ ] 提供风险推理所需的证据摘要；
- [ ] 明确原始媒体只通过受控本地引用交接；
- [ ] B 已完成读取测试。

### C 交接

- [ ] 提供视频元数据；
- [ ] 提供逐帧 2D 关键点；
- [ ] 提供可选 3D 关键点；
- [ ] 提供姿态和事件时间线；
- [ ] 提供不可用和拒判状态；
- [ ] C 已完成视频、骨架和标签同步测试。

### 比赛冻结

- [ ] Demo 结果可以离线回放；
- [ ] 一条命令可以重建关键产物；
- [ ] 连续运行至少三次无阻断错误；
- [ ] 已知限制已经书面记录；
- [ ] 冻结后不再随意增加标签或更换模型。

## 12. 当前最高优先级

A 当前应按以下顺序推进：

1. Ticket 01 已冻结 `video_148703662` 场景包并通过 Three.js 人工验收；
2. 进入 Ticket 02，标注现有视频中的静态姿态、正常转变、跌倒式转变和拒判区间；
3. 根据标注覆盖决定四个预录演示视频还需要补拍哪些动作和对照样本；
4. 建立几何基线并输出第一版混淆矩阵；
5. 仅在样本量和数据划分有效时运行 Conv1D 或其他轻量模型，否则输出 no-go；
6. 比较结果并确定 `unknown` 阈值；
7. 为每个预录视频生成独立 SceneBundle、姿态观察和转变事件；
8. 与 B、C 完成一次联合数据验收。

在上述步骤完成前，不应把时间优先投入实时摄像头、树莓派部署、更多复杂类别或大模型视觉理解。
