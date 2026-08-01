# 02 — 建立摄像头与 MoveNet 实时关键点流

**Type:** task

**What to build:** 在当前CUDA开发电脑上读取单人摄像头，复用已验证的MoveNet Lightning配置，持续生成符合共享接口的FrameLandmarks RuntimeEvent，并提供可测的帧率、延迟和降级状态。

**Blocked by:** 01 — 冻结运行时会话与事件合同。

**Status:** claimed

- [x] 枚举并打开当前电脑可用摄像头；打开或读取失败会产生明确CameraStreamError，A服务层据此回报degraded。
- [x] 使用MoveNet Lightning FP16与已验证的跟踪裁剪运行实时2D关键点。
- [x] 默认只在内存处理，不保存原始帧或录制视频。
- [x] 输出当前session_id下的FrameLandmarks RuntimeEvent，sequence单调递增。
- [x] 人离开画面时输出person_detected=false和正确质量状态。
- [x] 旧session停止后不再发送事件并释放摄像头。
- [x] 记录摄像头、事件输出FPS、MoveNet invoke和单帧处理延迟。
- [x] 300帧短跑达到约24 FPS，超过至少15 FPS目标。
- [ ] 连续运行10分钟无资源泄漏或阻断错误。
  - [x] 2026-08-01 完成 600.056 秒真实摄像头运行，无阻断错误；报告见 `../results/2026-08-01-runtime-reliability.md`。
  - [ ] 冷启动至结束 RSS 增长 165.590 MB，当前测量无法区分原生运行时初始化/缓存与真实泄漏，暂不接受“无资源泄漏”结论。
- [x] 摄像头适配器和确定性逻辑具有自动化测试；真实设备短跑已单独记录。
- [x] 人工确认真人摄像头画面可用；具体全身站位和各关键点质量覆盖留到最终演示验收。
