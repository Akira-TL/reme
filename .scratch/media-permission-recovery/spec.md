# 媒体权限诊断与模型恢复

- Status: completed
- Type: task
- Date: 2026-08-09
- Scope: 本机模型资产、浏览器媒体错误分层、本地全链路验收

## 问题

1. 默认姿态与跌倒模型缺失时，完整启动器只能退回不提供 JPEG 姿态推理的降级模式。
2. 媒体源打开流程把 `getUserMedia()` 与 `video.play()` 放在同一个错误分类中；任一阶段的 `NotAllowedError` / `SecurityError` 都被显示为“摄像头权限被拒绝”。这会让手机用户在已经允许摄像头后仍看到错误的拒绝结论。
3. 手机通过局域网 HTTP 打开页面时不是安全上下文，当前能力检测只显示“浏览器不支持”，没有指出必须使用受信任 HTTPS。

## 实现边界

- 只从用户提供且 SHA-256 匹配既有台账的压缩包导入 `models/trained/*`；不覆盖仓库跟踪的 MoveNet 权重，不提交 ignored 模型。
- 保留现有媒体请求与视频启动 watchdog，不覆盖工作区中的时间/超时修复。
- 把媒体流程至少分为 `capture` 与 `playback` 两个失败阶段。
- `playback` 阶段失败必须保留已取得授权这一事实，不得再显示为用户拒绝。
- 非安全上下文直接显示手机需要受信任 HTTPS；文件源仍可本地播放。
- 在浏览器支持 Permissions API 时，摄像头失败后读取当前 camera 权限状态；API 不支持或查询失败时安全降级。
- 不自动更改浏览器或系统权限，不上传或持久化摄像头画面。

## 验收

- 训练资产台账 38/38 SHA-256 通过；默认 posture / fall 模型可被运行时读取。
- 单元测试覆盖：非安全上下文、真实拒绝、已授权但采集受阻、已授权但播放受阻、权限查询不可用、播放超时。
- 前端全量测试、lint、build 通过。
- 后端相关模型加载测试与完整启动健康检查通过。
- 浏览器页面能够区分“请在网站设置中允许”“需要受信任 HTTPS”“摄像头已允许但预览启动失败”。
- 真实授权弹窗仍由用户本人操作；自动验收不代替手机真机 HTTPS Gate。

## 结果

- 用户提供的 `models.zip` SHA-256 为 `00590419009ccb531d2fa9345eccf142d79f1d579a0dc761cd09a9bf64424aa4`，与既有台账一致；导入后 38/38 文件再次通过 `docs/assets/training-models.sha256`。
- 默认 posture 与 fall 模型保持在 ignored 的 `models/trained/*`，未覆盖仓库跟踪的 MoveNet，也不进入提交。
- 运行时完整 JPEG 会话报告 MoveNet、learned posture、MIL v3 三项 `loaded: true`，无 fallback / error。
- 前端已按 capture / playback 阶段和 Permissions API 实际状态分类；未知状态不再断言“用户拒绝”，已授权后的设备或预览错误保留 `granted`。
- 本机浏览器验收确认：真实 `denied` 状态显示“请先在网站设置中允许，再重试”；自动化未代替用户操作原生权限。
- 单元测试、前端全量测试、lint、build 以及后端模型相关测试通过；手机受信任 HTTPS 下的原生授权仍需真机人工 Gate。
