# Local Agent Handoff — Frontend Engineering Foundation

## State

- Target remote branch: `origin/lbx-frontend`
- Implementation base: `origin/develop/akira@d590eaa7`
- Scope: frontend only; Backend and Relay contracts are unchanged.
- Workspace validation after the final E2E/docs edits was intentionally not run
  per user instruction. Do not treat the earlier baseline run as validation of
  the final commit.

## Prompt for the next local Agent

```text
你接手 Reme 前端工程质量的本地验证。先 fetch 并切到 origin/lbx-frontend 的最新提交，
阅读 AGENTS.md、CONTEXT.md、docs/frontend-architecture.md，以及
.scratch/frontend-engineering-foundation/spec.md。

本轮只验证和修复前端，不修改 Backend/Relay 权威合同，不允许前端推断跌倒、生成告警、
生成 MediaAuthorization，且 bathroom/hidden/skeleton_only 必须始终 fail closed。

在 frontend/ 执行：
1. npm ci
2. npm run typecheck:contracts
3. npm test
4. npm run lint
5. npm run build
6. npm run test:route-build
7. npx playwright install chromium（本机尚无 Playwright Chromium 时）
8. npm run e2e；若只使用系统 Chrome，可运行 REME_E2E_CHANNEL=chrome npm run e2e

随后在真实本地 Backend/Relay/摄像头环境验收：
- /home、/family、/debug 路由角色正确，首屏无白屏；
- /home 首选 TrackProcessor → Worker → OffscreenCanvas → 384px JPEG 链，连续前台至少
  5 秒接近目标 10 FPS；切后台后记录实际 FPS，不要编造结论；
- source generation 改变不应无故重启 Backend session；Worker/rAF/VideoFrame/socket
  在停止、切源和卸载后无泄漏；
- /debug 能看到 frame age、dropped、backpressure、capture transport、Relay
  state/pose offered/in-flight/ACK、协议错误、WebRTC 状态；
- Family DemoState + PoseFrame 能绘制骨架，断线/旧 session/过期帧清空；
- 告警确认只发 acknowledge_alarm，行动卡确认只发 confirm_action_card，并等待
  Relay/Backend ACK；
- bathroom、hidden、skeleton_only、授权过期、授权不匹配和 WebRTC 失败都只显示骨架；
- Relay JSON 不出现 JPEG/Blob/base64/音视频字节，MiMo 不接收日常连续帧或姿态流。

如有失败，在 lbx-frontend 上做最小修复，重复相关门禁，再提交并推送。最终报告每条命令
和浏览器验收的真实结果、失败条件、设备/浏览器版本；不要声称未测的 FPS、TURN 或设备
能力已通过。
```
