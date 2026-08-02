# 2026-08-02 · A→B 本地实链路验证（真 MiMo，B→C 未通期间的独立联调）

- 背景：B→C 数据链路尚未打通，先独立验证「A 姿态分类 → B 消费 → MiMo 判断输出」。
- 环境：单机 loopback。A `reme.pose.runtime_server --input-adapter c_ws_server`（127.0.0.1:8770，浏览器网关 landmarks 模式，无模型文件、纯几何分类）；B `reme.decision.server --a-events-url ws://127.0.0.1:8770/ws/events`（127.0.0.1:8100，live 模式，真 `MIMO_API_KEY`，key 寄存 `~/.config/reme/mimo.env`）。
- 工具：`examples/integration/ab_live_debug.py`（本轮新增）。合成 MoveNet-17 关键点经 A 的 `/ws/camera-input` 直传，同时订阅 A `/ws/events` 与 B `/ws`，并替 C 扮演倒计时/回应角色（状态机无定时器，超时升级依赖 C 提交 `none/timeout`）。

## 实测矩阵（均为本机单次实跑，非统计结论）

| 场景 | A 输出 | B 决策链 | MiMo |
|---|---|---|---|
| fall（站0.6s→倒0.4s→躺） | posture 5Hz；`fall_like_transition` conf=0.808 | normal(rule) → check_in_required(rule，预置话术+frame/voice 通道) → 超时 none/timeout → family_notification_required(rule，alarm=vibrate/ring/flash) | 0 次（危险链路合同要求不等 MiMo）✓ |
| concern + 主诉（坐姿静止30s→need_help「牙疼…」→consent_granted） | posture 5Hz sitting/still | normal(rule) → check_in_required(**mimo**) → consent_required(**mimo**) → family_notification_required(**mimo**，含家属卡文案) | 3 次，均 1 attempt；时延 4288/2391/2228 ms |
| still（站立8s） | posture 5Hz standing | normal(rule) ×1 | 0 次（正常稳定不调用）✓ |

MiMo 实际输出示例（source=mimo，live API）：问询「王奶奶，坐了会儿了，感觉还好吗？」；解读主诉后请求授权「…要不我帮您跟家人说一声，让他们带您去看看？」；家属通知「老人主诉牙疼两天、进食困难，已同意告知家人，请尽快帮忙安排口腔科检查。」

## 发现 1（已修复）：MiMo 在途窗口的 tick 风暴

首轮 concern 实测：check-in 触发后 MiMo 在途约 2s，期间 A 的 5Hz 姿态 tick 每个都再次发起 `COMPOSE_CHECK_IN` —— 审计记录 **11 次真实 API 调用**（1 次提交 + 10 次 `mimo_discarded`），且同一 `decision-0013` 向 C 重复广播 11 次（`_publish` 只对比 tick 前的 previous_id，CAS 竞态重播）。

修复（`backend/reme/decision/policy.py`）：`_SceneRuntime` 增加 `mimo_inflight` 门闩，`get_decision`/`submit_response` 在指令需要 MiMo 时先占坑；已有在途调用时幂等复用当前 pending 决策（不重复起调、不重复广播），调用结束 `finally` 在同一 runtime 对象上释放（session 重置换新对象，旧调用无法误释放）。回归测试 `test_tick_during_inflight_mimo_reuses_instead_of_stacking`（重入钩子模拟在途 tick，断言恰 1 次调用、发布序列无重复）。修复后复测：3 条 MiMo 决策各恰 1 次调用，`mimo_discarded` 为 0。

## 发现 2（已修复，见 `2026-08-02-fall-window-anchor-fix.md`）：规则跌倒候选依赖「缓冲重置后 1.4s 内」

`TransitionDetector` 的 `short_window` 信号要求评估窗口 ≤1400ms，但滑窗按 `window_ms=3200` 修剪、从场景开始/上一事件清空后累积。实测：站立前奏 2s 时同一跌倒序列只能产出 `uncertain_transition`(0.35)（窗口 0→2800ms 撑破 1400ms）；前奏 0.6s（与 e2e 同节奏）则正常产出 `fall_like_transition`(0.808)。推论（代码阅读，未逐一实测）：连续运行状态下缓冲常驻 ~3.2s，画面里站几秒再摔的真实跌倒无法满足 short_window，规则候选会漏报为 uncertain/normal。这正是 fall-transition-training（MIL 时序模型）要补的能力；演示编排时也需注意（利用 scene_signal 重置或紧凑动作起点）。B 侧 `fall_confidence_min` 锚定 A 的产出分布，A 重调阈值时联动。

## 复现

```bash
# 终端1（A）
.venv/bin/python -m reme.pose.runtime_server --host 127.0.0.1 --port 8770 --input-adapter c_ws_server
# 终端2（B）
source ~/.config/reme/mimo.env && .venv/bin/python -m reme.decision.server \
    --host 127.0.0.1 --port 8100 --a-events-url ws://127.0.0.1:8770/ws/events
# 终端3（驱动，场景任选）
.venv/bin/python examples/integration/ab_live_debug.py --scenario concern \
    --respond-text "牙疼了两天，饭都吃不下，又不想麻烦孩子"
```

浏览器真人驱动时（前端连 A），用 `--attach` 旁听同一会话的 A/B 双流输出。
