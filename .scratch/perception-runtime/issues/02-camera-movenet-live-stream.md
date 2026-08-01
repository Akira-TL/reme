# 02 — 建立摄像头与 MoveNet 实时关键点流

**Type:** task

**What to build:** 在当前CUDA开发电脑上读取单人摄像头，复用已验证的MoveNet Lightning配置，持续生成符合共享接口的FrameLandmarks RuntimeEvent，并提供可测的帧率、延迟和降级状态。

**Blocked by:** 01 — 冻结运行时会话与事件合同。

**Status:** ready-for-agent

- [ ] 枚举并打开当前电脑可用摄像头，失败时返回degraded和原因。
- [ ] 使用MoveNet Lightning FP16与已验证的跟踪裁剪运行实时2D关键点。
- [ ] 默认只在内存处理，不保存原始帧或录制视频。
- [ ] 输出当前session_id下的FrameLandmarks RuntimeEvent，sequence单调递增。
- [ ] 人离开画面时输出person_detected=false和正确质量状态。
- [ ] 旧session停止后不再发送事件。
- [ ] 记录摄像头预览FPS、MoveNet FPS和关键点产生延迟。
- [ ] 目标MoveNet至少15 FPS；未达到时记录真实结果和瓶颈。
- [ ] 连续运行10分钟无资源泄漏或阻断错误。
- [ ] 摄像头适配器和确定性逻辑具有自动化测试；真实设备验证单独记录。
