# Reme v0.1.0beta 项目结构审计

- 审计日期：2026-08-05
- 冻结演示提交：`aeef9599ba9788094873dfc98326540d989f8275`
- 主分支合并提交：`9a49fe572544677697deaf1aec36b6f955f2cd73`
- 冻结 Tag：`v0.1.0beta`
- 整理分支：`refactor/project-structure-v0.1.0beta`
- 本轮范围：版本归档、只读结构盘点、整理计划
- 本轮不处理：P0 隐私/检测/产品逻辑、算法阈值、模型训练、业务行为重构

## 1. 当前目录边界

| 路径 | 当前职责 | 审计结论 |
| --- | --- | --- |
| `backend/reme/pose/` | A：摄像头输入、MoveNet、姿态与转变、运行时服务 | 生产主路径，文件较多但职责基本集中 |
| `backend/reme/decision/` | B：决策、MiMo、会话、危险确认、WebSocket | 生产主路径，模块边界存在但单文件偏大 |
| `backend/reme/local_demo.py` | ABC 单机进程编排 | 当前真实全链路入口 |
| `frontend/src/typical-demo/` | C：四场景路演页面与老人端/家属端编排 | 当前真实演示页面 |
| `frontend/src/hooks/` | A/B 运行时前端生命周期 | 与 `typical-demo` 强耦合，移动需同步修复 import |
| `frontend/src/services/` | A/B HTTP/WS 客户端 | 边界清晰，可继续保留 |
| `frontend/src/assets/` | 高保真产品界面图片 | 与演示场景 JPG 分属两个资源体系 |
| `frontend/public/scenes/` | 演示背景 JPG | 构建时按固定 URL 使用，移动会影响运行时路径 |
| `models/movenet/` | Git 中冻结的 MoveNet TFLite | 当前 A 默认运行模型 |
| `artifacts/` | 本地训练、评估、审计产物 | 被 Git 忽略；当前工作区未包含所需全部训练模型 |
| `tests/` | Python 单元/集成测试 | 与 `main` 新合同和 aeef 演示合同存在漂移 |
| `.scratch/` | spec、issue、handoff、实验代码、结果证据 | 内容过度混合，是首要整理对象 |
| `docs/` | ADR、代理说明、参考资料、快速启动 | 正式文档与当前 README 有口径差异 |
| `planning/` | 早期产品/情报材料 | 与 `docs/`、`.scratch/` 职责重叠 |
| `scripts/` | MiMo 环境配置、全链路启动 | 数量少，适合作为统一脚本入口 |

## 2. 当前真实 A/B/C 调用链

```text
根目录启动器 / scripts/start-demo.sh
  -> uv run --extra pose reme-local-demo
  -> backend/reme/local_demo.py
       A: python -m reme.pose.runtime_server
          - HTTP: /api/runtime/capabilities|start|stop|status
          - WS 输入: /ws/camera-input
          - WS 事件: /ws/events?session_id=<id>
       B: python -m reme.decision.server
          - HTTP: /api/session|session/scene|session/stop
          - HTTP: /api/decision|api/response
          - 从 A 的 /ws/events 订阅事件
       C: npm run dev -- --port 4174
          - frontend/typical-demo.html
          - TypicalDemoApp -> useFallLiveLink
          - usePerceptionRuntime -> perceptionClient -> A
          - useDecisionRuntime -> decisionClient -> B
```

端口默认值：A `8770`、B `8100`、C `4174`。

## 3. 模型与运行时默认路径

| 能力 | 默认路径 | 当前状态 |
| --- | --- | --- |
| A MoveNet | `models/movenet/movenet_lightning_f16_v4.tflite` | 存在，约 4.54 MiB，已被 Git 跟踪 |
| C MediaPipe | `frontend/public/mediapipe/pose_landmarker_lite.task` | 存在，约 5.51 MiB，已被 Git 跟踪 |
| 姿态 Softmax | `artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json` | 本地工作区不存在，运行时应降级 |
| 跌倒 MIL v3 | `artifacts/pose-classification/fall-50/mil-v3/model.json` | 本地工作区不存在，3 项测试因此失败 |
| MiMo 凭据 | `~/.config/reme/mimo.env` | 仓库外路径，符合不提交密钥原则 |

