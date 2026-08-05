# 测试目录

`tests/` 保存 Python 产品代码的确定性测试，当前按文件名前缀区分主要领域：

- `test_pose_*`：感知、姿态、转变、模型适配和运行时兼容接口；
- `test_decision_*`：决策、状态机、MiMo、会话和危险确认；
- `test_runtime_launcher.py`：统一后端与前端启动器；
- `test_runtime_transport.py`：进程内感知到决策传输；
- `test_runtime_debug_ws_client.py`：仅供外部联调的 WebSocket 观察客户端；
- `test_demo_cli.py`、`test_motion_*`：早期兼容原型；
- `test_danger_link_e2e.py`：感知→决策危险链路端到端合同。

实验目录中的自包含测试保留在各自 `experiments/<name>/` 下，不自动加入主测试套件。

测试不得依赖真实 API key、互联网或危险真人动作。需要本地模型的测试应明确跳过或报告模型缺失，不能把 Git 忽略的模型不存在误判为训练未完成。
