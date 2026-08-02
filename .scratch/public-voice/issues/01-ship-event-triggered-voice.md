# 上线公网事件触发式语音唤起

- Type: task
- Status: claimed
- Owner: Codex
- Blocked by: none

## Scope

按 `../spec.md` 完成：

1. 监控端问询后自动短时 WAV 录音、状态显示、取消与资源释放；
2. 独立 `POST /api/danger/voice` 鉴权 Relay 与一次 MiMo omni 调用；
3. 当前事件与单次预算原子校验，音频不进入 WebSocket/DO/日志；
4. 自动化测试、构建、Worker dry-run；
5. staging → production 发布、真实 synthetic WAV smoke、脱敏日志核对；
6. 记录仍需真人完成的目标手机 Gate。

## Answer

实施中。