注意：`.gitignore` 当前忽略整个 `models/`，但 MoveNet 文件已经被历史提交跟踪。后续不得把“被忽略”误解为“模型不存在”，也不得擅自删除已跟踪演示权重。

## 4. 已确认的结构问题

### 4.1 入口与文档口径混杂

- `README.md` 开头仍把项目描述为“可行性分析阶段”，后半部分却已经给出完整 ABC 单机演示。
- `pyproject.toml` 同时暴露当前入口 `reme-local-demo` 和早期探索入口 `reme-demo`。
- `docs/motion-data-format.md` 仍把早期 `reme-demo` 当作可执行示例。
- 根目录、前端目录共有三个 `.command` 启动器：一个完整 ABC，两个只启动前端；命名不足以区分“正式演示”和“前端单独预览”。

### 4.2 `.scratch` 同时承担五种职责

`.scratch` 当前包含 131 个已跟踪文件，混合：

1. spec 与 issue；
2. 会话 handoff；
3. 可执行训练/实验脚本；
4. 实验结果与进度日志；
5. 产品、品牌和路演材料。

这使“临时文件”和“长期证据”无法仅凭目录判断。不得直接整体清理 `.scratch`。

### 4.3 旧迁移残留与索引漂移

- 根目录 `src/` 已被忽略，当前只剩旧 Python `__pycache__`，属于从 `src/reme` 迁移到 `backend/reme` 后的本地残留。
- `.codegraph` 索引仍返回旧 `src/reme` 路径，与当前磁盘代码不一致，使用前必须重建。

### 4.4 兼容层和同名模块

- `backend/reme/scene_bundle.py` 只是 `backend/reme/pose/scene_bundle.py` 的兼容导出层，不是第二套实现。
- 兼容层暂时仍被文档承诺保留；删除前必须确认 CLI、测试和外部调用方。

### 4.5 训练代码与产品代码边界不统一

- 正式姿态/跌倒训练逻辑部分位于 `backend/reme/pose/`。
- Conv1D、tiny-transition、MotionBERT 等实验实现仍位于 `.scratch`。
- 后续应区分“可复现实验工具”和“一次性研究草稿”，但不能在未验证依赖和输入路径前移动。

### 4.6 路径与命名不一致

- 多份历史结果记录硬编码 `/home/akira/Projects/reme`，与当前 `/home/Akira/Projects/reme` 大小写不一致。
- 文件名同时使用中文、英文、角色字母、功能名和日期；没有统一的归档规则。
- `planning/`、`docs/`、`.scratch/*/results` 都包含项目说明或证据，查找成本高。

### 4.7 生成物与本地空间

- `frontend/` 当前约 492 MiB，主要由已忽略的 `node_modules/`、`dist/` 和复制的 MediaPipe WASM 构成。
- `.venv/` 约 94 MiB，`.mypy_cache/`、`.pytest_cache/`、`.ruff_cache/` 均已忽略。
- `.gitignore` 已覆盖主要生成物；可补充检查 `.coverage`、`htmlcov/`、`frontend/.vite/`、`*.tsbuildinfo` 等潜在生成物，但应先确认仓库实际工具链。

### 4.8 测试合同漂移

合并 aeef 演示分支后，完整 Python 测试为 `556 passed, 28 failed`：

- 25 项来自当前 `main` 测试与 aeef 演示行为之间的合同差异；
- 3 项来自本地缺少 `artifacts/pose-classification/fall-50/mil-v3/model.json`。

该问题本轮只记录，不修改业务逻辑、阈值或测试预期。

## 5. 会影响运行的移动风险

