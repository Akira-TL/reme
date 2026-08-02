# 静止与动作转变事件基线结果（2026-08-01）

## 结论

本次完成了一个确定性、可测试的时序动作转变模块。模块只输出 A 侧客观感知事实，不输出风险等级、报警、家属通知或关怀策略。

当前可以证明：

- 使用明确时间窗口联合计算人体中心高度变化、关键点速度、躯干方向变化、转变前后姿态、关键点质量和可见关键点比例；
- 正常坐下、正常躺下和弯腰恢复的合成轨迹不会被标记为 `fall_like_transition`；
- 快速高位转低位且满足多项一致证据时可生成 `fall_like_transition` 候选；
- 单帧 `lying` 不会生成跌倒事件；
- 关键点大面积缺失、时间戳乱序、镜头跳变、窗口不足和证据冲突会拒判、记录错误区间，或输出 `uncertain_transition`；
- 通过窗口完成条件、事件后清空历史、冷却时间和 session 重置，避免同一动作连续产生多个事件；
- 同一离线输入重复运行时，事件顺序、事件 ID、JSONL 和报告内容保持稳定。

当前不能证明：

- 真实视频上的跌倒 precision、recall、F1 或误报率；
- 正常躺下与真实跌倒在不同人物、机位、遮挡和拍摄条件下可以可靠区分；
- 当前阈值已经经过真实转变验证集校准；
- 该模块具备医疗设备或安全设备等级的跌倒检测能力。

## 实现内容

### `backend/reme/pose/transitions.py`

公共接口：

```python
TransitionDetector(
    session_id: str,
    config: TransitionDetectorConfig | None = None,
)

TransitionDetector.process_runtime_event(
    event: RuntimeEvent,
) -> RuntimeEvent | None

TransitionDetector.process_posture(
    payload: dict[str, Any],
) -> None

TransitionDetector.process_frame(
    payload: dict[str, Any],
) -> TransitionEvent | None

TransitionDetector.reset(
    *,
    session_id: str,
) -> None
```

输入支持有序的：

- `FrameLandmarks` RuntimeEvent；
- `PostureObservation` RuntimeEvent；
- 两者按时间顺序交错输入。

输出符合共享合同：

```json
{
  "schema_version": "reme-transition/v0-experiment",
  "scene_id": "scene-1",
  "event_id": "transition-0001",
  "start_ms": 0.0,
  "end_ms": 800.0,
  "transition": "fall_like_transition",
  "transition_confidence": 0.75,
  "evidence": {
    "center_height_change": 0.28,
    "maximum_center_drop": 0.30,
    "peak_keypoint_speed": 1.10,
    "torso_direction_change_deg": 84.0,
    "maximum_torso_excursion_deg": 86.0,
    "posture_before": "standing",
    "posture_after": "lying",
    "intermediate_postures": [
      "standing",
      "bending_or_crouching",
      "lying"
    ],
    "visible_keypoint_ratio": 1.0,
    "window_duration_ms": 800.0,
    "reasons": [
      "high_keypoint_speed",
      "high_to_low_posture",
      "large_torso_change",
      "rapid_center_drop",
      "short_window"
    ]
  },
  "landmark_quality": "usable"
}
```

`transition_confidence` 只是规则证据强度，不是实测准确率。

### `backend/reme/pose/transition_eval.py`

离线工具读取关键点 JSONL，并可选读取同步姿态 JSONL。输出：

- `transition_events.jsonl`：候选事件；
- 报告 JSON：候选数量和错误区间；
- 固定状态 `candidates_only_unlabelled`；
- 在真实转变标注完成前不包含 precision、recall 或 F1。

## 默认时间窗口与拒判规则

默认配置：

| 配置 | 默认值 | 语义 |
|---|---:|---|
| `window_ms` | 3200 ms | 最大分析窗口 |
| `min_window_ms` | 500 ms | 产生事件所需最短窗口 |
| `max_frame_gap_ms` | 500 ms | 超过后切断窗口 |
| `max_posture_age_ms` | 600 ms | 姿态观察可用于当前帧的最大年龄 |
| `settle_ms` | 200 ms | 后姿态稳定后才完成候选 |
| `min_visible_keypoint_ratio` | 0.50 | 低于该值拒绝几何判断 |
| `fall_center_drop` | 0.20 | 跌倒式候选的最低中心下移量 |
| `fall_peak_speed` | 0.65 /s | 跌倒式候选的最低峰值关键点速度 |
| `fall_torso_change_deg` | 45° | 跌倒式候选的最低躯干变化 |
| `fall_max_duration_ms` | 1400 ms | 跌倒式候选的最大窗口时长 |
| `cooldown_ms` | 1600 ms | 事件后冷却时间 |

`fall_like_transition` 必须同时满足：

1. 人体中心明显向画面下方移动；
2. 关键点峰值速度较高；
3. 躯干方向明显变化；
4. 窗口较短；
5. 转变前为高位姿态，转变后为 `lying`。

任一单项证据都不足以生成跌倒式候选，尤其是单帧 `lying`。

## 合成轨迹测试

