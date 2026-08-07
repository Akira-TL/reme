# 后端代码边界

`backend/reme/` 是 Python 产品代码包。后端只保留一个运行时边界，不再把感知和决策作为两个独立可执行端。

## 当前模块

```text
backend/reme/
├── runtime/
│   ├── perception/   # 图像输入、姿态提取、分类与动作转变
│   ├── decision/     # 规则/MiMo、会话、危险确认与事件发布
│   ├── launcher.py   # 本地程序监督与前端启动
│   ├── transport.py       # 进程内感知到决策事件传输
│   ├── debug_ws_client.py # 外部联调观察器，不参与内部传输
│   └── server.py          # 唯一后端 HTTP/WS 服务入口
└── __init__.py
```

## 规则

- 新感知代码进入 `reme.runtime.perception`。
- 新决策代码进入 `reme.runtime.decision`。
- 感知到决策的数据传输必须走 `reme.runtime.transport` 的进程内接口，不得重新建立内部 HTTP/WebSocket 链路。
- 浏览器只访问统一后端服务暴露的 HTTP/WS 路由。
- 感知与决策代码只使用 `reme.runtime.perception` 和 `reme.runtime.decision`；旧顶层命名空间已删除。
- 早期动作 JSONL 原型已迁入 `experiments/legacy_motion_demo/`，不得重新放回产品包。
- 模型、训练数据和运行结果不得写入包目录，应写入 `models/` 约定位置或 Git 忽略的 `artifacts/`。
