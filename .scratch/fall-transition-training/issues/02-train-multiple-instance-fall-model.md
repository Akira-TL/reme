# 02 — 训练多实例跌倒转变模型

**Type:** task

**Status:** open

**What to build:** 使用Round 0高置信候选、全部50个跌倒positive bags和正常动作hard negatives，训练轻量多实例窗口模型，区分普通躺下与跌倒式转变。不得把单帧lying或视频主题标签直接当作事件真值。

**Blocked by:** 01

- [ ] 从12个accepted候选建立seed positive窗口，并保留9个uncertain与29个未定位positive bags。
- [ ] 从已有正常躺下、坐下/起身、弯腰/下蹲、稳定站立和稳定躺卧数据建立hard negative bags。
- [ ] 固定1.5–3.2秒窗口、步长、特征集合和质量拒判规则。
- [ ] 训练轻量多实例模型：positive bag至少一个窗口为正，negative bag所有窗口为负。
- [ ] 每轮重新选择positive bag最高分窗口，并记录边界变化；低置信bag保持uncertain。
- [ ] 阈值和拒判策略只使用train/val确定，test不得参与调参。
- [ ] 对8个test片段完成人工事件边界复核后再报告precision、recall、F1和时间误差。
- [ ] 单独报告正常躺下、坐下、弯腰/下蹲误报率和uncertain比例。
- [ ] 与确定性TransitionDetector在同一测试集比较。
- [ ] 输出可加载模型、固定训练/评估命令和A实时接入建议。
- [ ] 不在A侧输出报警、通知家属或风险等级；A只输出TransitionEvent。
