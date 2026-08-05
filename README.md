# Reme

Reme 是面向家庭关怀场景的隐私优先演示系统：统一后端在本地完成姿态感知、动作事件和关怀决策，结合确定性规则与 Xiaomi MiMo 生成交互；家属端默认只看到抽象骨架和结构化状态。

当前冻结演示版本为 `v0.1.0beta`。该版本用于比赛演示和后续结构整理，不代表医疗器械、生产级监护系统或已验证的跌倒检测产品。

## 当前演示链路

```text
浏览器摄像头
  └─ /ws/camera-input
       ↓
统一后端 backend/reme/runtime/server.py
  ├─ perception：MoveNet / MediaPipe、posture_observation、transition_event
  ├─ 进程内 EventBroker → EventIngest
  └─ decision：确定性状态机、MiMo 对话、care_decision
       ↓ /ws
frontend/typical-demo.html
  ├─ 老人端演示
  └─ 家属端隐私视图
```

正式单机入口为 `scripts/demo/start-local-demo.sh`。它只管理统一后端和前端两个进程；感知到决策不经过内部 HTTP/WebSocket。

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

兼容入口：

```bash
scripts/start-demo.sh
```

macOS 仍可双击根目录的 `启动Reme全链路演示.command`。旧入口只是兼容包装，实际逻辑统一位于 `scripts/`。

完整说明见 [docs/快速启动.md](docs/快速启动.md)。

## 目录结构

```text
.
├── backend/reme/       # 统一后端运行时：perception、decision、transport、server
├── frontend/           # React/Vite 演示页面
├── models/             # 运行时模型约定与本地训练模型
├── data/               # 本地训练、来源归档和参考场景数据
├── scripts/            # 演示、环境配置和平台启动器
├── docs/               # 产品、方案、调研、ADR 和启动文档
├── examples/           # 联调与合同示例
├── experiments/        # 可复现但未进入产品运行时的实验
├── tests/              # Python 确定性测试
├── .scratch/           # 规格、任务、实验过程、结果和交接记录
├── AGENTS.md           # Agent 工程规则
└── CONTEXT.md          # 当前领域边界与事实口径
```

文档入口见 [docs/README.md](docs/README.md)。

## 本地模型与训练数据

2026-08-05 已从团队开发机恢复训练模型和数据。当前运行时默认资产：

```text
models/movenet/movenet_lightning_f16_v4.tflite
frontend/public/mediapipe/pose_landmarker_lite.task
models/trained/posture/posture-sweep-20260801/seed-42-lr-0.04/model.json
models/trained/fall/mil-v3/model.json
```

本地还保存姿态 Softmax 历史版本、12 组 sweep 结果、MIL v1–v3、原始动作视频、关键点标注、跌倒 bootstrap 样本和参考场景。大型资产受 `.gitignore` 管理，不推送到远端 Git。

目录与校验信息见 [models/README.md](models/README.md) 和 [data/README.md](data/README.md)。可再生成的运行日志与临时结果继续写入 `artifacts/`。

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

- `scripts/demo/start-local-demo.sh` 是当前单机演示入口；项目不再向 `.venv/bin` 安装 `reme-*` 程序。
- `scripts/tools/run-legacy-motion-demo.sh`、`reme.motion` 和 `docs/motion-data-format.md` 属于早期动作 JSONL 探索原型，暂时保留用于历史追溯和兼容测试。
- `.scratch/` 中的阶段性方案、实验代码和结果不自动构成当前架构决策；正式事实以 `CONTEXT.md`、已接受 ADR 和当前代码为准。

## 隐私边界

Reme 的窄化隐私主张是：感知默认在本地处理，家属和评委界面优先使用骨架、抽象视图和结构化事件。任何向 MiMo 发送的视觉上下文必须是事件触发、最小、显式且可审计的，不能扩展为持续后台上传。
