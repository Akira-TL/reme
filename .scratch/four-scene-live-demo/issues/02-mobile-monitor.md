# 02 — 手机监控端四场景与真实触发

- Type: task
- Status: completed
- Owner: C / Mobile
- Blocked by: 01 的协议常量

## What to build

沿用当前 Reme 视觉，针对手机重新排列控制流；增加四场景、实验做饭识别、短时本地记录、确定性跌倒问询/超时和授权媒体发送。

## Acceptance

- [x] 390×844 无横向滚动且主操作可触达。
- [x] 切到厨房不会自动宣称做饭或开放原画。
- [x] 浴室/完全隐私无论上游状态如何都只输出骨架。
- [x] 跌倒 `checking` 无原画；规则告警后才启用媒体轨道。
- [x] 录音、iOS 音频解锁、scene takeover 与 LBX reply replay 不回退。
