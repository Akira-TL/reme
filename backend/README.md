# 后端代码边界

`backend/reme/` 是 Python 产品代码包。

## 当前模块

```text
backend/reme/
├── pose/          # A：姿态提取、分类、转变事件和浏览器输入运行时
├── decision/      # B：规则/MiMo 决策、会话、回应、危险确认和事件流
├── local_demo.py  # A/B/C 单机进程管理器
├── scene_bundle.py# `reme.pose.scene_bundle` 的兼容入口
├── care.py        # 早期动作 JSONL 关怀原型
├── motion.py      # 早期动作数据规则
├── motion_io.py   # 早期动作数据读取
└── demo.py        # 早期动作原型实现，由 scripts/tools/ 包装调用
```

## 规则

- 新感知代码进入 `reme.pose`。
- 新决策代码进入 `reme.decision`。
- A/B/C 共享合同先在 `.scratch/abc-interface/spec.md` 对齐，再进入正式模块。
- `care.py`、`motion.py`、`motion_io.py` 和 `demo.py` 属于兼容/历史原型；新代码不得继续扩大对它们的依赖。
- `reme.scene_bundle` 暂时保留兼容导出；新调用直接使用 `reme.pose.scene_bundle`。
- 模型、训练数据和运行结果不得写入包目录，应写入 `models/` 约定位置或 Git 忽略的 `artifacts/`。
