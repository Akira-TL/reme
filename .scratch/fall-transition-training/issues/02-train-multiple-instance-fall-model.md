# 02 — 训练多实例跌倒转变模型

**Type:** task

**Status:** claimed

**What to build:** 使用Round 0高置信候选、全部50个跌倒positive bags和正常动作hard negatives，训练轻量多实例窗口模型，区分普通躺下与跌倒式转变。不得把单帧lying或视频主题标签直接当作事件真值。

**Blocked by:** 01

- [x] 从12个accepted候选建立seed positive窗口，并保留9个uncertain与29个未定位positive bags。12个accepted中10个属于train并作为初始化seed；其余positive bags使用视频级MIL，不能通过候选门的bag继续保持uncertain。
- [x] 从已有正常躺下、坐下/起身、弯腰/下蹲、稳定站立和稳定躺卧数据建立hard negative bags，并加入跌倒视频内部远离候选窗口的同域负样本。
- [x] 固定1.5–3.2秒窗口、250ms步长、时序几何/运动特征和质量拒判规则。
- [x] 训练轻量多实例模型：positive bag至少一个窗口为正，negative bag所有窗口为负。
- [x] 每轮重新选择positive bag最高分合格窗口并记录边界变化；无法通过保守候选门的bag保持uncertain，不强制选正。
- [x] 阈值和拒判策略只使用train/val确定，test不参与特征缩放、权重训练或阈值选择，并有自动化隔离测试。
- [ ] 对8个test片段完成人工事件边界复核后再报告precision、recall、F1和时间误差。
- [x] 单独报告正常躺下、坐下、弯腰/下蹲、下跪和其他正常动作的警告候选；v3当前23个normal bags为0个警告候选，但不能外推为真实误报率。
- [ ] 与确定性TransitionDetector在同一人工标注测试集比较。
- [x] 输出可加载模型、固定训练命令、审计报告和A实时接入建议。
- [x] 不在A侧输出报警、通知家属或风险等级；A只输出TransitionEvent。

## Answer

已完成轻量多实例窗口模型和三轮结构迭代。v1/v2因正常躺下、V字动作或下跪误警被否决；v3移除静态姿态/质量域偏置特征，加入同视频负窗口，并增加净下移、持续高运动、方向改变与前后稳定候选门。

v3在当前视频级弱标签数据上产生43/50跌倒候选，23个现有normal bags无警告候选。该结果仅支持将v3作为确定性TransitionDetector后的高置信确认器：通过门和阈值输出`fall_like_transition`，其余有动作证据的情况输出`uncertain_transition`。人工复核8个test片段并完成同集对比前，不报告真实precision、recall、F1或跌倒准确率。

完整结果：

- [`../results/2026-08-02-mil-v3.md`](../results/2026-08-02-mil-v3.md)
