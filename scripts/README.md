# Reme 脚本目录

```text
scripts/
├── demo/                 # 本地演示与前端预览入口
├── launchers/macos/      # 可双击的 macOS 启动器
├── setup/                # 一次性环境配置
├── training/             # 训练与参数扫描入口
└── tools/                # MiMo、视觉、语音和历史原型工具入口
```

正式命令：

```bash
scripts/demo/start-local-demo.sh
scripts/demo/start-frontend-preview.sh
scripts/setup/setup-mimo-env.sh
scripts/training/run-posture-sweep.sh
scripts/tools/mimo-smoke.sh structured --rounds 1
```

项目不再定义 `[project.scripts]`。`uv sync` 只安装 Python 包和依赖，不会在 `.venv/bin` 生成 `reme-*` 程序。所有人工执行入口必须位于本目录，并通过 `uv run python -m ...` 调用后端模块。

根目录和 `frontend/` 中的 `.command` 文件作为比赛现场快捷方式保留，实际逻辑统一转发到 `scripts/launchers/macos/`，再调用本目录中的正式脚本。
