# 后端代码边界

`backend/reme/` 是 Python 产品代码包。后端只保留一个运行时边界，不再把感知和决策作为两个独立可执行端。

## 当前模块

```text
backend/reme/
├── runtime/
│   ├── perception/   # 图像输入、姿态提取、分类与动作转变
│   ├── decision/     # 规则/MiMo、会话、危险确认与事件发布
│   ├── launcher.py   # 本地程序监督与前端启动
│   ├── transport.py  # 进程内事件传输（后续批次建立）
│   └── server.py     # 统一后端 HTTP/WS 服务（后续批次建立）
├── pose/             # 旧 `reme.pose.*` 导入兼容层，不是独立服务
├── decision/         # 旧 `reme.decision.*` 导入兼容层，不是独立服务
├── local_demo.py     # 旧导入兼容别名
├── scene_bundle.py   # 场景包兼容入口
├── care.py           # 早期动作 JSONL 关怀原型
├── motion.py         # 早期动作数据规则
├── motion_io.py      # 早期动作数据读取
└── demo.py           # 早期动作原型实现，由 scripts/tools/ 包装调用
```

## 规则

- 新感知代码进入 `reme.runtime.perception`。
- 新决策代码进入 `reme.runtime.decision`。
- 感知到决策的数据传输必须走 `reme.runtime.transport` 的进程内接口，不得重新建立内部 HTTP/WebSocket 链路。
- 浏览器只访问统一后端服务暴露的 HTTP/WS 路由。
- `reme.pose`、`reme.decision` 和 `reme.local_demo` 只用于迁移期兼容；新代码不得新增这些路径的导入。
- `care.py`、`motion.py`、`motion_io.py` 和 `demo.py` 属于兼容/历史原型；新代码不得继续扩大对它们的依赖。
- 模型、训练数据和运行结果不得写入包目录，应写入 `models/` 约定位置或 Git 忽略的 `artifacts/`。
