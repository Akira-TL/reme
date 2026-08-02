# 05 — MiMo 显式真实识别与四场景切换 Gate

- Type: research
- Status: ready-for-agent
- Owner: C / MiMo scene recognition
- Related: `mimo-auto-scene-feasibility-spec.md`、ADR-0010

## What to build

实现一个独立于四场景 Dock 的“真实识别 · MiMo”实验动作。一次点击只取得并发送一个最小视觉样本：
默认约 2 秒 MP4；目标浏览器不支持或录制失败时，透明降级为单张 JPEG。MiMo 返回
`living | kitchen | bathroom | fall | uncertain`，本地策略只允许切换现有展示模式。

该任务是 feasibility adapter，不冻结永久架构。真实质量、时延、稳定性和成本 Gate 完成前，能力状态保持
`pending`，四个手动按钮必须始终可用。

## Acceptance

- [ ] 第五动作与四个场景按钮在语义和视觉上明确分离，不显示为第五场景。
- [ ] 每次用户点击最多产生一个受鉴权视觉请求；同一时刻只有一个在途请求，无定时或后台循环采样。
- [ ] 默认录制约 2 秒 MP4；不支持 MP4 或录制失败时只发送一张 JPEG，并在 UI 与证据中显示 fallback。
- [ ] MP4 已提交后失败时不静默补发 JPEG；用户可看到失败并主动重试。
- [ ] Relay 严格校验控制租约、MIME、魔数、大小、精确响应合同和上游超时；浏览器不接触 MiMo key。
- [ ] 原始媒体只存在于请求内存生命周期，不进入日志正文、浏览器持久存储、事件 WebSocket、DO、KV 或仓库。
- [ ] `living/kitchen/bathroom/fall` 只发布相应现有 `scene_state`；`uncertain`、低置信、非法或不可用保留当前模式。
- [ ] `kitchen` 提议不生成 cooking 事件、家庭心跳或媒体授权，也不级联未披露的视觉请求。
- [ ] `fall` 提议无法创建、升级、解除 `alarm_state`，无法暂停规则 timer，也无法签发 `fall_emergency` grant。
- [ ] 告警/问询存在时，任何 MiMo 场景结果都不能降低或隐藏既有风险状态。
- [ ] 手动场景点击、停止采集、会话变化或释放控制使在途结果过期；迟到响应不能覆盖人工选择。
- [ ] 完全隐私模式没有隐式采样；只有再次明确点击第五动作才发送一轮样本，并清楚披露云端视觉发送。
- [ ] 自动化覆盖 MP4、JPEG fallback、单请求上限、重复点击、取消、迟到、低置信、`uncertain`、非法响应、
  手动覆盖、隐私模式和 fall 安全不变量。
- [ ] 在目标手机完成 Pilot 与未参与调参的 Holdout，分别记录 MP4/JPEG 的混淆矩阵、拒判、重复稳定性、
  错误切换、Schema 通过、P50/P95、字节、usage、失败和测试条件。
- [ ] 在 Holdout Gate 评审前，不在 UI、文档或路演中宣称自动四场景能力已经通过。

## Evidence required to resolve

- `.scratch/four-scene-live-demo/results/<date>-mimo-auto-scene-pilot.md`
- `.scratch/four-scene-live-demo/results/<date>-mimo-auto-scene-holdout.md`
- `.scratch/four-scene-live-demo/results/<date>-mimo-auto-scene-calls.jsonl`
- 前端、Relay 测试/typecheck/build，以及目标手机浏览器的 MP4/JPEG 实际路径记录。

## No-go conditions

- 单击导致多次或后台视觉上传。
- 原始媒体持久化、进入 DO/事件平面或日志正文。
- 低置信、`uncertain`、失败或迟到结果改变模式。
- 手动 fallback 不能可靠接管。
- MiMo 场景结果直接影响报警状态或媒体授权。
- 完全隐私模式在无新一次明确点击时采样。
- 真实 Gate 缺失，却把合成素材或端点可用性描述成能力验收。
