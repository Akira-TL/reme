# 01 — 冻结运行时会话与事件合同

**Type:** task

**What to build:** 建立由C发起、A/B确认的双模式运行时合同，使实时摄像头和预录回放共享同一控制模型，并保证模式切换后旧会话数据不会污染当前页面。

**Blocked by:** None.

**Status:** resolved

- [x] 只允许 `live_camera` 和 `recorded_video` 两个profile。
- [x] profile确定input、perception和decision模式，不接受任意组合。
- [x] A/B回报requested与effective profile，运行中不得静默切换。
- [x] degraded状态必须提供原因。
- [x] RuntimeEvent携带session_id和sequence。
- [x] 旧session事件能够被拒绝。
- [x] 每次重新启动或切换profile都必须创建新的session_id。
- [x] 公共接口具有自动化测试。

## Answer

实现位于 `backend/reme/pose/runtime.py`，测试位于 `tests/test_pose_runtime.py`。
