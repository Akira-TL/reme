# 大样本提示词实验结论（B spec P1-1 / S10）

- 网格：8 场景 × 2 变体（v1-stock / v2-context）× 10 样本 = **160 次 live 真调用**，pace 0.7s，`mimo-v2.5` JSON 模式 + thinking disabled + temperature 0.2。
- 明细见同目录 `2026-08-01-experiment/report.md` 与 `outcomes.jsonl`。

## 结论

1. **JSON 合法率 / schema 合规率 160/160 = 100%**。MIMO-04 的"JSON 解析 100%"验收从此前 7 连发小样本升级为大样本证据。
2. **零分支漂移**：每格 10 样本状态分布全部收敛在期望集合内（含刻意放宽为双分支的 vague-reply，模型稳定选择保守的 check_in_required）。称呼合规 100%（elder_message 全部以配置的称呼开头）。
3. **v2 上下文注入（【行为特征】【长期记忆】【居家上下文】）零结构性退化**：总体 P50 2705ms（v1 3036ms，差异属噪声区间）；仅两个 COMPOSE_CARD 场景 P50 +~700ms（提示词更长，符合预期）。P95 两变体均 ~5.1s，在 8s 超时预算内。
4. **决定：认知三层保持默认开启（cognition_enabled=True）**，本轮无需提示词迭代。

## 已知盲区（后续工作）

- 指标不覆盖**通知文本的隐私泄漏**（如 night-fall-card 场景下"凌晨/卫生间"等环境细节是否被写进 family_notification）——outcomes 未捕获回复正文。后续给 SampleOutcome 增加可选正文留存 + 内容级质检。
- 期望集合是"分支正确性"口径，不评价文案质量；文案人工评审另行安排。

## 补充：v2 生产路径重跑（2026-08-02，Codex 复审后）

Codex 复审指出首轮 v2 测量未走生产提示词函数（缺 context_aware 系统守则、注入顺序手拼）。实验台改走生产同路径后 v2 全部 80 格重跑（`2026-08-02-experiment-v2rerun/`）：**80/80 四项指标仍全部 100%、零分支漂移**，总体 P50 2836ms / P95 6245ms。累计三轮 240 次 live 调用零失败。注意：`night-bathroom-lying` 单格 P95 达 8021ms（含重试口径），超时预算余量收窄——若联调期观察到降级增多，优先考虑调大 timeout 或减小该场景上下文注入长度。
