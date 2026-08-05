# Reme 文档导航

Reme 的长期文档统一放在 `docs/`；临时规格、任务、实验过程和会话交接继续放在 `.scratch/`。

## 启动与开发

- [快速启动](快速启动.md)：完整 ABC 单机演示、依赖和故障排查。
- [前端说明](../frontend/README.md)：React/Vite 页面、运行时接入和构建方式。
- [姿态模块说明](../backend/reme/pose/README.md)：A 侧模型、训练与运行时工具。

## 产品文档

- [核心产品文档 v3.0](product/Reme-核心产品文档-v3.0.md)：比赛产品、技术、交互和路演基线。
- [任务分解](product/任务分解.md)：工程任务、验收标准和依赖。
- [开发计划](product/开发计划.md)：比赛执行计划与合龙节点。
- [v3.0 增量分析](product/v3.0-增量分析.md)：v2.0 到 v3.0 的变化。
- [PRD v2.0](product/Reme-PRD-v2.0.md)：历史版本，仅供追溯。

## 技术方案

- [MiMo 接入方案](integration/方案-MiMo接入.md)：请求载荷、端到端流转和降级路径。
- [架构决策记录](adr/)：已接受、拒绝或被取代的架构决策。
- [旧动作数据格式](motion-data-format.md)：早期 `reme-demo` 探索接口，仅供兼容与历史追溯。

## 调研资料

- [MiMo API 调研](research/情报-MiMo-API.md)
- [Miloco 对比调研](research/情报-Miloco.md)
- [Miloco 代码剖析](research/情报-Miloco-代码剖析.md)
- [外部事实来源台账](references/intel-sources.md)
- [认知能力证据](references/cognition-evidence.md)

## 协作规则

- [Agent 领域文档规则](agents/domain.md)
- [本地 Issue Tracker](agents/issue-tracker.md)
- [Triage 标签](agents/triage-labels.md)

`.scratch/` 中的文件可能包含阶段性假设、实验代码和历史结果，不应自动视为当前产品事实。长期有效的结论应进入 `CONTEXT.md`、ADR 或本目录中的正式文档。
