# 03 — 将姿态分类接入实时运行时

**Type:** task

**What to build:** 将已验证的静态姿态分类器接入摄像头关键点流，以5–10 Hz输出PostureObservation RuntimeEvent，并在证据不足时稳定返回unknown。

**Blocked by:** 02 — 建立摄像头与MoveNet实时关键点流；`../../pose-classification-owner-a/issues/02-annotate-postures-and-transitions.md`；`../../pose-classification-owner-a/issues/03-build-geometric-posture-baseline.md`。

**Status:** claimed

- [x] 复用冻结的姿态标签、68维特征和置信度+特征距离双重unknown拒判。
- [x] 输出posture、confidence、duration、motion_level和landmark_quality。
- [x] 姿态输出频率为5–10 Hz，不要求每帧分类。
- [x] 人体不可用或证据不足时输出unknown，不沿用旧标签伪装稳定。
- [ ] 目标姿态到页面延迟P95不超过500 ms。
- [x] 每个session使用独立RealtimePostureTracker，切换后清空持续时长和分类缓存。
- [x] 提供左侧摄像头、右侧Three.js节点骨架和分类状态的本地实时预览入口。
- [ ] 连续运行10分钟无阻断错误。
- [ ] 实时与离线同一输入片段的结果差异有自动化对照测试。
