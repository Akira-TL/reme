# 04 — 完成 A/B/C 实时联合链路

**Type:** task

**What to build:** 在同一个live_camera session中连接A实时感知、B完整状态机与事件触发式MiMo、C运行控制和可视化，验证状态回报、交互、降级和session隔离。

**Blocked by:** 03 — 将姿态分类接入实时运行时；B/C对应P0实现。

**Status:** claimed

- [ ] C启动live_camera后A/B分别回报真实running状态。A侧HTTP控制已完成：请求先返回starting；正式模式连接C camera WebSocket并处理首帧后才回报running。B侧状态仍待联调。
- [ ] A关键点、姿态和转变候选事件通过WebSocket到达B/C。A侧已按`FrameLandmarks → PostureObservation → TransitionEvent`顺序接入send-only WebSocket；2026-08-01 正常客户端 P95 为关键点 9.694 ms、姿态 45.596 ms；B/C实际消费者仍待接入并验证转变候选展示。
- [ ] C使用自己采集的原视频显示实时画面，并将A关键点叠加为2D骨架和“2D关键点三维可视化”。A不回传原视频。
- [ ] B正常稳定时不持续调用MiMo，事件触发时返回CareDecision。
- [ ] C可以提交safe、need_help、unclear和timeout回应。
- [ ] C音频和用户回应进入C/B链路，不经过A；response_timeout_ms按现实交互时间运行。
- [ ] A或B失败时分别显示degraded，不自动切换预录模式。
- [ ] profile切换使用新session_id，旧事件不会污染新会话；同一session内的场景`activate/switch/reuse`复用C camera WebSocket，并清空A姿态/转变时序状态。
  - [x] A侧已停止旧 session、以新 session_id 重启，旧 WebSocket 关闭，双向 stale-session 注入均未污染。
  - [ ] B/C 实际消费者仍需在联合链路中确认丢弃旧 session 事件。
- [ ] 完整链路连续运行10分钟无阻断错误。
  - [x] A侧真实摄像头链路已连续累计运行 600.056 秒，无 runtime error。
  - [ ] B/C 与 MiMo 联合链路仍待同场验收。
- [ ] 输出端到端延迟、MiMo延迟、错误和降级报告。
  - [x] A侧稳定性、延迟、资源与 session 隔离报告已输出到 `../results/2026-08-01-runtime-reliability.md`。
  - [ ] B/C 端到端与 MiMo 延迟、错误和降级仍待补充。
