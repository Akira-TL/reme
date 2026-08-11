# `origin/lbx` 提交级对账

- Type: research
- Status: resolved
- Date: 2026-08-11
- Candidate baseline: `origin/lbx-frontend@d27a21b30a7dec3c76f18b482a87bd80907ed17d`
- Source branch: `origin/lbx@6c39d117f237533b5f5e02e383e581a383c6bdd4`
- Runtime constraint: 本轮只审计，不启动 Frontend、Backend 或 Relay

## 结论

`origin/lbx` 不能整支合并，也不能逐提交机械 cherry-pick。它相对候选基线有
61 个独有提交；提交级复核后，**没有一个提交构成当前全站基线必须新增的迁移包**。
61 个提交全部明确不迁移，其中 `6ed81cd6` 的行为已以 patch-equivalent 形式包含在当前分支，
其余提交或已被当前实现覆盖，或与当前合同、产品语义、架构和证据门禁不兼容。

| 终态 | 提交数 | 处理 |
| --- | ---: | --- |
| 选择性迁移 | 0 | 当前没有来自 `origin/lbx` 的必需增量 |
| 明确否决 | 61 | 不 cherry-pick；理由在逐提交表中冻结 |

否决不等于否认历史工作的价值。它表示该提交不再是当前 `lbx-frontend` 全栈基线的
可迁移代码单元：要么现实现已覆盖，要么证据/合同/部署已经过期，要么行为与当前
Accepted ADR、单人 MVP、Backend 权威或隐私边界冲突。

## 对账方法与判据

1. 执行 `git fetch origin --prune --tags`，以官方 `Akira-TL/reme` 当时远端为准。
2. 冻结集合：`git rev-list --reverse --topo-order origin/lbx-frontend..origin/lbx`，共 61 个提交。
3. 补丁等价检查：`git cherry origin/lbx-frontend origin/lbx`；只有
   `6ed81cd6` 已与当前分支的 `8ea93474` patch-equivalent。
4. 对每个提交检查 first-parent patch、受影响目录、当前等价实现、`CONTEXT.md`、
   ADR-0003/0005/0007/0008/0009 和当前确定性测试。
5. 二元裁决：只允许“选择性迁移”或“明确否决”。“选择性迁移”也禁止直接
   cherry-pick，必须使用当前 `backend/reme/runtime/*`、FamilyEvent、Viewer v2 和
   server-owned deadline 合同重新实现。

当前裁决边界：

- 单人、Backend 权威姿态；浏览器不得恢复 MoveNet/MediaPipe/LiteRT 推理或模型资产。
- 统一 Backend 拥有感知、决策、交互 deadline、Alarm、行动卡和媒体授权。
- Relay 只接收最小 FamilyEvent、媒体授权投影、ACK 和 WebRTC 信令；不得承担 MiMo
  场景识别、业务决策或原始媒体传输。
- Family 断线恢复由 Relay v2 的 FamilyEvent snapshot 承担；当前 Home/Debug 的 Backend
  `/ws` 仍按既定合同 fail-close，不恢复已删除的旧 Viewer 直连决策流。
- `resolved` 的老人端确认话术按具体模板决定；不得用“非安全终态”默认静默覆盖授权
  拒绝、分享拒绝或家属确认回执。
- 感知阈值和新 fall heuristic 未经当前数据与 Gate 复测，不因旧提交曾“实测”就移植。
- 历史部署证据、WIP、merge 容器和已失效域名不能成为新基线能力。

## 复核后否决的两个候选

### Backend `/ws` 当前决策快照补发

来源提交：`105c4ab6`、`798630a6`。

裁决：**明确否决当前迁移**。

1. 这两个提交修复的直接消费者是旧 `frontend/src/viewer/useViewerLink.js`：它直连
   Backend `/ws` 并每 1.5 秒重连。当前该 Viewer 已删除，Family 改为 Relay v2，且 Relay
   已在连接时补发最新 FamilyEvent。
2. 当前 `frontend/src/hooks/useDecisionRuntime.js` 是 Home/Debug 会话所有者；断线时清空
   authority 并显示不可用，不做同会话重连。这与 `.scratch/software-demo/spec.md` 的
   fail-close 约定一致。只移植 Backend 快照不会形成可到达的完整恢复路径。
3. 当前 Home 消费 CareDecision 时会触发 TTS、麦克风采集、danger frame 和 deadline
   展示等副作用。把旧决策当普通实时帧补发，可能重复播报、重复采集或改变语音窗口；
   旧只读 Viewer 的“按 decision id 去重即可”不能证明当前消费者安全。
