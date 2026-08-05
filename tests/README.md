# 测试目录

`tests/` 保存 Python 产品代码的确定性测试，当前按文件名前缀区分主要领域：

- `test_pose_*`：A 感知、姿态、转变、模型适配和运行时；
- `test_decision_*`：B 决策、状态机、MiMo、会话和危险确认；
- `test_local_demo.py`：ABC 单机启动器；
- `test_demo_cli.py`、`test_motion_*`：早期兼容原型；
- `test_danger_link_e2e.py`：A→B 危险链路端到端合同。

实验目录中的自包含测试保留在各自 `experiments/<name>/` 下，不自动加入主测试套件。

测试不得依赖真实 API key、互联网或危险真人动作。需要本地模型的测试应明确跳过或报告模型缺失，不能把 Git 忽略的模型不存在误判为训练未完成。
