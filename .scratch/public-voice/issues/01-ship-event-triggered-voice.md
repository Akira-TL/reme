# 上线公网事件触发式语音唤起

- Type: task
- Status: ready-for-human
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

公网事件触发式语音已经上线，常驻热词唤醒仍明确不在本轮范围内。

## 发布证据（2026-08-02）

- 代码：`092d5bbe`（事件语音链路）、`d0259818`（Durable Object 权威告警与恢复）、`e874de15`（生产三字段 `controller_ready` 滚动兼容），均已推送 `upstream/lbx`。
- Cloudflare staging：Worker version `720af6c0-c48b-48a1-bcdb-98c0a8ecf676`。
- Cloudflare production：Worker version `a88bc436-8d4b-4fd7-8e69-32f375db961b`，100% deployment。
- Vercel production：deployment `dpl_2XbrhAEBMGJ3kRWvguDgufSRbEbw`；`reme.maniforld.com` 与 `monitor.reme.maniforld.com` 均已指向该 deployment。
- 自动化：前端 105/105、lint、production build；Relay 42/42、Wrangler types、TypeScript、production/staging dry-run；两轮独立 P0/P1 Gate 均通过。

真实生产 MiMo synthetic WAV：

- event `voice-smoke-16892306-9bfa-41ef-8276-b0d8a03081c5`；HTTP 200；intent `safe`；model `mimo-v2.5`；983 ms。
- 同次脱敏自定义日志：request `7c3c24cc-55a0-4677-ac15-2d463335ba0f`；provider `xiaomi_mimo`；status 200；outcome `safe`；65186 bytes。日志未包含音频、Base64、transcript、Bearer token 或 API key。

真实 production watchdog：

- event `watchdog-smoke-553f6af9-1046-4438-a9e0-1617002c910f`；Durable Object 在约 2398 ms 后生成 event sequence 2、trigger `check_in_timeout`，随后按相同权威 trigger 成功结案。
- 验证结束后 `/api/status` 为 `controller_locked=false`、`controller_connected=false`，无测试租约残留。

静态生产 Gate：

- 两个公网域名均 HTTP 200；CSP 保持同源脚本/资源与指定 Relay；`Permissions-Policy` 为 `camera=(self), microphone=(self), geolocation=()`。
- monitor bundle 含 `/api/danger/voice`、`getUserMedia`、`current_alarm`、`microphone`；viewer bundle 不含这些语音/控制能力。
- `/voice/fall_check_in.m4a` SHA-256 为 `7928e7ed3cfa8a9649585ef5c27e7b8a3d7c67ed1dd980c1988339adbe7c80bc`。

## 待真人 Gate

仍需在目标 iPhone Safari 与 Android Chrome 实机完成：HTTPS 权限、提示音回声、自然换气与噪声、safe/help、拒权、后台/前台恢复，以及停止后麦克风指示器熄灭。完成前不得宣称跨设备换气体验或浏览器兼容性已经证明。
