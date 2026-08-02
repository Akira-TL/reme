# Downloads (6) 弱标签姿态分类 Bootstrap 报告

- Date: 2026-08-01
- Owner: A
- Evidence level: `weak_label_bootstrap`
- Source: 解压后的 3D 动画动作参考视频
- Final candidate: `posture-softmax-v3`

## 1. 数据边界

压缩包已直接解压到：

```text
artifacts/pose-classification/raw/downloads6/
```

共 58 段 MP4。当前没有全部用于训练，而是按动作文件名选择 23 段代表视频：

- train：站立、坐姿、躺卧、弯腰/下蹲，以及跳跃/一字马拒判样本；
- val：独立站立、坐姿、鞠躬和 V 字腹部运动；
- test：独立站立、坐姿、躺卧、屈膝礼、俯卧撑和下跪。

划分按完整视频进行，同一视频不跨 train/val/test。每个视频最多均匀抽样 400 个已标注帧，避免长视频主导训练。

标签来自文件名和相对时间段推断，尚未逐帧人工复核，因此：

- 可以用于验证数据链路、模型接口、拒判设计和实时接入；
- 不可以作为真人准确率、医疗级能力或最终比赛指标；
- 真人摄像头受控视频仍需成为最终验证集。

## 2. MoveNet 提取

配置：

```text
MoveNet Lightning FP16
tracking crop
10 Hz 抽样
score_threshold = 0.2
num_threads = 4
```

数据索引：

```text
artifacts/pose-classification/datasets/downloads6/dataset-index.json
```

提取结果：

```text
23 scenes
22,255 sampled frames before labelled-window filtering
```

绝大多数动画视频的人体检测覆盖接近 100%；两段躺卧视频约为 91.5% 和 92.4%。未保存新的原始帧图片。

## 3. 训练方法

模型不是把 `unknown` 当作普通动作类别，而是：

```text
四类已知姿态 Softmax
+
低置信度拒判
+
标准化特征到已知类中心的距离拒判
```

已知姿态：

```text
standing
sitting
lying
bending_or_crouching
```

拒判状态：

```text
unknown
```

特征共 68 维，包括：

- 根节点相对、尺度归一化的 17 点坐标；
- 17 点置信度；
- 人体包围盒宽高和比例；
- 躯干方向；
- 肩、髋、膝、踝高度；
- 腿部垂直跨度；
- 左右膝角；
- 肩宽和髋宽；
- 可见关键点比例。

最终阈值由验证视频校准：

```text
confidence_threshold = 0.45
distance_threshold = 1.053877
```

模型产物：

```text
artifacts/pose-classification/models/posture-softmax-v3/model.json
artifacts/pose-classification/models/posture-softmax-v3/metrics.json
```

## 4. 迭代结果

| 版本 | 关键变化 | Test macro-F1 |
|---|---|---:|
| v0 | 文件名弱标签，未训练 unknown，长视频未限额 | 0.403 |
| v1 | 增加 unknown 训练视频，每视频最多 400 帧 | 0.439 |
| v2 | unknown 改为置信度 + 特征距离拒判 | 0.565 |
| v3 | 下跪退出弯腰承诺，作为 unknown 压力测试 | 0.713 |

v3 视频级测试结果：

| 标签 | Precision | Recall | F1 | Support |
|---|---:|---:|---:|---:|
| `standing` | 0.858 | 0.969 | 0.910 | 292 |
| `sitting` | 0.628 | 0.844 | 0.720 | 262 |
| `lying` | 0.987 | 0.431 | 0.600 | 181 |
| `bending_or_crouching` | 0.498 | 0.697 | 0.581 | 152 |
| `unknown` | 0.798 | 0.711 | 0.752 | 800 |

整体：

```text
accuracy = 0.745
macro-F1 = 0.713
```

验证集 macro-F1 为 0.605。验证中的鞠躬视频与训练动作外观差异较大，说明当前域内泛化仍有限。

## 5. 能力判断

### 当前可用于实时接口联调

- `standing`：动画参考域表现稳定；
- `sitting`：可用于联调，但需要真人视频验证；
- `lying`：精度高、召回偏低，系统倾向拒判而不是误报；
- `bending_or_crouching`：支持弯腰、鞠躬、下蹲类动作的实验展示；
- `unknown`：可以拒判俯卧撑、下跪等未支持低位动作。

### 当前明确不承诺

- 下跪属于 `bending_or_crouching`；
- 俯卧撑属于 `lying`；
- 动画域指标可以代表真人摄像头；
- 跌倒可以由单帧姿态模型判断；
- 当前模型达到安全设备或医疗级准确率。

## 6. 实时接入

正式运行模块：

```text
backend/reme/pose/posture.py
backend/reme/pose/posture_runtime.py
```

实时链路：

```text
Camera
→ MoveNet FrameLandmarks
→ StaticPostureModel
→ 5–10 Hz RealtimePostureTracker
→ PostureObservation RuntimeEvent
```

实时输出包含：

```text
posture
posture_confidence
posture_duration_ms
motion_level
visible_keypoint_ratio
landmark_quality
```

当前使用短窗口加权平滑；一旦当前证据为 `unknown`，立即清空历史并输出 `unknown`，不会沿用旧标签伪装稳定。

## 7. 下一步

1. 使用当前摄像头录制真人 standing/sitting/lying/bending/unknown 短片；
2. 逐段人工标注，作为独立真人验证集；
3. 测量实时标签延迟与抖动；
4. 根据真人结果决定是否继续使用 Softmax、补几何规则，或训练 Conv1D；
5. 静态姿态稳定后，再实现正常转变和跌倒式转变。