4. 因此不能把“Hub 能补发一个 JSON”误判为全站断线恢复。若产品以后要求 Home/Debug
   同会话续接，必须先冻结前端重连、snapshot 标识、副作用抑制、剩余 deadline 和会话
   替换语义，再按当前路径重新实现；这是一项新需求，不是本轮基线迁移。

### 非安全 `resolved` 默认静默

来源提交：`6c39d117`。

裁决：**明确否决当前迁移**。

1. 当前前端只有 `check_in_required` 和 `consent_required` 会进入等待回复/录音；
   `resolved + need_dialogue=true` 不会再开启一轮问答，只允许播放确认话术。因此该提交
   并未修复当前实现中的对话循环。
2. 已冻结的行动卡闭环要求家属确认后输出 `mark_resolved + elder_message` 回执；当前
   `RECEIPT_RESOLVED` 模板也明确告诉老人家属已经收到。默认静默会直接删除这条产品承诺。
3. `CONSENT_DENIED_CLOSE`、`KITCHEN_SHARE_DENIED` 等话术是在确认老人选择和隐私边界，
   不能仅因它们属于“非安全 resolved”就静默。
4. 若以后要降低播报频率，应逐模板做产品裁决并增加语音验收，而不是把 `_resolve`
   默认值改成 `False`。`6c39d117` 没有提供足以推翻当前合同的提交级证据。

## 61 个提交逐条裁决

