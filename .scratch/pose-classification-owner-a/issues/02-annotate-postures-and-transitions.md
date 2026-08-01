# 02 — 标注姿态与转变并评估样本覆盖

**Type:** task

**What to build:** 为已冻结场景建立可审查的静态姿态和时序转变真值，使后续模型可以在不泄漏相邻帧的前提下训练和评估，并明确现有视频是否足以支持比赛要展示的动作类别。

**Blocked by:** 01 — 冻结输入场景与姿态提取数据包。

**Status:** claimed

- [ ] 按连续时间段标注 `standing`、`sitting`、`lying`、`bending_or_crouching` 和 `unknown`，所有有效视频时间均有标签或明确排除原因。
- [ ] 单独按时间窗口标注 `normal_transition`、`fall_like_transition` 和 `uncertain_transition`，不得用单帧 `lying` 代替跌倒式转变。
- [x] 标注格式包含 `scene_id`、起止时间、标签、数据划分和边界备注，并通过自动解析校验。
- [x] bootstrap 数据按完整视频划分 train、val、test，不随机打散相邻帧；每个视频最多等量抽样400帧。
- [x] 对当前弱标签数据统计视频数、样本数、标签分布、划分和人体检测覆盖；真人数据统计仍待补充。
- [ ] 逐段回放并复核动作边界，模糊区间必须标为 `unknown` 或 `uncertain_transition`，不得强制归类。
- [x] 输出动画参考域 bootstrap 覆盖与模型报告，明确其不能作为真人准确率；真人受控视频仍需作为最终验证集。
- [ ] 若现有数据不足，给出最小补拍清单，包括动作、人物/机位变化、正常对照和拒判样本，而不是直接开始训练并报告虚假指标。