`tests/test_pose_transitions.py` 覆盖：

| 场景 | 预期 |
|---|---|
| 正常坐下 | 单个 `normal_transition` |
| 正常躺下 | 不产生 `fall_like_transition` |
| 弯腰后恢复 | 只产生正常转变候选 |
| 快速高位转低位 | 单个 `fall_like_transition` |
| 单帧躺卧 | 不输出事件 |
| 关键点丢失 | 不输出或不确定，并记录错误区间 |
| 时间戳乱序 | 不输出错误跌倒，并重置窗口 |
| 镜头跳变 | 不输出跌倒，并记录 `camera_jump` |
| 重复事件 | 冷却期内只输出一次 |
| session 重置 | 丢弃旧窗口，事件 ID 从新会话重新开始 |
| 离线命令 | 输出候选和错误区间，不输出准确率 |

结果：

```text
11 passed
```

全仓回归：

```text
63 passed
```

## 现有视频候选运行

输入：

```text
/home/akira/Projects/reme/artifacts/pose-classification/scenes/video_148703662/keypoints_2d.jsonl
```

该输入当前没有同步的 `PostureObservation` 文件。因此模块不会根据关键点几何单独声称跌倒，而是将达到动作候选门限但缺少转变前后姿态上下文的窗口标为不确定。

运行结果：

```text
keypoint_record_count: 2370
posture_record_count: 0
candidate_event_count: 42
uncertain_transition: 42
fall_like_transition: 0
normal_transition: 0
error_intervals: 1
```

错误区间：

```text
51.100 s - 51.133 s: insufficient_visible_keypoints
```

该结果只能说明：

- 离线工具可以读取完整关键点流；
- 缺少同步姿态上下文时会保守拒判；
- 可以定位需要人工复核的候选窗口和关键点错误区间。

该结果不能用于计算真实 precision、recall、F1 或误报率。

重复运行的字节级结果一致：

```text
transition_events.jsonl sha256:
37e870b3908f7ee4f0d9ba734306fdf362691617c8ebe4cabf2347a8d658c804

transition_report.json sha256:
7f79fbe8566b904b3124d24340028875232408e6cea12d1ed7a56f84c27b1be7
```

## 固定离线运行命令

有同步姿态流时：

```bash
uv run --extra dev python -m reme.pose.transition_eval \
  --keypoints artifacts/pose-classification/scenes/<scene_id>/keypoints_2d.jsonl \
  --postures artifacts/pose-classification/predictions/<scene_id>/posture_observations.jsonl \
  --output artifacts/pose-classification/predictions/<scene_id>/transition_events.jsonl \
  --report artifacts/pose-classification/metrics/<scene_id>/transition_candidates.json \
  --session-id offline-<scene_id>
```

只有关键点流时：

```bash
uv run --extra dev python -m reme.pose.transition_eval \
  --keypoints artifacts/pose-classification/scenes/<scene_id>/keypoints_2d.jsonl \
  --output artifacts/pose-classification/predictions/<scene_id>/transition_events.jsonl \
  --report artifacts/pose-classification/metrics/<scene_id>/transition_candidates.json \
  --session-id offline-<scene_id>
```

只有关键点时，候选通常会因缺少转变前后姿态而输出 `uncertain_transition`，不能作为跌倒结果使用。

## 验证命令与结果

```text
Pytest: 63 passed
Ruff（本分支文件）: passed
Mypy strict（含 dev + pose extras）: passed, 22 source files
uv build: passed
  dist/reme-0.1.0.tar.gz
  dist/reme-0.1.0-py3-none-any.whl
git diff --check: passed
```

全仓 `ruff check .` 仍被本分支外的既有问题阻断：

- `.scratch/conv1d-posture-classifier/dataset.py`：旧导入位置和两处超长行；
- `tests/test_contracts.py`：旧导入排序；
- `tests/test_motion_io.py`：旧导入排序。

本任务未修改这些不在范围内的文件。本次新增与修改文件的 Ruff 检查全部通过。

## 仍需要的真实转变标注

至少需要以下受控真实视频，并逐事件标注 `start_ms`、`end_ms`、标签、人物、机位和备注：

1. 正常坐下：不同速度、不同椅子高度、正面与侧面机位；
2. 正常起身：从椅子、床沿和地面起身；
3. 正常躺下：床、沙发和地垫，慢速与较快速；
4. 正常翻身和坐起：避免将床上动作混成跌倒；
5. 弯腰取物后恢复；
6. 下蹲、跪下和起身；
7. 快速但可控的坐下或躺下；
8. 安全保护条件下的跌倒式失衡：前、后、左、右方向；
9. 跌倒后局部遮挡、关键点丢失和人体出画；
10. 镜头移动、镜头切换和画面抖动的负样本；
11. 不同人物、衣着、体型、光照和摄像头高度；
12. 明确的 `uncertain_transition` 样本，包括动作边界不完整和证据冲突。

划分必须按人物、视频或连续片段进行，不能把相邻帧随机拆分到 train、val、test。阈值只能在验证集校准，最终指标只在冻结测试集报告。