| # | Commit | 终态 | 明确理由 |
| ---: | --- | --- | --- |
| 01 | `4ce38a2a` | 否决 | 当前 `startSession(... replace_active: true)` 与 Backend 原子接管已覆盖 409 残留会话；旧前端重试实现不再需要。 |
| 02 | `71b38641` | 否决 | 当前 decision voice 预热与 `useAlertEffects` 已在真实用户手势后恢复 AudioContext；旧共享对象不可直接移植。 |
| 03 | `3ae97608` | 否决 | 当前 `HomeCarePrompt`、权威 deadline 展示和求助动作已覆盖可见性；浏览器不再拥有 timeout 决策。 |
| 04 | `eb37ff40` | 否决 | 基于旧实时 detector 的阈值调优，未在当前 `runtime/perception` 数据集与 Gate 上复测；禁止迁移旧阈值。 |
| 05 | `7c45d9ef` | 否决 | “下坠后消失=fall”是旧 vanish heuristic，会把遮挡/离场混入跌倒；与当前 temporal evidence、unknown 策略不兼容。 |
| 06 | `97ec6bde` | 否决 | 提交自标 WIP，旧 Viewer 骨架回放器已被当前 Backend PoseFrame + Family Canvas runtime 取代。 |
| 07 | `7e9810ab` | 否决 | 提交自标 WIP，样式依附已删除的旧 Viewer DOM，不构成可迁移功能。 |
| 08 | `4f9e3ece` | 否决 | 只修补已否决的 vanish heuristic；不能绕过对该候选路本身的可行性 Gate。 |
| 09 | `d3f02e87` | 否决 | 当前 `/family`、Viewer v2、控制 ACK 与三角色路由已完整替代旧旁观页。 |
| 10 | `4d73a5a3` | 否决 | 混合提交不可 cherry-pick：重复 fall 与 timeout 已由 handled event/server deadline 覆盖；“呻吟即报警”违反 unclear/规则升级边界。 |
| 11 | `d44c9d06` | 否决 | 提交自标 WIP，旧 viewer 批次已被后续 Family 产品面重写。 |
| 12 | `105c4ab6` | 否决 | 修复对象是已删除的旧 Viewer 直连/重连路径；当前 Family 已由 Relay v2 快照收敛，Home/Debug 又没有同会话重连，后端单边补发不是完整能力且会重触发有副作用的决策消费。 |
| 13 | `798630a6` | 否决 | 仅加固已否决的旧 `/ws` replay 方案；“锁外 socket I/O”本身正确，但当前没有需要迁移的 replay 功能单元。 |
| 14 | `67963f0a` | 否决 | “unbounded voice capture”与当前有界录音、最小 FamilyEvent、默认不出域 elder quote 的隐私边界冲突。 |
| 15 | `341eb315` | 否决 | 旧 detector 的运动锚定调整不能跨实现沿用；当前 continuous runtime 需用现有标注数据重新比较而非搬阈值。 |
| 16 | `a51829f4` | 否决 | 纯 merge 容器；两个父线的实际提交已分别裁决。 |
| 17 | `f3adc04d` | 否决 | 研究笔记的可用方向已由 ADR-0006 与当前 behavior/memory/home 实现吸收；旧笔记不是运行时补丁。 |
| 18 | `a8f1f41f` | 否决 | 旧 judge/monitor 公网部署与当前单域名前端、ADR-0009 Runtime/Relay 权威和 VPS 包不兼容。 |
| 19 | `7b6bdb72` | 否决 | 纯 merge 容器；ABC 单机线已经是现分支历史祖先，不重复引入。 |
| 20 | `13ae5dbc` | 否决 | 旧生产部署证据绑定过时 commit、域名和拓扑，不能证明当前候选。 |
| 21 | `775efa2e` | 否决 | 纯 merge 容器；v0.1.0 前端已被当前三角色前端取代。 |
| 22 | `8a2f6a52` | 否决 | 旧 upstream 部署记录；且该 archived 线已是 `origin/lbx` 子集，无独立迁移价值。 |
| 23 | `541b80b8` | 否决 | 纯 merge 容器；只汇合已逐条裁决的旧分叉。 |
| 24 | `6ed81cd6` | 否决 | 已与当前分支 `8ea93474` patch-equivalent；重复迁移会制造冲突。 |
| 25 | `22778f27` | 否决 | 四场景旧壳混合浏览器/Relay 权威和旧合同；当前 `/home`、`/family`、`/debug` 与 Backend 权威已重写。 |
| 26 | `4f27311a` | 否决 | 旧 LBX release 状态证据，不适用于当前 commit 或拓扑。 |
| 27 | `c070b509` | 否决 | 旧 `monitor` 域名发版 Gate 已被单产品域名决策明确废止。 |
| 28 | `be6337dc` | 否决 | 旧 shared-demo 视觉对齐已被当前 Home/Family 设计与角色拆分覆盖。 |
| 29 | `1d49f97e` | 否决 | ChatCut 编辑记录属于交付历史，不是全栈代码或合同增量。 |
| 30 | `6634c92f` | 否决 | 旧 public-voice 合同让公共演示面承担语音链路；当前 MiMo voice 必须留在统一 Backend。 |
| 31 | `98f80c1e` | 否决 | ChatCut 导出证据不属于运行时基线。 |
| 32 | `4444ace5` | 否决 | 恢复旧 controller session 与当前短租约、刷新不恢复 room authority 的 fail-closed 决策冲突；scene dock 已由 Debug 覆盖。 |
| 33 | `092d5bbe` | 否决 | 事件语音经公共 Relay/Frontend 的实现违反 ADR-0009 最小 Relay；当前 voice dialogue 由 Backend 承担。 |
| 34 | `d0259818` | 否决 | fall escalation durability 已由 Backend-owned deadline、FamilyEvent 和 Relay revision 取代，旧 public-voice 状态机不再是权威。 |
| 35 | `e874de15` | 否决 | legacy controller-ready bridge 会放宽当前 exact v1/v2 协议；不保留旧客户端兼容旁路。 |
| 36 | `e465fd73` | 否决 | 旧 public-voice 生产验证绑定已否决的架构，证据随实现一起失效。 |
| 37 | `1e50fdb1` | 否决 | MiMo auto-scene Gate 把场景识别放到公共演示面，违反 Backend 感知权威。 |
| 38 | `e9245970` | 否决 | Relay 调 MiMo 分类视觉样本违反 ADR-0009：Relay 不得成为视觉理解或业务推理服务。 |
| 39 | `920e992d` | 否决 | Frontend MiMo scene client 恢复浏览器推理权威和云视觉旁路；当前前端只消费 Backend 结果。 |
| 40 | `ede3b8f4` | 否决 | 自动场景动作串起两个已否决端点，且 Viewer 命令不得伪造场景/安全事实。 |
| 41 | `f94d5fc6` | 否决 | 旧 activity/scene media authority 已被 Backend `MediaAuthorization` + Relay grant 双层合同取代。 |
| 42 | `0f18a59f` | 否决 | 当前交互 deadline 属于 Backend scheduler，浏览器 hidden 不再暂停或取消它。 |
| 43 | `710e9a7b` | 否决 | 当前 source generation、room/runtime session、grant revoke 和 peer cleanup 测试已覆盖旧生命周期竞态。 |
| 44 | `45de900c` | 否决 | 当前 runtime/room session 与 revision 已承担状态隔离，Family 重连由 Relay v2 snapshot 收敛；Home/Debug `/ws` 仍按合同 fail-close，旧 authority 形态不兼容。 |
| 45 | `c1e9abc8` | 否决 | 仅锁定旧前端 fall deadline 语义；当前权威 deadline 测试位于 Backend，重复测试没有目标实现。 |
| 46 | `abec5d9e` | 否决 | 旧 visual policy 验收记录不能证明当前 FamilyEvent/media authorization 实现。 |
| 47 | `9ffa989d` | 否决 | 浏览器 activity confirmation 不能成为公共广播前置权威；当前广播只能来自 Backend FamilyEvent。 |
| 48 | `f55ca630` | 否决 | 所修的 activity-confirmation capability 协议已删除；当前 exact runtime capability 必须 fail-closed，不兼容该迟到消息状态机。 |
| 49 | `e0601fb4` | 否决 | 旧 release-candidate 证据，不适用于当前树。 |
| 50 | `2122e02e` | 否决 | 旧 visual-policy 生产发布记录，绑定已替换的 authority 实现。 |
| 51 | `f131b74b` | 否决 | anonymous multipose 违反当前单人 MVP 和 no-browser-pose 门禁；不恢复浏览器模型与权重。 |
| 52 | `44890559` | 否决 | 只加固已否决的 multipose/browser 推理路径，不能改变范围裁决。 |
| 53 | `c126958a` | 否决 | 被否决 multipose 路径的生产证据随路径一起退出当前基线。 |
| 54 | `c39d5d20` | 否决 | grant-bound TURN 已由 ADR-0009、当前 `/api/rtc-config`、短期凭据和当前 TURN 验证覆盖；旧 scene/grant schema 不迁移。 |
| 55 | `43283d2b` | 否决 | 旧 TURN 自动 Gate 证据绑定旧 Relay；当前候选使用新的 provider-neutral RTC 合同与验证记录。 |
| 56 | `e9312aed` | 否决 | 当前 `voice_dialogue` 与 danger endpoints 已把 fall reply 送入 Backend 权威路径。 |
| 57 | `627e2c6b` | 否决 | 旧 LBX 集成验证记录不能替代当前分支测试和浏览器验收。 |
| 58 | `e03305b4` | 否决 | 当前 Backend `mark_decision_voice_started/ready` 会暂停并重启完整回复窗口，已覆盖旧浏览器计时方案。 |
| 59 | `7a283ad8` | 否决 | 旧固定 post-prompt grace 已被 Backend 在 TTS ready 后重启 exact `response_timeout_ms` 取代。 |
| 60 | `99a01ff1` | 否决 | 当前 `_reject_too_early_timeout` 与 Backend scheduler 已拒绝 prompt 完成前/窗口内 timeout。 |
| 61 | `6c39d117` | 否决 | 当前 resolved 不会开启回复采集；默认静默反而会删除行动卡回执、授权拒绝和分享拒绝的老人端确认话术，与已冻结产品闭环冲突。 |

