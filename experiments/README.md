# Reme 实验目录

`experiments/` 保存可执行、可复现但尚未进入产品运行时的实验代码。

每个实验目录应尽量自包含，并明确：

- 实验目的和事实边界；
- 输入数据与本地模型路径；
- 运行命令；
- 输出位置；
- 已测结果与未验证项；
- 是否仍被当前产品代码调用。

长期产品代码放在 `backend/` 或 `frontend/`；规格、任务、会话交接和阶段性调查记录放在 `.scratch/`；大型数据、权重和生成结果放在 Git 忽略的 `artifacts/`。

当前目录中的实验不自动构成已接受架构，也不得直接引用其实验指标作为产品指标。

## 当前实验

- `conv1d-posture-classifier/`：MoveNet 17 点序列的 Conv1D 姿态分类复现原型。
- `litert-movenet-feasibility/`：LiteRT MoveNet 视频提取、性能记录和 Web Viewer。
- `legacy_motion_demo/`：从产品包移出的早期动作 JSONL 与透明启发式原型。
- `motionbert-offline-demo/`：离线 3D 姿态提升与双栏演示。
- `tiny-transition-model/`：基于合成数据的轻量动作转变基线。

正式姿态训练扫描脚本位于 `scripts/training/`；其输入、模型和结果继续写入 Git 忽略的 `artifacts/`。
