# Reme

Reme 是面向家庭关怀场景的隐私优先演示系统：本地感知端提取人体姿态和动作事件，决策端结合确定性规则与 Xiaomi MiMo 生成关怀交互，家属端默认只看到抽象骨架和结构化状态。

当前冻结演示版本为 `v0.1.0beta`。该版本用于比赛演示和后续结构整理，不代表医疗器械、生产级监护系统或已验证的跌倒检测产品。

## 当前演示链路

```text
C 浏览器摄像头
  └─ /ws/camera-input
       ↓
A backend/reme/pose/runtime_server.py
  ├─ MoveNet / MediaPipe 姿态数据
  ├─ posture_observation
  └─ transition_event
       ↓ /ws/events
B backend/reme/decision/server.py
  ├─ 确定性关怀与危险状态机
  ├─ MiMo 对话与摘要
  └─ care_decision
       ↓ /ws
C frontend/typical-demo.html
  ├─ 老人端演示
  └─ 家属端隐私视图
```

正式单机入口由 `backend/reme/local_demo.py` 统一管理 A、B、C 三个进程。

## 快速启动

环境要求：Python 3.11+、`uv`、Node.js 和 npm。

```bash
uv sync --extra dev --extra pose
scripts/setup/setup-mimo-env.sh
scripts/demo/start-local-demo.sh
```

MiMo 密钥写入仓库根目录 `.env`；该文件已被 Git 忽略。也可以复制模板后手动填写：

```bash
cp .env.example .env
```

启动后访问：

```text
http://127.0.0.1:4174/typical-demo.html
```

等价入口：

```bash
uv run reme-local-demo
scripts/start-demo.sh
```

macOS 仍可双击根目录的 `启动Reme全链路演示.command`。旧入口只是兼容包装，实际逻辑统一位于 `scripts/`。

完整说明见 [docs/快速启动.md](docs/快速启动.md)。

## 目录结构

```text
.
├── backend/reme/       # Python 后端：A 感知、B 决策和本地启动器
├── frontend/           # React/Vite 演示页面
├── models/             # 模型目录约定与待迁移占位
├── scripts/            # 演示、环境配置和平台启动器
├── docs/               # 产品、方案、调研、ADR 和启动文档
├── examples/           # 联调与合同示例
├── tests/              # Python 确定性测试
├── .scratch/           # 规格、任务、实验过程、结果和交接记录
├── AGENTS.md           # Agent 工程规则
└── CONTEXT.md          # 当前领域边界与事实口径
```

文档入口见 [docs/README.md](docs/README.md)。

## 模型资产

本轮结构整理只预留新目录，不自动移动模型。当前运行仍可能使用以下旧位置：

```text
models/movenet/movenet_lightning_f16_v4.tflite
frontend/public/mediapipe/pose_landmarker_lite.task
artifacts/pose-classification/
```

`artifacts/` 保存本地训练数据、模型和派生产物，默认不进入 Git。模型不存在于 Git 不等于模型未训练或本机不存在。

后续模型迁移目标与规则见 [models/README.md](models/README.md)。

## 开发检查

全部整理批次完成后执行：

```bash
python -m compileall backend
python -m pytest
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

涉及本地模型、摄像头或 MiMo 的检查必须如实记录运行环境和缺失条件，不得把降级结果描述为完整能力通过。

## 兼容与历史内容

- `reme-local-demo` 是当前 ABC 单机演示入口。
- `reme-demo`、`reme.motion` 和 `docs/motion-data-format.md` 属于早期动作 JSONL 探索原型，暂时保留用于历史追溯和兼容测试。
- `.scratch/` 中的阶段性方案、实验代码和结果不自动构成当前架构决策；正式事实以 `CONTEXT.md`、已接受 ADR 和当前代码为准。

## 隐私边界

Reme 的窄化隐私主张是：感知默认在本地处理，家属和评委界面优先使用骨架、抽象视图和结构化事件。任何向 MiMo 发送的视觉上下文必须是事件触发、最小、显式且可审计的，不能扩展为持续后台上传。
