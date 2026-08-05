# Reme v0.1.0beta 后端统一运行时整理审计

- 审计日期：2026-08-05
- 冻结发布节点：`main@9a49fe572544677697deaf1aec36b6f955f2cd73`
- 冻结 Tag：`v0.1.0beta`
- 整理分支：`refactor/project-structure-v0.1.0beta`
- 本轮范围：程序入口、后端目录、内部传输、统一 HTTP/WS 服务、启动流程
- 本轮不处理：模型文件实际迁移、算法阈值、P0 隐私策略、检测业务行为

## 1. 程序入口

项目不再定义 `[project.scripts]`，`uv sync` 不应在 `.venv/bin` 安装 `reme-*` 程序。

正式人工入口全部位于仓库：

```text
scripts/demo/start-local-demo.sh
scripts/demo/start-frontend-preview.sh
scripts/setup/setup-mimo-env.sh
scripts/training/run-posture-sweep.sh
scripts/tools/
```

正式单机启动链：

```text
scripts/demo/start-local-demo.sh
  → uv run --extra pose python -m reme.runtime.launcher
  → BACKEND: python -m reme.runtime.server
  → FRONTEND: npm run dev
```

已删除旧 `reme.local_demo` 兼容模块。`tests/test_runtime_launcher.py` 直接验证 `reme.runtime.launcher`。

## 2. 后端目录

```text
backend/reme/
├── runtime/
│   ├── perception/       # 视频输入、姿态、动作转变和感知会话
│   ├── decision/         # 规则/MiMo、危险确认、回应与家属事件
│   ├── transport.py      # 进程内感知到决策事件传输
│   ├── server.py         # 唯一后端 HTTP/WS 服务
│   ├── launcher.py       # 统一后端与前端进程监督器
│   └── debug_ws_client.py# 外部联调观察器，不参与内部传输
├── pose/                 # 旧导入兼容命名空间，仅含 __init__.py
├── decision/             # 旧导入兼容命名空间，仅含 __init__.py
├── scene_bundle.py       # 场景包兼容导出
└── care.py / motion.py / motion_io.py / demo.py
                           # 早期动作 JSONL 原型
```

物理实现已通过 `git mv` 从 `backend/reme/pose`、`backend/reme/decision` 迁入 `backend/reme/runtime`。兼容命名空间仍有大量历史导入，当前只负责解析旧模块路径，不是独立执行端。

## 3. 单进程数据流

```text
浏览器
  ├─ HTTP /api/runtime/*
  ├─ WS   /ws/camera-input
  ├─ HTTP /api/session|decision|response|danger/*
  └─ WS   /ws
        ↓
reme.runtime.server（单进程、单端口 8770）
  ├─ perception RuntimePerceptionController
  │    └─ EventBroker
  ├─ InProcessPerceptionBridge
  │    └─ EventIngest
  └─ decision DecisionService / DangerConfirmController / MiMo
```

感知到决策不经过 HTTP、WebSocket、JSON 网络重解析或重连循环。`POST /api/events` 在统一服务器中返回 `in_process_only`，防止重新打开内部 HTTP 推送入口。

`/ws/events` 仍保留为浏览器和开发工具的只读观察接口；`debug_ws_client.py` 只用于外部联调，不得被生产组件用于内部传输。

## 4. 对外端口

| 组件 | 默认地址 | 说明 |
|---|---|---|
| 统一后端 | `127.0.0.1:8770` | 感知、决策及全部 HTTP/WS 接口 |
| Vite 前端 | `127.0.0.1:4174` | 典型场景和产品页面 |

已移除旧决策端口 `8100` 和 `--a-events-url` 配置。前端以下变量均指向统一后端：

```text
VITE_REME_PERCEPTION_HTTP_URL=http://127.0.0.1:8770
VITE_REME_PERCEPTION_INPUT_WS_URL=ws://127.0.0.1:8770/ws/camera-input
VITE_REME_DECISION_HTTP_URL=http://127.0.0.1:8770
```

## 5. MiMo 配置

MiMo 密钥只从仓库根目录 `.env` 读取：

```text
.env.example  # 提交模板
.env          # 本地密钥，Git 忽略
```

不再读取 `~/.config/reme/mimo.env`。

## 6. 模型位置

本轮只保留目标目录，不移动现有模型。后续由项目所有者手动迁移，每组模型必须独立提交并同步运行路径。

```text
models/runtime/movenet/
models/runtime/mediapipe/
models/trained/posture/
models/trained/fall/
models/vendor/
```

当前运行位置仍为：

```text
models/movenet/movenet_lightning_f16_v4.tflite
frontend/public/mediapipe/pose_landmarker_lite.task
artifacts/pose-classification/models/posture-sweep-20260801/seed-42-lr-0.04/model.json
artifacts/pose-classification/fall-50/mil-v3/model.json
```

## 7. 本轮提交

```text
10297a2 feat(project): 移除虚拟环境安装型程序入口
2dd481c feat(runtime): 合并感知与决策后端目录
e2c4d3d feat(runtime): 建立进程内感知决策传输
7a6d587 feat(runtime): 合并后端服务与对外接口
a75cc82 feat(runtime): 统一后端与前端启动流程
61d5293 feat(runtime): 移除内部 WebSocket 传输通道
e36ff41 feat(runtime): 删除旧本地演示兼容入口
```

## 8. 风险与后续

1. `reme.pose.*` 与 `reme.decision.*` 仍被历史实现、测试和实验广泛导入。下一轮若迁移命名空间，必须逐模块替换并防止同一文件以两个模块名重复加载。
2. 模型文件尚未移动；不得提前修改默认路径或删除旧权重。
3. `reme.scene_bundle` 仍是兼容导出，删除前需再次全仓确认调用方。
4. Python 主测试原冻结基线为 `556 passed, 28 failed`；本轮统一验证需在全部整理提交完成后执行，并区分既有合同失败与新增结构回归。
5. `.venv/bin` 中可能残留旧安装生成物；重新执行 `uv sync` 后应确认 `reme-*` 文件不再存在。该目录不属于 Git 内容。
