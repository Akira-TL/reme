# 单人 / 多人匿名火柴人自动化 Gate 结果

- Date: 2026-08-02
- Parent commit: `710e9a7b2d6d01eb6ee581aee8b5b86297ff8b76`
- Worktree: `/tmp/reme-auto-scene`（detached）
- Scope: demo-only 单人/多人投影按钮、真实多人本地提取、严格 Relay/viewer 合同、清场和权威链隔离
- Capability status: automated hard gates passed; target-phone capability gate pending

## 静止代码自动化结果

- Frontend：`npm test` 194/194；`npm run lint` 通过；`npm run build` 通过（975 modules）。
- Relay：最终静止代码上 `npm test -- --reporter=dot` 连续三次均为 69/69；`npm run check` 通过。
- Wrangler：production 与 staging `npm run dry-run` 均通过；只生成本地 dry-run 输出，没有发布。
- Git hygiene：提交前运行 `git diff --check` 与冲突标记扫描；结果记录在本次提交交接中。
- 独立只读终审：未发现 P0/P1；模型、协议、viewer cursor、断线清场和权威链隔离均通过审查。

## 已通过的硬边界

- `single` 继续使用原 `movenet-17/v1-demo`，只有该既有单人帧可进入浏览器跌倒规则。
- `multi` 使用本地 MediaPipe Pose Landmarker 的真实同帧候选，严格输出 `0..4` 个匿名 17 点 pose；未复制、平移或扰动单人骨架。
- batch 不含身份、稳定 ID、track、人物编号、图片或媒体字段；viewer 对所有候选使用同一种骨架颜色。
- batch、按钮和候选数量不会生成或修改 alarm、activity、voice、card、receipt、verified activity、grant、lease、watchdog 或 checkpoint。
- 单人/多人/reset 共用单调 frame cursor；切换、停止、隐藏和 controller 断线清除人物层，旧 session 或旧 generation 不能恢复最后一帧。
- 浏览器必须提供严格增长的可靠解码帧计数；无计数、计数冻结、计数 API 交替，以及异步推理 promise 超过三秒时会 fail-close，不使用 `currentTime` 给旧帧续命。当前 MediaPipe `detectForVideo` 同步运行于主线程，底层同步阻塞不能被 JavaScript timer 抢占；该长任务风险仍属于目标手机 Gate，自动化结果不声称三秒硬切断同步调用。
- 多人 estimator 失败后会作废并重新加载；隐藏/恢复、发送失败和资源 dispose 不会把健康 estimator 误判为权威事件，也不会卡住停止采集。
- 权威厨房/跌倒 grant 的真实视频继续覆盖骨架；完全隐私仍禁止真实像素和家具背景。

## 尚未关闭的真实设备 Gate

本轮没有用目标手机完成 Pilot/Holdout，因此不能声称多人检出率、可靠人数统计、目标手机帧率/时延、遮挡质量、温升、跨设备稳定性或路演主路径已通过。上线前仍需按规格在指定手机上覆盖 `0/1/2/3/4/5+` 人、交叉遮挡、进出画、竖屏后置摄像头、前后台恢复、至少两个 viewer、断线恢复和连续运行。

还必须在目标手机观测主线程长任务和最坏推理耗时。若同步 `detectForVideo` 造成不可接受的事件循环阻塞，本 Gate 判为 No-go；现有 Promise deadline 不是 Worker 级抢占保证。

## 发布边界

本轮只在 detached worktree 形成独立多人功能提交；未推送、未部署、未移动 `lbx`，也未改动当前主工作树。是否合入与发布由上游协调任务在不可变 SHA 上另行决定。
