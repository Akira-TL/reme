# Reme v0.1.0beta 项目结构整理记录

- 日期：2026-08-05
- 冻结演示提交：`aeef9599ba9788094873dfc98326540d989f8275`
- `main` 合并提交：`9a49fe572544677697deaf1aec36b6f955f2cd73`
- 冻结 Tag：`v0.1.0beta`
- 整理分支：`refactor/project-structure-v0.1.0beta`
- 整理原则：不处理 P0，不修改算法判断，不重新训练模型，不移动现有模型二进制

## 1. 当前目录边界

```text
.
├── backend/             # Python 产品代码
│   └── reme/
│       ├── pose/        # A：姿态提取、分类和事件运行时
│       ├── decision/    # B：规则/MiMo 决策和会话运行时
│       └── local_demo.py# ABC 单机启动器
├── frontend/            # C：React/Vite 演示页面
├── models/              # 模型目录约定与待迁移占位
├── scripts/
│   ├── demo/            # 完整演示和前端预览
│   ├── launchers/macos/ # macOS 双击入口
│   ├── setup/           # 本地环境配置
│   └── training/        # 训练和参数扫描入口
├── docs/
│   ├── product/         # 产品文档和比赛执行计划
│   ├── integration/     # 技术接入方案
│   ├── research/        # 外部调研
│   ├── adr/             # 架构决策
│   ├── references/      # 来源和证据台账
│   └── agents/          # Agent 协作规则
├── experiments/         # 可复现、未进入产品运行时的实验
├── examples/            # 小型合同样例与联调工具
├── tests/               # Python 产品测试
└── .scratch/            # spec、issue、handoff、结果和研究过程
```

`planning/` 的已跟踪内容已全部迁入 `docs/`。本地若仍显示空 `planning/` 目录，只是文件系统空目录，不属于 Git 内容。

## 2. 当前 A/B/C 入口

```text
scripts/demo/start-local-demo.sh
  -> uv run --extra pose reme-local-demo
  -> backend/reme/local_demo.py
       A: python -m reme.pose.runtime_server
       B: python -m reme.decision.server
       C: npm run dev -- --host 127.0.0.1 --port 4174
```

验收页面：

```text
http://127.0.0.1:4174/typical-demo.html
```

兼容入口仍保留：

- `scripts/start-demo.sh`
- 根目录 `启动Reme全链路演示.command`
- `frontend/启动Reme典型场景演示.command`
- `frontend/启动Reme手机演示.command`

兼容入口仅转发到 `scripts/`，不再复制进程管理逻辑。

## 3. MiMo 本地配置

MiMo 密钥统一从仓库根目录 `.env` 读取，不再使用 Home 目录文件。

```text
.env.example  # 可提交模板
.env          # 本地真实配置，Git 忽略
```

配置入口：

```bash
scripts/setup/setup-mimo-env.sh
```

`backend/reme/local_demo.py` 中相对 `--mimo-env` 路径以仓库根目录解析，默认值为 `.env`。

## 4. 模型目录状态

本轮只预留以下目标结构：

```text
models/
├── runtime/
│   ├── movenet/
│   └── mediapipe/
├── trained/
│   ├── posture/
│   └── fall/
└── vendor/
```

现有模型没有移动，当前运行仍可能使用：

```text
models/movenet/movenet_lightning_f16_v4.tflite
frontend/public/mediapipe/pose_landmarker_lite.task
artifacts/pose-classification/
```

后续由负责人手动迁移。每批模型移动必须独立提交，并同步更新默认路径、构建脚本、文档、SHA-256 和降级说明。

模型未提交 Git 不等于模型未训练或本地不存在。

## 5. 已迁移实验

所有现有目录移动均使用 `git mv`。

| 原路径 | 新路径 |
|---|---|
| `.scratch/conv1d-posture-classifier/` | `experiments/conv1d-posture-classifier/` |
| `.scratch/litert-movenet-feasibility/` | `experiments/litert-movenet-feasibility/` |
| `.scratch/motionbert-offline-demo/` | `experiments/motionbert-offline-demo/` |
| `.scratch/tiny-transition-model/` | `experiments/tiny-transition-model/` |
| `.scratch/pose-classification-owner-a/run-posture-sweep.sh` | `scripts/training/run-posture-sweep.sh` |

