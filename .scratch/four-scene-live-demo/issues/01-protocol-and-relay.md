# 01 — 四场景事件与媒体信令 Relay

- Type: task
- Status: completed
- Owner: C / Relay

## What to build

在不改变姿态合同和媒体拒绝边界的前提下，实现精确的场景事件、晚加入状态回放、事件级 media grant 和 WebRTC 信令路由。

## Acceptance

- [x] `reme-demo-event/v1` 正常、乱序、未知字段和媒体注入均有测试。
- [x] Viewer 只有在 attachment 被当前 grant 授权后才能发送 answer/ICE。
- [x] 新加入 viewer 不继承活动媒体 grant。
- [x] grant 过期/撤销后双方信令被拒绝，媒体仍不进入 DO。
- [x] Worker typecheck、Vitest 和 production/staging dry-run 通过。