| 整理对象 | 可能受影响内容 |
| --- | --- |
| `backend/reme/**` | `pyproject.toml` 包路径、模块 import、`python -m` 入口、全部 Python 测试 |
| `frontend/src/**` | React import、Vite 构建、测试脚本、动态资源引用 |
| `frontend/public/scenes/**` | `/scenes/*.jpg` 固定 URL、场景配置、构建产物 |
| `models/movenet/**` | A 默认参数、README、启动脚本、运行时测试 |
| `artifacts/**` 约定 | 本地训练模型、测试 fixture、运行时降级逻辑 |
| `.scratch` 实验脚本 | 相对路径、历史命令、证据可复现性 |
| `.command` 与 `scripts/**` | macOS 启动体验、依赖检查、端口和工作目录 |
| 兼容模块 `reme.scene_bundle` | 外部 CLI、旧文档、潜在未跟踪调用方 |

## 6. 建议分阶段整理

### 第一批：低风险、行为不变

1. 统一 README、`docs/快速启动.md`、`frontend/README.md` 的真实启动方式和当前阶段描述。
2. 为三个启动器增加明确用途说明，决定是否只保留一个正式入口，其余改名为“前端预览”。
3. 清理本地被忽略的 `src/__pycache__`，重建 `.codegraph`。
4. 建立 `.scratch/README.md`，定义 spec、issue、handoff、results、prototype 的保留规则。
5. 建立模型清单，记录 Git 权重、本地 artifact、默认路径、SHA-256 和缺失时降级行为。

### 第二批：需要修引用与测试

1. 将可长期复现的实验脚本从 `.scratch` 迁移到 `tools/experiments/` 或 `experiments/`。
2. 将路演、品牌、产品材料归档到 `docs/product/` 或 `docs/archive/`。
3. 将历史结果中的绝对路径改为仓库相对路径或明确标记为历史快照。
4. 评估移除 `reme.scene_bundle` 兼容入口，并先做全仓引用和外部调用确认。
5. 将早期 `reme-demo` 标记为 legacy、迁入独立目录或删除入口；不得与当前 ABC 启动方式并列。

### 第三批：需单独决策，不在纯整理提交中处理

1. 处理 aeef 演示行为与当前测试合同的差异。
2. 确定本地训练模型的分发、校验和恢复机制。
3. 拆分 B 的超大模块或调整 A/B/C 运行时边界。
4. 处理任何 P0 隐私、检测、产品逻辑问题。

## 7. 分支结构快照

### 本地

```text
main                                  -> origin/main
refactor/project-structure-v0.1.0beta -> origin/refactor/project-structure-v0.1.0beta
```

### 远端已完全并入 main，可考虑归档或删除

```text
archive/biomech-posture-classifier
b-decision
codex/remove-browser-tts-voice-gate
develop/akira
develop/jiang
develop/master
feature/abc-single-device-integration
mimo-api-research
```

### 远端仍与 main 分叉，不得直接删除

```text
codex/shared-live-demo  # main 独有 10，分支独有 18
lbx                     # main 独有 10，分支独有 53；包含 shared-live-demo
```

### 当前发布节点

```text
main
v0.1.0beta
refactor/project-structure-v0.1.0beta（创建时）
  -> 9a49fe572544677697deaf1aec36b6f955f2cd73
```

## 8. 下一阶段优先文件

1. `README.md`
2. `docs/快速启动.md`
3. `frontend/README.md`
4. `pyproject.toml`
5. `scripts/start-demo.sh`
6. `启动Reme全链路演示.command`
7. `frontend/启动Reme典型场景演示.command`
8. `frontend/启动Reme手机演示.command`
9. `.gitignore`
10. `.scratch/` 各实验目录及待新增的保留规则
11. `backend/reme/scene_bundle.py`
12. `backend/reme/pose/scene_bundle.py`
13. `backend/reme/pose/runtime_server.py`
14. `backend/reme/pose/fall_runtime.py`
15. `tests/test_pose_fall_runtime.py`

任何实际文件移动都必须独立提交，并同步修复 import、资源路径、测试与文档。