`.scratch/posture-classifier-theory/` 中的辅助脚本直接复现同目录理论笔记数字，因此保留原位，不作为通用实验迁移。

## 6. 文档迁移

`planning/docs/` 已按职责拆分：

| 类型 | 新目录 |
|---|---|
| 核心产品、PRD、任务分解、开发计划 | `docs/product/` |
| MiMo 接入方案 | `docs/integration/` |
| MiMo/Miloco 调研 | `docs/research/` |

正式文档入口为 `docs/README.md`。根 `README.md`、`docs/快速启动.md` 和联调示例已统一使用当前目录与 `.env` 配置。

## 7. 分支归档

保留为活跃分支：

```text
main
refactor/project-structure-v0.1.0beta
develop/akira
develop/jiang
develop/master
lbx
```

归档映射：

| 原分支 | 归档分支 | Commit |
|---|---|---|
| `b-decision` | `archive/b-decision` | `63dd353f45ccde093ec9236a0c47d9cc7037d44d` |
| `codex/remove-browser-tts-voice-gate` | `archive/codex/remove-browser-tts-voice-gate` | `aeef9599ba9788094873dfc98326540d989f8275` |
| `codex/shared-live-demo` | `archive/codex/shared-live-demo` | `8a2f6a527f107cbcc381fb41fa396212819354c2` |
| `feature/abc-single-device-integration` | `archive/feature/abc-single-device-integration` | `a4e8625969c41e65dd4f22d20ab23abb5b5ecbde` |
| `mimo-api-research` | `archive/mimo-api-research` | `9fa4d2b1825bf9cae468fe6984b36898ca28b877` |

`archive/biomech-posture-classifier` 原本已经是归档分支，保持不变。

归档过程先以原 SHA 创建 `archive/*`，再删除原分支名，没有丢失提交，也没有强推。

## 8. 整理提交

```text
487ea33 feat(project): 预留模型目录结构
e12c849 feat(project): 整理启动脚本并改用本地环境文件
3fc81ac feat(docs): 整理产品方案与调研文档目录
d3f9b9f feat(docs): 统一本地启动与密钥配置说明
7b24d66 feat(project): 迁移 Conv1D 姿态分类实验
eb3fe7a feat(project): 迁移 LiteRT 姿态提取实验
a56435f feat(project): 迁移 MotionBERT 离线演示实验
8146a49 feat(project): 迁移轻量动作转变实验
988455c feat(project): 迁移姿态训练扫描脚本
a7b494a feat(docs): 明确代码实验与过程资料边界
```

每类移动均使用独立提交；批次间未运行测试，统一验证安排在全部整理完成之后。

## 9. 有意保留的兼容与历史内容

以下内容本轮不移动、不删除：

- `backend/reme/demo.py`、`care.py`、`motion.py`、`motion_io.py`：早期 `reme-demo` 兼容原型；
- `backend/reme/scene_bundle.py`：`reme.pose.scene_bundle` 兼容导出；
- `.scratch` 中的 spec、issue、handoff、结果和理论研究；
- 已跟踪的演示模型和前端 MediaPipe 模型；
- 本地 Git 忽略的训练模型、数据和结果。

删除兼容层需要单独确认外部调用方，不属于本轮结构整理。

## 10. 本轮明确不处理

- 已知 P0 隐私、检测或产品逻辑问题；
- 跌倒触发阈值、确认通道或超时策略；
- 测试合同与 `aeef` 演示行为差异；
- 模型重新训练、模型文件自动迁移或大文件提交；
- A/B/C 架构重写；
- `lbx` 或 `develop/*` 内容合并。

## 11. 统一验证计划

全部整理提交完成后统一执行：

```bash
python -m compileall backend
python -m pytest
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
bash -n scripts/**/*.sh
```

测试失败必须区分：本轮移动导致的路径错误、冻结演示版本已有合同差异、本地模型缺失以及环境依赖缺失。