## 否决分类统计

| 类别 | 数量 | 说明 |
| --- | ---: | --- |
| 当前实现已覆盖或 patch-equivalent | 17 | 不重复迁移旧代码 |
| WIP、merge、研究/发布证据 | 20 | 不作为运行时增量 |
| 架构、隐私、产品语义或 authority 冲突 | 16 | 与当前 Accepted ADR/合同不兼容 |
| 未在当前 Gate 复测的感知 heuristic | 4 | 不搬阈值或旧 detector |
| 单人 MVP / no-browser-pose 范围冲突 | 2 | multipose 路径退出基线 |
| 旧部署拓扑 | 2 | 由当前单域名、ADR-0009 和 VPS 边界取代 |
| **合计** | **61** | 与逐提交裁决一致 |

## 下一阶段边界

本文件只冻结裁决，没有迁移实现。当前 `lbx-frontend` 可继续作为全站启动候选，不需要
从 `origin/lbx` 引入提交。后续只有出现新的、明确验收需求时才重新开题：

1. 若要求 Home/Debug 在 Backend `/ws` 中断后保持同一 runtime session，先写前后端一体的
   续接合同和副作用安全测试，再决定 snapshot 或 HTTP current-decision 方案。
2. 若要求部分 resolved 不播报，按模板逐项冻结老人端体验；不得恢复“非安全默认静默”。
3. 任何后续实现都以当前 `lbx-frontend` 新建独立分支，不切到或 merge `origin/lbx`；
   启动或真机联调仍须等待单独发令。

## 本轮验证

- `git fetch origin --prune --tags`: 成功。
- `git rev-list --count origin/lbx-frontend..origin/lbx`: `61`。
- `git rev-list --count origin/lbx..origin/lbx-frontend`: `180`。
- `git cherry origin/lbx-frontend origin/lbx`: 60 个 `+`，1 个 `-`；唯一 `-` 为 `6ed81cd6`。
- 当前工作树开始前已有 `.codex-tmp-hybrid/` 未跟踪目录，本轮不读取、不修改、不提交。
- 本轮未启动 Frontend、Backend、Relay，未部署，未修改产品代码。
