# 早期动作 JSONL 原型

该目录归档 Reme 最初基于派生动作数据的透明跌倒启发式、JSONL 读取和关怀流程。它用于历史追溯、合同回放以及 `tiny-transition-model` 的基线对比，不属于当前统一运行时，也不代表已经验证的跌倒检测能力。

## 内容

```text
contracts.py   # 早期事件候选合同
motion.py      # 几何动作启发式
motion_io.py   # JSONL 读取
care.py        # 早期确定性关怀流程
demo.py        # 命令行回放入口
```

运行兼容工具：

```bash
scripts/tools/run-legacy-motion-demo.sh <motion.jsonl>
```

也可以直接运行：

```bash
uv run python -m experiments.legacy_motion_demo.demo <motion.jsonl>
```

新产品代码不得依赖本目录；当前实现应进入 `backend/reme/runtime/`。
