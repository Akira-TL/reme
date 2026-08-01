# 04 — 完成 A/B/C 实时联合链路

**Type:** task

**What to build:** 在同一个live_camera session中连接A实时感知、B完整状态机与事件触发式MiMo、C运行控制和可视化，验证状态回报、交互、降级和session隔离。

**Blocked by:** 03 — 将姿态分类接入实时运行时；B/C对应P0实现。

**Status:** ready-for-agent

- [ ] C启动live_camera后A/B分别回报真实running状态。
- [ ] A关键点和姿态事件通过WebSocket到达B/C。
- [ ] C显示实时视频、2D骨架和“2D关键点三维可视化”。
- [ ] B正常稳定时不持续调用MiMo，事件触发时返回CareDecision。
- [ ] C可以提交safe、need_help、unclear和timeout回应。
- [ ] response_timeout_ms按现实交互时间运行。
- [ ] A或B失败时分别显示degraded，不自动切换预录模式。
- [ ] profile切换使用新session_id，旧事件不会污染新会话。
- [ ] 完整链路连续运行10分钟无阻断错误。
- [ ] 输出端到端延迟、MiMo延迟、错误和降级报告。
